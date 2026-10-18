#!/usr/bin/env node
'use strict';
// The background music, composed as code: renders 8-bar segments per track
// (A, A2, B, B2) plus an ending into public/music/ (MP3, content-hashed names)
// and writes public/music/manifest.json. Dev-only: needs ffmpeg with libmp3lame.
//
//   node scripts/render-music.js                 render everything
//   node scripts/render-music.js --levels        only recompute the levels (sound effects changed)
//   node scripts/render-music.js --preview DIR   2-3 min per track, as the player sequences it
//
// See docs/developer/music.md.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const SR = 44100;
const TAU = Math.PI * 2;
const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'public', 'music');
const MANIFEST = path.join(OUT_DIR, 'manifest.json');
const TAIL = 4; // seconds after the last bar: releases and reverb overlap the next segment
const TAIL_FADE = 1; // only the end of the tail fades, under the next segment's start
const PEAK = 0.8; // headroom: a tail still rings into the next segment's downbeat
// "Leise" sits this far below the in-game sound effects (RMS); Mittel/Laut add 6 dB each.
const LOW_BELOW_SFX_DB = 6;
const LEVEL_STEP_DB = 6;

const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
const dbToGain = (db) => Math.pow(10, db / 20);
const gainToDb = (g) => 20 * Math.log10(g);

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// Oscillator start phases: seeded, so an unchanged score renders to the same
// bytes and keeps its hash (players keep their cached files).
let phaseRng = mulberry32(1);

// ---------------------------------------------------------------- DSP
function makeFilter(mode) {
  let ic1 = 0, ic2 = 0;
  return (x, fc, Q = 0.707) => {
    const g = Math.tan(Math.PI * Math.min(Math.max(fc, 20), SR * 0.45) / SR);
    const k = 1 / Q;
    const a1 = 1 / (1 + g * (g + k)), a2 = g * a1, a3 = g * a2;
    const v3 = x - ic2;
    const v1 = a1 * ic1 + a2 * v3;
    const v2 = ic2 + a2 * ic1 + a3 * v3;
    ic1 = 2 * v1 - ic1; ic2 = 2 * v2 - ic2;
    if (mode === 'lp') return v2;
    if (mode === 'bp') return v1;
    return x - k * v1 - v2;
  };
}
function polyBlep(t, dt) {
  if (t < dt) { t /= dt; return t + t - t * t - 1; }
  if (t > 1 - dt) { t = (t - 1) / dt; return t * t + t + t + 1; }
  return 0;
}
function sawOsc() {
  let ph = phaseRng();
  return (f) => { const dt = f / SR; const v = 2 * ph - 1 - polyBlep(ph, dt); ph += dt; if (ph >= 1) ph -= 1; return v; };
}
function pulseOsc(duty = 0.5) {
  let ph = phaseRng();
  return (f) => {
    const dt = f / SR;
    let v = ph < duty ? 1 : -1;
    v += polyBlep(ph, dt);
    v -= polyBlep((ph + 1 - duty) % 1, dt);
    ph += dt; if (ph >= 1) ph -= 1;
    return v;
  };
}
function adsr(t, gate, a, d, s, r) {
  let v;
  if (t < a) v = t / a;
  else if (t < a + d) v = 1 - (1 - s) * ((t - a) / d);
  else v = s;
  if (t > gate) v *= Math.max(0, 1 - (t - gate) / r);
  return v;
}
const gateRel = (t, gate, r) => (t > gate ? Math.max(0, 1 - (t - gate) / r) : 1);

class Mix {
  constructor(seconds) {
    this.n = Math.ceil(seconds * SR);
    this.L = new Float32Array(this.n);
    this.R = new Float32Array(this.n);
    this.send = new Float32Array(this.n);
  }
  add(startSec, lenSec, gen, { gain = 1, pan = 0, send = 0.2 } = {}) {
    const s0 = Math.max(0, Math.round(startSec * SR));
    const len = Math.round(lenSec * SR);
    const ang = (pan + 1) * Math.PI / 4;
    const gl = gain * Math.cos(ang), gr = gain * Math.sin(ang), gs = gain * send;
    for (let i = 0; i < len; i++) {
      const idx = s0 + i;
      if (idx >= this.n) break;
      const v = gen(i / SR);
      this.L[idx] += v * gl; this.R[idx] += v * gr; this.send[idx] += v * gs;
    }
  }
}

