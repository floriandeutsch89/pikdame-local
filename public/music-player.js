// public/music-player.js
// Background music: pre-rendered 8-bar segments (scripts/render-music.js),
// started back to back on the Web Audio clock. Loaded before client.js; the
// sequencer is shared with the renderer's previews (Node).
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PikdameMusic = api;
}(typeof self !== 'undefined' ? self : this, () => {
  'use strict';

  const LEVELS = ['off', 'low', 'mid', 'high'];
  const TRACK_IDS = ['kaffeehaus', 'lounge', 'kaetzchen'];
  const CHOICES = ['mix'].concat(TRACK_IDS);
  const FORM = ['A', 'A', 'B', 'A'];
  const ROTATE_AFTER = 120; // seconds before "mix" moves on, at the end of a form
  const PAUSE_BETWEEN = 2; // silence after an ending, before the next track
  const CACHE_NAME = 'pikdame-music';
  const FALLBACK_LEVELS = { low: 0.1, mid: 0.2, high: 0.4 };

  /** Stored choices, else the defaults: quiet and rotating, off for players
   *  who silenced the sound before or ask the browser to save data. */
  function resolvePrefs({ level, choice, soundOff = false, saveData = false } = {}) {
    const explicit = LEVELS.includes(level);
    return {
      level: explicit ? level : (soundOff || saveData ? 'off' : 'low'),
      choice: CHOICES.includes(choice) ? choice : 'mix',
      explicit,
    };
  }

  /** Segment order: the form A A B A, each slot taking the variant heard least
   *  recently (never the same one twice in a row). "mix" plays the ending once a
   *  form is complete after ROTATE_AFTER seconds, pauses, then another track. */
  function createSequencer(manifest, { choice = 'mix', startTrack = null, random = Math.random, rotateAfter = ROTATE_AFTER } = {}) {
    const tracks = ((manifest && manifest.tracks) || []).filter((t) => (t.segments || []).some((s) => s.role === 'A'));
    const byId = (id) => tracks.find((t) => t.id === id) || null;
    const pick = (list) => list[Math.min(list.length - 1, Math.floor(random() * list.length))];
    const fixed = choice !== 'mix' ? byId(choice) : null;
    let track = fixed || byId(startTrack) || (tracks.length ? pick(tracks) : null);
    let formPos = 0, elapsed = 0, last = null, ended = null, step = 0, rounds = 0;
    let heard = new Map(); // segment -> step it last played
    const played = new Map([[track, 0]]); // track -> round it last played

    function next() {
      if (!track) return null;
      if (ended) {
        const gap = ended.duration - ended.seconds + PAUSE_BETWEEN;
        // The track that waited longest: all three come round before one repeats.
        const others = tracks.filter((t) => t !== track);
        if (others.length) {
          const age = (t) => (played.has(t) ? played.get(t) : -1);
          const oldest = Math.min(...others.map(age));
          track = pick(others.filter((t) => age(t) === oldest));
          played.set(track, ++rounds);
        }
        formPos = 0; elapsed = 0; last = null; ended = null; heard = new Map();
        return { kind: 'gap', seconds: gap };
      }
      if (!fixed && tracks.length > 1 && formPos === 0 && elapsed >= rotateAfter) {
        const end = track.segments.find((s) => s.role === 'END');
        if (end) {
          ended = end;
          return { kind: 'segment', track: track.id, segment: end };
        }
      }
      const role = FORM[formPos];
      let all = track.segments.filter((s) => s.role === role);
      if (!all.length) all = track.segments.filter((s) => s.role === 'A');
      const fresh = all.length > 1 ? all.filter((s) => s !== last) : all;
      const oldest = Math.min(...fresh.map((s) => (heard.has(s) ? heard.get(s) : -1)));
      const segment = pick(fresh.filter((s) => (heard.has(s) ? heard.get(s) : -1) === oldest));
      heard.set(segment, step++);
      formPos = (formPos + 1) % FORM.length;
      elapsed += segment.seconds;
      last = segment;
      return { kind: 'segment', track: track.id, segment };
    }
    return { next, get track() { return track ? track.id : null; } };
  }

  const pathOf = (u) => {
    try { return new URL(String(u), 'https://music.invalid').pathname; } catch (e) { return String(u); }
  };

  /**
   * The player. getContext() hands out the page's shared AudioContext (null
   * without Web Audio: then every call is a quiet no-op). Files come from the
   * Cache Storage first and the network only on a miss: each is fetched once.
   */
  function createPlayer({
    getContext,
    fetchImpl = null,
    cachesImpl = null,
    manifestUrl = '/music/manifest.json',
    base = '/music/',
    random = Math.random,
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (id) => clearTimeout(id),
    onStart = null,
  } = {}) {
    let level = 'off';
    let choice = 'mix';
    let unlocked = false;
    let manifest = null;
    let manifestLoading = null;
    let ctx = null;
    let master = null; // level gain, shared by every run
    let run = null; // the playing sequence, or null

    const levelGain = (l) => {
      if (l === 'off') return 0;
      const levels = (manifest && manifest.levels) || FALLBACK_LEVELS;
      return Math.max(0, Math.min(1, Number(levels[l]) || FALLBACK_LEVELS[l] || 0));
    };

    async function openCache() {
      if (!cachesImpl) return null;
      try { return await cachesImpl.open(CACHE_NAME); } catch (e) { return null; }
    }

    async function prune(cache, m) {
      try {
        const keep = new Set([pathOf(manifestUrl)]);
        for (const t of m.tracks) for (const s of t.segments || []) keep.add(pathOf(base + s.file));
        for (const req of await cache.keys()) {
          if (!keep.has(pathOf(typeof req === 'string' ? req : req.url))) await cache.delete(req);
        }
      } catch (e) { /* cleanup is best effort */ }
    }

    /** The manifest is revalidated on every start; offline the cached copy plays. */
    function loadManifest() {
      if (manifest) return Promise.resolve(manifest);
      if (!manifestLoading) {
        manifestLoading = (async () => {
          const cache = await openCache();
          let m = null;
          try {
            const res = await fetchImpl(manifestUrl, { cache: 'no-cache' });
            if (res && res.ok) {
              if (cache) { try { await cache.put(manifestUrl, res.clone()); } catch (e) { /* quota */ } }
              m = await res.json();
            }
          } catch (e) { /* offline: the cached copy below */ }
          if (!m && cache) {
            try { const hit = await cache.match(manifestUrl); if (hit) m = await hit.json(); } catch (e) { m = null; }
          }
          manifest = m && Array.isArray(m.tracks) ? m : null;
          if (manifest && cache) await prune(cache, manifest);
          manifestLoading = null;
          return manifest;
        })();
      }
      return manifestLoading;
    }

    async function loadBytes(url) {
      const cache = await openCache();
      if (cache) {
        try { const hit = await cache.match(url); if (hit) return await hit.arrayBuffer(); } catch (e) { /* network below */ }
      }
      const res = await fetchImpl(url);
      if (!res || !res.ok) throw new Error(`music ${res ? res.status : 'offline'}`);
      if (cache) { try { await cache.put(url, res.clone()); } catch (e) { /* quota: plays uncached */ } }
      return res.arrayBuffer();
    }

    // Old Safari only knows the callback form.
    function decode(bytes) {
      return new Promise((resolve, reject) => {
        try {
          const p = ctx.decodeAudioData(bytes, resolve, reject);
          if (p && typeof p.then === 'function') p.then(resolve, reject);
        } catch (e) { reject(e); }
      });
    }

    function ensureGraph() {
      const c = getContext ? getContext() : null;
      if (!c) return null;
      if (c !== ctx || !master) {
        ctx = c;
        master = ctx.createGain();
        master.gain.value = levelGain(level);
        master.connect(ctx.destination);
      }
      return ctx;
    }

    const resumeContext = () => {
      if (ctx && ctx.state !== 'running' && typeof ctx.resume === 'function') {
        try { const p = ctx.resume(); if (p && p.catch) p.catch(() => {}); } catch (e) { /* needs a gesture */ }
      }
    };

    /** The next segment (gaps add up); loaded only once a decode slot is free. */
    function prepare(r) {
      r.upcoming = null;
      for (let guard = 0; guard < 8; guard++) {
        const ev = r.seq.next();
        if (!ev) return;
        if (ev.kind === 'gap') { r.gap += ev.seconds; continue; }
        const track = manifest.tracks.find((t) => t.id === ev.track);
        ev.trim = Math.pow(10, ((track && Number(track.trimDb)) || 0) / 20);
        r.upcoming = ev;
        return;
      }
    }

    function schedule(r, ev, buffer) {
      r.failures = 0;
      const now = ctx.currentTime;
      // Late (slow network): start now and move the grid, never stack onto the last one.
      const at = Math.max(r.nextStart == null ? now + 0.1 : r.nextStart + r.gap, now + 0.05);
      r.gap = 0;
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      const trim = ctx.createGain();
      trim.gain.value = ev.trim;
      src.connect(trim);
      trim.connect(r.bus);
      src.onended = () => { try { src.disconnect(); trim.disconnect(); } catch (e) { /* already gone */ } };
      src.start(at);
      r.scheduled.push({ src, end: at + buffer.duration, track: ev.track, id: ev.segment.id });
      r.nextStart = at + ev.segment.seconds;
      if (!r.started) {
        r.started = true;
        r.bus.gain.setValueAtTime(0, at);
        r.bus.gain.linearRampToValueAtTime(1, at + 1.5);
        if (onStart) { try { onStart(); } catch (e) { /* the hint is cosmetic */ } }
      }
    }

    /** At most two segments loaded and decoded: the playing one and the next.
     *  A segment still ringing out counts, so the next waits for its tail
     *  (4 s); it starts a whole segment later (at least 15 s), time enough. */
    function pump(r) {
      if (run !== r) return;
      clearTimer(r.timer);
      r.timer = setTimer(() => pump(r), 1000);
      const now = ctx.currentTime;
      r.scheduled = r.scheduled.filter((s) => s.end > now);
      if (r.decoding || !r.upcoming || r.scheduled.length >= 2) return;
      const ev = r.upcoming;
      r.decoding = true;
      loadBytes(base + ev.segment.file).then(decode).then((buffer) => {
        r.decoding = false;
        if (run !== r) return;
        schedule(r, ev, buffer);
        prepare(r);
        pump(r);
      }, () => {
        r.decoding = false;
        if (run !== r) return;
        // A segment that will not load is skipped; three in a row (offline) end the music.
        if (++r.failures >= 3) { stop(0.3); return; }
        prepare(r);
        pump(r);
      });
    }

    function start() {
      if (!ensureGraph()) return;
      resumeContext();
      const r = { bus: null, seq: null, scheduled: [], upcoming: null, gap: 0, nextStart: null, decoding: false, failures: 0, timer: null, started: false };
      run = r;
      loadManifest().then((m) => {
        if (run !== r) return;
        if (!m) { run = null; return; }
        master.gain.value = levelGain(level);
        r.bus = ctx.createGain();
        r.bus.gain.value = 0;
        r.bus.connect(master);
        r.seq = createSequencer(m, { choice, random });
        prepare(r);
        pump(r);
      }, () => { if (run === r) run = null; });
    }

    function stop(fade = 0.6) {
      const r = run;
      run = null;
      if (!r) return;
      clearTimer(r.timer);
      if (!ctx || !r.bus) return;
      const now = ctx.currentTime;
      try {
        r.bus.gain.cancelScheduledValues(now);
        r.bus.gain.setValueAtTime(r.bus.gain.value, now);
        r.bus.gain.linearRampToValueAtTime(0, now + fade);
      } catch (e) { /* closed context */ }
      for (const s of r.scheduled) { try { s.src.stop(now + fade + 0.05); } catch (e) { /* never started */ } }
      setTimer(() => { try { r.bus.disconnect(); } catch (e) { /* gone */ } }, (fade + 0.3) * 1000);
    }

    function sync() {
      const wanted = unlocked && level !== 'off';
      if (wanted && !run) start();
      else if (!wanted && run) stop();
    }

    return {
      /** Call from a user gesture: iOS starts audio only there. Cheap to repeat. */
      unlock() {
        unlocked = true;
        if (level === 'off') return;
        if (ensureGraph()) resumeContext();
        sync();
      },
      /** Back from the background: the page suspended the context when it hid. */
      wake() {
        if (run) resumeContext();
      },
      setLevel(l) {
        if (!LEVELS.includes(l)) return;
        level = l;
        if (master && ctx && l !== 'off') {
          const now = ctx.currentTime;
          try {
            master.gain.cancelScheduledValues(now);
            master.gain.setValueAtTime(master.gain.value, now);
            master.gain.linearRampToValueAtTime(levelGain(l), now + 0.4);
          } catch (e) { /* closed context */ }
        }
        sync();
      },
      setChoice(c) {
        if (!CHOICES.includes(c) || c === choice) return;
        choice = c;
        if (run) stop(1);
        sync();
      },
      isActive: () => !!run,
      state: () => ({
        level, choice, unlocked, active: !!run,
        track: run && run.seq ? run.seq.track : null,
        scheduled: run ? run.scheduled.map((s) => `${s.track}-${s.id}`) : [],
      }),
    };
  }

  return { LEVELS, TRACK_IDS, CHOICES, ROTATE_AFTER, resolvePrefs, createSequencer, createPlayer };
}));
