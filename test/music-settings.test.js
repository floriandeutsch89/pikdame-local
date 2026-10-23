/** Music settings in the real client (jsdom): defaults, the one "Optionen"
 *  sheet (start screen and table), both languages, the one-time hint after the
 *  first gesture, and a quiet fallback where the player module or Web Audio is missing. */
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
      constructor() { this.state = 'suspended'; this.currentTime = 1; this.destination = {}; this.started = []; this.stopped = []; contexts.push(this); }
      resume() { this.state = 'running'; return Promise.resolve(); }
      suspend() { this.state = 'suspended'; return Promise.resolve(); }
      createGain() { return { gain: param(), connect() {}, disconnect() {} }; }
      createOscillator() { return { type: 'sine', frequency: param(), connect: (n) => n, start() {}, stop() {} }; }
      createBufferSource() { const c = this; return { connect() {}, disconnect() {}, start(t) { c.started.push(t); }, stop(t) { c.stopped.push(t); } }; }
      decodeAudioData(bytes, ok) { const b = { duration: JSON.parse(Buffer.from(bytes).toString()).duration }; ok(b); return Promise.resolve(b); }
    };
  }
  const sockets = [];
  class FakeSocket {
    constructor() { this.readyState = 0; this.listeners = {}; this.sent = []; sockets.push(this); }
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
    removeEventListener() {}
    send(data) { this.sent.push(JSON.parse(data)); }
    close() {}
    fire(type, payload) {
      if (type === 'open') this.readyState = 1;
      for (const fn of this.listeners[type] || []) fn(payload === undefined ? {} : { data: JSON.stringify(payload) });
    }
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
  // The level as the sheet shows it: the pressed segment (the select stays the source of truth).
  const level = () => [...doc.querySelectorAll('.segmented[data-select="musicLevelSelect"] .segBtn.active')].map((b) => b.dataset.value);
  const toast = () => $('toastContainer').textContent;
  const socket = () => { const ws = sockets[sockets.length - 1]; if (ws.readyState !== 1) ws.fire('open'); return ws; };
  return { window, doc, $, level, toast, socket, fetched, contexts, errors };
}
const flush = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r)); };

test('defaults: quiet and rotating, shown in the settings sheet', () => {
  const t = boot();
  assert.strictEqual(t.$('musicItem').classList.contains('hidden'), false);
  assert.strictEqual(t.$('musicLevelSelect').value, 'low');
  assert.strictEqual(t.$('musicTrackSelect').value, 'mix');
  assert.deepStrictEqual(t.level(), ['low']);
  assert.deepStrictEqual(t.contexts, [], 'no AudioContext before the first gesture');
  assert.ok(!t.fetched.some((u) => u.startsWith('/music/')), 'no music download before the first gesture');
  assert.deepStrictEqual(t.errors, []);
  t.window.close();
});

test('defaults: off for players who switched the sound off or save data', () => {
  const quiet = boot({ storage: { pikdame_sound_enabled: 'off' } });
  assert.strictEqual(quiet.$('musicLevelSelect').value, 'off');
  assert.deepStrictEqual(quiet.level(), ['off']);
  quiet.window.close();
  const saver = boot({ saveData: true });
  assert.strictEqual(saver.$('musicLevelSelect').value, 'off');
  saver.window.close();
  const chosen = boot({ saveData: true, storage: { pikdame_music_level: 'mid', pikdame_music_track: 'lounge' } });
  assert.strictEqual(chosen.$('musicLevelSelect').value, 'mid', 'an explicit choice wins over data saving');
  assert.strictEqual(chosen.$('musicTrackSelect').value, 'lounge');
  assert.deepStrictEqual(chosen.level(), ['mid']);
  chosen.window.close();
});

test('settings: the selects store the choice; one control per setting, no cycling row', () => {
  const t = boot();
  const sel = t.$('musicTrackSelect');
  sel.value = 'kaetzchen';
  sel.dispatchEvent(new t.window.Event('change'));
  assert.strictEqual(t.window.localStorage.getItem('pikdame_music_track'), 'kaetzchen');
  const level = t.$('musicLevelSelect');
  level.value = 'high';
  level.dispatchEvent(new t.window.Event('change'));
  assert.strictEqual(t.window.localStorage.getItem('pikdame_music_level'), 'high');
  assert.deepStrictEqual(t.level(), ['high'], 'the segments follow the select');
  // Music off from the default: one tap on "Aus", not three through Mittel and Laut.
  t.doc.querySelector('.segmented[data-select="musicLevelSelect"] .segBtn[data-value="off"]').click();
  assert.strictEqual(t.$('musicLevelSelect').value, 'off');
  assert.strictEqual(t.window.localStorage.getItem('pikdame_music_level'), 'off');
  assert.strictEqual(t.$('musicToggle'), null, 'the cycling in-game row is gone');
  assert.strictEqual(t.doc.querySelectorAll('#musicLevelSelect, [data-select="musicLevelSelect"]').length, 2, 'one select, one segment group');
  assert.deepStrictEqual(t.errors, []);
  t.window.close();
});