// ---------------------------------------------------------------- instruments
const I = {
  epiano(mix, t0, dur, m, vel, o) {
    const f = mtof(m); let pc = 0, pm = 0, pb = 0;
    mix.add(t0, dur + 1.4, (t) => {
      pc += TAU * f / SR; pm += TAU * f / SR; pb += TAU * f * 14 / SR;
      const idx = 1.3 * Math.exp(-t * 2.8) + 0.18;
      const bell = Math.sin(pb) * 0.05 * Math.exp(-t * 16);
      const env = Math.min(1, t / 0.004) * Math.exp(-t * 1.0) * gateRel(t, dur, 0.3);
      return (Math.sin(pc + Math.sin(pm) * idx) + bell) * env * vel;
    }, o);
  },
  vibes(mix, t0, dur, m, vel, o) {
    const f = mtof(m); let p1 = 0, p2 = 0;
    mix.add(t0, dur + 2.2, (t) => {
      p1 += TAU * f / SR; p2 += TAU * f * 4 / SR;
      const trem = 1 - 0.22 * (0.5 + 0.5 * Math.sin(TAU * 5.0 * t));
      const env = Math.min(1, t / 0.003) * Math.exp(-t * 1.2) * gateRel(t, dur + 0.4, 0.8);
      return (Math.sin(p1) + 0.2 * Math.sin(p2) * Math.exp(-t * 7)) * env * trem * vel;
    }, o);
  },
  upright(mix, t0, dur, m, vel, o) {
    const f = mtof(m); let p = 0; const lp = makeFilter('lp');
    mix.add(t0, dur + 0.25, (t) => {
      p += TAU * f / SR;
      const x = Math.sin(p) + 0.5 * Math.sin(2 * p) * Math.exp(-t * 6) + 0.28 * Math.sin(3 * p) * Math.exp(-t * 11);
      const env = Math.min(1, t / 0.007) * Math.exp(-t * 1.8) * gateRel(t, dur, 0.09);
      return lp(x, 1100) * env * vel;
    }, o);
  },
  pluck(mix, t0, dur, m, vel, o, { bright = 0.5, decay = 0.997, ring = 1.6, seed = 1 } = {}) {
    // The two-point average delays half a sample: subtract it, or high notes go flat.
    const f = mtof(m); const N = Math.max(2, Math.round(SR / f - 0.5));
    const buf = new Float32Array(N); const rng = mulberry32((m * 7919 + Math.round(t0 * 997) + seed) | 0);
    let prev = 0;
    for (let i = 0; i < N; i++) { prev += bright * ((rng() * 2 - 1) - prev); buf[i] = prev; }
    let idx = 0;
    mix.add(t0, dur + ring, (t) => {
      const cur = buf[idx]; const nxt = buf[(idx + 1) % N];
      buf[idx] = decay * 0.5 * (cur + nxt);
      idx = (idx + 1) % N;
      return cur * gateRel(t, dur + ring * 0.6, ring * 0.4) * vel;
    }, o);
  },
  flute(mix, t0, dur, m, vel, o) {
    const f = mtof(m); let p = 0; const rng = mulberry32(m * 131 + Math.round(t0 * 101)); const bp = makeFilter('bp');
    mix.add(t0, dur + 0.3, (t) => {
      const vib = t > 0.22 ? 1 + 0.0055 * Math.sin(TAU * 5.1 * t) : 1;
      p += TAU * f * vib / SR;
      const breath = bp(rng() * 2 - 1, f * 2.2, 2.5) * 0.18 * Math.exp(-t * 3);
      const x = Math.sin(p) + 0.16 * Math.sin(2 * p) + 0.05 * Math.sin(3 * p) + breath;
      return x * adsr(t, dur, 0.06, 0.25, 0.82, 0.22) * vel;
    }, o);
  },
  chipLead(mix, t0, dur, m, vel, o) {
    const f = mtof(m); const osc = pulseOsc(0.25);
    mix.add(t0, dur + 0.05, (t) => {
      const vib = t > 0.2 ? 1 + 0.008 * Math.sin(TAU * 6 * t) : 1;
      const env = (t < dur ? (t < 0.25 ? 1 - t * 1.2 : 0.7) : Math.max(0, 0.7 - (t - dur) * 14));
      return osc(f * vib) * env * vel;
    }, o);
  },
  chipArp(mix, t0, dur, m, vel, o) {
    const f = mtof(m); const osc = pulseOsc(0.125);
    mix.add(t0, dur, (t) => osc(f) * Math.max(0, 1 - t / (dur * 1.05)) * vel, o);
  },
  chipBass(mix, t0, dur, m, vel, o) {
    const f = mtof(m); let ph = 0;
    mix.add(t0, dur + 0.02, (t) => {
      ph += f / SR; if (ph >= 1) ph -= 1;
      const tri = Math.round((4 * Math.abs(ph - 0.5) - 1) * 7.5) / 7.5; // 4-bit triangle
      return tri * (t < dur ? 1 : Math.max(0, 1 - (t - dur) * 50)) * vel;
    }, o);
  },
  meow(mix, t0, vel, o) {
    const osc = pulseOsc(0.3); const lp = makeFilter('lp');
    mix.add(t0, 0.75, (t) => {
      const f = t < 0.18 ? 620 + 520 * (t / 0.18) : 1140 - 600 * Math.min(1, (t - 0.18) / 0.5);
      const env = Math.min(1, t / 0.03) * Math.max(0, 1 - t / 0.75);
      return lp(osc(f), 2200, 2) * env * vel;
    }, o);
  },
};

// ---------------------------------------------------------------- drums
const D = {
  kick(mix, t0, vel, o) {
    let p = 0;
    mix.add(t0, 0.5, (t) => {
      const f = 58 + 90 * Math.exp(-t * 30); p += TAU * f / SR;
      return (Math.sin(p) * Math.exp(-t * 7) + (t < 0.003 ? (1 - t / 0.003) * 0.3 : 0)) * vel * 0.7;
    }, o);
  },
  snare(mix, t0, vel, o, soft = false) {
    const rng = mulberry32(Math.round(t0 * 7919) + 3); const bp = makeFilter('bp'); let p = 0;
    mix.add(t0, 0.4, (t) => {
      p += TAU * 185 / SR;
      const n = bp(rng() * 2 - 1, soft ? 2600 : 1900, soft ? 0.55 : 0.9);
      const env = (soft ? Math.min(1, t / 0.008) : 1) * Math.exp(-t * (soft ? 10 : 17));
      return (n * 1.7 + (soft ? 0.15 : 0.45) * Math.sin(p) * Math.exp(-t * 24)) * env * vel;
    }, o);
  },
  hat(mix, t0, vel, o, open = false) {
    const rng = mulberry32(Math.round(t0 * 4513) + 11); const hp = makeFilter('hp');
    mix.add(t0, open ? 0.45 : 0.09, (t) => hp(rng() * 2 - 1, 7200, 0.7) * Math.exp(-t * (open ? 9 : 52)) * vel, o);
  },
  shaker(mix, t0, vel, o) {
    const rng = mulberry32(Math.round(t0 * 3301) + 5); const bp = makeFilter('bp');
    mix.add(t0, 0.12, (t) => bp(rng() * 2 - 1, 5600, 0.8) * Math.min(1, t / 0.012) * Math.exp(-t * 30) * vel, o);
  },
  rim(mix, t0, vel, o) {
    let p = 0; const rng = mulberry32(Math.round(t0 * 2203)); const bp = makeFilter('bp');
    mix.add(t0, 0.08, (t) => { p += TAU * 1750 / SR; return (Math.sin(p) * 0.7 + bp(rng() * 2 - 1, 3500, 1.2)) * Math.exp(-t * 75) * vel; }, o);
  },
  chipNoise(mix, t0, vel, o, len = 0.06, rate = 11000) {
    const rng = mulberry32(Math.round(t0 * 991)); let held = 0, acc = 0;
    mix.add(t0, len, (t) => { acc += rate / SR; if (acc >= 1) { acc -= 1; held = rng() * 2 - 1; } return held * Math.max(0, 1 - t / len) * vel; }, o);
  },
  chipKick(mix, t0, vel, o) {
    let ph = 0;
    mix.add(t0, 0.14, (t) => { const f = 160 * Math.exp(-t * 18) + 40; ph += f / SR; if (ph >= 1) ph -= 1; return (4 * Math.abs(ph - 0.5) - 1) * Math.max(0, 1 - t / 0.14) * vel; }, o);
  },
};

