// server.js
// Leichtgewichtiger Offline-Server für "Pik Dame" - läuft mit reinem Node.js
// `http`-Modul + `ws`-Bibliothek, geeignet für iOS CodeApp / iPhone-Hotspot.
//
// Start: node server.js  (Standardport 8080, override via PORT env var)

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const GameManager = require('./game/GameManager');
const { createPlayerStore } = require('./game/PlayerStore');
const { createGameHistoryStore } = require('./game/GameHistoryStore');
const { SessionRegistry, sanitizeName } = require('./game/SessionRegistry');

const PORT = process.env.PORT || 8080;
const PUBLIC_DIR = path.join(__dirname, 'public');
const playerStore = createPlayerStore();
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

// maxPayload: Schutz vor absichtlich riesigen Nachrichten auf einem
// öffentlichen Server (16 KB reichen für jedes legitime Spielkommando).
const wss = new WebSocket.Server({ server, maxPayload: 16 * 1024 });

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
    onGameOver: (results, gameRecord) => {
      playerStore.recordGameResult(results);
      gameHistoryStore.saveGame(gameRecord);
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

function sendProfilesAndTeams(session, playerId) {
  const ws = session.sockets.get(playerId);
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'profiles', players: playerStore.listPlayers(), teams: playerStore.listTeams() }));
  }
}

wss.on('connection', (ws) => {
  let playerId = null;
  let session = null;

  // --- Schutzmechanismen für den öffentlichen Betrieb ---
  // Rate-Limit: mehr als 40 Nachrichten/Sekunde ist kein menschliches Spielen.
  let msgCount = 0;
  const rateTimer = setInterval(() => { msgCount = 0; }, 1000);
  rateTimer.unref();
  // Brute-Force-Schutz: wer wiederholt falsche Session-Codes probiert, fliegt.
  let failedJoins = 0;

  ws.on('message', (raw) => {
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
      handleMessage(msg);
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

  function joinSession(targetSession, msg) {
    playerId = msg.playerId || `p-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const player = targetSession.game.addOrReconnectPlayer(playerId, sanitizeName(msg.name));
    if (!player) {
      sendError(ws, 'Tisch ist voll.');
      return false;
    }
    session = targetSession;
    session.sockets.set(playerId, ws);
    registry.touch(session);
    ws.send(JSON.stringify({ type: 'joined', playerId, sessionCode: session.code }));
    session.game.broadcastState();
    sendProfilesAndTeams(session, playerId);
    return true;
  }

  function handleMessage(msg) {
    // --- Session-Verwaltung (einzige Nachrichten OHNE bestehende Session) ---
    if (msg.type === 'createSession') {
      const created = registry.create();
      if (created.error) return sendError(ws, created.error);
      joinSession(created.session, msg);
      return;
    }
    if (msg.type === 'joinSession') {
      const target = registry.get(msg.code);
      if (!target) {
        failedJoins += 1;
        if (failedJoins > 10) {
          ws.close(1008, 'Zu viele Fehlversuche');
          return;
        }
        return sendError(ws, 'Kein Spiel mit diesem Code gefunden. Bitte Code prüfen.');
      }
      joinSession(target, msg);
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
        game.startNewRound();
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
      case 'createTeam': {
        const team = playerStore.createTeam(sanitizeName(msg.name, 24), (msg.memberNames || []).map((n) => sanitizeName(n)));
        sendProfilesAndTeams(session, playerId);
        ws.send(JSON.stringify({ type: 'teamCreated', team }));
        break;
      }
      case 'updateTeam': {
        const team = playerStore.updateTeam(msg.id, {
          name: sanitizeName(msg.name, 24),
          memberNames: (msg.memberNames || []).map((n) => sanitizeName(n)),
        });
        if (!team) {
          sendError(ws, 'Team nicht gefunden.');
        } else {
          sendProfilesAndTeams(session, playerId);
        }
        break;
      }
      case 'deleteTeam': {
        playerStore.deleteTeam(msg.id);
        sendProfilesAndTeams(session, playerId);
        break;
      }
      case 'applyTeam': {
        const teams = playerStore.listTeams();
        const team = teams.find((t) => t.id === msg.teamId);
        if (!team) {
          sendError(ws, 'Team nicht gefunden.');
          break;
        }
        game.fillWithBots();
        // Sanitizing auch hier (Altbestände in players.json könnten vor der
        // Härtung gespeichert worden sein).
        const r = game.applyTeamNames((team.memberNames || []).map((n) => sanitizeName(n)));
        if (r && r.error) sendError(ws, r.error);
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
        const EMOTES = ['👍', '😂', '😱', '😤', '🎉', '🃏'];
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
      session.game.markDisconnected(playerId);
      session.game.broadcastState();
    }
  });
});

// Graceful Shutdown: Docker sendet SIGTERM beim Stoppen des Containers -
// offene Verbindungen sauber schließen statt sie hart zu kappen.
function shutdown(signal) {
  console.log(`${signal} empfangen - Server fährt herunter...`);
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
