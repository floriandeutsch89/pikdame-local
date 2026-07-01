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

const PORT = process.env.PORT || 8080;
const PUBLIC_DIR = path.join(__dirname, 'public');
const playerStore = createPlayerStore();
const gameHistoryStore = createGameHistoryStore();

// --- Absturz-Diagnose ------------------------------------------------------
// Schreibt Fehler zusätzlich in eine Log-Datei, falls die Konsole in der
// verwendeten Umgebung (z. B. iOS CodeApp) nicht sichtbar/durchsuchbar ist.
const CRASH_LOG_FILE = path.join(__dirname, 'crash.log');
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

const wss = new WebSocket.Server({ server });

// playerId -> WebSocket (für gezieltes Senden)
const sockets = new Map();

function sendTo(playerId, message) {
  const ws = sockets.get(playerId);
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

function sendError(ws, error) {
  ws.send(JSON.stringify({ type: 'error', error }));
}

const game = new GameManager(sendTo, {
  onGameOver: (results, gameRecord) => {
    playerStore.recordGameResult(results);
    gameHistoryStore.saveGame(gameRecord);
  },
});

function sendProfilesAndTeams(playerId) {
  sendTo(playerId, { type: 'profiles', players: playerStore.listPlayers(), teams: playerStore.listTeams() });
}

wss.on('connection', (ws) => {
  let playerId = null;

  ws.on('message', (raw) => {
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

  function handleMessage(msg) {
    switch (msg.type) {
      case 'join': {
        playerId = msg.playerId || `p-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const player = game.addOrReconnectPlayer(playerId, msg.name);
        if (!player) {
          sendError(ws, 'Tisch ist voll (max. 4 Spieler).');
          return;
        }
        sockets.set(playerId, ws);
        ws.send(JSON.stringify({ type: 'joined', playerId }));
        game.broadcastState();
        sendTo(playerId, { type: 'state', state: game.publicState(playerId) });
        sendProfilesAndTeams(playerId);
        break;
      }
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
          sendTo(playerId, { type: 'gameExport', record: game.lastGameRecord });
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
        sendProfilesAndTeams(playerId);
        break;
      }
      case 'createTeam': {
        const team = playerStore.createTeam(msg.name, msg.memberNames || []);
        sendProfilesAndTeams(playerId);
        sendTo(playerId, { type: 'teamCreated', team });
        break;
      }
      case 'updateTeam': {
        const team = playerStore.updateTeam(msg.id, { name: msg.name, memberNames: msg.memberNames });
        if (!team) {
          sendError(ws, 'Team nicht gefunden.');
        } else {
          sendProfilesAndTeams(playerId);
        }
        break;
      }
      case 'deleteTeam': {
        playerStore.deleteTeam(msg.id);
        sendProfilesAndTeams(playerId);
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
        const r = game.applyTeamNames(team.memberNames);
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
        if (r && r.ambiguous) sendTo(playerId, { type: 'meldAmbiguous', cardIds: msg.cardIds, options: r.options });
        break;
      }
      case 'layOff': {
        const r = game.layOffCard(playerId, msg.meldId, msg.cardId, msg.asSuit, msg.side);
        if (r && r.error) sendError(ws, r.error);
        if (r && r.ambiguous) {
          sendTo(playerId, { type: 'layOffAmbiguous', meldId: msg.meldId, cardId: msg.cardId, options: r.options });
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
    if (playerId) {
      game.markDisconnected(playerId);
      game.broadcastState();
    }
  });
});

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