// ---------------------------------------------------------------- reverb (Freeverb)
function freeverb(input, { room = 0.84, damp = 0.3 } = {}) {
  const combT = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617], apT = [556, 441, 341, 225], spread = 23;
  const mk = (n) => ({ buf: new Float32Array(n), i: 0, store: 0 });
  const cL = combT.map(mk), cR = combT.map((n) => mk(n + spread));
  const aL = apT.map(mk), aR = apT.map((n) => mk(n + spread));
  const oL = new Float32Array(input.length), oR = new Float32Array(input.length);
  const comb = (c, x) => { const y = c.buf[c.i]; c.store = y * (1 - damp) + c.store * damp; c.buf[c.i] = x + c.store * room; if (++c.i >= c.buf.length) c.i = 0; return y; };
  const ap = (a, x) => { const b = a.buf[a.i]; const y = -x + b; a.buf[a.i] = x + b * 0.5; if (++a.i >= a.buf.length) a.i = 0; return y; };
  for (let s = 0; s < input.length; s++) {
    const x = input[s] * 0.015;
    let l = 0, r = 0;
    for (const c of cL) l += comb(c, x);
    for (const c of cR) r += comb(c, x);
    for (const a of aL) l = ap(a, l);
    for (const a of aR) r = ap(a, r);
    oL[s] = l; oR[s] = r;
  }
  return { L: oL, R: oR };
}

// ---------------------------------------------------------------- song helpers
function song({ bpm, bars, swing = 0.5, tail = TAIL, seed = 1 }) {
  const beat = 60 / bpm, bar = beat * 4;
  const mix = new Mix(bars * bar + tail);
  const rng = mulberry32(seed);
  const hum = (s = 0.004) => (rng() * 2 - 1) * s;
  const vel = (v, s = 0.07) => v * (1 + (rng() * 2 - 1) * s);
  const t8 = (b, e) => b * bar + Math.floor(e / 2) * beat + (e % 2 ? swing * beat : 0);
  const t16 = (b, s) => b * bar + s * beat / 4;
  return { mix, beat, bar, bars, length: bars * bar, t8, t16, hum, vel };
}

/** Reverb, optional lowpass and the 38 Hz high-pass; the level stage follows per track. */
function premaster(mix, { wet = 1.4, lowpass = 0 } = {}) {
  const rv = freeverb(mix.send);
  const n = mix.n; const L = new Float32Array(n), R = new Float32Array(n);
  const lpL = makeFilter('lp'), lpR = makeFilter('lp');
  const hp1L = makeFilter('hp'), hp1R = makeFilter('hp'), hp2L = makeFilter('hp'), hp2R = makeFilter('hp');
  let peak = 0;
  for (let i = 0; i < n; i++) {
    let l = mix.L[i] + rv.L[i] * wet, r = mix.R[i] + rv.R[i] * wet;
    if (lowpass) { l = lpL(l, lowpass); r = lpR(r, lowpass); }
    L[i] = hp2L(hp1L(l, 38), 38); R[i] = hp2R(hp1R(r, 38), 38);
    peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
  }
  return { L, R, peak };
}

/** One gain for the whole track (its loudest segment), then the soft clip. */
function finish({ L, R }, pre, drive, fadeSec) {
  const n = L.length; const norm = Math.tanh(drive);
  const fadeN = Math.round(fadeSec * SR);
  for (let i = 0; i < n; i++) {
    const left = n - i;
    const g = left < fadeN ? 0.5 - 0.5 * Math.cos(Math.PI * left / fadeN) : 1;
    L[i] = Math.tanh(L[i] * pre * drive) / norm * PEAK * g;
    R[i] = Math.tanh(R[i] * pre * drive) / norm * PEAK * g;
  }
  return { L, R };
}

function vinyl(mix, seconds, seed, fadeOut = 0) {
  const rng = mulberry32(seed); const hp = makeFilter('hp'); let pop = 0;
  mix.add(0, seconds, (t) => {
    if (rng() < 0.00006) pop = (rng() * 2 - 1) * 0.5; else pop *= 0.92;
    const f = fadeOut ? Math.max(0, Math.min(1, (seconds - t) / fadeOut)) : 1;
    return (hp(rng() * 2 - 1, 3000) * 0.008 + pop) * f;
  }, { gain: 0.25, send: 0 });
}

const split = (CH, p) => [CH[Array.isArray(p) ? p[0] : p], CH[Array.isArray(p) ? p[1] : p]];

