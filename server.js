// server.js
// Leichtgewichtiger Offline-Server für "Pik Dame" - läuft mit reinem Node.js
// `http`-Modul + `ws`-Bibliothek, geeignet für iOS CodeApp / iPhone-Hotspot.
//
// Start: node server.js  (Standardport 8080, override via PORT env var)

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');
const GameManager = require('./game/GameManager');
const { createPlayerStore } = require('./game/PlayerStore');
const { createGlobalStatsStore } = require('./game/GlobalStatsStore');
const { computeEarnedBadges } = require('./game/Badges');
const { createAccountStoreAuto } = require('./game/AccountStore');
const { createMailer } = require('./game/Mailer');
const { createGameHistoryStore } = require('./game/GameHistoryStore');
const { SessionRegistry, sanitizeName } = require('./game/SessionRegistry');

const PORT = process.env.PORT || 8080;
const PUBLIC_DIR = path.join(__dirname, 'public');
const playerStore = createPlayerStore();
const { createChallengeStore, seedForDate, todayUTC } = require('./game/ChallengeStore');
const challengeStore = createChallengeStore();
const globalStats = createGlobalStatsStore();
// Benutzerkonten: aktiv, wenn Nodes eingebautes SQLite verfügbar ist
// (Node >= 22, im Docker-Image gegeben) und nicht per Env abgeschaltet.
// In der iOS CodeApp (ältere Node-Version) liefert die Factory null und
// der Client blendet die komplette Account-UI aus - genau wie gewünscht.
const accountStore = process.env.PIKDAME_ACCOUNTS === '0' ? null : createAccountStoreAuto();
const mailer = createMailer();
const ACCOUNTS_ENABLED = !!accountStore;
if (ACCOUNTS_ENABLED) {
  console.log(`Benutzerkonten: aktiv (Backend: ${accountStore.backend || 'sqlite'}, Mail-Treiber: ${mailer.configured ? 'SMTP' : 'Log-Fallback'})`);
} else {
  console.log('Benutzerkonten: deaktiviert (node:sqlite nicht verfügbar oder PIKDAME_ACCOUNTS=0)');
}
const gameHistoryStore = createGameHistoryStore();

// --- Absturz-Diagnose ------------------------------------------------------
// Schreibt Fehler zusätzlich in eine Log-Datei, falls die Konsole in der
// verwendeten Umgebung (z. B. iOS CodeApp) nicht sichtbar/durchsuchbar ist.
// Liegt im data/-Verzeichnis: im Docker-Betrieb ist das ein Volume, das Log
// überlebt also Container-Neustarts und ist von außen einsehbar.
const DATA_DIR = process.env.PIKDAME_DATA_DIR || path.join(__dirname, 'data');
try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
} catch (e) {
  /* existiert bereits */
}
const CRASH_LOG_FILE = path.join(DATA_DIR, 'crash.log');
function logCrash(context, err, extra = {}) {
  const entry = `[${new Date().toISOString()}] (${context}) ${err && err.stack ? err.stack : err} ${
    Object.keys(extra).length ? JSON.stringify(extra) : ''
  }\n`;
  console.error(entry);
  try {
    fs.appendFileSync(CRASH_LOG_FILE, entry);
  } catch (writeErr) {
    // Wenn nicht mal das Log geschrieben werden kann, zumindest nicht crashen.
    console.error('Konnte crash.log nicht schreiben:', writeErr.message);
  }
}

// Letztes Sicherheitsnetz: verhindert, dass eine unerwartete Exception oder
// eine abgelehnte Promise (z. B. in einem setTimeout-Callback der Bot-Logik)
// den GESAMTEN Serverprozess lautlos beendet. Der Server bleibt am Leben,
// der Fehler landet in crash.log.
process.on('uncaughtException', (err) => {
  logCrash('uncaughtException', err);
});
process.on('unhandledRejection', (reason) => {
  logCrash('unhandledRejection', reason instanceof Error ? reason : new Error(String(reason)));
});

/**
 * Ermittelt alle lokalen IPv4-Adressen des Geräts (ohne 127.0.0.1). Der
 * iPhone-Personal-Hotspot vergibt dem Host praktisch immer 172.20.10.1 aus
 * Apples reserviertem Hotspot-Subnetz - diese Adresse wird speziell markiert,
 * alle anderen gefundenen Adressen werden als mögliche Alternativen gelistet
 * (z. B. bei WLAN statt Hotspot).
 */
function getLocalIPv4Addresses() {
  const interfaces = os.networkInterfaces();
  const addresses = [];
  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal) {
        addresses.push({ name, address: entry.address, isAppleHotspot: entry.address.startsWith('172.20.10.') });
      }
    }
  }
  return addresses;
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// --- Statischer Datei-Server für den Ordner public/ -------------------------