test('settings: the level segments write the select and follow a change made elsewhere', () => {
  const t = boot();
  const seg = (v) => t.doc.querySelector(`.segmented[data-select="musicLevelSelect"] .segBtn[data-value="${v}"]`);
  const active = () => [...t.doc.querySelectorAll('.segmented[data-select="musicLevelSelect"] .segBtn.active')].map((b) => b.dataset.value);
  assert.deepStrictEqual(active(), ['low'], 'the default level is marked');
  seg('mid').click();
  assert.strictEqual(t.$('musicLevelSelect').value, 'mid');
  assert.strictEqual(t.window.localStorage.getItem('pikdame_music_level'), 'mid', 'same storage key as the select');
  const sel = t.$('musicLevelSelect');
  sel.value = 'high';
  sel.dispatchEvent(new t.window.Event('change'));
  assert.deepStrictEqual(active(), ['high'], 'the segments follow a change made elsewhere');
  assert.strictEqual(seg('high').getAttribute('aria-pressed'), 'true');
  t.$('langBtn').click();
  assert.deepStrictEqual([...t.doc.querySelectorAll('.segmented[data-select="musicLevelSelect"] .segBtn')].map((b) => b.textContent),
    ['Off', 'Quiet', 'Medium', 'Loud']);
  assert.deepStrictEqual(t.errors, []);
  t.window.close();
});

test('settings: labels follow the language switch', () => {
  const t = boot({ storage: { pikdame_music_track: 'kaffeehaus' } });
  t.$('langBtn').click();
  const labels = (id) => [...t.$(id).options].map((o) => o.textContent);
  assert.deepStrictEqual(labels('musicLevelSelect'), ['Off', 'Quiet', 'Medium', 'Loud']);
  assert.deepStrictEqual(labels('musicTrackSelect'), ['Shuffle', 'Coffee house', 'Lounge bossa', 'Kitten']);
  assert.strictEqual(t.$('musicLevelLabel').textContent, 'Music');
  assert.strictEqual(t.$('musicTrackSelect').value, 'kaffeehaus');
  t.$('langBtn').click();
  assert.strictEqual(t.$('musicLevelLabel').textContent, 'Musik');
  assert.deepStrictEqual(labels('musicTrackSelect'), ['Wechselnd', 'Kaffeehaus', 'Lounge-Bossa', 'Kätzchen']);
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
  assert.match(t.toast(), /Musik läuft leise – ändern unter Optionen › Musik/);
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

test('first gesture: a priority toast on screen keeps the hint for the next start', async () => {
  const t = boot();
  // A server error is a priority toast: it holds the container for its full time.
  t.socket().fire('message', { type: 'error', error: 'Server kaputt' });
  t.doc.dispatchEvent(new t.window.Event('pointerup'));
  await flush();
  assert.ok(t.contexts[0].started.length >= 1, 'the music starts anyway');
  assert.match(t.toast(), /Server kaputt/, 'the priority toast stays');
  assert.strictEqual(t.window.localStorage.getItem('pikdame_music_hint'), null, 'the hint is still owed');
  t.window.close();
});

test('sound effects and music are separate: the label says so, effects off leaves the music playing', async () => {
  const t = boot();
  const effectsLabel = () => t.doc.querySelector('label[for="soundCheckbox"] .prefLabel').textContent;
  assert.strictEqual(effectsLabel(), 'Soundeffekte & Vibration');
  assert.strictEqual(t.doc.querySelectorAll('label[for="soundCheckbox"]').length, 1, 'one switch for the effects');
  // The music rows sit right below the effects.
  assert.strictEqual(t.doc.querySelector('label[for="soundCheckbox"]').nextElementSibling.id, 'musicItem');

  t.doc.dispatchEvent(new t.window.Event('pointerup'));
  await flush();
  const ctx = t.contexts[0];
  assert.ok(ctx.started.length >= 1, 'music plays');
  const box = t.$('soundCheckbox');
  box.checked = false;
  box.dispatchEvent(new t.window.Event('change'));
  assert.strictEqual(t.window.localStorage.getItem('pikdame_sound_enabled'), 'off');
  box.click(); // on again
  box.click(); // and off
  await flush();
  assert.deepStrictEqual(ctx.stopped, [], 'no music source was stopped');
  assert.strictEqual(ctx.state, 'running');
  assert.strictEqual(t.$('musicLevelSelect').value, 'low');
  assert.deepStrictEqual(t.level(), ['low']);

  t.$('langBtn').click();
  assert.strictEqual(effectsLabel(), 'Sound effects & vibration');
  assert.deepStrictEqual(t.errors, []);
  t.window.close();
});

test('fallback: without the player module or Web Audio the music settings hide', () => {
  const noModule = boot({ withPlayer: false });
  assert.ok(noModule.$('musicItem').classList.contains('hidden'));
  assert.deepStrictEqual(noModule.errors, []);
  noModule.window.close();
  const noAudio = boot({ withAudio: false });
  assert.ok(noAudio.$('musicItem').classList.contains('hidden'));
  noAudio.doc.dispatchEvent(new noAudio.window.Event('pointerup'));
  assert.deepStrictEqual(noAudio.errors, []);
  noAudio.window.close();
});
