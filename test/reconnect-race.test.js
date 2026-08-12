/**
 * Regressionstest zum Spieler-Report: "Ich wurde aus einem Spiel gekickt und
 * musste dem Bot zuschauen - dabei sah ich alles live und konnte klicken."
 *
 * Ursache war ein Wettlauf: Bei einer Neuverbindung registriert sich der NEUE
 * Socket sofort, das 'close' des ALTEN trifft erst danach ein. Wurde daraufhin
 * ungeprüft markDisconnected() gerufen, galt ein gerade zurückgekehrter
 * Spieler als getrennt - Bildschirm und Klicks funktionierten weiter, aber
 * nach Ablauf der Gnadenfrist übernahm ein Bot seinen Platz.
 *
 * Der Test fährt den ECHTEN Server hoch: Der Fehler lag in der Verdrahtung
 * zwischen WebSocket-Ereignissen und Spielzustand, nicht in einer einzelnen
 * Funktion - eine Attrappe hätte ihn nicht gezeigt.
 */
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const PORT = 8091;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function openSocket() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}`);
    const timer = setTimeout(() => reject(new Error('WebSocket öffnete nicht')), 5000);
    ws.once('open', () => { clearTimeout(timer); resolve(ws); });
    ws.once('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

function waitFor(ws, type, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`keine ${type}-Nachricht`)), timeoutMs);
    const onMsg = (raw) => {
      let m;
      try { m = JSON.parse(raw); } catch (e) { return; }
      if (m.type !== type) return;
      clearTimeout(timer);
      ws.off('message', onMsg);
      resolve(m);
    };
    ws.on('message', onMsg);
  });
}

test('a late close from the OLD socket must not mark a reconnected player as gone', async (t) => {
  const server = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), PIKDAME_PUBLIC_MODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => server.kill());
  await wait(2200); // Server hochfahren lassen

  const first = await openSocket();
  const joinedPromise = waitFor(first, 'joined');
  first.send(JSON.stringify({ type: 'createSession', name: 'Flodex' }));
  const joined = await joinedPromise;

  // Neuverbindung mit denselben Zugangsdaten - wie nach einem Funkloch.
  const second = await openSocket();
  const rejoined = waitFor(second, 'joined');
  second.send(JSON.stringify({
    type: 'joinSession',
    code: joined.sessionCode,
    playerId: joined.playerId,
    playerToken: joined.playerToken,
    name: 'Flodex',
  }));
  await rejoined;

  // Jetzt meldet die ALTE Verbindung ihr close - verspätet.
  first.close();
  await wait(700);

  // Zustand über die NEUE Verbindung anfordern.
  const statePromise = waitFor(second, 'state');
  second.send(JSON.stringify({ type: 'setHouseRules', houseRules: {} }));
  const state = await statePromise;

  const me = state.state.players.find((p) => p.id === joined.playerId);
  assert.ok(me, 'der Spieler sitzt weiterhin am Tisch');
  assert.equal(
    me.connected, true,
    'ein verspätetes close der alten Verbindung darf den zurückgekehrten Spieler nicht als getrennt führen - sonst übernimmt ein Bot seinen Platz'
  );

  second.close();
});