function serveStatic(req, res) {
  let filePath = req.url.split('?')[0];
  if (filePath === '/statusz') {
    // Beobachtbarkeit für den gehosteten Betrieb: Anzahlen + Speicher.
    // Enthält bewusst KEINE Namen/Codes - nur aggregierte Zahlen.
    let players = 0;
    for (const s of registry.sessions.values()) {
      for (const sock of s.sockets.values()) {
        if (sock && sock.readyState === WebSocket.OPEN) players += 1;
      }
    }
    const mem = process.memoryUsage();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        status: 'ok',
        version: APP_VERSION,
        accountsEnabled: ACCOUNTS_ENABLED,
        uptimeSeconds: Math.round(process.uptime()),
        sessions: registry.size,
        connectedPlayers: players,
        rssMb: Math.round(mem.rss / 1024 / 1024),
        heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
        publicMode: PUBLIC_MODE,
        node: process.version,
      })
    );
    return;
  }
  // ---------------- Benutzerkonten-API ----------------
  if (filePath.startsWith('/api/') || filePath === '/verify') {
    // handleAccountRequest ist async: eine unerwartete Exception (z.B. aus
    // SQLite) darf weder als unhandledRejection enden noch die HTTP-Antwort
    // ewig offen lassen - der Client bekommt ein sauberes 500.
    handleAccountRequest(req, res, filePath).catch((err) => {
      logCrash('account-api', err, { path: filePath });
      if (!res.headersSent) sendJson(res, 500, { error: 'Interner Fehler - bitte erneut versuchen.' });
      else res.end();
    });
    return;
  }
  if (filePath === '/changelogz') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(CHANGELOG_TEXT);
    return;
  }
  if (filePath === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('ok');
    return;
  }
  if (filePath === '/') filePath = '/index.html';
  const resolved = path.normalize(path.join(PUBLIC_DIR, filePath));

  // Verhindert Verzeichnis-Traversal außerhalb von public/
  if (!resolved.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Verboten');
    return;
  }

  fs.readFile(resolved, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Nicht gefunden');
      return;
    }
    const ext = path.extname(resolved);
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(serveStatic);

// --- WebSocket-Server ---------------------------------------------------------

// --- Konfiguration für gehosteten Betrieb (alles optional - der
// iPhone-/Hotspot-Betrieb läuft mit den Defaults unverändert) -------------
// PIKDAME_PUBLIC_MODE=1   -> Profile/Teams/Statistik deaktiviert (Fremde
//                            sollen keine Namen/Statistiken anderer sehen)
// PIKDAME_TRUST_PROXY=1   -> Client-IP aus X-Forwarded-For lesen (NUR hinter
//                            eigenem Reverse-Proxy setzen, sonst fälschbar!)
// PIKDAME_ALLOWED_ORIGIN  -> wenn gesetzt: WebSocket-Verbindungen nur von
//                            dieser Origin (z. B. https://spiel.example.org)
const APP_VERSION = require('./package.json').version;
let CHANGELOG_TEXT = '';
try {
  CHANGELOG_TEXT = require('fs').readFileSync(require('path').join(__dirname, 'CHANGELOG.md'), 'utf8');
} catch (e) {
  CHANGELOG_TEXT = `# Changelog\n\nVersion ${APP_VERSION}`;
}

const PUBLIC_MODE = process.env.PIKDAME_PUBLIC_MODE === '1';
const TRUST_PROXY = process.env.PIKDAME_TRUST_PROXY === '1';
const ALLOWED_ORIGIN = process.env.PIKDAME_ALLOWED_ORIGIN || null;
const HEARTBEAT_MS = Number(process.env.PIKDAME_HEARTBEAT_MS) || 30000;

