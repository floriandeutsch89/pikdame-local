// public/sfx.js
// The game's sound effects, synthesised as samples on the spot (no audio
// files): card noises, the bells and the Queen of Spades' cues. Loaded before
// client.js; the tests and scripts/render-music.js (music levels) require() it.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PikdameSfx = api;
}(typeof self !== 'undefined' ? self : this, () => {
  'use strict';

  const PEAK_MAX = 0.4; // an effect on top of loud music stays below full scale
  const LN1000 = Math.log(1000); // a t60 decays by this many e-folds (-60 dB)
  const TAU = 2 * Math.PI;

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** State-variable filter (TPT): stays stable while its cutoff moves. bp has unity gain at f. */
  class Filter {
    constructor(sr, f, q = 0.707) { this.sr = sr; this.s1 = 0; this.s2 = 0; this.v1 = 0; this.tune(f, q); }
    tune(f, q = this.q) {
      const g = Math.tan(Math.PI * Math.min(Math.max(f, 20), this.sr * 0.45) / this.sr);
      this.q = q; this.k = 1 / q;
      this.a1 = 1 / (1 + g * (g + this.k)); this.a2 = g * this.a1; this.a3 = g * this.a2;
    }
    lp(x) {
      const v3 = x - this.s2;
      const v1 = this.a1 * this.s1 + this.a2 * v3;
      const v2 = this.s2 + this.a2 * this.s1 + this.a3 * v3;
      this.s1 = 2 * v1 - this.s1; this.s2 = 2 * v2 - this.s2;
      this.v1 = v1;
      return v2;
    }
    bp(x) { this.lp(x); return this.k * this.v1; }
    hp(x) { const low = this.lp(x); return x - this.k * this.v1 - low; }
  }

  /** One take being written: layers add into `out`; `rand` makes every take a little different. */
  class Score {
    constructor(sr, seconds, seed) {
      this.sr = sr;
      this.out = new Float32Array(Math.ceil(seconds * sr));
      this.rand = mulberry32(seed >>> 0);
    }
    vary(v, by) { return v * (1 + by * (2 * this.rand() - 1)); }
    span(at, len) {
      const s0 = Math.max(0, Math.round(at * this.sr));
      return [s0, Math.max(0, Math.min(this.out.length - s0, Math.ceil(len * this.sr)))];
    }

    /** Filtered white noise: an attack (curve 2: a swell), then a t60 decay; bpTo glides the band. */
    noise({ at = 0, attack = 0.001, curve = 1, t60 = 0.05, gain = 1, hp = 0, lp = 0, bp = 0, bpTo = 0, q = 1 }) {
      const [s0, n] = this.span(at, attack + 1.2 * t60);
      const rnd = mulberry32((this.rand() * 4294967296) >>> 0);
      const fh = hp ? new Filter(this.sr, hp) : null;
      const fl = lp ? new Filter(this.sr, lp) : null;
      const fb = bp ? new Filter(this.sr, bp, q) : null;
      const a = Math.max(1, Math.round(attack * this.sr));
      const fall = Math.exp(-LN1000 / (t60 * this.sr));
      const glide = bpTo ? Math.pow(bpTo / bp, 16 / n) : 1;
      let env = 1;
      let f = bp;
      for (let i = 0; i < n; i++) {
        let e;
        if (i < a) { e = i / a; if (curve === 2) e *= e; } else { env *= fall; e = env; }
        let x = 2 * rnd() - 1;
        if (fh) x = fh.hp(x);
        if (fb) {
          if (bpTo && (i & 15) === 0) { f *= glide; fb.tune(f); }
          x = fb.bp(x);
        }
        if (fl) x = fl.lp(x);
        this.out[s0 + i] += gain * e * x;
      }
    }

    /** Decaying sine partials [ratio, amplitude, t60]: bells, mallets, plucks. */
    bell({ at = 0, f, partials, attack = 0.002, gain = 1 }) {
      const a = Math.max(1, Math.round(attack * this.sr));
      for (const [ratio, amp, t60] of partials) {
        const w = TAU * f * ratio / this.sr;
        if (w >= 0.9 * Math.PI) continue; // above Nyquist at this rate
        const [s0, n] = this.span(at, attack + 1.15 * t60);
        const c2 = 2 * Math.cos(w);
        let y1 = 0;
        let y2 = -Math.sin(w); // sin(w i) by recursion: no Math.sin per sample
        const fall = Math.exp(-LN1000 / (t60 * this.sr));
        const g = gain * amp;
        let env = 1;
        for (let i = 0; i < n; i++) {
          const y = y1;
          y1 = c2 * y1 - y2;
          y2 = y;
          let e;
          if (i < a) e = i / a; else { env *= fall; e = env; }
          this.out[s0 + i] += g * e * y;
        }
      }
    }

    /** A brass note: a saw (PolyBLEP, no aliasing) through a lowpass that opens on the attack.
     *  scoop/droop bend in and out, fade: t60 of a stab, wah: [lo, hi, rate] a plunger (rate 0: once). */
    brass({ at = 0, f, len, gain = 1, attack = 0.015, release = 0.12, bright = 4, q = 0.9,
      scoop = 0.03, droop = 0, vib = 0, vibRate = 5.5, fade = 0, wah = null }) {
      const sr = this.sr;
      const out = this.out;
      const [s0, n] = this.span(at, len + 1.15 * release);
      let phase = this.rand();
      const vibPhase = this.rand() * TAU;
      const a = Math.max(1, Math.round(attack * sr));
      const hold = Math.round(len * sr);
      const fall = Math.exp(-LN1000 / (release * sr));
      const settle = Math.exp(-1 / (0.05 * sr)); // the attack's accent settles to 0.8
      const sag = fade ? Math.exp(-LN1000 / (fade * sr)) : 1;
      const k = 1 / q;
      let accent = 0.2;
      let body = 0.8;
      let env = 0;
      let dt = f / sr;
      // The lowpass inline (Filter.lp with local state): this loop is the costliest one here.
      let s1 = 0; let s2 = 0; let a1 = 0; let a2 = 0; let a3 = 0;
      for (let i = 0; i < n; i++) {
        if ((i & 31) === 0) {
          const t = i / sr;
          let pitch = f * (1 - scoop * Math.exp(-t / 0.025));
          if (droop && t > len - 0.12) pitch *= 1 - droop * Math.min(1, (t - len + 0.12) / 0.12);
          if (vib && t > 0.12) pitch *= 1 + vib * Math.min(1, (t - 0.12) / 0.15) * Math.sin(TAU * vibRate * t + vibPhase);
          dt = pitch / sr;
          let cut;
          if (wah) {
            const [lo, hi, rate] = wah;
            const w = rate ? 0.5 - 0.5 * Math.cos(TAU * rate * t)
              : Math.min(1, t / 0.1) * Math.max(0.25, Math.min(1, (len - t) / 0.1));
            cut = lo + (hi - lo) * w;
          } else {
            cut = f * (1.2 + bright * (1 - Math.exp(-t / 0.03)) * (0.75 + 0.25 * Math.exp(-t / 0.12)));
          }
          const g = Math.tan(Math.PI * Math.min(cut, sr * 0.45) / sr);
          a1 = 1 / (1 + g * (g + k)); a2 = g * a1; a3 = g * a2;
        }
        if (i < a) env = i / a;
        else if (i < hold) { accent *= settle; body *= sag; env = body + accent; } else env *= fall;
        phase += dt;
        if (phase >= 1) phase -= 1;
        let x = 2 * phase - 1;
        if (phase < dt) { const p = phase / dt; x -= p + p - p * p - 1; } else if (phase > 1 - dt) { const p = (phase - 1) / dt; x -= p * p + p + p + 1; }
        const v3 = x - s2;
        const v1 = a1 * s1 + a2 * v3;
        const v2 = s2 + a2 * s1 + a3 * v3;
        s1 = 2 * v1 - s1; s2 = 2 * v2 - s2;
        out[s0 + i] += gain * env * v2;
      }
    }
  }

  // --- Building blocks -------------------------------------------------------
  // A card on the felt: a dry crack, the card's flap, a short body. The body
  // sits above 300 Hz: phone speakers drop everything below.
  function slap(S, at, { body = 560, crack = 2700, weight = 1, length = 1 } = {}) {
    S.noise({ at, attack: 0.0004, t60: 0.018 * length, hp: 900, lp: S.vary(crack, 0.1), gain: 0.55 });
    S.noise({ at, attack: 0.0006, t60: 0.024 * length, bp: S.vary(1400, 0.1), q: 1.5, gain: 0.9 * weight });
    S.noise({ at, attack: 0.0008, t60: 0.03 * length, bp: S.vary(body, 0.06), q: 2.5, gain: 2.4 * weight });
  }

  // One card leaving a riffle: a short bright flick.
  function flick(S, at, gain) {
    S.noise({ at, attack: 0.0004, t60: S.vary(0.011, 0.3), bp: S.vary(3300, 0.3), q: 1.5, gain });
  }

  const chime = (S, at, f, gain, ring = 1) => S.bell({
    at, f, gain, partials: [[1, 1, 0.42 * ring], [2, 0.22, 0.22 * ring], [2.76, 0.05, 0.12 * ring], [5.4, 0.02, 0.06]],
  });
  const mallet = (S, at, f, gain) => S.bell({
    at, f, gain, attack: 0.003, partials: [[1, 1, 0.5], [2, 0.22, 0.3], [3.93, 0.1, 0.12], [9.2, 0.03, 0.04]],
  });

  // --- The effects -----------------------------------------------------------
  // db: RMS of the sounding part (dBFS), every take is normalised to it. Balanced
  // by ear-weighted loudness (scripts/render-sfx.js prints both).
  const EFFECTS = {
    // A card slides off the pile, its edge snips free.
    draw: {
      seconds: 0.12, db: -45.4,
      make(S) {
        const f = S.vary(2600, 0.08);
        S.noise({ at: 0, attack: 0.02, curve: 2, t60: 0.05, hp: 1200, bp: f, bpTo: f * 1.6, q: 0.9 });
        S.noise({ at: S.vary(0.034, 0.15), attack: 0.0004, t60: 0.009, bp: S.vary(5600, 0.1), q: 1.4, gain: 1.1 });
      },
    },
    // A card flicked onto the felt: a breath of air, then the slap.
    discard: {
      seconds: 0.13, db: -41.5,
      make(S) {
        S.noise({ at: 0, attack: 0.024, curve: 2, t60: 0.012, bp: 1900, q: 0.7, gain: 0.25 });
        slap(S, 0.028, { body: S.vary(560, 0.05) });
      },
    },
    // Laying out a meld: three cards in quick succession, the last one firm.
    meld: {
      seconds: 0.24, db: -41.6,
      make(S) {
        [620, 540, 600].forEach((body, i) => {
          const at = i * 0.068 + (i ? S.vary(0.006, 1) - 0.006 : 0);
          slap(S, at, { body: S.vary(body, 0.05), weight: [0.8, 0.75, 1][i], length: 0.7 });
        });
      },
    },
    // Round start: a riffle shuffle, the bridge cascading back, the deck squared.
    deal: {
      seconds: 1.12, db: -42.4,
      make(S) {
        const end = 0.64;
        S.noise({ at: 0.02, attack: 0.08, t60: 0.62, bp: 3000, q: 0.6, gain: 0.07 }); // the flutter under it
        for (let t = 0.02; t < end;) {
          const p = (t - 0.02) / (end - 0.02);
          flick(S, t, S.vary(0.55, 0.35) * (0.75 + 0.25 * Math.sin(Math.PI * p)));
          t += S.vary(1 / (55 + 40 * Math.sin(Math.PI * p)), 0.3);
        }
        S.noise({ at: 0.7, attack: 0.03, t60: 0.22, bp: 2300, bpTo: 1800, q: 0.8, gain: 0.09 });
        for (let i = 0, u = 0.7; i < 22; i++, u += S.vary(0.009, 0.25)) flick(S, u, 0.35 * (1 - i / 26));
        slap(S, 0.98, { body: 520, crack: 2800, weight: 0.9, length: 0.8 });
      },
    },
    // Your turn: two rising chimes (C5, E5), as ever. Its RMS is the old bell's:
    // the music levels hang on it (scripts/render-music.js).
    turn: {
      seconds: 0.5, db: -37.1719,
      make(S) {
        chime(S, 0, 523.25, 0.9, 0.55);
        chime(S, 0.09, 659.26, 1, 0.65);
      },
    },
    // Refused: two dull knocks going down.
    error: {
      seconds: 0.26, db: -41.2, hp: 300,
      make(S) {
        for (const [at, f, g] of [[0, 480, 1], [0.11, 400, 0.8]]) {
          S.noise({ at, attack: 0.0006, t60: 0.05, bp: f, q: 2.5, lp: 1500, gain: 3 * g });
          S.noise({ at, attack: 0.0003, t60: 0.004, hp: 1500, gain: 0.2 * g });
        }
      },
    },
    // Round end: the G major arpeggio, on a mallet.
    roundEnd: {
      seconds: 0.92, db: -36.7,
      make(S) {
        [392, 493.88, 587.33, 783.99].forEach((f, i) => mallet(S, i * 0.105, f, i === 3 ? 1 : 0.85));
      },
    },
    // A badge unlocked: a soft high chime (G5, D6).
    unlock: {
      seconds: 0.6, db: -40,
      make(S) {
        chime(S, 0, 783.99, 0.85, 0.8);
        chime(S, 0.15, 1174.66, 1, 0.9);
      },
    },
    // The Queen of Spades is ours: a brass "Tusch", ta-ta-ta-taaa.
    pikdame: {
      seconds: 1.02, db: -34.9,
      make(S) {
        for (let i = 0; i < 3; i++) S.brass({ at: i * 0.095, f: 392, len: 0.065, release: 0.05, bright: 3.5 });
        for (const [f, g] of [[392, 0.45], [523.25, 0.6], [659.26, 0.5], [783.99, 0.55]]) {
          S.brass({ at: 0.285, f: S.vary(f, 0.002), len: 0.48, release: 0.2, bright: 5, vib: 0.004, gain: g });
        }
        S.noise({ at: 0.285, attack: 0.001, t60: 0.14, bp: 3600, q: 0.8, hp: 1500, gain: 0.3 }); // snare
        S.noise({ at: 0.285, attack: 0.002, t60: 0.6, hp: 6500, gain: 0.08 }); // cymbal
      },
    },
    // Someone else secured her: a low "dun - dunnn" (on a phone through its overtones).
    pikdameLost: {
      seconds: 1.12, db: -33.8, hp: 280,
      make(S) {
        for (const [at, f, len, fade] of [[0, 164.81, 0.2, 0.5], [0.3, 155.56, 0.6, 1.2]]) {
          S.brass({ at, f, len, attack: 0.006, release: 0.25, bright: 3, scoop: 0.01, fade });
          S.brass({ at, f: f * 2, len, attack: 0.006, release: 0.25, bright: 2, scoop: 0.01, fade, gain: 0.35 });
          S.noise({ at, attack: 0.001, t60: 0.25, bp: 330, q: 2, gain: 1.6 });
          S.noise({ at, attack: 0.001, t60: 0.12, bp: 700, q: 2, gain: 0.6 });
        }
      },
    },
    // Caught holding her: the sad trombone, wah wah wah waaah.
    pikdameCaught: {
      seconds: 1.95, db: -35.4, hp: 340,
      make(S) {
        [293.66, 277.18, 261.63].forEach((f, i) => S.brass({
          at: i * 0.3, f, len: 0.25, attack: 0.03, release: 0.06, scoop: 0.02, droop: 0.02, wah: [320, 1600, 0], q: 2.4,
        }));
        S.brass({ at: 0.9, f: 246.94, len: 0.85, attack: 0.03, release: 0.14, scoop: 0.02, droop: 0.05, vib: 0.012, vibRate: 4.5, wah: [420, 1400, 4.5], q: 2.4 });
      },
    },
    // Glücksgriff: a quick harp run up and a sparkle.
    lucky: {
      seconds: 1.05, db: -35.8,
      make(S) {
        [523.25, 587.33, 659.26, 783.99, 880, 1046.5, 1174.66, 1318.51].forEach((f, i) => S.bell({
          at: i * 0.034, f, gain: 0.6 + 0.05 * i, partials: [[1, 1, 0.5], [2, 0.3, 0.25], [3, 0.08, 0.1]],
        }));
        for (const f of [1046.5, 1318.51, 1567.98]) chime(S, 0.29, f, 0.5, 1.1);
        for (let i = 0; i < 9; i++) S.bell({ at: 0.2 + 0.55 * S.rand(), f: S.vary(3600, 0.3), gain: 0.15, partials: [[1, 1, 0.07]] });
        S.noise({ at: 0, attack: 0.18, curve: 2, t60: 0.15, bp: 1800, bpTo: 6000, q: 0.9, gain: 0.08 });
      },
    },
  };
  const NAMES = Object.keys(EFFECTS);

  /** RMS between the first and the last sample above -40 dB of the peak. */
  function activeRms(x) {
    let peak = 0;
    for (let i = 0; i < x.length; i++) peak = Math.max(peak, Math.abs(x[i]));
    if (!peak) return 0;
    const floor = peak / 100;
    let a = 0;
    let b = x.length - 1;
    while (Math.abs(x[a]) < floor) a++;
    while (Math.abs(x[b]) < floor) b--;
    let sum = 0;
    for (let i = a; i <= b; i++) sum += x[i] * x[i];
    return Math.sqrt(sum / (b - a + 1));
  }

  /** One take of an effect (mono): normalised to its level, PEAK_MAX at most. */
  function render(name, sampleRate = 48000, { seed = 1 } = {}) {
    const fx = EFFECTS[name];
    if (!fx) throw new Error(`unknown sound effect: ${name}`);
    const S = new Score(sampleRate, fx.seconds, seed);
    fx.make(S);
    const out = S.out;
    // Nothing a phone speaker cannot play (no wasted excursion, no DC): 12 dB/octave, 24 with fx.hp.
    for (const f of fx.hp ? [fx.hp, fx.hp] : [180]) {
      const h = new Filter(sampleRate, f);
      for (let i = 0; i < out.length; i++) out[i] = h.hp(out[i]);
    }
    const fade = Math.min(out.length, Math.round(0.01 * sampleRate));
    for (let i = 0; i < fade; i++) out[out.length - 1 - i] *= i / fade;
    const rms = activeRms(out);
    let peak = 0;
    for (let i = 0; i < out.length; i++) peak = Math.max(peak, Math.abs(out[i]));
    const gain = rms ? Math.min(Math.pow(10, fx.db / 20) / rms, PEAK_MAX / peak) : 0;
    for (let i = 0; i < out.length; i++) out[i] *= gain;
    return out;
  }

  /** Plays a fresh take on a Web Audio context: volume 0..1, `when` on its clock.
   *  Returns its length in seconds. */
  function play(ctx, name, { volume = 1, when = 0 } = {}) {
    const samples = render(name, ctx.sampleRate, { seed: (Math.random() * 4294967296) >>> 0 });
    const buffer = ctx.createBuffer(1, samples.length, ctx.sampleRate);
    buffer.getChannelData(0).set(samples);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const gain = ctx.createGain();
    gain.gain.value = volume;
    src.connect(gain);
    gain.connect(ctx.destination);
    src.onended = () => { try { src.disconnect(); gain.disconnect(); } catch (e) { /* already gone */ } };
    src.start(when);
    return samples.length / ctx.sampleRate;
  }

  return { NAMES, EFFECTS, PEAK_MAX, render, play, activeRms };
}));
