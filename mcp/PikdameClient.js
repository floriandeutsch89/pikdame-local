'use strict';

// A seat at a Pik Dame table, driven over the same WebSocket protocol as the
// browser client. It only ever sees what that seat may see.

const WebSocket = require('ws');
const { legalActions } = require('./LegalActions');

const DEFAULT_URL = 'wss://play.pikdame.online';

class PikdameClient {
  constructor({ url = DEFAULT_URL, name = 'Claude', accountToken } = {}) {
    this.url = url;
    this.name = name;
    this.accountToken = accountToken || undefined;
    this.ws = null;
    this.playerId = null;
    this.playerToken = null;
    this.sessionCode = null;
    this.state = null;
    this.stateSeq = 0;
    this.lastError = null;
    this.events = []; // emotes and bot lines since the last read, for table talk
    this._waiters = new Set();
    this._closedByUs = false;
  }

  async _connect() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
    this.ws = new WebSocket(this.url, { headers: { 'User-Agent': 'pikdame-mcp' } });
    await new Promise((resolve, reject) => {
      this.ws.once('open', resolve);
      this.ws.once('error', reject);
    });
    this.ws.on('message', (data) => this._onMessage(data));
    this.ws.on('error', () => {});
    this.ws.on('close', () => {
      if (!this._closedByUs && this.sessionCode) this._reconnectSoon();
      this._notify();
    });
  }

  _reconnectSoon(delay = 1000) {
    const t = setTimeout(async () => {
      try {
        await this._connect();
        this._send({ type: 'joinSession', code: this.sessionCode, name: this.name, playerId: this.playerId, playerToken: this.playerToken, accountToken: this.accountToken });
      } catch (e) {
        if (delay < 30000) this._reconnectSoon(delay * 2);
      }
    }, delay);
    t.unref();
  }

  _onMessage(data) {
    let msg;
    try { msg = JSON.parse(String(data)); } catch (e) { return; }
    switch (msg.type) {
      case 'joined':
        this.playerId = msg.playerId;
        this.playerToken = msg.playerToken;
        this.sessionCode = msg.sessionCode;
        break;
      case 'state':
        this.state = msg.state;
        this.stateSeq++;
        break;
      case 'error':
        this.lastError = { text: msg.error, seq: this.stateSeq, at: Date.now() };
        break;
      case 'emote':
      case 'quip':
        this.events.push(msg);
        if (this.events.length > 30) this.events.shift();
        break;
      default:
        break;
    }
    this._notify();
  }

  _notify() {
    for (const w of [...this._waiters]) w();
  }

  _send(msg) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error('Not connected to the game server.');
    this.ws.send(JSON.stringify(msg));
  }

  /** Resolves with the first truthy `check()` result, or null on timeout. */
  waitFor(check, timeoutMs) {
    const first = check();
    if (first) return Promise.resolve(first);
    return new Promise((resolve) => {
      const done = (v) => { clearTimeout(timer); this._waiters.delete(onChange); resolve(v); };
      const onChange = () => { const v = check(); if (v) done(v); };
      const timer = setTimeout(() => done(null), timeoutMs);
      this._waiters.add(onChange);
    });
  }

  async _enter(msg) {
    await this._connect();
    this.lastError = null;
    const before = this.playerId;
    this._send({ ...msg, name: this.name, accountToken: this.accountToken });
    const r = await this.waitFor(() => (this.lastError ? { error: this.lastError.text } : this.playerId && this.playerId !== before && this.state ? { ok: true } : null), 10000);
    if (!r) throw new Error('The server did not answer.');
    if (r.error) throw new Error(r.error);
    return this.sessionCode;
  }

  createGame() {
    return this._enter({ type: 'createSession' });
  }

  joinGame(code) {
    return this._enter({ type: 'joinSession', code: String(code).trim().toUpperCase() });
  }

  get me() {
    return this.state && this.state.players.find((p) => p.id === this.playerId);
  }

  actions() {
    return legalActions(this.state, this.playerId);
  }

  /** What, if anything, needs this seat now: 'turn', 'gameOver' or null. */
  attention() {
    const s = this.state;
    if (!s) return null;
    if (s.phase === 'gameOver') return 'gameOver';
    return this.actions().some((a) => a.key !== 'ready') ? 'turn' : null;
  }

  /** Sends one action and waits for the server's verdict (new state or error). */
  async perform(action) {
    const seq = this.stateSeq;
    this.lastError = null;
    this._send(action.msg);
    const r = await this.waitFor(() => (this.lastError ? { error: this.lastError.text } : this.stateSeq > seq ? { ok: true } : null), 10000);
    if (!r) return { error: 'No answer from the server within 10 s.' };
    if (r.error) return r;
    // Give a same-tick follow-up state (bots react instantly) a moment to land.
    await new Promise((res) => setTimeout(res, 150));
    return r;
  }

  emote(emoji) {
    this._send({ type: 'emote', emoji });
  }

  drainEvents() {
    const e = this.events;
    this.events = [];
    return e;
  }

  close() {
    this._closedByUs = true;
    if (this.ws) this.ws.close();
  }
}

module.exports = { PikdameClient, DEFAULT_URL };