// ---------------------------------------------------------------- 1: Kaffeehaus
// Lo-fi jazz in F, swung: Rhodes, vibraphone, upright bass, brushes, vinyl.
// A: | Fmaj9 | Dm9 | Gm9 | C13 | Am9 | D13 | Gm9 | C13 |
// B: | Bbmaj9 | Bbm6 | Am9 | D13b9 | Gm9 | C13 | Fmaj9 | C13 |  (the bridge)
const KH_PROG_A = [
  { v: [57, 60, 64, 67], walk: [41, 45, 48, 49] },
  { v: [53, 57, 60, 64], walk: [50, 48, 45, 44] },
  { v: [58, 62, 65, 69], walk: [43, 46, 50, 47] },
  { v: [58, 62, 64, 69], walk: [48, 46, 43, 44] },
  { v: [60, 64, 67, 71], walk: [45, 48, 52, 49] },
  { v: [60, 64, 66, 71], walk: [50, 48, 45, 44] },
  { v: [58, 62, 65, 69], walk: [43, 46, 50, 49] },
  { v: [58, 62, 64, 69], walk: [48, 46, 43, 40] },
];
const KH_PROG_B = [
  { v: [57, 60, 62, 65], walk: [46, 50, 53, 50] },
  { v: [61, 65, 67, 70], walk: [46, 53, 49, 46] },
  { v: [60, 64, 67, 71], walk: [45, 48, 52, 51] },
  { v: [60, 63, 66, 71], walk: [50, 48, 45, 44] },
  { v: [58, 62, 65, 69], walk: [43, 46, 50, 47] },
  { v: [58, 62, 64, 69], walk: [48, 46, 43, 40] },
  { v: [57, 60, 64, 67], walk: [41, 45, 43, 47] },
  { v: [58, 62, 64, 69], walk: [48, 46, 43, 40] },
];
// Melody notes: [eighth, midi, length in eighths].
const KH_MEL_A = [
  [[2, 69, 1], [3, 72, 1], [4, 76, 2], [6, 74, 2]],
  [[0, 72, 3], [3, 69, 1], [4, 65, 2], [6, 69, 2]],
  [[0, 70, 2], [2, 74, 1], [3, 77, 1], [4, 76, 2], [6, 74, 1], [7, 72, 1]],
  [[0, 70, 3], [3, 67, 1], [4, 64, 4]],
  [[2, 76, 1], [3, 79, 1], [4, 76, 2], [6, 72, 2]],
  [[0, 74, 2], [2, 78, 1], [3, 76, 1], [4, 72, 2], [6, 69, 2]],
  [[0, 70, 2], [2, 69, 1], [3, 67, 1], [4, 65, 2], [6, 67, 1], [7, 69, 1]],
  [[0, 70, 2], [2, 69, 2], [4, 67, 4]],
];
const KH_MEL_A2 = KH_MEL_A.slice(0, 6).concat([
  [[0, 70, 2], [2, 74, 2], [4, 77, 2], [6, 76, 2]],
  [[0, 74, 2], [2, 70, 2], [4, 72, 4]],
]);
const KH_MEL_B = [
  [[0, 74, 3], [3, 72, 1], [4, 69, 2], [6, 65, 2]],
  [[0, 73, 3], [3, 70, 1], [4, 67, 2], [6, 65, 2]],
  [[0, 64, 2], [2, 67, 1], [3, 71, 1], [4, 72, 2], [6, 69, 2]],
  [[0, 66, 3], [3, 69, 1], [4, 72, 2], [6, 75, 1], [7, 74, 1]],
  [[0, 74, 2], [2, 70, 2], [4, 69, 2], [6, 67, 2]],
  [[0, 69, 1], [1, 70, 1], [2, 72, 2], [4, 76, 2], [6, 74, 2]],
  [[0, 72, 3], [3, 69, 1], [4, 65, 4]],
  [[2, 67, 1], [3, 69, 1], [4, 70, 2], [6, 72, 2]],
];
const KH_MEL_B2 = [
  [[0, 74, 1], [1, 76, 1], [2, 77, 1], [3, 74, 1], [4, 72, 2], [6, 69, 2]],
  [[0, 73, 2], [2, 70, 1], [3, 72, 1], [4, 73, 2], [6, 77, 2]],
  [[0, 76, 2], [2, 72, 1], [3, 71, 1], [4, 69, 2], [6, 67, 2]],
  [[0, 66, 1], [1, 69, 1], [2, 72, 1], [3, 75, 1], [4, 74, 2], [6, 72, 2]],
  [[0, 70, 3], [3, 74, 1], [4, 77, 2], [6, 74, 2]],
  [[0, 76, 2], [2, 72, 2], [4, 70, 2], [6, 69, 2]],
  [[0, 67, 2], [2, 69, 1], [3, 72, 1], [4, 76, 4]],
  [[0, 74, 3], [3, 72, 1], [4, 70, 2], [6, 69, 2]],
];

function kaffeehaus(S, prog, mel, { light = false, seed }) {
  const { mix, t8, beat, hum, vel } = S;
  for (let b = 0; b < 8; b++) {
    const c = prog[b];
    for (const [e, d] of [[0, 3], [5, 3]]) for (const m of c.v) I.epiano(mix, t8(b, e) + hum(0.006), d * beat / 2, m, vel(e ? 0.15 : 0.19), { pan: -0.25, send: 0.28 });
    c.walk.forEach((m, k) => I.upright(mix, t8(b, k * 2) + hum(), beat * 0.85, m, vel(0.85), { pan: 0, send: 0.04 }));
    for (const [e, m, d] of mel[b]) I.vibes(mix, t8(b, e) + hum(), d * beat / 2 * 0.9, m, vel(0.42), { pan: 0.25, send: 0.38 });
    // The light bridge keeps one kick and the quarter-note hats: same groove, more air.
    D.kick(mix, t8(b, 0), vel(light ? 0.6 : 0.75), { send: 0.02 });
    if (!light) {
      D.kick(mix, t8(b, 3), vel(0.35), { send: 0.02 });
      D.kick(mix, t8(b, 5), vel(0.55), { send: 0.02 });
    }
    D.snare(mix, t8(b, 2) + hum(0.008), vel(0.22), { pan: 0.05, send: 0.2 }, true);
    D.snare(mix, t8(b, 6) + hum(0.008), vel(0.24), { pan: 0.05, send: 0.2 }, true);
    for (let e = 0; e < 8; e += light ? 2 : 1) D.hat(mix, t8(b, e) + hum(0.005), vel(e % 2 ? 0.07 : light ? 0.09 : 0.11), { pan: 0.35, send: 0.05 });
  }
  vinyl(mix, S.length, seed);
}
function kaffeehausEnd(S, { seed }) {
  const { mix } = S;
  for (const m of [57, 60, 64, 67, 72]) I.epiano(mix, 0, 2.5, m, 0.17, { pan: -0.25, send: 0.35 });
  I.upright(mix, 0, 1.8, 41, 0.85, { send: 0.04 });
  I.vibes(mix, 0.02, 2.5, 69, 0.4, { pan: 0.25, send: 0.45 });
  vinyl(mix, mix.n / SR, seed, 3);
}

