// game/PgDocument.js
// Document backends for the stats stores. Same contract as AtomicJsonFile
// (read/write/flushSync), plus load/flush/pendingStatements/status.
const { createWriteBehind } = require('./WriteBehind');

function createPgDocument({ pool, codec, flushDelayMs = 800, log = console }) {
  let doc;
  let loaded = false;
  let persisted = new Map(); // key -> serialized values as last written

  function rowsOf(d) {
    const m = new Map();
    if (d === undefined) return m;
    for (const [key, stmt] of codec.rows(d)) if (!m.has(key)) m.set(key, { stmt, json: JSON.stringify(stmt.values) });
    return m;
  }

  function changes(cur) {
    const out = [];
    if (codec.deleteRow) {
      for (const key of persisted.keys()) {
        if (cur.has(key)) continue;
        const del = codec.deleteRow(key);
        if (del) out.push(del);
      }
    }
    for (const [key, r] of cur) if (persisted.get(key) !== r.json) out.push(r.stmt);
    return out;
  }

  const remember = (cur) => new Map([...cur].map(([k, r]) => [k, r.json]));

  const wb = createWriteBehind({
    pool, name: codec.name, flushDelayMs, log,
    collect() {
      const cur = rowsOf(doc);
      return { statements: changes(cur), token: cur };
    },
    commit(cur) { persisted = remember(cur); },
  });

  return {
    read() {
      if (!loaded) throw new Error(`${codec.name}: read before load()`);
      return doc;
    },
    write(next) {
      if (!loaded) throw new Error(`${codec.name}: write before load()`);
      doc = next;
      wb.markDirty();
    },
    async load() {
      doc = await codec.load(pool);
      loaded = true;
      persisted = remember(rowsOf(doc));
    },
    flush: wb.flush,
    // Crash paths call this synchronously; Postgres can only be asked to start.
    flushSync() { wb.flush().catch(() => {}); },
    pendingStatements() { return loaded && wb.isDirty() ? changes(rowsOf(doc)) : []; },
    status: wb.status,
  };
}

/** No database: play-only, nothing survives a restart. */
function createMemoryDocument() {
  let doc;
  return {
    read: () => doc,
    write(next) { doc = next; },
    async load() {},
    async flush() {},
    flushSync() {},
    pendingStatements: () => [],
    status: () => 'ok',
  };
}

module.exports = { createPgDocument, createMemoryDocument };