function clientIp(req) {
  if (TRUST_PROXY) {
    const fwd = req.headers['x-forwarded-for'];
    if (typeof fwd === 'string' && fwd.length > 0) return fwd.split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

// IP-basierter Brute-Force-Schutz: Fehlversuche pro IP über ein 15-Minuten-
// Fenster (das frühere Limit pro VERBINDUNG war umgehbar, indem man einfach
// neue Verbindungen öffnet). Map wird periodisch geleert - kein Wachstum.
const FAILED_JOIN_WINDOW_MS = 15 * 60 * 1000;
const FAILED_JOIN_LIMIT = 20;
const failedJoinsByIp = new Map(); // ip -> { count, windowStart }

// ---------------------------------------------------------------------------
// Benutzerkonten: HTTP-API (/api/register, /api/login, /api/logout, /api/me)
// und der Bestätigungslink (GET /verify?token=...). Kleine JSON-Endpunkte,
// bewusst ohne Framework. IP-Rate-Limit gegen Brute-Force/Registrier-Spam.
// ---------------------------------------------------------------------------
const accountApiByIp = new Map(); // ip -> { count, windowStart }
function accountRateLimited(ip) {
  const WINDOW_MS = 10 * 60 * 1000;
  const MAX = 20;
  const now = Date.now();
  let e = accountApiByIp.get(ip);
  if (!e || now - e.windowStart > WINDOW_MS) {
    e = { count: 0, windowStart: now };
    accountApiByIp.set(ip, e);
  }
  e.count += 1;
  return e.count > MAX;
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 10 * 1024) {
        resolve(null); // zu gross
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'));
      } catch (e) {
        resolve(null);
      }
    });
    req.on('error', () => resolve(null));
  });
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

async function handleAccountRequest(req, res, filePath) {
  // GET /verify?token=... - der Link aus der Bestätigungs-Mail (HTML-Antwort)
  if (filePath === '/verify') {
    const url = new URL(req.url, 'http://localhost');
    const result = ACCOUNTS_ENABLED
      ? await accountStore.verifyEmail(url.searchParams.get('token'))
      : { error: 'Konten sind auf diesem Server nicht verfügbar.' };
    const ok = !!result.ok;
    res.writeHead(ok ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!DOCTYPE html><html lang="de"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pik Dame - E-Mail-Bestätigung</title>
<body style="font-family:sans-serif;background:#14171c;color:#eef1f4;display:flex;min-height:100dvh;align-items:center;justify-content:center;text-align:center;padding:20px">
<div><h1>${ok ? '✅ E-Mail bestätigt!' : '❌ Bestätigung fehlgeschlagen'}</h1>
<p>${ok ? `Willkommen, ${result.username}! Du kannst dich jetzt im Spiel anmelden.` : result.error}</p>
<p><a href="/" style="color:#2fd6b0">Zurück zum Spiel</a></p></div></body></html>`);
    return;
  }

  if (!ACCOUNTS_ENABLED) return sendJson(res, 404, { error: 'Konten sind auf diesem Server nicht verfügbar.' });
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'Nur POST.' });
  const ip = req.socket.remoteAddress || '?';
  if (accountRateLimited(ip)) return sendJson(res, 429, { error: 'Zu viele Anfragen - bitte kurz warten.' });
  const body = await readJsonBody(req);
  if (!body) return sendJson(res, 400, { error: 'Ungültige Anfrage.' });

  if (filePath === '/api/register') {
    const r = await accountStore.register(body.username, body.email, body.password);
    if (r.error) return sendJson(res, 400, { error: r.error });
    // Bestätigungslink: Basis-URL aus Env (Docker), sonst aus dem Request
    const base = (process.env.PIKDAME_BASE_URL || `http://${req.headers.host || 'localhost'}`).replace(/\/$/, '');
    const verifyUrl = `${base}/verify?token=${r.verifyToken}`;
    const mail = await mailer.send({
      to: String(body.email).trim(),
      subject: 'Pik Dame: E-Mail-Adresse bestätigen',
      text: `Hallo ${String(body.username).trim()},\n\nwillkommen bei Pik Dame! Bitte bestätige deine E-Mail-Adresse über diesen Link:\n\n${verifyUrl}\n\nDer Link ist 48 Stunden gültig. Falls du dich nicht registriert hast, ignoriere diese Mail einfach.\n`,
    });
    return sendJson(res, 200, { ok: true, mailDelivered: !!mail.delivered });
  }
  if (filePath === '/api/login') {
    const r = await accountStore.login(body.username, body.password);
    if (r.error) return sendJson(res, 401, { error: r.error });
    return sendJson(res, 200, { ok: true, token: r.token, username: r.username });
  }
  if (filePath === '/api/logout') {
    await accountStore.logout(body.token);
    return sendJson(res, 200, { ok: true });
  }
  if (filePath === '/api/me') {
    const u = await accountStore.sessionUser(body.token);
    if (!u) return sendJson(res, 401, { error: 'Nicht angemeldet.' });
    return sendJson(res, 200, { ok: true, username: u.username });
  }
  return sendJson(res, 404, { error: 'Unbekannter Endpunkt.' });
}
function registerFailedJoin(ip) {
  const now = Date.now();
  let entry = failedJoinsByIp.get(ip);
  if (!entry || now - entry.windowStart > FAILED_JOIN_WINDOW_MS) {
    entry = { count: 0, windowStart: now };
    failedJoinsByIp.set(ip, entry);
  }
  entry.count += 1;
  return entry.count;
}
function ipIsBlocked(ip) {
  const entry = failedJoinsByIp.get(ip);
  if (!entry) return false;
  if (Date.now() - entry.windowStart > FAILED_JOIN_WINDOW_MS) return false;
  return entry.count >= FAILED_JOIN_LIMIT;
}
const ipCleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of failedJoinsByIp) {
    if (now - entry.windowStart > FAILED_JOIN_WINDOW_MS) failedJoinsByIp.delete(ip);
  }
  // Auch die Account-API-Zaehler verfallen lassen - sonst wuechse die Map
  // im Docker-Dauerbetrieb mit jeder jemals gesehenen IP unbegrenzt.
  for (const [ip, entry] of accountApiByIp) {
    if (now - entry.windowStart > 10 * 60 * 1000) accountApiByIp.delete(ip);
  }
}, 5 * 60 * 1000);
ipCleanupTimer.unref();