// ---------------------------------------------------------------- 2: Lounge-Bossa
// D major, straight eighths: nylon guitar (Karplus-Strong), flute, shaker, rim.
// A: | Dmaj7 | Bm7 | Em7 | A7 | Dmaj7 | Bm7 | Em7 A7 | Dmaj7 |
// B: | Gmaj7 | Gm6 | F#m7 | B7 | Em7 | A7 | Dmaj7 | A7 |
const LB_CH = {
  Dmaj7: { c: [54, 57, 61, 64], r: 38, f: 45 },
  Bm7: { c: [57, 62, 66, 69], r: 47, f: 42 },
  Em7: { c: [55, 59, 62, 66], r: 40, f: 47 },
  A7: { c: [55, 61, 64, 66], r: 45, f: 40 },
  Gmaj7: { c: [59, 62, 66, 69], r: 43, f: 50 },
  Gm6: { c: [58, 62, 64, 67], r: 43, f: 50 },
  'F#m7': { c: [57, 61, 64, 66], r: 42, f: 49 },
  B7: { c: [57, 63, 66, 68], r: 47, f: 42 },
};
const LB_PROG_A = ['Dmaj7', 'Bm7', 'Em7', 'A7', 'Dmaj7', 'Bm7', ['Em7', 'A7'], 'Dmaj7'];
const LB_PROG_B = ['Gmaj7', 'Gm6', 'F#m7', 'B7', 'Em7', 'A7', 'Dmaj7', 'A7'];
const LB_MEL_A = [
  [[0, 78, 3], [3, 76, 1], [4, 73, 4]],
  [[0, 74, 3], [3, 71, 1], [4, 69, 4]],
  [[0, 67, 2], [2, 71, 2], [4, 74, 2], [6, 78, 2]],
  [[0, 76, 6], [6, 73, 2]],
  [[0, 78, 3], [3, 81, 1], [4, 78, 2], [6, 76, 2]],
  [[0, 74, 3], [3, 73, 1], [4, 71, 4]],
  [[0, 79, 2], [2, 78, 2], [4, 76, 2], [6, 73, 2]],
  [[0, 74, 8]],
];
const LB_MEL_A2 = LB_MEL_A.slice(0, 4).concat([
  [[0, 81, 3], [3, 78, 1], [4, 76, 2], [6, 73, 2]],
  [[0, 74, 2], [2, 76, 1], [3, 78, 1], [4, 74, 4]],
  [[0, 71, 2], [2, 74, 2], [4, 73, 2], [6, 76, 2]],
  [[0, 78, 6], [6, 76, 1], [7, 73, 1]],
]);
const LB_MEL_B = [
  [[0, 74, 3], [3, 78, 1], [4, 81, 4]],
  [[0, 79, 3], [3, 76, 1], [4, 74, 4]],
  [[0, 73, 2], [2, 76, 2], [4, 78, 2], [6, 81, 2]],
  [[0, 80, 4], [4, 78, 2], [6, 75, 2]],
  [[0, 79, 3], [3, 78, 1], [4, 76, 2], [6, 74, 2]],
  [[0, 73, 3], [3, 76, 1], [4, 79, 4]],
  [[0, 78, 6], [6, 76, 2]],
  [[0, 73, 4], [4, 69, 2], [6, 76, 2]],
];
// B2: the guitar takes the bridge, syncopated; the flute rests.
const LB_MEL_B2 = [
  [[0, 74, 1], [1, 78, 1], [3, 81, 2], [6, 78, 2]],
  [[0, 79, 2], [3, 76, 1], [4, 74, 2], [6, 70, 2]],
  [[1, 73, 1], [2, 76, 2], [5, 78, 1], [6, 81, 2]],
  [[0, 80, 2], [3, 78, 1], [4, 75, 2], [6, 71, 2]],
  [[0, 79, 2], [3, 78, 1], [4, 76, 1], [5, 74, 1], [6, 71, 2]],
  [[1, 73, 1], [2, 76, 2], [5, 79, 1], [6, 76, 2]],
  [[0, 78, 3], [3, 76, 1], [4, 73, 4]],
  [[0, 76, 2], [2, 73, 2], [4, 69, 2], [6, 73, 2]],
];

function loungeStrum(S, t, notes, v) {
  notes.forEach((m, k) => I.pluck(S.mix, t + k * 0.012, 0.2, m, S.vel(v), { pan: -0.2, send: 0.25 }, { bright: 0.42, decay: 0.997, ring: 0.9, seed: k }));
}
function lounge(S, prog, mel, { guitar = false } = {}) {
  const { mix, t8, t16, beat, hum, vel } = S;
  for (let b = 0; b < 8; b++) {
    const [c1, c2] = split(LB_CH, prog[b]);
    I.pluck(mix, t16(b, 0), 0.5, c1.r, vel(0.8), { pan: -0.1, send: 0.12 }, { bright: 0.3, decay: 0.998, ring: 1.0 });
    I.pluck(mix, t16(b, 6), 0.4, c1.f, vel(0.55), { pan: -0.1, send: 0.12 }, { bright: 0.3, decay: 0.998, ring: 0.8 });
    I.pluck(mix, t16(b, 8), 0.5, c2.r, vel(0.75), { pan: -0.1, send: 0.12 }, { bright: 0.3, decay: 0.998, ring: 1.0 });
    I.pluck(mix, t16(b, 14), 0.4, c2.f, vel(0.5), { pan: -0.1, send: 0.12 }, { bright: 0.3, decay: 0.998, ring: 0.8 });
    for (const s of [2, 5]) loungeStrum(S, t16(b, s), c1.c, 0.32);
    for (const s of [9, 12]) loungeStrum(S, t16(b, s), c2.c, 0.32);
    for (const [e, m, d] of mel[b]) {
      if (guitar) I.pluck(mix, t8(b, e) + hum(0.004), 0.3, m, vel(0.5), { pan: 0.2, send: 0.32 }, { bright: 0.55, decay: 0.996, ring: 1.0, seed: 7 });
      else I.flute(mix, t8(b, e) + hum(0.006), d * beat / 2 * 0.95, m, vel(0.38, 0.04), { pan: 0.25, send: 0.4 });
    }
    for (let s = 0; s < 16; s++) D.shaker(mix, t16(b, s) + hum(0.003), vel(s % 2 ? 0.07 : 0.12), { pan: 0.4, send: 0.04 });
    for (const s of (b % 2 ? [4, 10] : [0, 6, 12])) D.rim(mix, t16(b, s), vel(0.18), { pan: -0.35, send: 0.15 });
    D.kick(mix, t16(b, 0), vel(0.4), { send: 0.02 });
    D.kick(mix, t16(b, 8), vel(0.35), { send: 0.02 });
  }
}
function loungeEnd(S) {
  const { mix } = S;
  I.pluck(mix, 0, 1.0, 38, 0.8, { send: 0.15 }, { bright: 0.3, decay: 0.999, ring: 2.0 });
  loungeStrum(S, 0.03, [54, 57, 61, 64, 69], 0.35);
  I.flute(mix, 0, 2.2, 74, 0.32, { pan: 0.25, send: 0.5 });
}

