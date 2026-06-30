// server.js
// Leichtgewichtiger Offline-Server für "Pik Dame" - läuft mit reinem Node.js
// `http`-Modul + `ws`-Bibliothek, geeignet für iOS CodeApp / iPhone-Hotspot.
//
// Start: node server.js  (Standardport 8080, override via PORT env var)

const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const GameManager = require('./game/GameManager');

const PORT = process.env.PORT || 8080;
const PUBLIC_DIR = path.join(__dirname, 'public');

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

const game = new GameManager(sendTo);

wss.on('connection', (ws) => {
  let playerId = null;

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (e) {
      return sendError(ws, 'Ungültige Nachricht.');
    }

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
        break;
      }
      case 'startGame': {
        game.setHouseRules(msg.houseRules || {});
        game.fillWithBots();
        game.startNewRound();
        break;
      }
      case 'nextRound': {
        game.startNewRound();
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
        break;
      }
      case 'layOff': {
        const r = game.layOffCard(playerId, msg.meldId, msg.cardId, msg.asSuit);
        if (r && r.error) sendError(ws, r.error);
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
      default:
        sendError(ws, `Unbekannter Nachrichtentyp: ${msg.type}`);
    }
  });

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
  console.log(`Hotspot:  http://<deine-iPhone-Hotspot-IP>:${PORT}`);
});