// maxPayload: Schutz vor absichtlich riesigen Nachrichten auf einem
// öffentlichen Server (16 KB reichen für jedes legitime Spielkommando).
const wss = new WebSocket.Server({
  server,
  maxPayload: 16 * 1024,
  verifyClient: ({ origin, req }, done) => {
    // Origin-Check nur, wenn explizit konfiguriert (im LAN/Hotspot ist die
    // Origin variabel - deshalb opt-in).
    if (ALLOWED_ORIGIN && origin && origin !== ALLOWED_ORIGIN) {
      return done(false, 403, 'Origin nicht erlaubt');
    }
    done(true);
  },
});

// --- Heartbeat: Zombie-Verbindungen erkennen -------------------------------
// Im Internet (Mobilfunk, NAT-Timeouts) bleiben Verbindungen oft halb offen,
// ohne dass je ein 'close'-Event kommt. Ohne Heartbeat merkt der Server nie,
// dass ein Spieler weg ist -> markDisconnected feuert nicht -> der Bot
// übernimmt nie und der Tisch wartet ewig. Wer auf den Ping nicht antwortet,
// wird terminiert - terminate() löst 'close' aus und damit die Bot-Übernahme.
const heartbeatTimer = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    try {
      ws.ping();
    } catch (e) {
      /* Socket bereits kaputt - terminate folgt im nächsten Zyklus */
    }
  }
}, HEARTBEAT_MS);
heartbeatTimer.unref();

function sendError(ws, error) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'error', error }));
  }
}

// Jede Session bekommt ihren eigenen GameManager, dessen sendTo NUR die
// Sockets dieser Session erreicht - Spiele sind vollständig voneinander
// isoliert. Profil-/Verlaufs-Stores bleiben pro Server-Instanz geteilt.
const registry = new SessionRegistry((session) => {
  const sendTo = (playerId, message) => {
    const ws = session.sockets.get(playerId);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  };
  return new GameManager(sendTo, {
    deckSeed: typeof session.deckSeed === 'number' ? session.deckSeed : undefined,
    challengeDate: session.challengeDate || undefined,
    // Bot-Emotes gehen denselben Weg wie Spieler-Emotes: an alle am Tisch.
    onBotEmote: (botId, emoji) => {
      for (const [, sock] of session.sockets) {
        if (sock && sock.readyState === WebSocket.OPEN) {
          sock.send(JSON.stringify({ type: 'emote', playerId: botId, emoji }));
        }
      }
    },
    onGameOver: (results, gameRecord) => {
      // Globale Zähler sind ANONYM aggregiert (keine Namen) und daher auch
      // im öffentlichen Modus unbedenklich.
      globalStats.recordGame(gameRecord);
      // Im öffentlichen Modus werden KEINE Namen/Statistiken persistiert -
      // Fremde sollen nichts voneinander sehen, und zwei "Max" aus
      // verschiedenen Gruppen teilen sich kein Profil.
      if (PUBLIC_MODE) return;
      playerStore.recordGameResult(results);
      gameHistoryStore.saveGame(gameRecord);

      // Erfolgs-Badges: pro ECHTEM Spieler aus der Partie berechnen, im
      // Profil persistieren (nur neue) und die frisch verdienten an alle
      // am Tisch melden - der grosse Moment gehoert ins Ergebnis-Overlay.
      const earned = [];
      for (const p of gameRecord.players || []) {
        if (p.isBot) continue;
        const profile = playerStore.getPlayerByName(p.name) || {};
        const deserved = computeEarnedBadges(gameRecord, p.id, profile);
        const fresh = playerStore.awardBadges(p.name, deserved);
        if (fresh.length > 0) earned.push({ name: p.name, badges: fresh });
      }
      if (earned.length > 0) {
        for (const p of gameRecord.players || []) {
          sendTo(p.id, { type: 'badges', earned });
        }
      }

      // Daily challenge: record the human's score and hand out the board.
      if (gameRecord.challengeDate) {
        const human = (gameRecord.players || []).find((p) => !p.isBot);
        if (human) {
          const score = (gameRecord.finalTotals || {})[human.id] || 0;
          const board = challengeStore.submit(gameRecord.challengeDate, human.name, score);
          sendTo(human.id, {
            type: 'challengeBoard',
            date: gameRecord.challengeDate,
            board,
            yourScore: score,
            yourRank: challengeStore.rankOf(gameRecord.challengeDate, human.name),
          });
        }
      }
    },
  });
}, {
  maxSessions: Number(process.env.PIKDAME_MAX_SESSIONS) || 200,
});

