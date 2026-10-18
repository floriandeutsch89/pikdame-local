/** Music settings in the real client (jsdom): defaults, both settings surfaces,
 *  both languages, the one-time hint after the first gesture, and a quiet
 *  fallback where the player module or Web Audio is missing. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');

const pub = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(pub, 'music', 'manifest.json'), 'utf8'));

function boot({ storage = {}, withPlayer = true, withAudio = true, saveData = false } = {}) {
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e) => errors.push(e));
  const { window } = new JSDOM(html, {
    url: 'https://play.example/', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole,
  });
  window.matchMedia = (q) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  window.navigator.vibrate = () => true;
  window.requestAnimationFrame = () => 0;
  window.scrollTo = () => {};
  if (saveData) Object.defineProperty(window.navigator, 'connection', { value: { saveData: true } });
  const fetched = [];
  const respond = (body, ok = true) => ({
    ok, status: ok ? 200 : 404,
    json: () => Promise.resolve(JSON.parse(body)),
    text: () => Promise.resolve(body),
    arrayBuffer: () => Promise.resolve(Buffer.from(body)),
    clone() { return respond(body, ok); },
  });
  window.fetch = (url) => {
    fetched.push(String(url));
    if (url === '/music/manifest.json') return Promise.resolve(respond(JSON.stringify(manifest)));
    const m = String(url).match(/^\/music\/(.+\.mp3)$/);
    if (m) return Promise.resolve(respond(JSON.stringify({ duration: 26 })));
    return Promise.resolve(respond('{}'));
  };
  const contexts = [];
  if (withAudio) {
    const param = () => ({ value: 1, setValueAtTime() {}, linearRampToValueAtTime() {}, cancelScheduledValues() {}, exponentialRampToValueAtTime() {} });
    window.AudioContext = class {
      constructor() { this.state = 'suspended'; this.currentTime = 1; this.destination = {}; this.started = []; contexts.push(this); }
      resume() { this.state = 'running'; return Promise.resolve(); }
      suspend() { this.state = 'suspended'; return Promise.resolve(); }
      createGain() { return { gain: param(), connect() {}, disconnect() {} }; }
      createOscillator() { return { type: 'sine', frequency: param(), connect: (n) => n, start() {}, stop() {} }; }
      createBufferSource() { const c = this; return { connect() {}, disconnect() {}, start(t) { c.started.push(t); }, stop() {} }; }
      decodeAudioData(bytes, ok) { const b = { duration: JSON.parse(Buffer.from(bytes).toString()).duration }; ok(b); return Promise.resolve(b); }
    };
  }
  class FakeSocket {
    constructor() { this.readyState = 0; this.listeners = {}; this.sent = []; }
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
    removeEventListener() {}
    send(data) { this.sent.push(JSON.parse(data)); }
    close() {}
  }
  FakeSocket.CONNECTING = 0;
  FakeSocket.OPEN = 1;
  window.WebSocket = FakeSocket;
  window.sessionStorage.setItem('pikdame_splash_seen', '1');
  window.localStorage.setItem('pikdame_player_name', 'Ben');
  for (const [k, v] of Object.entries(storage)) window.localStorage.setItem(k, v);
  const scripts = withPlayer ? ['i18n.js', 'music-player.js', 'client.js'] : ['i18n.js', 'client.js'];
  for (const src of scripts) window.eval(fs.readFileSync(path.join(pub, src), 'utf8'));
  const doc = window.document;
  const $ = (id) => doc.getElementById(id);
  const rowValue = () => $('musicToggle').querySelector('.sheetRowValue').textContent;
  const toast = () => $('toastContainer').textContent;
  return { window, doc, $, rowValue, toast, fetched, contexts, errors };
}
const flush = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r)); };

test('defaults: quiet and rotating, shown in the settings sheet and the in-game row', () => {
  const t = boot();
  assert.strictEqual(t.$('musicItem').classList.contains('hidden'), false);
  assert.strictEqual(t.$('musicToggle').classList.contains('hidden'), false);
  assert.strictEqual(t.$('musicLevelSelect').value, 'low');
  assert.strictEqual(t.$('musicTrackSelect').value, 'mix');
  assert.strictEqual(t.rowValue(), 'Leise · Wechselnd');
  assert.deepStrictEqual(t.contexts, [], 'no AudioContext before the first gesture');
  assert.ok(!t.fetched.some((u) => u.startsWith('/music/')), 'no music download before the first gesture');
  assert.deepStrictEqual(t.errors, []);
  t.window.close();
});

test('defaults: off for players who switched the sound off or save data', () => {
  const quiet = boot({ storage: { pikdame_sound_enabled: 'off' } });
  assert.strictEqual(quiet.$('musicLevelSelect').value, 'off');
  assert.strictEqual(quiet.rowValue(), 'Aus');
  quiet.window.close();
  const saver = boot({ saveData: true });
  assert.strictEqual(saver.$('musicLevelSelect').value, 'off');
  saver.window.close();
  const chosen = boot({ saveData: true, storage: { pikdame_music_level: 'mid', pikdame_music_track: 'lounge' } });
  assert.strictEqual(chosen.$('musicLevelSelect').value, 'mid', 'an explicit choice wins over data saving');
  assert.strictEqual(chosen.$('musicTrackSelect').value, 'lounge');
  assert.strictEqual(chosen.rowValue(), 'Mittel · Lounge-Bossa');
  chosen.window.close();
});

test('settings: the selects store the choice, the in-game row cycles the level', () => {
  const t = boot();
  const sel = t.$('musicTrackSelect');
  sel.value = 'kaetzchen';
  sel.dispatchEvent(new t.window.Event('change'));
  assert.strictEqual(t.window.localStorage.getItem('pikdame_music_track'), 'kaetzchen');
  assert.strictEqual(t.rowValue(), 'Leise · Kätzchen');
  const level = t.$('musicLevelSelect');
  level.value = 'high';
  level.dispatchEvent(new t.window.Event('change'));
  assert.strictEqual(t.window.localStorage.getItem('pikdame_music_level'), 'high');
  t.$('musicToggle').click();
  assert.strictEqual(t.$('musicLevelSelect').value, 'off', 'Laut -> Aus');
  assert.strictEqual(t.rowValue(), 'Aus');
  assert.match(t.toast(), /Musik: Aus/);
  t.$('musicToggle').click();
  assert.strictEqual(t.rowValue(), 'Leise · Kätzchen');
  assert.deepStrictEqual(t.errors, []);
  t.window.close();
});

test('settings: labels follow the language switch', () => {
  const t = boot({ storage: { pikdame_music_track: 'kaffeehaus' } });
  t.$('langBtn').click();
  const labels = (id) => [...t.$(id).options].map((o) => o.textContent);
  assert.deepStrictEqual(labels('musicLevelSelect'), ['Off', 'Quiet', 'Medium', 'Loud']);
  assert.deepStrictEqual(labels('musicTrackSelect'), ['Shuffle', 'Coffee house', 'Lounge bossa', 'Kitten']);
  assert.strictEqual(t.rowValue(), 'Quiet · Coffee house');
  assert.strictEqual(t.$('musicToggle').querySelector('.sheetRowLabel').textContent, 'Music');
  t.$('langBtn').click();
  assert.strictEqual(t.rowValue(), 'Leise · Kaffeehaus');
  t.window.close();
});

test('first gesture: the music starts and says once where to change it', async () => {
  const t = boot();
  t.doc.dispatchEvent(new t.window.Event('pointerup'));
  await flush();
  assert.strictEqual(t.contexts.length, 1);
  assert.strictEqual(t.contexts[0].state, 'running');
  assert.ok(t.contexts[0].started.length >= 1, 'a segment was scheduled');
  assert.ok(t.fetched.includes('/music/manifest.json'));
  assert.match(t.toast(), /Musik läuft leise – ändern unter Einstellungen › Musik/);
  assert.strictEqual(t.window.localStorage.getItem('pikdame_music_hint'), '1');
  assert.deepStrictEqual(t.errors, []);
  t.window.close();

  const later = boot({ storage: { pikdame_music_hint: '1' } });
  later.doc.dispatchEvent(new later.window.Event('pointerup'));
  await flush();
  assert.ok(later.contexts[0].started.length >= 1);
  assert.doesNotMatch(later.toast(), /Musik läuft leise/, 'the hint shows only once');
  later.window.close();

  const chosen = boot({ storage: { pikdame_music_level: 'low' } });
  chosen.doc.dispatchEvent(new chosen.window.Event('pointerup'));
  await flush();
  assert.doesNotMatch(chosen.toast(), /Musik läuft leise/, 'no hint for a level the player picked');
  chosen.window.close();
});

test('fallback: without the player module or Web Audio the music settings hide', () => {
  const noModule = boot({ withPlayer: false });
  assert.ok(noModule.$('musicItem').classList.contains('hidden'));
  assert.ok(noModule.$('musicToggle').classList.contains('hidden'));
  assert.deepStrictEqual(noModule.errors, []);
  noModule.window.close();
  const noAudio = boot({ withAudio: false });
  assert.ok(noAudio.$('musicItem').classList.contains('hidden'));
  noAudio.doc.dispatchEvent(new noAudio.window.Event('pointerup'));
  assert.deepStrictEqual(noAudio.errors, []);
  noAudio.window.close();
});