// ---------------------------------------------------------------- 3: Kaetzchen
// Cozy chiptune in C: 25 % pulse lead, 12.5 % arpeggio, 4-bit triangle bass, a meow.
// A: | C | Am | F | G | C | Am | Dm G | C |    B: | F | G | Em | Am | Dm | G | C | G |
const KC_CH = {
  C: { arp: [60, 64, 67, 72], bass: 48 }, Am: { arp: [57, 60, 64, 69], bass: 45 },
  F: { arp: [53, 57, 60, 65], bass: 41 }, G: { arp: [55, 59, 62, 67], bass: 43 },
  Dm: { arp: [50, 53, 57, 62], bass: 50 }, Em: { arp: [52, 55, 59, 64], bass: 40 },
};
const KC_PROG_A = ['C', 'Am', 'F', 'G', 'C', 'Am', ['Dm', 'G'], 'C'];
const KC_PROG_B = ['F', 'G', 'Em', 'Am', 'Dm', 'G', 'C', 'G'];
const KC_MEL_A = [
  [[0, 76, 1], [1, 79, 1], [2, 76, 2], [4, 72, 1], [5, 74, 1], [6, 76, 2]],
  [[0, 81, 2], [2, 79, 1], [3, 76, 1], [4, 72, 4]],
  [[0, 77, 1], [1, 81, 1], [2, 77, 2], [4, 72, 1], [5, 74, 1], [6, 77, 2]],
  [[0, 79, 3], [3, 77, 1], [4, 76, 2], [6, 74, 2]],
  [[0, 76, 1], [1, 79, 1], [2, 76, 2], [4, 84, 2], [6, 83, 1], [7, 81, 1]],
  [[0, 79, 2], [2, 76, 2], [4, 81, 2], [6, 79, 2]],
  [[0, 77, 2], [2, 74, 2], [4, 71, 2], [6, 74, 2]],
  [[0, 72, 4], [6, 67, 1], [7, 71, 1]],
];
const KC_MEL_B = [
  [[0, 77, 2], [2, 81, 2], [4, 84, 3], [7, 81, 1]],
  [[0, 79, 2], [2, 83, 2], [4, 86, 2], [6, 83, 2]],
  [[0, 83, 3], [3, 79, 1], [4, 76, 4]],
  [[0, 81, 2], [2, 79, 1], [3, 76, 1], [4, 72, 2], [6, 76, 2]],
  [[0, 77, 2], [2, 74, 2], [4, 81, 2], [6, 77, 2]],
  [[0, 79, 1], [1, 81, 1], [2, 83, 2], [4, 86, 2], [6, 83, 2]],
  [[0, 84, 3], [3, 79, 1], [4, 76, 2], [6, 79, 2]],
  [[0, 79, 2], [2, 77, 2], [4, 74, 2], [6, 71, 2]],
];
const KC_MEL_B2 = [
  [[0, 72, 1], [1, 77, 1], [2, 81, 1], [3, 84, 1], [4, 81, 2], [6, 77, 2]],
  [[0, 74, 1], [1, 79, 1], [2, 83, 1], [3, 86, 1], [4, 83, 2], [6, 79, 2]],
  [[0, 76, 2], [2, 79, 2], [4, 83, 2], [6, 79, 2]],
  [[0, 81, 3], [3, 79, 1], [4, 76, 2], [6, 72, 2]],
  [[0, 74, 1], [1, 77, 1], [2, 81, 1], [3, 86, 1], [4, 84, 2], [6, 81, 2]],
  [[0, 83, 2], [2, 79, 2], [4, 77, 2], [6, 74, 2]],
  [[0, 76, 2], [2, 79, 2], [4, 84, 4]],
  [[0, 83, 2], [2, 81, 1], [3, 79, 1], [4, 77, 2]],
];
const UP_DOWN = [0, 1, 2, 3, 2, 1, 0, 1];

function kaetzchen(S, prog, mel, { echo = false, upDown = false, meow = false } = {}) {
  const { mix, t8, t16, beat } = S;
  for (let b = 0; b < 8; b++) {
    const [c1, c2] = split(KC_CH, prog[b]);
    for (let s = 0; s < 16; s++) {
      const c = s < 8 ? c1 : c2;
      I.chipArp(mix, t16(b, s), beat / 4 * 0.9, c.arp[upDown ? UP_DOWN[s % 8] : s % 4] + 12, 0.07, { pan: -0.3, send: 0.12 });
    }
    for (let e = 0; e < 8; e++) { const c = e < 4 ? c1 : c2; I.chipBass(mix, t8(b, e), beat / 2 * 0.7, c.bass + (e % 2 ? 12 : 0), 0.32, { send: 0.03 }); }
    for (const [e, m, d] of mel[b]) {
      I.chipLead(mix, t8(b, e), d * beat / 2 * 0.85, m, 0.16, { pan: 0.1, send: 0.2 });
      if (echo) I.chipLead(mix, t8(b, e) + beat * 0.75, d * beat / 2 * 0.85, m, 0.06, { pan: 0.45, send: 0.25 });
    }
    D.chipKick(mix, t8(b, 0), 0.45, {});
    D.chipKick(mix, t8(b, 4), 0.4, {});
    D.chipNoise(mix, t8(b, 2), 0.16, { send: 0.08 }, 0.12, 6000);
    D.chipNoise(mix, t8(b, 6), 0.16, { send: 0.08 }, 0.12, 6000);
    for (let e = 1; e < 8; e += 2) D.chipNoise(mix, t8(b, e), 0.05, { pan: 0.3 }, 0.03, 16000);
  }
  if (meow) I.meow(mix, t8(7, 5), 0.12, { pan: 0.1, send: 0.3 });
}
function kaetzchenEnd(S) {
  const { mix } = S;
  I.chipBass(mix, 0, 1.0, 48, 0.32, {});
  for (const [k, m] of [72, 76, 79, 84].entries()) I.chipArp(mix, k * 0.08, 0.6, m, 0.08, { send: 0.2 });
  I.meow(mix, 0.7, 0.22, { pan: 0.1, send: 0.3 });
}