// Inaktive Sessions regelmäßig entsorgen (sonst wächst der Speicher eines
// lange laufenden öffentlichen Containers unbegrenzt).
const cleanupTimer = setInterval(() => {
  const removed = registry.cleanup();
  if (removed > 0) console.log(`Session-Cleanup: ${removed} inaktive Session(s) entfernt. Aktiv: ${registry.size}`);
}, 5 * 60 * 1000);
cleanupTimer.unref();

// --- Deployment-feste Sessions -------------------------------------------
// Ein `docker pull && restart` würde sonst alle laufenden Tische abbrechen.
// Beim Shutdown wird der komplette Spielzustand jeder Session auf das
// data/-Volume geschrieben und beim nächsten Start wiederhergestellt - die
// Clients reconnecten automatisch (Session-Code + gespeicherte playerId).
const SNAPSHOT_FILE = path.join(DATA_DIR, 'sessions-snapshot.json');

function writeSessionsSnapshot() {
  try {
    const snapshot = [];
    for (const session of registry.sessions.values()) {
      snapshot.push({
        code: session.code,
        createdAt: session.createdAt,
        lastActivity: session.lastActivity,
        playerTokens: session.playerTokens ? Object.fromEntries(session.playerTokens) : {},
        state: session.game.serialize(),
      });
    }
    fs.writeFileSync(`${SNAPSHOT_FILE}.tmp`, JSON.stringify({ savedAt: Date.now(), sessions: snapshot }), 'utf8');
    fs.renameSync(`${SNAPSHOT_FILE}.tmp`, SNAPSHOT_FILE);
    console.log(`Session-Snapshot geschrieben: ${snapshot.length} Session(s).`);
  } catch (e) {
    console.error('Session-Snapshot fehlgeschlagen:', e.message);
  }
}

function restoreSessionsSnapshot() {
  let raw;
  try {
    raw = fs.readFileSync(SNAPSHOT_FILE, 'utf8');
  } catch (e) {
    return; // kein Snapshot vorhanden - normaler Kaltstart
  }
  try {
    const { sessions } = JSON.parse(raw);
    let restored = 0;
    for (const snap of sessions || []) {
      const session = registry.restore(snap);
      if (!session) continue;
      session.playerTokens = new Map(Object.entries(snap.playerTokens || {}));
      session.game.deserialize(snap.state);
      restored += 1;
    }
    if (restored > 0) console.log(`Session-Restore: ${restored} Session(s) aus dem Snapshot wiederhergestellt.`);
  } catch (e) {
    console.error('Session-Restore fehlgeschlagen (Snapshot wird verworfen):', e.message);
  }
  // Snapshot ist einmalig - danach löschen, damit ein Crash-Loop nicht
  // immer wieder denselben alten Zustand lädt.
  try {
    fs.unlinkSync(SNAPSHOT_FILE);
  } catch (e) {
    /* schon weg */
  }
}
restoreSessionsSnapshot();

function sendProfilesAndTeams(session, playerId) {
  const ws = session.sockets.get(playerId);
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(
      JSON.stringify(
        PUBLIC_MODE
          ? { type: 'profiles', players: [], publicMode: true, globalStats: globalStats.getStats() }
          : { type: 'profiles', players: playerStore.listPlayers(), publicMode: false, globalStats: globalStats.getStats() }
      )
    );
  }
}

