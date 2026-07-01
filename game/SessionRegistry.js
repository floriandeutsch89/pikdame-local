// game/SessionRegistry.js
// Verwaltung paralleler Spiel-Sessions für den (öffentlich hostbaren) Server.
// Jede Session hat einen kryptographisch zufälligen, kurzen Beitritts-Code -
// NUR wer den Code kennt, kann beitreten. Enthält außerdem die nötigen
// Schutzmechanismen für einen öffentlichen Betrieb: Obergrenze paralleler
// Sessions (Speicher-/DoS-Schutz) und automatisches Aufräumen inaktiver
// Sessions (sonst wächst der Speicher eines lange laufenden Containers
// unbegrenzt).
const crypto = require('crypto');

// Alphabet ohne leicht verwechselbare Zeichen (kein O/0, I/1/L, U/V):
// gut vorlesbar und auf dem Handy tippbar.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTWXYZ23456789';
const CODE_LENGTH = 6;

const DEFAULTS = {
  maxSessions: 200,
  // Session ohne verbundene Spieler wird nach dieser Inaktivität entfernt.
  emptySessionTtlMs: 30 * 60 * 1000, // 30 Minuten
  // Harte Obergrenze, selbst wenn noch jemand verbunden ist (hängende Sockets).
  maxSessionAgeMs: 24 * 60 * 60 * 1000, // 24 Stunden
};

function generateCode() {
  const bytes = crypto.randomBytes(CODE_LENGTH);
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return code;
}

/**
 * Entfernt alles aus Nutzereingaben (Spieler-/Teamnamen), was in HTML-Kontexten
 * gefährlich werden könnte, und begrenzt die Länge. Whitelist statt Blacklist:
 * Buchstaben (inkl. Umlaute), Ziffern, Leerzeichen und wenige harmlose Zeichen.
 */
function sanitizeName(raw, maxLen = 16) {
  if (typeof raw !== 'string') return '';
  const cleaned = raw
    .replace(/[^\p{L}\p{N} ._\-!?]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
  return cleaned;
}

function normalizeCode(raw) {
  if (typeof raw !== 'string') return '';
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, CODE_LENGTH);
}

class SessionRegistry {
  /**
   * @param {(session) => GameManager} createGame - Fabrik, die pro Session
   *   einen GameManager erzeugt (bekommt das Session-Objekt, um sendTo an
   *   die Session-Sockets zu binden).
   * @param {object} options - Limits/TTLs (siehe DEFAULTS), now() injizierbar für Tests.
   */
  constructor(createGame, options = {}) {
    this.createGame = createGame;
    this.options = { ...DEFAULTS, ...options };
    this.now = options.now || (() => Date.now());
    this.sessions = new Map(); // code -> { code, game, sockets: Map<playerId, ws>, createdAt, lastActivity }
  }

  create() {
    if (this.sessions.size >= this.options.maxSessions) {
      return { error: 'Der Server ist derzeit voll - bitte später erneut versuchen.' };
    }
    let code;
    do {
      code = generateCode();
    } while (this.sessions.has(code));

    const session = {
      code,
      sockets: new Map(),
      createdAt: this.now(),
      lastActivity: this.now(),
    };
    session.game = this.createGame(session);
    this.sessions.set(code, session);
    return { session };
  }

  get(rawCode) {
    const code = normalizeCode(rawCode);
    return this.sessions.get(code) || null;
  }

  touch(session) {
    session.lastActivity = this.now();
  }

  delete(code) {
    this.sessions.delete(code);
  }

  /**
   * Entfernt inaktive Sessions. Wird periodisch aufgerufen.
   * Gibt die Anzahl entfernter Sessions zurück.
   */
  cleanup() {
    const now = this.now();
    let removed = 0;
    for (const [code, session] of this.sessions) {
      const connected = [...session.sockets.values()].some((ws) => ws && ws.readyState === 1);
      const idleFor = now - session.lastActivity;
      const age = now - session.createdAt;
      const emptyAndStale = !connected && idleFor > this.options.emptySessionTtlMs;
      const tooOld = age > this.options.maxSessionAgeMs;
      if (emptyAndStale || tooOld) {
        for (const ws of session.sockets.values()) {
          try {
            if (ws && ws.readyState === 1) ws.close();
          } catch (e) {
            /* Socket war schon zu */
          }
        }
        this.sessions.delete(code);
        removed++;
      }
    }
    return removed;
  }

  get size() {
    return this.sessions.size;
  }
}

module.exports = { SessionRegistry, sanitizeName, normalizeCode, generateCode, CODE_ALPHABET, CODE_LENGTH };