// ---------------------------------------------------------------- the tracks
// Ids are the player's contract (settings, storage); roles drive its A A B A form.
const TRACKS = [
  {
    id: 'kaffeehaus', bpm: 84, swing: 0.62, seed: 11, master: { wet: 1.3, lowpass: 9000, drive: 1.25 },
    segments: [
      { id: 'a', role: 'A', bars: 8, draw: (S, o) => kaffeehaus(S, KH_PROG_A, KH_MEL_A, o) },
      { id: 'a2', role: 'A', bars: 8, draw: (S, o) => kaffeehaus(S, KH_PROG_A, KH_MEL_A2, o) },
      { id: 'b', role: 'B', bars: 8, draw: (S, o) => kaffeehaus(S, KH_PROG_B, KH_MEL_B, o) },
      { id: 'b2', role: 'B', bars: 8, draw: (S, o) => kaffeehaus(S, KH_PROG_B, KH_MEL_B2, { ...o, light: true }) },
      { id: 'end', role: 'END', bars: 1, tail: 4.5, draw: kaffeehausEnd },
    ],
  },
  {
    id: 'lounge', bpm: 126, swing: 0.5, seed: 44, master: { wet: 1.4, drive: 1.1 },
    segments: [
      { id: 'a', role: 'A', bars: 8, draw: (S) => lounge(S, LB_PROG_A, LB_MEL_A) },
      { id: 'a2', role: 'A', bars: 8, draw: (S) => lounge(S, LB_PROG_A, LB_MEL_A2) },
      { id: 'b', role: 'B', bars: 8, draw: (S) => lounge(S, LB_PROG_B, LB_MEL_B) },
      { id: 'b2', role: 'B', bars: 8, draw: (S) => lounge(S, LB_PROG_B, LB_MEL_B2, { guitar: true }) },
      { id: 'end', role: 'END', bars: 1, tail: 5, draw: loungeEnd },
    ],
  },
  {
    id: 'kaetzchen', bpm: 96, swing: 0.5, seed: 55, master: { wet: 1.1, drive: 1.1 },
    segments: [
      { id: 'a', role: 'A', bars: 8, draw: (S) => kaetzchen(S, KC_PROG_A, KC_MEL_A) },
      { id: 'a2', role: 'A', bars: 8, draw: (S) => kaetzchen(S, KC_PROG_A, KC_MEL_A, { echo: true }) },
      { id: 'b', role: 'B', bars: 8, draw: (S) => kaetzchen(S, KC_PROG_B, KC_MEL_B) },
      { id: 'b2', role: 'B', bars: 8, draw: (S) => kaetzchen(S, KC_PROG_B, KC_MEL_B2, { echo: true, upDown: true, meow: true }) },
      { id: 'end', role: 'END', bars: 1, tail: 4, draw: kaetzchenEnd },
    ],
  },
];

function renderTrack(def) {
  const parts = def.segments.map((seg, i) => {
    const seed = def.seed * 100 + i + 1;
    phaseRng = mulberry32(seed);
    const tail = seg.tail || TAIL;
    const S = song({ bpm: def.bpm, bars: seg.bars, swing: def.swing, tail, seed });
    seg.draw(S, { seed });
    return { seg, seconds: S.length, tail, pm: premaster(S.mix, def.master) };
  });
  const pre = 1 / Math.max(...parts.map((p) => p.pm.peak));
  for (const p of parts) p.out = finish(p.pm, pre, def.master.drive, p.seg.role === 'END' ? 2 : TAIL_FADE);
  return parts;
}

/** Mean power over the musical part of the A/B segments (the tail belongs to the next one). */
function trackPower(parts) {
  let sum = 0, n = 0;
  for (const p of parts) {
    if (p.seg.role === 'END') continue;
    const len = Math.round(p.seconds * SR);
    for (let i = 0; i < len; i++) sum += (p.out.L[i] * p.out.L[i] + p.out.R[i] * p.out.R[i]) / 2;
    n += len;
  }
  return sum / n;
}

// ---------------------------------------------------------------- the reference: our sound effects
const SFX_RE = /(\w+): \(\) => \{ playTone\(\[([\d.,\s]+)\], (\d+), '(\w+)', ([\d.]+)\)/g;

/** RMS of one playTone() call, envelope as in client.js (10 ms attack, exponential decay). */
function toneRms(freqs, ms, type, gain) {
  const noteLen = ms / 1000 / freqs.length;
  const n = Math.round(ms / 1000 * SR);
  let sum = 0;
  for (let s = 0; s < n; s++) {
    const t = s / SR;
    const i = Math.min(freqs.length - 1, Math.floor(t / noteLen));
    const tn = t - i * noteLen;
    const env = tn < 0.01 ? gain * tn / 0.01 : gain * Math.pow(0.0001 / gain, (tn - 0.01) / (noteLen - 0.01));
    const ph = (freqs[i] * tn) % 1;
    const w = type === 'sine' ? Math.sin(TAU * ph)
      : type === 'square' ? (ph < 0.5 ? 1 : -1)
        : type === 'sawtooth' ? 2 * ph - 1
          : 1 - 4 * Math.abs(ph - 0.5);
    sum += (w * env) ** 2;
  }
  return Math.sqrt(sum / n);
}

/** Median RMS of the game's sound effects, read from client.js itself. */
function sfxReference(clientSrc) {
  const list = [...clientSrc.matchAll(SFX_RE)].map((m) => ({
    name: m[1], rms: toneRms(m[2].split(',').map(Number), Number(m[3]), m[4], Number(m[5])),
  }));
  if (list.length < 3) throw new Error('sound effects not found in client.js (SFX_RE)');
  const sorted = list.map((x) => x.rms).sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return { median, list };
}

/** Level gains from the reference and the (trimmed) music RMS. */
function levelGains(sfxRms, musicRms) {
  const low = sfxRms * dbToGain(-LOW_BELOW_SFX_DB) / musicRms;
  const round = (g) => Math.round(Math.min(1, g) * 10000) / 10000;
  return { low: round(low), mid: round(low * dbToGain(LEVEL_STEP_DB)), high: round(low * dbToGain(2 * LEVEL_STEP_DB)) };
}

// ---------------------------------------------------------------- files
function wavBuffer({ L, R }) {
  const n = L.length; const buf = Buffer.alloc(44 + n * 4);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 4, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(L[i] * 32767))), 44 + i * 4);
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(R[i] * 32767))), 46 + i * 4);
  }
  return buf;
}