wss.on('connection', (ws, req) => {
  let playerId = null;
  let session = null;
  const ip = clientIp(req);

  // Heartbeat-Buchhaltung: Browser antworten auf Protokoll-Pings automatisch.
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  // --- Schutzmechanismen für den öffentlichen Betrieb ---
  // Rate-Limit: mehr als 40 Nachrichten/Sekunde ist kein menschliches Spielen.
  let msgCount = 0;
  const rateTimer = setInterval(() => { msgCount = 0; }, 1000);
  rateTimer.unref();

  // async so that awaited account lookups (Postgres) reject INTO the
  // try/catch below instead of becoming unhandled rejections
  ws.on('message', async (raw) => {
    msgCount += 1;
    if (msgCount > 40) {
      ws.close(1008, 'Zu viele Nachrichten');
      return;
    }

    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (e) {
      return sendError(ws, 'Ungültige Nachricht.');
    }

    try {
      await handleMessage(msg);
    } catch (err) {
      // KRITISCH: Ohne dieses try/catch würde JEDE unerwartete Exception in
      // der Spiellogik (z. B. durch eine kaputte/unerwartete Nachricht) den
      // gesamten Node-Prozess abstürzen lassen (Node killt den Prozess bei
      // unbehandelten Exceptions in Event-Handlern) - für alle Mitspieler
      // gleichzeitig, ohne sichtbare Fehlermeldung. Stattdessen: loggen,
      // dem betroffenen Client eine Fehlermeldung schicken, Server läuft weiter.
      logCrash('message-handler', err, { messageType: msg && msg.type });
      sendError(ws, 'Interner Fehler bei der Verarbeitung - bitte erneut versuchen.');
    }
  });

  async function joinSession(targetSession, msg) {
    // PROGRESS PROTECTION: a name belonging to a verified account may only
    // be used with a valid login token - otherwise anyone could hijack an
    // account's statistics/badges. Async because the Postgres backend
    // queries over the network; the SQLite path resolves immediately.
    if (ACCOUNTS_ENABLED) {
      const wantedName = sanitizeName(msg.name);
      if (await accountStore.isRegisteredName(wantedName)) {
        const session = await accountStore.sessionUser(msg.accountToken);
        if (!session || session.username.toLowerCase() !== String(wantedName).toLowerCase()) {
          sendError(ws, 'Dieser Name gehört zu einem registrierten Konto - bitte zuerst anmelden, um ihn zu verwenden.');
          return;
        }
      }
    }
    // --- Seat protection (anti-cheat) -------------------------------------
    // Player ids are PUBLIC (every state broadcast contains them for
    // rendering), so they must never be sufficient to claim a seat: anyone
    // could read a fellow player's id from the state and open their hand
    // in a second tab. Reclaiming an existing seat therefore requires a
    // secret per-seat token, generated server-side (crypto) and known only
    // to the seat's own browser. Legacy seats without a token (pre-update
    // snapshots) are claimable once by id and upgraded on the spot.
    if (!targetSession.playerTokens) targetSession.playerTokens = new Map();
    const wantsExistingSeat =
      msg.playerId && targetSession.game.players.some((p) => p.id === msg.playerId && !p.isBot);
    if (wantsExistingSeat) {
      const expected = targetSession.playerTokens.get(msg.playerId);
      if (expected && expected !== msg.playerToken) {
        const count = registerFailedJoin(ip); // token guessing counts as a failed join
        if (count >= FAILED_JOIN_LIMIT) {
          ws.close(1008, 'Zu viele Fehlversuche');
          return false;
        }
        sendError(ws, 'Dieser Platz ist geschützt - er gehört einem anderen Gerät.');
        return false;
      }
    }
    playerId = wantsExistingSeat ? msg.playerId : `p-${crypto.randomBytes(9).toString('base64url')}`;
    const player = targetSession.game.addOrReconnectPlayer(playerId, sanitizeName(msg.name));
    if (!player) {
      sendError(ws, 'Tisch ist voll.');
      return false;
    }
    let playerToken = targetSession.playerTokens.get(playerId);
    if (!playerToken) {
      playerToken = crypto.randomBytes(18).toString('base64url');
      targetSession.playerTokens.set(playerId, playerToken);
    }
    session = targetSession;
    session.sockets.set(playerId, ws);
    registry.touch(session);
    ws.send(JSON.stringify({ type: 'joined', playerId, playerToken, sessionCode: session.code }));
    session.game.broadcastState();
    sendProfilesAndTeams(session, playerId);
    return true;
  }

  // Per-connection message throttle: a well-behaved client sends a handful
  // of messages per second at most; a flooding one gets one warning, then
  // the connection closes. O(1) per message - no server-side game cost.
  let msgWindowStart = Date.now();
  let msgWindowCount = 0;
  let floodWarned = false;
  function messageFloodCheck() {
    const now = Date.now();
    if (now - msgWindowStart > 1000) {
      msgWindowStart = now;
      msgWindowCount = 0;
      floodWarned = false;
    }
    msgWindowCount += 1;
    if (msgWindowCount > 25) {
      if (!floodWarned) {
        floodWarned = true;
        sendError(ws, 'Zu viele Aktionen - bitte kurz durchatmen.');
      }
      if (msgWindowCount > 60) ws.close(1008, 'Nachrichtenflut');
      return true;
    }
    return false;
  }

  async function handleMessage(msg) {
    if (messageFloodCheck()) return;
    // --- Session-Verwaltung (einzige Nachrichten OHNE bestehende Session) ---
    if (msg.type === 'startChallenge') {
      // Daily challenge: everyone on the planet gets the identical deck
      // (UTC-date seed) against three medium bots - comparable scores.
      const date = todayUTC();
      const created = registry.create({ deckSeed: seedForDate(date), challengeDate: date });
      if (created.error) return sendError(ws, created.error);
      const ok = await joinSession(created.session, msg);
      if (ok) {
        const game = created.session.game;
        game.setHouseRules({ botDifficulty: 'medium', turnTimerSeconds: 0 });
        game.fillWithBots();
        game.startNewRound();
      }
      return;
    }
    if (msg.type === 'createSession') {
      const created = registry.create();
      if (created.error) return sendError(ws, created.error);
      await joinSession(created.session, msg);
      return;
    }
    if (msg.type === 'joinSession') {
      if (ipIsBlocked(ip)) {
        ws.close(1008, 'Zu viele Fehlversuche');
        return;
      }
      const target = registry.get(msg.code);
      if (!target) {
        // Fehlversuche zählen pro IP (nicht pro Verbindung - das war durch
        // simples Neu-Verbinden umgehbar).
        const count = registerFailedJoin(ip);
        if (count >= FAILED_JOIN_LIMIT) {
          ws.close(1008, 'Zu viele Fehlversuche');
          return;
        }
        return sendError(ws, 'Kein Spiel mit diesem Code gefunden. Bitte Code prüfen.');
      }
      await joinSession(target, msg);
      return;
    }

    // Alles Weitere setzt eine beigetretene Session voraus - ohne gültigen
    // Code gibt es KEINEN Zugriff auf irgendein Spiel.
    if (!session) {
      return sendError(ws, 'Bitte zuerst ein Spiel erstellen oder mit einem Code beitreten.');
    }
    registry.touch(session);
    const game = session.game;

    switch (msg.type) {
      case 'startGame': {
        game.setHouseRules(msg.houseRules || {});
        game.fillWithBots();
        game.startNewRound();
        break;
      }
      case 'setMaxSeats': {
        const r = game.setMaxSeats(msg.count);
        if (r && r.error) sendError(ws, r.error);
        break;
      }
      case 'nextRound': {
        // Ready check: the round continues once every connected human
        // confirmed - nobody gets rushed past the round statistics.
        const r = game.markNextRoundReady(playerId);
        if (r && r.error) sendError(ws, r.error);
        break;
      }
      case 'rematch': {
        // Neue Partie mit denselben (noch verbundenen) Spielern.
        game.prepareRematch();
        break;
      }
      case 'exportLastGame': {
        if (!game.lastGameRecord) {
          sendError(ws, 'Es gibt noch keinen abgeschlossenen Spielverlauf zum Exportieren.');
        } else {
          ws.send(JSON.stringify({ type: 'gameExport', record: game.lastGameRecord }));
        }
        break;
      }
      case 'reorderSeats': {
        const r = game.reorderPlayers(msg.order || []);
        if (r && r.error) sendError(ws, r.error);
        break;
      }
      case 'setDealer': {
        const r = game.setExplicitDealer(msg.playerId);
        if (r && r.error) sendError(ws, r.error);
        break;
      }
      case 'listProfiles': {
        sendProfilesAndTeams(session, playerId);
        break;
      }
      case 'drawFromPile': {
        const r = game.drawFromPile(playerId);
        if (r && r.error) sendError(ws, r.error);
        break;
      }
      case 'drawFromDiscard': {
        const r = game.drawFromDiscard(playerId);
        if (r && r.error) sendError(ws, r.error);
        break;
      }
      case 'layoutMeld': {
        const r = game.layoutMeld(playerId, msg.cardIds, msg.jokerAssignments || {});
        if (r && r.error) sendError(ws, r.error);
        if (r && r.ambiguous) ws.send(JSON.stringify({ type: 'meldAmbiguous', cardIds: msg.cardIds, options: r.options }));
        break;
      }
      case 'layOffMulti': {
        const r = game.layOffCards(playerId, msg.meldId, msg.cardIds);
        if (r && r.error) sendError(ws, r.error);
        break;
      }
      case 'layOff': {
        const r = game.layOffCard(playerId, msg.meldId, msg.cardId, msg.asSuit, msg.side);
        if (r && r.error) sendError(ws, r.error);
        if (r && r.ambiguous) {
          ws.send(JSON.stringify({ type: 'layOffAmbiguous', meldId: msg.meldId, cardId: msg.cardId, options: r.options }));
        }
        break;
      }
      case 'swapJoker': {
        const r = game.swapJoker(playerId, msg.meldId, msg.handCardId);
        if (r && r.error) sendError(ws, r.error);
        break;
      }
      case 'discard': {
        const r = game.discard(playerId, msg.cardId);
        if (r && r.error) sendError(ws, r.error);
        break;
      }
      case 'emote': {
        // Emotes: kurze Reaktionen an den ganzen Tisch. Whitelist + eigenes
        // Rate-Limit (1 Emote / 1,5s), damit niemand den Tisch flutet.
        const EMOTES = ['👍', '😂', '😱', '😤', '🎉', '⏳', 'pikdame'];
        if (!EMOTES.includes(msg.emoji)) break;
        const now = Date.now();
        if (ws._lastEmoteAt && now - ws._lastEmoteAt < 1500) break;
        ws._lastEmoteAt = now;
        for (const [, sock] of session.sockets) {
          if (sock && sock.readyState === WebSocket.OPEN) {
            sock.send(JSON.stringify({ type: 'emote', playerId, emoji: msg.emoji }));
          }
        }
        break;
      }
      case 'setBotDifficulty': {
        const r = game.setBotDifficulty(playerId, msg.botId, msg.difficulty);
        if (r && r.error) sendError(ws, r.error);
        break;
      }
      case 'forfeitRound': {
        const r = game.forfeitRound(playerId);
        if (r && r.error) sendError(ws, r.error);
        break;
      }
      default:
        sendError(ws, `Unbekannter Nachrichtentyp: ${msg.type}`);
    }
  }

  ws.on('close', () => {
    clearInterval(rateTimer);
    if (playerId && session) {
      // Toten Socket sofort aus der Session-Map entfernen (nicht erst beim
      // Session-Cleanup) - sonst sammeln sich bei vielen kurzen Besuchen
      // WebSocket-Objekte an. Ein Reconnect setzt den Eintrag neu.
      if (session.sockets.get(playerId) === ws) {
        session.sockets.delete(playerId);
      }
      session.game.markDisconnected(playerId);
      session.game.broadcastState();
    }
  });
});

