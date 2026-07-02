// game/AtomicJsonFile.js
// Nicht-blockierende JSON-Persistenz für den gehosteten Betrieb mit vielen
// parallelen Spielen:
// - LESEN: einmal von der Platte in einen In-Memory-Cache, danach nur RAM.
// - SCHREIBEN: gesammelt (debounced) und ASYNCHRON, damit die Event-Loop
//   nie blockiert (das synchrone Read-Modify-Write bei jedem Partieende
//   fror vorher kurz ALLE laufenden Spiele ein).
// - ATOMAR: erst in eine .tmp-Datei schreiben, dann per rename ersetzen -
//   ein Absturz mitten im Schreiben kann die Datei nicht mehr korrumpieren.
// - flushSync() für den Graceful Shutdown (SIGTERM/SIGINT), damit nichts
//   verloren geht.
// Bewusst dependency-frei (nur fs/path) - läuft unverändert in iOS CodeApp.
const fs = require('fs');
const path = require('path');

function createAtomicJsonFile(filePath, { flushDelayMs = 800 } = {}) {
  let cache;
  let loaded = false;
  let dirty = false;
  let writing = false;
  let timer = null;

  function ensureDir() {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  /** Liest einmal von der Platte, danach ausschließlich aus dem RAM. */
  function read() {
    if (!loaded) {
      try {
        cache = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      } catch (e) {
        cache = undefined; // Datei fehlt/kaputt -> Aufrufer nutzt Default
      }
      loaded = true;
    }
    return cache;
  }

  /** Übernimmt neue Daten in den Cache und plant einen atomaren Write. */
  function write(data) {
    cache = data;
    loaded = true;
    dirty = true;
    clearTimeout(timer);
    timer = setTimeout(writeNow, flushDelayMs);
    if (timer.unref) timer.unref();
  }

  function writeNow() {
    if (!dirty || writing) return;
    dirty = false;
    writing = true;
    ensureDir();
    const tmp = `${filePath}.tmp`;
    const json = JSON.stringify(cache, null, 2);
    fs.writeFile(tmp, json, 'utf8', (err) => {
      if (err) {
        writing = false;
        console.error(`AtomicJsonFile: Schreiben fehlgeschlagen (${filePath}):`, err.message);
        return;
      }
      fs.rename(tmp, filePath, (err2) => {
        writing = false;
        if (err2) {
          console.error(`AtomicJsonFile: rename fehlgeschlagen (${filePath}):`, err2.message);
          return;
        }
        // Falls während des Schreibens erneut Änderungen kamen: nachziehen.
        if (dirty) writeNow();
      });
    });
  }

  /** Synchroner, atomarer Flush - für SIGTERM/SIGINT beim Shutdown. */
  function flushSync() {
    if (!dirty) return;
    dirty = false;
    try {
      ensureDir();
      const tmp = `${filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(cache, null, 2), 'utf8');
      fs.renameSync(tmp, filePath);
    } catch (e) {
      console.error(`AtomicJsonFile: flushSync fehlgeschlagen (${filePath}):`, e.message);
    }
  }

  return { read, write, flushSync };
}

module.exports = { createAtomicJsonFile };
