/** Background music: the committed files match their manifest and names, the
 *  sequencer keeps the A A B A form, the player schedules segments gaplessly,
 *  holds at most two decoded and loads each file once (Cache Storage), and the
 *  server lets browsers keep the hashed files for good. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const MUSIC = path.join(ROOT, 'public', 'music');
const manifest = JSON.parse(fs.readFileSync(path.join(MUSIC, 'manifest.json'), 'utf8'));
const M = require('../public/music-player.js');
const R = require('../scripts/render-music.js');

const allSegments = () => manifest.tracks.flatMap((t) => t.segments.map((s) => ({ track: t, s })));

test('manifest: every file exists, its name carries its own hash, lengths fit the tempo', () => {
  assert.strictEqual(manifest.version, 1);
  assert.deepStrictEqual(manifest.tracks.map((t) => t.id).sort(), [...M.TRACK_IDS].sort());
  for (const { track, s } of allSegments()) {
    const file = path.join(MUSIC, s.file);
    assert.ok(fs.existsSync(file), `${s.file} is committed`);
    const bytes = fs.readFileSync(file);
    const m = s.file.match(/^([a-z0-9]+)-([a-z0-9]+)\.([0-9a-f]{8})\.mp3$/);
    assert.ok(m, `${s.file}: <track>-<segment>.<hash>.mp3`);
    assert.strictEqual(m[1], track.id);
    assert.strictEqual(m[2], s.id);
    assert.strictEqual(m[3], crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 8),
      `${s.file}: the hash in the name matches the content (it is cached for a year)`);
    assert.strictEqual(s.bytes, bytes.length);
    assert.ok(Math.abs(s.seconds - s.bars * 4 * 60 / track.bpm) < 1e-5, `${s.file}: ${s.bars} bars at ${track.bpm} bpm`);
    assert.ok(s.duration > s.seconds + 3, `${s.file}: a tail rings into the next segment`);
  }
});

test('manifest: each track has the form material, nothing stray, and stays small', () => {
  for (const t of manifest.tracks) {
    const roles = t.segments.map((s) => s.role);
    assert.ok(roles.filter((r) => r === 'A').length >= 2, `${t.id}: two A variants`);
    assert.ok(roles.filter((r) => r === 'B').length >= 2, `${t.id}: two B variants`);
    assert.strictEqual(roles.filter((r) => r === 'END').length, 1, `${t.id}: one ending`);
    assert.ok(t.trimDb <= 0, 'trims only cut');
  }
  const listed = new Set(allSegments().map(({ s }) => s.file));
  const stray = fs.readdirSync(MUSIC).filter((f) => f.endsWith('.mp3') && !listed.has(f));
  assert.deepStrictEqual(stray, [], 'every MP3 is in the manifest (render-music.js removes old ones)');
  const total = allSegments().reduce((sum, { s }) => sum + s.bytes, 0);
  assert.ok(total <= 5 * 1024 * 1024, `all music together ${(total / 1048576).toFixed(2)} MB <= 5 MB`);
});

test('levels: "Leise" sits 8 dB above the sound effects, computed from client.js', () => {
  const sfx = R.sfxReference(fs.readFileSync(path.join(ROOT, 'public', 'client.js'), 'utf8'));
  assert.ok(sfx.list.length >= 5, 'the sound effects were found');
  assert.ok(Math.abs(sfx.median - manifest.sfxRms) < 1e-6,
    'the sound effects changed: run `node scripts/render-music.js --levels`');
  assert.deepStrictEqual(manifest.levels, R.levelGains(manifest.sfxRms, manifest.musicRms));
  const { low, mid, high } = manifest.levels;
  assert.ok(low > 0 && low < mid && mid < high && high <= 1);
  const lowDb = 20 * Math.log10(low * manifest.musicRms / manifest.sfxRms);
  assert.ok(Math.abs(lowDb - R.LOW_VS_SFX_DB) < 0.05, `quiet music is ${lowDb.toFixed(2)} dB against the effects`);
  // A plain sine at 0.06 for its whole length: the envelope must pull it well below.
  assert.ok(R.toneRms([440], 200, 'sine', 0.06) < 0.06 / Math.SQRT2);
});

test('prefs: quiet and rotating by default, off for players who silenced sound or save data', () => {
  assert.deepStrictEqual(M.resolvePrefs({}), { level: 'low', choice: 'mix', explicit: false });
  assert.strictEqual(M.resolvePrefs({ soundOff: true }).level, 'off');
  assert.strictEqual(M.resolvePrefs({ saveData: true }).level, 'off');
  assert.deepStrictEqual(M.resolvePrefs({ level: 'mid', saveData: true, soundOff: true }), { level: 'mid', choice: 'mix', explicit: true });
  assert.deepStrictEqual(M.resolvePrefs({ level: 'loud!', choice: 'jazz' }), { level: 'low', choice: 'mix', explicit: false });
  assert.strictEqual(M.resolvePrefs({ choice: 'kaetzchen' }).choice, 'kaetzchen');
});

function seeded(seed) {
  let s = seed;
  return () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
}

test('sequencer: a fixed piece loops A A B A, never repeats a segment, uses every variant', () => {
  for (const t of manifest.tracks) {
    const seq = M.createSequencer(manifest, { choice: t.id, random: seeded(3) });
    let prev = null;
    const seen = new Set();
    for (let i = 0; i < 64; i++) {
      const ev = seq.next();
      assert.strictEqual(ev.kind, 'segment');
      assert.strictEqual(ev.track, t.id, 'a chosen piece never changes');
      assert.strictEqual(ev.segment.role, ['A', 'A', 'B', 'A'][i % 4]);
      assert.notStrictEqual(ev.segment, prev, 'never the same segment twice in a row');
      prev = ev.segment;
      seen.add(ev.segment.id);
    }
    assert.deepStrictEqual([...seen].sort(), t.segments.filter((s) => s.role !== 'END').map((s) => s.id).sort());
  }
});

test('sequencer: "Wechselnd" ends a piece after a whole form past two minutes, pauses, plays all three in turn', () => {
  for (const seed of [1, 7, 42]) {
    const seq = M.createSequencer(manifest, { choice: 'mix', random: seeded(seed) });
    const order = [seq.track];
    let elapsed = 0;
    let pos = 0;
    for (let i = 0; i < 60; i++) {
      const ev = seq.next();
      if (ev.kind === 'gap') {
        const track = manifest.tracks.find((t) => t.id === order[order.length - 1]);
        const end = track.segments.find((s) => s.role === 'END');
        assert.ok(Math.abs(ev.seconds - (end.duration - end.seconds + 2)) < 1e-9, 'two seconds after the ending fades out');
        const nextEv = seq.next();
        assert.notStrictEqual(nextEv.track, order[order.length - 1], 'another piece follows');
        order.push(nextEv.track);
        elapsed = nextEv.segment.seconds;
        pos = 1;
        continue;
      }
      if (ev.segment.role === 'END') {
        assert.strictEqual(pos % 4, 0, 'only after a complete A A B A');
        assert.ok(elapsed >= M.ROTATE_AFTER, `not before ${M.ROTATE_AFTER} s (${elapsed.toFixed(0)} s)`);
        assert.ok(elapsed < M.ROTATE_AFTER + 100, 'and within the next form');
        continue;
      }
      elapsed += ev.segment.seconds;
      pos++;
    }
    assert.strictEqual(new Set(order.slice(0, 3)).size, 3, `all three pieces come round first (${order.join(' > ')})`);
  }
});

// --- the player against fakes ------------------------------------------------
class FakeParam {
  constructor(v = 1) { this.value = v; this.events = []; }
  setValueAtTime(v, t) { this.events.push(['set', v, t]); this.value = v; }
  linearRampToValueAtTime(v, t) { this.events.push(['ramp', v, t]); this.value = v; }
  cancelScheduledValues(t) { this.events.push(['cancel', t]); }
}
class FakeContext {
  constructor() {
    this.currentTime = 10;
    this.state = 'suspended';
    this.destination = { id: 'out' };
    this.sources = [];
    this.decoded = 0;
  }
  resume() { this.state = 'running'; return Promise.resolve(); }
  createGain() { return { gain: new FakeParam(1), connect() {}, disconnect() {} }; }
  createBufferSource() {
    const src = { buffer: null, startAt: null, stopAt: null, connect() {}, disconnect() {}, start(t) { this.startAt = t; }, stop(t) { this.stopAt = t; } };
    this.sources.push(src);
    return src;
  }
  decodeAudioData(bytes, ok) {
    this.decoded++;
    const { file, duration } = JSON.parse(Buffer.from(bytes).toString('utf8'));
    const buffer = { file, duration };
    ok(buffer);
    return Promise.resolve(buffer);
  }
}
class FakeResponse {
  constructor(body, status = 200) { this.body = body; this.status = status; this.ok = status === 200; }
  clone() { return new FakeResponse(this.body, this.status); }
  json() { return Promise.resolve(JSON.parse(this.body)); }
  arrayBuffer() { const b = Buffer.from(this.body); return Promise.resolve(b.buffer.slice(b.byteOffset, b.byteOffset + b.length)); }
}
function fakeCaches() {
  const store = new Map();
  const cache = {
    match: (url) => Promise.resolve(store.has(url) ? store.get(url).clone() : undefined),
    put: (url, res) => { store.set(url, res); return Promise.resolve(); },
    keys: () => Promise.resolve([...store.keys()].map((url) => ({ url: `https://play.example${url}` }))),
    delete: (req) => Promise.resolve(store.delete(new URL(req.url).pathname)),
  };
  return { store, open: () => Promise.resolve(cache) };
}
function fakeNet({ offline = false } = {}) {
  const requests = [];
  const fetchImpl = (url) => {
    requests.push(url);
    if (offline) return Promise.reject(new TypeError('offline'));
    if (url === '/music/manifest.json') return Promise.resolve(new FakeResponse(JSON.stringify(manifest)));
    const seg = allSegments().find(({ s }) => `/music/${s.file}` === url);
    if (!seg) return Promise.resolve(new FakeResponse('', 404));
    return Promise.resolve(new FakeResponse(JSON.stringify({ file: seg.s.file, duration: seg.s.duration })));
  };
  return { requests, fetchImpl };
}
const flush = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r)); };

function rig({ choice = 'kaffeehaus', caches = fakeCaches(), net = fakeNet(), withContext = true } = {}) {
  const ctx = withContext ? new FakeContext() : null;
  let made = 0;
  const timers = [];
  const starts = [];
  const player = M.createPlayer({
    getContext: () => { if (ctx) made++; return ctx; },
    fetchImpl: net.fetchImpl,
    cachesImpl: caches,
    random: seeded(5),
    setTimer: (fn) => { timers.push(fn); return timers.length; },
    clearTimer: () => {},
    onStart: () => starts.push(ctx.currentTime),
  });
  player.setChoice(choice);
  return { ctx, player, net, caches, timers, starts, made: () => made };
}
const playing = (ctx) => ctx.sources.filter((s) => s.stopAt == null || s.stopAt > ctx.currentTime);

test('player: silent until a gesture; then segments start back to back on the musical grid', async () => {
  const t = rig();
  t.player.setLevel('low');
  await flush();
  assert.strictEqual(t.made(), 0, 'no AudioContext before a gesture (iOS)');
  assert.deepStrictEqual(t.net.requests, [], 'nothing is downloaded before music can play');

  t.player.unlock();
  await flush();
  assert.strictEqual(t.ctx.state, 'running');
  assert.strictEqual(t.starts.length, 1, 'the first-start hook fires once');
  const [first, second] = t.ctx.sources;
  assert.ok(first && second, 'the playing segment and the next one are scheduled');
  assert.ok(Math.abs(first.startAt - 10.1) < 1e-9);
  const seg = (src) => allSegments().find(({ s }) => s.file === src.buffer.file).s;
  assert.ok(Math.abs(second.startAt - (first.startAt + seg(first).seconds)) < 1e-9, 'the next starts after the musical length');
  assert.ok(second.startAt < first.startAt + first.buffer.duration, 'and overlaps the tail of the first');
  assert.strictEqual(t.ctx.sources.length, 2, 'at most two decoded segments');
  assert.strictEqual(t.net.requests.filter((u) => u.endsWith('.mp3')).length, 2, 'only the playing segment and the next are loaded');

  // The first rings out: only then is the third decoded and placed on the grid.
  t.ctx.currentTime = first.startAt + first.buffer.duration + 0.01;
  t.timers.shift()();
  await flush();
  const third = t.ctx.sources[2];
  assert.ok(third, 'the third follows once the first has ended');
  assert.ok(Math.abs(third.startAt - (second.startAt + seg(second).seconds)) < 1e-9);
  assert.notStrictEqual(seg(third).id, seg(second).id);
  assert.strictEqual(t.ctx.decoded, 3);
  assert.strictEqual(t.net.requests.filter((u) => u.endsWith('.mp3')).length, 3, 'loaded just in time, not ahead');
});

test('player: level ramps, off stops with a fade, a new piece restarts the sequence', async () => {
  const t = rig({ choice: 'lounge' });
  t.player.setLevel('mid');
  t.player.unlock();
  await flush();
  assert.ok(t.player.isActive());
  assert.match(t.player.state().scheduled[0], /^lounge-/);
  t.player.setLevel('high');
  assert.ok(t.player.isActive(), 'a new level keeps the music running');
  t.player.setChoice('kaetzchen');
  await flush();
  assert.ok(t.ctx.sources.filter((s) => /^lounge-/.test(s.buffer.file)).every((s) => s.stopAt != null), 'the old piece stops');
  assert.match(t.player.state().scheduled[0], /^kaetzchen-/);
  t.player.setLevel('off');
  assert.strictEqual(t.player.isActive(), false);
  assert.ok(playing(t.ctx).every((s) => s.stopAt != null), 'every source got a stop time');
  t.player.unlock();
  await flush();
  assert.strictEqual(t.player.isActive(), false, 'a gesture does not restart music that is off');
});

test('player: each file is downloaded once - the next start plays from the Cache Storage', async () => {
  const caches = fakeCaches();
  caches.store.set('/music/kaffeehaus-a.00000000.mp3', new FakeResponse('stale'));
  const first = rig({ caches });
  first.player.setLevel('low');
  first.player.unlock();
  await flush();
  const fetched = first.net.requests.filter((u) => u.endsWith('.mp3'));
  assert.ok(fetched.length >= 2);
  assert.ok(!caches.store.has('/music/kaffeehaus-a.00000000.mp3'), 'files no longer in the manifest are removed');
  for (const u of fetched) assert.ok(caches.store.has(u), `${u} is cached`);

  const again = rig({ caches });
  again.player.setLevel('low');
  again.player.unlock();
  await flush();
  assert.deepStrictEqual(again.net.requests, ['/music/manifest.json'], 'only the manifest is revalidated, no MP3 goes over the network');
  assert.strictEqual(again.ctx.sources.length, 2);

  const offline = rig({ caches, net: fakeNet({ offline: true }) });
  offline.player.setLevel('low');
  offline.player.unlock();
  await flush();
  assert.strictEqual(offline.ctx.sources.length, 2, 'offline the cached manifest and files still play');
});

test('player: without Web Audio or Cache Storage it stays quiet or falls back to the network', async () => {
  const none = rig({ withContext: false });
  none.player.setLevel('low');
  none.player.unlock();
  await flush();
  assert.strictEqual(none.player.isActive(), false);
  assert.deepStrictEqual(none.net.requests, []);

  const plain = rig({ caches: null });
  plain.player.setLevel('low');
  plain.player.unlock();
  await flush();
  assert.strictEqual(plain.ctx.sources.length, 2, 'plain fetch works where caches is missing (http, private mode)');

  const broken = rig({ caches: { open: () => Promise.reject(new Error('SecurityError')) } });
  broken.player.setLevel('low');
  broken.player.unlock();
  await flush();
  assert.strictEqual(broken.ctx.sources.length, 2, 'a cache that refuses to open is skipped');
});

test('player: the master gain follows the manifest levels and ramps between them', async () => {
  const t = rig();
  const gains = [];
  t.ctx.createGain = () => { const g = { gain: new FakeParam(1), connect() {}, disconnect() {} }; gains.push(g); return g; };
  t.player.setLevel('mid');
  t.player.unlock();
  await flush();
  const master = gains[0]; // created first, shared by every run
  assert.strictEqual(master.gain.value, manifest.levels.mid);
  t.player.setLevel('low');
  assert.deepStrictEqual(master.gain.events.at(-1).slice(0, 2), ['ramp', manifest.levels.low], 'a level change ramps, it never jumps');
  const bus = gains[1];
  assert.deepStrictEqual(bus.gain.events.slice(0, 2).map((e) => e.slice(0, 2)), [['set', 0], ['ramp', 1]], 'each start fades in');
});

test('server: hashed music is cacheable forever, the manifest revalidates', async (t) => {
  const PORT = 8111;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pikdame-music-'));
  const server = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), PIKDAME_DATA_DIR: dataDir, PIKDAME_ONNX: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    const gone = server.exitCode !== null ? null : new Promise((r) => server.once('exit', r));
    server.kill();
    await gone;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const get = (p) => new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: p, timeout: 2000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
  });
  const deadline = Date.now() + 15000;
  for (;;) {
    try { await get('/healthz'); break; } catch (e) {
      if (Date.now() > deadline) throw new Error(`server on port ${PORT} did not come up`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  const seg = manifest.tracks[0].segments[0];
  const mp3 = await get(`/music/${seg.file}`);
  assert.strictEqual(mp3.status, 200);
  assert.strictEqual(mp3.headers['content-type'], 'audio/mpeg');
  assert.strictEqual(mp3.headers['cache-control'], 'public, max-age=31536000, immutable');
  assert.strictEqual(mp3.body.length, seg.bytes);
  const man = await get('/music/manifest.json');
  assert.strictEqual(man.status, 200);
  assert.strictEqual(man.headers['cache-control'], 'no-cache');
});