// Graceful Shutdown: Docker sendet SIGTERM beim Stoppen des Containers -
// offene Verbindungen sauber schließen statt sie hart zu kappen.
function shutdown(signal) {
  console.log(`${signal} empfangen - Server fährt herunter...`);
  // Laufende Spiele überleben den Neustart; gepufferte Store-Writes landen
  // sicher auf der Platte.
  writeSessionsSnapshot();
  playerStore.flushSync();
  gameHistoryStore.flushSync();
  globalStats.flushSync();
  if (accountStore) {
    try {
      const p = accountStore.close();
      if (p && p.catch) p.catch(() => {});
    } catch (e) { /* never block shutdown */ }
  }
  for (const client of wss.clients) {
    try {
      client.close(1001, 'Server wird neu gestartet');
    } catch (e) {
      /* Socket war schon zu */
    }
  }
  server.close(() => process.exit(0));
  // Falls server.close hängt (offene Keep-Alives): harter Ausstieg nach 5s.
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

server.listen(PORT, () => {
  console.log(`Pik Dame Server läuft auf Port ${PORT}`);
  console.log(`Lokal:    http://localhost:${PORT}`);

  const addresses = getLocalIPv4Addresses();
  if (addresses.length === 0) {
    console.log('Keine Netzwerk-IP gefunden (nur localhost erreichbar - Hotspot/WLAN aktiv?).');
  } else {
    for (const { name, address, isAppleHotspot } of addresses) {
      const label = isAppleHotspot ? ' <- iPhone-Hotspot (üblicher Adressbereich)' : '';
      console.log(`Netzwerk: http://${address}:${PORT}  (${name})${label}`);
    }
  }

  console.log('');
  console.log('⚠️  WICHTIG (iOS-Einschränkung, nicht durch Code behebbar):');
  console.log('    CodeApp muss im VORDERGRUND bleiben, solange gespielt wird!');
  console.log('    iOS pausiert diesen Server komplett, sobald du die App wechselst');
  console.log('    oder das Display sich sperrt. Auto-Sperre auf "Nie" stellen');
  console.log('    (Einstellungen -> Anzeige & Helligkeit) oder Geführten Zugriff');
  console.log('    nutzen (Einstellungen -> Bedienungshilfen).');
  console.log('');
  console.log(`Fehler-Log (falls etwas schiefgeht): ${CRASH_LOG_FILE}`);
});