/** WAV -> MP3 (LAME VBR). bitexact keeps encoder version strings out of the bytes. */
function encodeMp3(wav, quality) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pikdame-music-'));
  try {
    const src = path.join(tmp, 'in.wav'); const dst = path.join(tmp, 'out.mp3');
    fs.writeFileSync(src, wav);
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', src, '-c:a', 'libmp3lame', '-q:a', String(quality),
      '-map_metadata', '-1', '-id3v2_version', '0', '-write_id3v1', '0', '-fflags', '+bitexact', '-flags:a', '+bitexact', dst]);
    return fs.readFileSync(dst);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const hashOf = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 8);
const round3 = (x) => Math.round(x * 1e3) / 1e3;
const round6 = (x) => Math.round(x * 1e6) / 1e6;

function render({ quality = 6 } = {}) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const sfx = sfxReference(fs.readFileSync(path.join(ROOT, 'public', 'client.js'), 'utf8'));
  const rendered = TRACKS.map((def) => {
    const t0 = Date.now();
    const parts = renderTrack(def);
    const rms = Math.sqrt(trackPower(parts));
    console.log(`${def.id}: rendered in ${Date.now() - t0} ms, rms ${gainToDb(rms).toFixed(1)} dBFS`);
    return { def, parts, rms };
  });
  // Tracks meet at the quietest one: trims only cut, so nothing can clip.
  const common = Math.min(...rendered.map((r) => r.rms));
  const manifest = {
    version: 1,
    sfxRms: round6(sfx.median),
    lowBelowSfxDb: LOW_BELOW_SFX_DB,
    musicRms: round6(common),
    levels: levelGains(sfx.median, common),
    tracks: [],
  };
  const keep = new Set();
  for (const { def, parts, rms } of rendered) {
    const track = { id: def.id, bpm: def.bpm, trimDb: round3(gainToDb(common / rms)), segments: [] };
    for (const p of parts) {
      const mp3 = encodeMp3(wavBuffer(p.out), quality);
      const file = `${def.id}-${p.seg.id}.${hashOf(mp3)}.mp3`;
      fs.writeFileSync(path.join(OUT_DIR, file), mp3);
      keep.add(file);
      track.segments.push({
        id: p.seg.id, role: p.seg.role, bars: p.seg.bars,
        seconds: round6(p.seconds), duration: round6(p.seconds + p.tail), file, bytes: mp3.length,
      });
      console.log(`  ${file}  ${(mp3.length / 1024).toFixed(0)} KB`);
    }
    manifest.tracks.push(track);
  }
  for (const f of fs.readdirSync(OUT_DIR)) {
    if (f.endsWith('.mp3') && !keep.has(f)) fs.unlinkSync(path.join(OUT_DIR, f));
  }
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
  const total = manifest.tracks.reduce((s, t) => s + t.segments.reduce((a, x) => a + x.bytes, 0), 0);
  console.log(`levels ${JSON.stringify(manifest.levels)}, sfx ${gainToDb(sfx.median).toFixed(1)} dBFS, total ${(total / 1024 / 1024).toFixed(2)} MB`);
  return manifest;
}

// ---------------------------------------------------------------- previews
function decodeMp3(file) {
  const raw = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file, '-f', 'f32le', '-ac', '2', '-ar', String(SR), '-'],
    { maxBuffer: 1 << 28 });
  return new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4);
}

/** Mixes each track like the player does: segment k starts at the sum of the
 *  musical lengths before it, tails overlap, the ending follows after ~2 min. */
function preview(dir, { seed = 7 } = {}) {
  const { createSequencer } = require('../public/music-player.js');
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  fs.mkdirSync(dir, { recursive: true });
  const out = [];
  for (const track of manifest.tracks) {
    const seq = createSequencer(manifest, { choice: 'mix', startTrack: track.id, random: mulberry32(seed) });
    const plan = [];
    let at = 0;
    for (;;) {
      const ev = seq.next();
      if (ev.kind !== 'segment' || ev.track !== track.id) break;
      plan.push({ at, seg: ev.segment });
      at += ev.segment.seconds;
      if (ev.segment.role === 'END') break;
    }
    const last = plan[plan.length - 1];
    const n = Math.ceil((last.at + last.seg.duration + 0.5) * SR);
    const L = new Float32Array(n), R = new Float32Array(n);
    const trim = dbToGain(track.trimDb);
    const cache = new Map();
    for (const { at: start, seg } of plan) {
      if (!cache.has(seg.file)) cache.set(seg.file, decodeMp3(path.join(OUT_DIR, seg.file)));
      const pcm = cache.get(seg.file);
      const s0 = Math.round(start * SR);
      for (let i = 0; i < pcm.length / 2 && s0 + i < n; i++) {
        L[s0 + i] += pcm[2 * i] * trim; R[s0 + i] += pcm[2 * i + 1] * trim;
      }
    }
    let peak = 0;
    for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
    if (peak > 0.98) for (let i = 0; i < n; i++) { L[i] *= 0.98 / peak; R[i] *= 0.98 / peak; }
    const file = path.join(dir, `${track.id}-preview.mp3`);
    fs.writeFileSync(file, encodeMp3(wavBuffer({ L, R }), 3));
    out.push({ file, seconds: n / SR, order: plan.map((p) => p.seg.id).join(' ') });
    console.log(`${file}  ${(n / SR).toFixed(0)} s  ${out[out.length - 1].order}`);
  }
  return out;
}

/** After a change to the sound effects: new levels, same files (no ffmpeg needed). */
function relevel() {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const sfx = sfxReference(fs.readFileSync(path.join(ROOT, 'public', 'client.js'), 'utf8'));
  manifest.sfxRms = round6(sfx.median);
  manifest.levels = levelGains(sfx.median, manifest.musicRms);
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`levels ${JSON.stringify(manifest.levels)}`);
}

if (require.main === module) {
  const i = process.argv.indexOf('--preview');
  if (i > -1) preview(path.resolve(process.argv[i + 1] || 'music-preview'));
  else if (process.argv.includes('--levels')) relevel();
  else render();
}

module.exports = { TRACKS, sfxReference, toneRms, levelGains, hashOf, LOW_BELOW_SFX_DB, LEVEL_STEP_DB };
