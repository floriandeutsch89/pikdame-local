# Game Stats in the Database Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move every player statistic from the JSON files in `data/` into
PostgreSQL without losing a single stat, and drop the SQLite account backend.

**Architecture:** Each stats store keeps its synchronous document API
(`read()` → mutate → `write(doc)`). A new Postgres document backend
(`PgDocument`) loads the document at startup and writes changed rows in the
background (write-behind, 800 ms). Per-store *codecs* map documents to rows.
Game history is the exception: it is append-only and large, so it gets its
own queue-based Postgres store with async reads. The server boots in this
order: schema → replay pending → import JSON → load → listen. Without a
database the game runs play-only (memory documents, no accounts).

**Tech Stack:** Node ≥ 22, `pg` 8 (already a lazy dependency), `node:test`,
PostgreSQL 18.

**Spec:** `docs/superpowers/specs/2026-10-09-game-stats-in-db-design.md`

## Global Constraints

- No new npm packages. Only `pg`, which is already in `package.json` and
  required lazily.
- **English:** code, comments, identifiers, commits and docs. **German:**
  user-visible texts (admin page, config report). Comments are 1–2 lines and
  explain the why only.
- Times are epoch milliseconds (`BIGINT`), and day keys are
  `'YYYY-MM-DD'` `TEXT`. Never use `DATE` or `TIMESTAMPTZ` in the stats
  schema.
- Store public APIs stay **synchronous**. The only exception is game-history
  reads (`historyFor`, async).
- No caps on profiles, games, Stammtisch tables or challenge days. The
  quest and puzzle 7-day pruning inside a profile stays.
- Postgres tests skip without `PIKDAME_TEST_PG_URL` (CI sets it). Every
  Postgres test runs in its own schema (`test/helpers/pg.js`).
- Exceptions never kill the process (CLAUDE.md constraint 5). Each WS
  handler keeps its try/catch.
- New write paths only go to `data/` (`pending-stats.json`).
- Release: version **3.0.0** with a CHANGELOG section (headings in English,
  content in German).
- Commit with `-c user.name=… -c user.email=…`. Stage only your own files,
  never `git add -A`. Before committing: `rm -f data/*.json data/crash.log`.

## Review Focus

1. **One bad row must not freeze all stats.** A statement that Postgres
   rejects for its data (SQLSTATE 22/23, e.g. a NUL byte or an out-of-range
   number) is retried alone, logged in full, and skipped; the rest commits.
   Tested in Task 3 (`WriteBehind`).
2. **A counter that isn't an integer** (legacy `2.5`, `"7"`) must not be
   lost or crash the insert. It goes into `extra` and loads back unchanged.
   Tested in Task 4.
3. **Bot timers from a restored session can finish a game before stats are
   loaded.** Session restore must run only after `bootStats()`. Tested in
   Task 10 (order assertion via the log).
4. **Corrupt or empty JSON file at import.** An empty file imports as
   nothing and is renamed. A corrupt file refuses the start with the file
   name in the error and stays untouched. Tested in Task 9.
5. **JSONB key reordering** must not make every row look changed after a
   load (the stats would be rewritten every flush). This needs stable
   (sorted-key) JSON serialization. Tested in Task 3 (`stableJson`) and
   Task 4 (no statements after load + flush).

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `game/Db.js` | create | The one `pg` pool for the server (`createPool`), password-file injection |
| `game/SqlRows.js` | create | Pure helpers: `upsert()`, `stableJson()`, `num()`, no `pg` import |
| `game/WriteBehind.js` | create | Flush loop: batching, transaction, backoff, poison-row skip |
| `game/PgDocument.js` | create | `createPgDocument` (document ↔ rows through a codec), `createMemoryDocument` |
| `game/PendingStats.js` | create | Shutdown dump `pending-stats.json` and its replay on start |
| `game/StatsSchema.js` | create | Stats DDL + `ensureStatsSchema(pool)` |
| `game/StatsImport.js` | create | One-time JSON → Postgres import with verification |
| `game/PlayerStore.js` | modify | Backend injection, no profile cap, export `playerCodec` |
| `game/GlobalStatsStore.js` | modify | Backend injection, export `globalStatsCodec` |
| `game/ChallengeStore.js` | modify | Backend injection, no per-day cap, `flushSync`, export `challengeCodec` |
| `game/StammtischStore.js` | modify | Backend injection, no prune or game cap, export `stammtischCodec` |
| `game/GameHistoryStore.js` | modify | `historyFor()`, `createPgGameHistoryStore`, export `gameHistoryCodec` |
| `game/PgAccountStore.js` | modify | Accept a shared `pool` |
| `game/AccountStore.js` | rewrite | Only `createAccountStoreAuto` (Postgres or `null`) |
| `game/ConfigReport.js` | modify | Accounts line without SQLite |
| `server.js` | modify | Pool, backends, `bootStats()`, shutdown flush, `/healthz`, history handler |
| `test/helpers/pg.js` | create | `hasPg`, `freshSchema()` |
| `test/helpers/fake-pool.js` | create | In-memory `pg` pool stand-in for unit tests |
| `test/stats-db.test.js` | create | Db, SqlRows, WriteBehind, PgDocument, PendingStats, schema |
| `test/stats-codecs.test.js` | create | The codecs (unit + Postgres round trips) |
| `test/stats-import.test.js` | create | Import |
| `test/stats-server.test.js` | create | Server boot, no-DB mode, shutdown dump |
| existing tests | modify | Drop SQLite variants, port the server test to Postgres |
| docs, CLAUDE.md, README, CHANGELOG, package.json | modify | Postgres required, 3.0.0 |

---

### Task 1: Shared pool and Postgres test helpers

**Files:**
- Create: `game/Db.js`, `test/helpers/pg.js`, `test/helpers/fake-pool.js`, `test/stats-db.test.js`
- Modify: `game/PgAccountStore.js:108-135` (pool construction), `:751-753` (`close`)

**Interfaces:**
- Produces: `createPool(env, { max }) → Pool | null`, `connectionStringFor(url, password) → string`
- Produces: `createPgAccountStore(databaseUrl, { password, pool })`. With `pool`, `close()` does not end it.
- Produces (tests): `hasPg: boolean`, `freshSchema() → Promise<{ name, url, pool, drop() }>`, `createFakePool() → { connect, query, log, failNext(err), dataStatements() }`

- [ ] **Step 1: Write the test helpers**

`test/helpers/pg.js`:
```js
// Postgres test helpers: each test gets its own schema, dropped afterwards,
// so tests never see each other's rows.
const PG_URL = process.env.PIKDAME_TEST_PG_URL || '';
let hasPg = false;
if (PG_URL) { try { require.resolve('pg'); hasPg = true; } catch (e) { hasPg = false; } }

async function freshSchema() {
  const { Pool } = require('pg');
  const name = `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const admin = new Pool({ connectionString: PG_URL, max: 1 });
  await admin.query(`CREATE SCHEMA ${name}`);
  await admin.end();
  const u = new URL(PG_URL);
  u.search = `options=${encodeURIComponent(`-c search_path=${name}`)}`;
  const url = u.toString();
  const pool = new Pool({ connectionString: url, max: 4 });
  return {
    name, url, pool,
    async drop() {
      await pool.end().catch(() => {});
      const a = new Pool({ connectionString: PG_URL, max: 1 });
      await a.query(`DROP SCHEMA IF EXISTS ${name} CASCADE`);
      await a.end();
    },
  };
}

module.exports = { PG_URL, hasPg, freshSchema };
```

`test/helpers/fake-pool.js`:
```js
// Stand-in for a pg Pool: records every query; failNext(err) makes the next
// data statement (INSERT/UPDATE/DELETE) throw that error.
const DATA = /^\s*(INSERT|UPDATE|DELETE)/i;

function createFakePool() {
  const log = [];
  const failures = [];
  const client = {
    async query(text, values) {
      log.push({ text, values });
      if (DATA.test(text) && failures.length) throw failures.shift();
      return { rows: [] };
    },
    release() {},
  };
  return {
    log,
    failNext(err) { failures.push(err); },
    async connect() { return client; },
    async query(text, values) { return client.query(text, values); },
    dataStatements() { return log.filter((q) => DATA.test(q.text)); },
  };
}

module.exports = { createFakePool };
```

- [ ] **Step 2: Write the failing tests**

`test/stats-db.test.js`:
```js
const test = require('node:test');
const assert = require('node:assert');
const { createPool, connectionStringFor } = require('../game/Db');
const { hasPg, freshSchema } = require('./helpers/pg');

test('Db: no PIKDAME_DATABASE_URL means no pool (play-only)', () => {
  assert.equal(createPool({}), null);
});

test('Db: a password from a secret is injected URL-encoded', () => {
  const s = connectionStringFor('postgres://pikdame@db:5432/pikdame', 'p@ss/w:rd');
  assert.equal(new URL(s).password, encodeURIComponent('p@ss/w:rd'));
  assert.equal(connectionStringFor('postgres://u@h/db', undefined), 'postgres://u@h/db');
});

test('test helper: freshSchema isolates by search_path', { skip: !hasPg && 'needs PIKDAME_TEST_PG_URL' }, async () => {
  const s = await freshSchema();
  try {
    const r = await s.pool.query('SELECT current_schema() AS s');
    assert.equal(r.rows[0].s, s.name);
  } finally { await s.drop(); }
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node --test test/stats-db.test.js`
Expected: FAIL, `Cannot find module '../game/Db'`

- [ ] **Step 4: Implement `game/Db.js`**

```js
// game/Db.js
// The server's single pg pool, shared by accounts and stats. null without
// PIKDAME_DATABASE_URL or without 'pg': the game then runs play-only.
const { readSecret } = require('./secretEnv');

/** A password from a secret file goes into the URL (pg ignores a separate option next to a connectionString). */
function connectionStringFor(databaseUrl, password) {
  if (!password) return databaseUrl;
  const u = new URL(databaseUrl);
  u.password = password;
  return u.toString();
}

function createPool(env = process.env, { max = 10 } = {}) {
  if (!env.PIKDAME_DATABASE_URL) return null;
  let Pool;
  try {
    ({ Pool } = require('pg'));
  } catch (e) {
    console.error("PIKDAME_DATABASE_URL is set but the 'pg' package is unavailable - running play-only.");
    return null;
  }
  const pool = new Pool({
    connectionString: connectionStringFor(env.PIKDAME_DATABASE_URL, readSecret(env, 'PIKDAME_DATABASE_PASSWORD')),
    max,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });
  // A broken idle client must never crash the process.
  pool.on('error', (err) => console.error('Postgres pool error:', err.message));
  return pool;
}

module.exports = { createPool, connectionStringFor };
```

- [ ] **Step 5: Let `PgAccountStore` use a shared pool**

In `game/PgAccountStore.js`, replace the block from `let Pool;` through
`pool.on('error', …);` (lines ~109–133) with:

```js
  let pool = options.pool || null;
  const ownsPool = !pool;
  if (!pool) {
    let Pool;
    try {
      ({ Pool } = require('pg'));
    } catch (e) {
      return null; // pg not installed (e.g. stripped-down environment)
    }
    const { connectionStringFor } = require('./Db');
    pool = new Pool({
      connectionString: connectionStringFor(databaseUrl, options.password),
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });
    // A broken idle client must never crash the process.
    pool.on('error', (err) => console.error('Postgres pool error:', err.message));
  }
```

Then change `close()` (line ~751) to:
```js
  async function close() {
    if (ownsPool) await pool.end().catch(() => {});
  }
```

Make sure the returned object still has `backend: 'postgres'`. If it
doesn't, add `backend: 'postgres',` to it (`grep -n "backend" game/PgAccountStore.js`).

- [ ] **Step 6: Run the tests**

Run: `node --test test/stats-db.test.js test/account-store.test.js`
Expected: PASS. The Postgres tests skip without `PIKDAME_TEST_PG_URL`.

To run them locally:
`docker run -d --name pikdame-testpg -e POSTGRES_USER=pikdame -e POSTGRES_PASSWORD=testpass -e POSTGRES_DB=pikdame_test -p 5432:5432 postgres:18-alpine`,
then `PIKDAME_TEST_PG_URL=postgres://pikdame:testpass@127.0.0.1:5432/pikdame_test node --test test/stats-db.test.js`.

- [ ] **Step 7: Commit**

```bash
git add game/Db.js game/PgAccountStore.js test/helpers/pg.js test/helpers/fake-pool.js test/stats-db.test.js
git commit -m "feat(db): one shared pg pool; Postgres test helpers"
```

---

### Task 2: Stats schema and pure SQL row helpers

**Files:**
- Create: `game/StatsSchema.js`, `game/SqlRows.js`
- Test: `test/stats-db.test.js` (append)

**Interfaces:**
- Produces: `ensureStatsSchema(q) → Promise<void>` (q = pool or client), `STATS_TABLES: string[]`
- Produces: `upsert(table, columns, keyColumns, values) → { text, values }`, `stableJson(value) → string|null`, `num(v) → number|undefined`, `json(v) → any|undefined`

- [ ] **Step 1: Write the failing tests** (append to `test/stats-db.test.js`)

```js
const { upsert, stableJson, num } = require('../game/SqlRows');
const { ensureStatsSchema, STATS_TABLES } = require('../game/StatsSchema');

test('SqlRows: upsert builds an ON CONFLICT statement', () => {
  const s = upsert('kv', ['k', 'v'], ['k'], ['a', 1]);
  assert.equal(s.text, 'INSERT INTO kv (k, v) VALUES ($1, $2) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v');
  assert.deepEqual(s.values, ['a', 1]);
  assert.match(upsert('kv', ['k'], ['k'], ['a']).text, /DO NOTHING$/);
});

test('SqlRows: stableJson sorts keys, strips NUL, keeps null for undefined', () => {
  assert.equal(stableJson({ b: 1, a: { d: 2, c: [3, { z: 1, y: 2 }] } }), '{"a":{"c":[3,{"y":2,"z":1}],"d":2},"b":1}');
  assert.equal(stableJson({ n: 'a\u0000b' }), '{"n":"ab"}');
  assert.equal(stableJson(undefined), null);
});

test('SqlRows: NUL bytes are stripped from text values', () => {
  assert.deepEqual(upsert('kv', ['k', 'v'], ['k'], ['a\u0000b', 1]).values, ['ab', 1]);
});

test('SqlRows: num parses BIGINT strings and keeps null as undefined', () => {
  assert.equal(num('9007199254740991'), 9007199254740991);
  assert.equal(num(null), undefined);
});

test('StatsSchema: creates all tables and is idempotent', { skip: !hasPg && 'needs PIKDAME_TEST_PG_URL' }, async () => {
  const s = await freshSchema();
  try {
    await ensureStatsSchema(s.pool);
    await ensureStatsSchema(s.pool);
    const r = await s.pool.query('SELECT table_name FROM information_schema.tables WHERE table_schema = $1', [s.name]);
    assert.deepEqual(r.rows.map((x) => x.table_name).sort(), [...STATS_TABLES].sort());
  } finally { await s.drop(); }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/stats-db.test.js`
Expected: FAIL, `Cannot find module '../game/SqlRows'`

- [ ] **Step 3: Implement `game/SqlRows.js`**

```js
// game/SqlRows.js
// Pure helpers that turn store documents into SQL rows. No pg import: the
// codecs that use this must also load in a database-free test.

const stripNul = (s) => s.replace(/\u0000/g, ''); // Postgres TEXT/JSONB reject NUL

function sortKeys(v) {
  if (typeof v === 'string') return stripNul(v);
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v instanceof Date) return v.toISOString();
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) if (v[k] !== undefined) out[stripNul(k)] = sortKeys(v[k]);
    return out;
  }
  return v;
}

/** JSON with sorted keys: JSONB reorders keys, so only stable text can tell "changed" from "loaded". */
function stableJson(value) {
  return value === undefined ? null : JSON.stringify(sortKeys(value));
}

function upsert(table, columns, keyColumns, values) {
  const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
  const set = columns.filter((c) => !keyColumns.includes(c)).map((c) => `${c} = EXCLUDED.${c}`).join(', ');
  return {
    text: `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders}) ON CONFLICT (${keyColumns.join(', ')}) DO ${set ? `UPDATE SET ${set}` : 'NOTHING'}`,
    values: values.map((v) => (typeof v === 'string' ? stripNul(v) : v)),
  };
}

/** pg returns BIGINT as string; NULL means "never set" and becomes undefined. */
function num(v) {
  return v === null || v === undefined ? undefined : Number(v);
}

/** JSONB NULL → undefined, everything else as parsed by pg. */
function json(v) {
  return v === null || v === undefined ? undefined : v;
}

module.exports = { upsert, stableJson, num, json };
```

- [ ] **Step 4: Implement `game/StatsSchema.js`**

```js
// game/StatsSchema.js
// Stats tables (see docs/superpowers/specs/2026-10-09-game-stats-in-db-design.md).
// Times are epoch ms, days 'YYYY-MM-DD' text: pg would turn DATE into a local Date.
const STATS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS player_profiles (
    name_key TEXT PRIMARY KEY,
    seq BIGINT GENERATED ALWAYS AS IDENTITY,
    name TEXT NOT NULL,
    profile_id TEXT,
    games_played INT, games_won INT, games_lost INT, total_score BIGINT,
    win_streak INT, best_game_score INT, best_round_score INT,
    total_queens_laid INT, total_queens_caught INT, total_jokers_laid INT,
    total_hand_aus INT, last_place_streak INT, total_challenges INT,
    total_stammtisch_games INT, total_puzzles_solved INT, xp BIGINT, daily_streak INT,
    badges JSONB, favorite_badges JSONB, seasonal_backs JSONB,
    quests JSONB, daily JSONB, puzzles JSONB,
    extra JSONB
  );
  CREATE TABLE IF NOT EXISTS game_records (
    id TEXT PRIMARY KEY,
    finished_at BIGINT,
    record JSONB NOT NULL
  );
  CREATE INDEX IF NOT EXISTS game_records_finished ON game_records (finished_at DESC);
  CREATE TABLE IF NOT EXISTS game_record_players (
    game_id TEXT NOT NULL REFERENCES game_records(id) ON DELETE CASCADE,
    seat SMALLINT NOT NULL,
    name_key TEXT NOT NULL,
    is_bot BOOLEAN NOT NULL,
    PRIMARY KEY (game_id, seat)
  );
  CREATE INDEX IF NOT EXISTS game_record_players_name ON game_record_players (name_key) WHERE NOT is_bot;
  CREATE TABLE IF NOT EXISTS challenge_scores (
    day TEXT NOT NULL, name_key TEXT NOT NULL, name TEXT NOT NULL,
    score INT NOT NULL, at BIGINT NOT NULL,
    PRIMARY KEY (day, name_key)
  );
  CREATE TABLE IF NOT EXISTS stammtisch_tables (
    code TEXT PRIMARY KEY, name TEXT, owner TEXT,
    created_at BIGINT, last_activity BIGINT,
    members JSONB NOT NULL, series JSONB, extra JSONB
  );
  CREATE TABLE IF NOT EXISTS stammtisch_games (
    code TEXT NOT NULL REFERENCES stammtisch_tables(code) ON DELETE CASCADE,
    idx INT NOT NULL,
    at BIGINT, series_no INT, players JSONB NOT NULL, extra JSONB,
    PRIMARY KEY (code, idx)
  );
  CREATE TABLE IF NOT EXISTS global_stats (
    id BOOLEAN PRIMARY KEY CHECK (id),
    games BIGINT NOT NULL, rounds BIGINT NOT NULL, pik_dames_laid_out BIGINT NOT NULL,
    pik_dames_caught BIGINT NOT NULL, hand_aus_rounds BIGINT NOT NULL
  );
`;

const STATS_TABLES = ['player_profiles', 'game_records', 'game_record_players', 'challenge_scores',
  'stammtisch_tables', 'stammtisch_games', 'global_stats'];

async function ensureStatsSchema(q) {
  await q.query(STATS_SCHEMA);
}

module.exports = { ensureStatsSchema, STATS_TABLES, STATS_SCHEMA };
```

- [ ] **Step 5: Run the tests**

Run: `node --test test/stats-db.test.js`
Expected: PASS (the schema test skips without Postgres).

- [ ] **Step 6: Commit**

```bash
git add game/SqlRows.js game/StatsSchema.js test/stats-db.test.js
git commit -m "feat(stats): stats schema and pure SQL row helpers"
```

---

### Task 3: Write-behind loop, Postgres document, pending dump

**Files:**
- Create: `game/WriteBehind.js`, `game/PgDocument.js`, `game/PendingStats.js`
- Test: `test/stats-db.test.js` (append)

**Interfaces:**
- Consumes: `upsert`, `stableJson` (Task 2), `createFakePool`, `freshSchema` (Task 1)
- Produces: `runInTransaction(pool, statements)`, `isDataError(err)`, `createWriteBehind({ pool, name, collect, commit, flushDelayMs, log }) → { markDirty(), flush(): Promise, status(): 'ok'|'degraded', isDirty(): boolean }`
- Produces: **the codec contract** used by Tasks 4–8:
  ```
  codec = {
    name: string,                    // log label
    table: string,                   // main table; import checks it is empty
    normalize(parsed) → doc,         // JSON file content → document (as the store's own loader)
    rows(doc) → Iterable<[key, {text, values}]>,   // deterministic; table rows before their child rows
    deleteRow?(key) → {text, values} | null,       // only for rows that may disappear
    load(q, { all } = {}) → Promise<doc>,          // q = pool or client
  }
  ```
- Produces: `createPgDocument({ pool, codec, flushDelayMs?, log? })` and `createMemoryDocument()`. Both return `{ read(), write(doc), flushSync(), load(): Promise, flush(): Promise, pendingStatements(): Statement[], status() }`.
- Produces: `writePending(file, statements) → boolean`, `replayPending(pool, file) → Promise<number>`

- [ ] **Step 1: Write the failing tests** (append to `test/stats-db.test.js`)

```js
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createFakePool } = require('./helpers/fake-pool');
const { createWriteBehind } = require('../game/WriteBehind');
const { createPgDocument, createMemoryDocument } = require('../game/PgDocument');
const { writePending, replayPending } = require('../game/PendingStats');

// A tiny codec: { items: { key: number } } <-> table kv(k, v).
const kvCodec = {
  name: 'kv',
  table: 'kv',
  normalize: (p) => ({ items: (p && p.items) || {} }),
  *rows(doc) { for (const [k, v] of Object.entries(doc.items)) yield [k, upsert('kv', ['k', 'v'], ['k'], [k, v])]; },
  deleteRow: (k) => ({ text: 'DELETE FROM kv WHERE k = $1', values: [k] }),
  async load(q) {
    const r = await q.query('SELECT k, v FROM kv ORDER BY k');
    return { items: Object.fromEntries((r.rows || []).map((x) => [x.k, x.v])) };
  },
};
const quiet = { log() {}, error() {} };

test('PgDocument: read before load throws (stats must be loaded before serving)', () => {
  const d = createPgDocument({ pool: createFakePool(), codec: kvCodec, log: quiet });
  assert.throws(() => d.read(), /before load/);
});

test('PgDocument: flush writes only rows that changed since the last flush', async () => {
  const pool = createFakePool();
  const d = createPgDocument({ pool, codec: kvCodec, flushDelayMs: 60000, log: quiet });
  await d.load();
  assert.equal(pool.dataStatements().length, 0, 'loading writes nothing');
  d.write({ items: { a: 1, b: 2 } });
  await d.flush();
  assert.equal(pool.dataStatements().length, 2);
  const doc = d.read();
  doc.items.b = 3;
  d.write(doc);
  await d.flush();
  const last = pool.dataStatements().slice(2);
  assert.equal(last.length, 1);
  assert.deepEqual(last[0].values, ['b', 3]);
  await d.flush();
  assert.equal(pool.dataStatements().length, 3, 'nothing dirty, nothing written');
});

test('PgDocument: vanished rows are deleted only when the codec allows it', async () => {
  const pool = createFakePool();
  const d = createPgDocument({ pool, codec: kvCodec, flushDelayMs: 60000, log: quiet });
  await d.load();
  d.write({ items: { a: 1, b: 2 } });
  await d.flush();
  d.write({ items: { a: 1 } });
  await d.flush();
  assert.match(pool.dataStatements().at(-1).text, /^DELETE FROM kv/);
  const keep = createPgDocument({ pool: createFakePool(), codec: { ...kvCodec, deleteRow: undefined }, flushDelayMs: 60000, log: quiet });
  await keep.load();
  keep.write({ items: { a: 1 } });
  await keep.flush();
  keep.write({ items: {} });
  await keep.flush();
  assert.deepEqual(keep.pendingStatements(), []);
});

test('PgDocument: a failed flush keeps the rows, reports degraded, and retries', async () => {
  const pool = createFakePool();
  const d = createPgDocument({ pool, codec: kvCodec, flushDelayMs: 60000, log: quiet });
  await d.load();
  pool.failNext(Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' }));
  d.write({ items: { a: 1 } });
  await assert.rejects(d.flush(), /connection refused/);
  assert.equal(d.status(), 'degraded');
  assert.equal(d.pendingStatements().length, 1, 'unsaved row is still pending');
  await d.flush();
  assert.equal(d.status(), 'ok');
  assert.deepEqual(d.pendingStatements(), []);
  assert.deepEqual(pool.dataStatements().at(-1).values, ['a', 1]);
});

test('PgDocument: writes flush by themselves after the delay', async () => {
  const pool = createFakePool();
  const d = createPgDocument({ pool, codec: kvCodec, flushDelayMs: 10, log: quiet });
  await d.load();
  d.write({ items: { a: 1 } });
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(pool.dataStatements().length, 1);
});

test('WriteBehind: one row Postgres rejects is skipped and logged, the rest commits', async () => {
  const pool = createFakePool();
  const errors = [];
  const stmts = [{ text: 'INSERT INTO kv VALUES ($1)', values: ['bad'] }, { text: 'INSERT INTO kv VALUES ($1)', values: ['good'] }];
  let committed = 0;
  const wb = createWriteBehind({
    pool, name: 'kv', flushDelayMs: 60000, log: { log() {}, error: (m) => errors.push(m) },
    collect: () => ({ statements: stmts, token: 1 }), commit: () => { committed += 1; },
  });
  // Batch fails on 'bad' (data error), then one by one: 'bad' fails again, 'good' passes.
  pool.failNext(Object.assign(new Error('invalid input'), { code: '22P02' }));
  pool.failNext(Object.assign(new Error('invalid input'), { code: '22P02' }));
  wb.markDirty();
  await wb.flush();
  assert.equal(committed, 1);
  assert.equal(wb.status(), 'ok');
  assert.match(errors.join('\n'), /rejected a statement, skipped.*bad/);
  assert.deepEqual(pool.dataStatements().at(-1).values, ['good']);
});

test('MemoryDocument: same interface, RAM only', async () => {
  const d = createMemoryDocument();
  assert.equal(d.read(), undefined);
  d.write({ x: 1 });
  assert.deepEqual(d.read(), { x: 1 });
  await d.flush();
  assert.deepEqual(d.pendingStatements(), []);
  assert.equal(d.status(), 'ok');
});

test('PendingStats: dump on shutdown, replay in order on start, file removed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pikpend-'));
  const file = path.join(dir, 'pending-stats.json');
  assert.equal(writePending(file, []), false, 'nothing pending, no file');
  assert.equal(fs.existsSync(file), false);
  const stmts = [upsert('kv', ['k', 'v'], ['k'], ['a', 1]), upsert('kv', ['k', 'v'], ['k'], ['b', 2])];
  assert.equal(writePending(file, stmts), true);
  const pool = createFakePool();
  assert.equal(await replayPending(pool, file), 2);
  assert.deepEqual(pool.dataStatements().map((q) => q.values), [['a', 1], ['b', 2]]);
  assert.equal(fs.existsSync(file), false);
  assert.equal(await replayPending(pool, file), 0, 'no file, nothing to do');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('PgDocument: round trip through Postgres', { skip: !hasPg && 'needs PIKDAME_TEST_PG_URL' }, async () => {
  const s = await freshSchema();
  try {
    await s.pool.query('CREATE TABLE kv (k TEXT PRIMARY KEY, v INT)');
    const d = createPgDocument({ pool: s.pool, codec: kvCodec, log: quiet });
    await d.load();
    d.write({ items: { a: 1, b: 2 } });
    await d.flush();
    const d2 = createPgDocument({ pool: s.pool, codec: kvCodec, log: quiet });
    await d2.load();
    assert.deepEqual(d2.read(), { items: { a: 1, b: 2 } });
  } finally { await s.drop(); }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/stats-db.test.js`
Expected: FAIL, `Cannot find module '../game/WriteBehind'`

- [ ] **Step 3: Implement `game/WriteBehind.js`**

```js
// game/WriteBehind.js
// Shared flush loop of the Postgres stats backends: batch, one transaction,
// retry with backoff. Only rows Postgres rejects for their DATA are skipped.
const BACKOFF_MS = [1000, 2000, 5000, 10000, 30000];

async function runInTransaction(pool, statements) {
  if (statements.length === 0) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const s of statements) await client.query(s.text, s.values);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// SQLSTATE class 22 (data exception) / 23 (constraint): a retry cannot help.
function isDataError(err) {
  return !!(err && typeof err.code === 'string' && /^2[23]/.test(err.code));
}

function createWriteBehind({ pool, name, collect, commit, flushDelayMs = 800, log = console }) {
  let dirty = false;
  let timer = null;
  let running = null;
  let failures = 0;

  function schedule(ms) {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      flush().catch(() => {}); // logged in flush; retried by its backoff
    }, ms);
    if (timer.unref) timer.unref();
  }

  function markDirty() {
    dirty = true;
    schedule(flushDelayMs);
  }

  async function writeOnce() {
    dirty = false;
    const { statements, token } = collect(); // synchronous snapshot
    try {
      await runInTransaction(pool, statements);
    } catch (e) {
      if (!isDataError(e)) throw e;
      // One bad row must not block every other stat forever.
      for (const s of statements) {
        try {
          await runInTransaction(pool, [s]);
        } catch (e2) {
          if (!isDataError(e2)) throw e2;
          log.error(`[stats] ${name}: Postgres rejected a statement, skipped: ${e2.message} ${JSON.stringify(s)}`);
        }
      }
    }
    commit(token);
  }

  async function flush() {
    while (running) await running.catch(() => {});
    if (!dirty) return;
    running = writeOnce();
    try {
      await running;
      if (failures > 0) log.log(`[stats] ${name}: database reachable again`);
      failures = 0;
    } catch (e) {
      dirty = true;
      failures += 1;
      if (failures === 1) log.error(`[stats] ${name}: write failed, will retry: ${e.message}`);
      schedule(BACKOFF_MS[Math.min(failures, BACKOFF_MS.length) - 1]);
      throw e;
    } finally {
      running = null;
    }
  }

  return {
    markDirty,
    flush,
    status: () => (failures > 0 ? 'degraded' : 'ok'),
    isDirty: () => dirty || !!running,
  };
}

module.exports = { createWriteBehind, runInTransaction, isDataError };
```

- [ ] **Step 4: Implement `game/PgDocument.js`**

```js
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
```

- [ ] **Step 5: Implement `game/PendingStats.js`**

```js
// game/PendingStats.js
// Statements still unsaved at shutdown go to data/pending-stats.json and are
// replayed (upserts, idempotent) before anything else on the next start.
const fs = require('fs');
const path = require('path');
const { runInTransaction } = require('./WriteBehind');

function writePending(file, statements) {
  if (!statements.length) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, statements }), 'utf8');
  fs.renameSync(tmp, file);
  return true;
}

async function replayPending(pool, file) {
  if (!fs.existsSync(file)) return 0;
  const { statements } = JSON.parse(fs.readFileSync(file, 'utf8'));
  await runInTransaction(pool, statements);
  fs.unlinkSync(file);
  return statements.length;
}

module.exports = { writePending, replayPending };
```

- [ ] **Step 6: Run the tests**

Run: `node --test test/stats-db.test.js`
Expected: PASS. Also run once with `PIKDAME_TEST_PG_URL`.

- [ ] **Step 7: Commit**

```bash
git add game/WriteBehind.js game/PgDocument.js game/PendingStats.js test/stats-db.test.js
git commit -m "feat(stats): write-behind Postgres document backend with pending dump"
```

---

### Task 4: Player profiles in Postgres

**Files:**
- Modify: `game/PlayerStore.js` (constructor lines 28–31; cap lines 100–106; return block 294–312; exports line 315)
- Test: `test/stats-codecs.test.js` (create)

**Interfaces:**
- Consumes: codec contract, `createPgDocument` (Task 3), `upsert`/`stableJson`/`num`/`json` (Task 2), `ensureStatsSchema`
- Produces: `createPlayerStore(backend)`, where `backend` is a file path string (`AtomicJsonFile`, for tests and tools) or a document object (Task 3). The store gains `flush()`, `pendingStatements()` and `status()`.
- Produces: `playerCodec` (table `player_profiles`)

- [ ] **Step 1: Write the failing tests**

`test/stats-codecs.test.js`:
```js
const test = require('node:test');
const assert = require('node:assert');
const { hasPg, freshSchema } = require('./helpers/pg');
const { ensureStatsSchema } = require('../game/StatsSchema');
const { createPgDocument, createMemoryDocument } = require('../game/PgDocument');
const { createPlayerStore, playerCodec } = require('../game/PlayerStore');

const PG = !hasPg && 'needs PIKDAME_TEST_PG_URL';
const quiet = { log() {}, error() {} };
const rowsOf = (codec, doc) => [...codec.rows(doc)];

/** write -> flush -> a fresh document loads it again. */
async function roundTrip(codec, doc, loadOpts) {
  const s = await freshSchema();
  try {
    await ensureStatsSchema(s.pool);
    const d = createPgDocument({ pool: s.pool, codec, log: quiet });
    await d.load();
    d.write(doc);
    await d.flush();
    const again = await codec.load(s.pool, loadOpts);
    const d2 = createPgDocument({ pool: s.pool, codec, log: quiet });
    await d2.load();
    d2.write(d2.read());
    return { again, rewritten: d2.pendingStatements() };
  } finally { await s.drop(); }
}

const FULL_PROFILE = {
  id: 'profile-1', name: 'Oma Inge', gamesPlayed: 7, gamesWon: 3, totalScore: 900, gamesLost: 4,
  winStreak: 0, bestGameScore: 400, bestRoundScore: 120, totalQueensLaid: 2, totalQueensCaught: 1,
  totalJokersLaid: 5, totalHandAus: 1, lastPlaceStreak: 0, totalChallenges: 2, totalStammtischGames: 1,
  totalPuzzlesSolved: 3, xp: 420, dailyStreak: 2,
  badges: { first_win: 1700000000000 }, favoriteBadges: ['first_win'], seasonalBacks: { winter: '2026-01-02' },
  quests: { '2026-10-09': { play3: 2 } }, daily: { streak: 2, best: 5, last: '2026-10-09' },
  puzzles: { '2026-10-09': { tries: 1, solved: true, revealed: false } },
  teams: ['legacy'], // unknown field from an old file - must survive
};

test('playerCodec: one row per lower-case name, first one wins', () => {
  const rows = rowsOf(playerCodec, { players: [{ name: 'Anna' }, { name: 'anna', gamesPlayed: 9 }, { name: 'Bo' }] });
  assert.deepEqual(rows.map(([k]) => k), ['anna', 'bo']);
});

test('playerCodec: a counter that is not an integer goes to extra, not lost', () => {
  const [[, stmt]] = rowsOf(playerCodec, { players: [{ name: 'X', gamesPlayed: 2.5, xp: '7' }] });
  const extra = JSON.parse(stmt.values.at(-1));
  assert.deepEqual(extra, { gamesPlayed: 2.5, xp: '7' });
});

test('PlayerStore: no profile cap any more', () => {
  const store = createPlayerStore(createMemoryDocument());
  for (let i = 0; i < 520; i++) store.recordGameResult([{ name: `P${i}`, score: 1, won: false }]);
  assert.equal(store.listPlayers().length, 520);
});

test('PlayerStore on Postgres: every field round-trips, a load rewrites nothing', { skip: PG }, async () => {
  const { again, rewritten } = await roundTrip(playerCodec, { players: [FULL_PROFILE, { id: 'profile-2', name: 'Neu', gamesPlayed: 0, gamesWon: 0, totalScore: 0 }] });
  assert.deepEqual(again.players[0], FULL_PROFILE);
  assert.equal(again.players[1].name, 'Neu');
  assert.equal(again.players[1].bestGameScore, undefined, 'never-set stays undefined');
  assert.deepEqual(rewritten, [], 'JSONB key order must not look like a change');
});

test('playerCodec: non-integer counters round-trip through extra', { skip: PG }, async () => {
  const { again } = await roundTrip(playerCodec, { players: [{ name: 'X', gamesPlayed: 2.5, xp: '7' }] });
  assert.equal(again.players[0].gamesPlayed, 2.5);
  assert.equal(again.players[0].xp, '7');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/stats-codecs.test.js`
Expected: FAIL, `playerCodec` is undefined (`TypeError: … rows`)

- [ ] **Step 3: Make the store take a backend and drop the cap**

In `game/PlayerStore.js`, replace lines 28–31 with:
```js
function createPlayerStore(backend = DEFAULT_DATA_FILE) {
  // A path = atomic JSON file (tests, tools); the server passes a document
  // backend (Postgres, or memory without a database).
  const file = typeof backend === 'string' ? createAtomicJsonFile(backend) : backend;
  const filePath = typeof backend === 'string' ? backend : null;
```

Delete the cap block (lines 100–106, from `// Cap gegen unbegrenztes Wachstum`
through the closing `}` of `if (store.players.length > MAX_PROFILES)`).

In the returned object (line ~294), replace `flushSync: file.flushSync,` with:
```js
    flushSync: file.flushSync,
    flush: file.flush || (async () => {}),
    pendingStatements: file.pendingStatements || (() => []),
    status: file.status || (() => 'ok'),
```

- [ ] **Step 4: Add the codec** (above `module.exports` in `game/PlayerStore.js`)

```js
// --- Postgres codec (see game/PgDocument.js) --------------------------------
const { upsert, stableJson, num, json } = require('./SqlRows');

// [profile field, column, kind]; a field not listed here is kept in `extra`.
const PROFILE_COLUMNS = [
  ['gamesPlayed', 'games_played', 'int'], ['gamesWon', 'games_won', 'int'], ['gamesLost', 'games_lost', 'int'],
  ['totalScore', 'total_score', 'int'], ['winStreak', 'win_streak', 'int'], ['bestGameScore', 'best_game_score', 'int'],
  ['bestRoundScore', 'best_round_score', 'int'], ['totalQueensLaid', 'total_queens_laid', 'int'],
  ['totalQueensCaught', 'total_queens_caught', 'int'], ['totalJokersLaid', 'total_jokers_laid', 'int'],
  ['totalHandAus', 'total_hand_aus', 'int'], ['lastPlaceStreak', 'last_place_streak', 'int'],
  ['totalChallenges', 'total_challenges', 'int'], ['totalStammtischGames', 'total_stammtisch_games', 'int'],
  ['totalPuzzlesSolved', 'total_puzzles_solved', 'int'], ['xp', 'xp', 'int'], ['dailyStreak', 'daily_streak', 'int'],
  ['badges', 'badges', 'json'], ['favoriteBadges', 'favorite_badges', 'json'], ['seasonalBacks', 'seasonal_backs', 'json'],
  ['quests', 'quests', 'json'], ['daily', 'daily', 'json'], ['puzzles', 'puzzles', 'json'],
];
const KNOWN_FIELDS = new Set(['id', 'name', ...PROFILE_COLUMNS.map(([f]) => f)]);
const PROFILE_SQL_COLUMNS = ['name_key', 'name', 'profile_id', ...PROFILE_COLUMNS.map(([, c]) => c), 'extra'];
const INT_LIMIT = 2147483647; // INT columns; BIGINT ones (total_score, xp) take more

function profileRow(p, key) {
  const extra = {};
  for (const [k, v] of Object.entries(p)) if (!KNOWN_FIELDS.has(k) && v !== undefined) extra[k] = v;
  const values = [key, String(p.name), p.id == null ? null : String(p.id)];
  for (const [field, column, kind] of PROFILE_COLUMNS) {
    const v = p[field];
    if (v === undefined || v === null) values.push(null);
    else if (kind === 'json') values.push(stableJson(v));
    else if (Number.isInteger(v) && (column === 'total_score' || column === 'xp' || Math.abs(v) <= INT_LIMIT)) values.push(v);
    else { extra[field] = v; values.push(null); } // keeps odd legacy values unchanged
  }
  values.push(Object.keys(extra).length ? stableJson(extra) : null);
  return upsert('player_profiles', PROFILE_SQL_COLUMNS, ['name_key'], values);
}

function rowToProfile(row) {
  const p = {};
  if (row.profile_id !== null) p.id = row.profile_id;
  p.name = row.name;
  for (const [field, column, kind] of PROFILE_COLUMNS) {
    const v = kind === 'json' ? json(row[column]) : num(row[column]);
    if (v !== undefined) p[field] = v;
  }
  return Object.assign(p, row.extra || {});
}

const playerCodec = {
  name: 'player_profiles',
  table: 'player_profiles',
  normalize(parsed) {
    return { players: parsed && Array.isArray(parsed.players) ? parsed.players.filter((p) => p && typeof p.name === 'string') : [] };
  },
  *rows(doc) {
    const seen = new Set();
    for (const p of doc.players) {
      const key = p.name.toLowerCase(); // the store's lookup key (findPlayerByName)
      if (seen.has(key)) continue; // unreachable duplicates: find() returns the first
      seen.add(key);
      yield [key, profileRow(p, key)];
    }
  },
  async load(q) {
    const r = await q.query('SELECT * FROM player_profiles ORDER BY seq');
    return { players: r.rows.map(rowToProfile) };
  },
};
```

Change the export line to:
```js
module.exports = { createPlayerStore, playerCodec, DEFAULT_DATA_FILE };
```

- [ ] **Step 5: Run the tests**

Run: `node --test test/stats-codecs.test.js test/player-store.test.js test/badges.test.js test/progression.test.js test/daily-puzzle.test.js`
Expected: PASS. The existing file-based tests are unchanged.

- [ ] **Step 6: Commit**

```bash
git add game/PlayerStore.js test/stats-codecs.test.js
git commit -m "feat(stats): player profiles in Postgres, no profile cap"
```

---

### Task 5: Global stats in Postgres

**Files:**
- Modify: `game/GlobalStatsStore.js` (lines 19–20, 46, 49)
- Test: `test/stats-codecs.test.js` (append)

**Interfaces:**
- Produces: `createGlobalStatsStore(backend)` with `flush`/`pendingStatements`/`status`, and `globalStatsCodec` (table `global_stats`)

- [ ] **Step 1: Write the failing tests** (append)

```js
const { createGlobalStatsStore, globalStatsCodec } = require('../game/GlobalStatsStore');

test('GlobalStats on Postgres: counters round-trip; empty table = undefined', { skip: PG }, async () => {
  const doc = { games: 12, rounds: 80, pikDamesLaidOut: 9, pikDamesCaught: 4, handAusRounds: 3 };
  const { again, rewritten } = await roundTrip(globalStatsCodec, doc);
  assert.deepEqual(again, doc);
  assert.deepEqual(rewritten, []);
  const s = await freshSchema();
  try { await ensureStatsSchema(s.pool); assert.equal(await globalStatsCodec.load(s.pool), undefined); } finally { await s.drop(); }
});

test('GlobalStats: works on a memory document', () => {
  const g = createGlobalStatsStore(createMemoryDocument());
  g.recordGame({ rounds: [{ isHandAus: true, results: {} }] });
  assert.equal(g.getStats().games, 1);
  assert.equal(g.getStats().handAusRounds, 1);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/stats-codecs.test.js`
Expected: FAIL, `globalStatsCodec` is undefined

- [ ] **Step 3: Implement**

In `game/GlobalStatsStore.js`, replace lines 19–20 with:
```js
function createGlobalStatsStore(backend = DEFAULT_STATS_FILE) {
  const file = typeof backend === 'string' ? createAtomicJsonFile(backend) : backend;
```

Replace the `return` line (46) with:
```js
  return {
    getStats, recordGame, flushSync: file.flushSync,
    flush: file.flush || (async () => {}),
    pendingStatements: file.pendingStatements || (() => []),
    status: file.status || (() => 'ok'),
  };
```

Add above `module.exports`:
```js
// --- Postgres codec: one row ------------------------------------------------
const { upsert, num } = require('./SqlRows');

const globalStatsCodec = {
  name: 'global_stats',
  table: 'global_stats',
  normalize: (parsed) => (parsed && typeof parsed === 'object' ? { ...EMPTY, ...parsed } : undefined),
  *rows(doc) {
    const s = { ...EMPTY, ...doc };
    yield ['global', upsert('global_stats',
      ['id', 'games', 'rounds', 'pik_dames_laid_out', 'pik_dames_caught', 'hand_aus_rounds'], ['id'],
      [true, s.games, s.rounds, s.pikDamesLaidOut, s.pikDamesCaught, s.handAusRounds])];
  },
  async load(q) {
    const r = await q.query('SELECT * FROM global_stats WHERE id');
    if (r.rows.length === 0) return undefined;
    const row = r.rows[0];
    return {
      games: num(row.games), rounds: num(row.rounds), pikDamesLaidOut: num(row.pik_dames_laid_out),
      pikDamesCaught: num(row.pik_dames_caught), handAusRounds: num(row.hand_aus_rounds),
    };
  },
};
```

Change the exports to `module.exports = { createGlobalStatsStore, globalStatsCodec };`

- [ ] **Step 4: Run the tests**

Run: `node --test test/stats-codecs.test.js test/global-stats.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add game/GlobalStatsStore.js test/stats-codecs.test.js
git commit -m "feat(stats): global counters in Postgres"
```

---

### Task 6: Daily challenge scores in Postgres

**Files:**
- Modify: `game/ChallengeStore.js` (lines 14, 26–27, 57, 179, 182)
- Test: `test/stats-codecs.test.js` (append)

**Interfaces:**
- Produces: `createChallengeStore(backend)` with `flushSync`/`flush`/`pendingStatements`/`status` (`flushSync` is new: the bug from the spec)
- Produces: `challengeCodec` (table `challenge_scores`). `load(q)` returns the last `KEEP_DAYS` days; `load(q, { all: true })` returns every day.

- [ ] **Step 1: Write the failing tests** (append)

```js
const { createChallengeStore, challengeCodec } = require('../game/ChallengeStore');
const { gameDay, addDays } = require('../game/GameDay');

test('ChallengeStore: keeps every entry of a day (no 100 cap) and can be flushed', () => {
  const c = createChallengeStore(createMemoryDocument());
  const day = gameDay(Date.now());
  for (let i = 0; i < 130; i++) c.submit(day, `P${i}`, i);
  assert.equal(c.rankOf(day, 'P0'), 130);
  assert.equal(typeof c.flushSync, 'function');
});

test('ChallengeStore on Postgres: window load vs full load; pruned days stay in the DB', { skip: PG }, async () => {
  const today = gameDay(Date.now());
  const old = addDays(today, -30);
  const doc = { days: { [today]: [{ name: 'Anna', score: 50, at: 2 }, { name: 'Bo', score: 40, at: 1 }], [old]: [{ name: 'Cy', score: 9, at: 1 }] } };
  const { again, rewritten } = await roundTrip(challengeCodec, doc, { all: true });
  assert.deepEqual(again, doc);
  assert.deepEqual(rewritten, []);
  const s = await freshSchema();
  try {
    await ensureStatsSchema(s.pool);
    const d = createPgDocument({ pool: s.pool, codec: challengeCodec, log: quiet });
    await d.load();
    d.write(doc);
    await d.flush();
    assert.deepEqual(Object.keys((await challengeCodec.load(s.pool)).days), [today], 'RAM window = KEEP_DAYS');
    const d2 = createPgDocument({ pool: s.pool, codec: challengeCodec, log: quiet });
    await d2.load();
    d2.write(d2.read());
    await d2.flush();
    const all = await challengeCodec.load(s.pool, { all: true });
    assert.ok(all.days[old], 'a day outside the window is never deleted');
  } finally { await s.drop(); }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/stats-codecs.test.js`
Expected: FAIL, `challengeCodec` is undefined

- [ ] **Step 3: Implement**

In `game/ChallengeStore.js`:
- Delete line 14 (`const MAX_ENTRIES_PER_DAY = 100;`).
- Replace lines 26–27 with:
  ```js
  function createChallengeStore(backend = DEFAULT_DATA_FILE) {
    const file = typeof backend === 'string' ? createAtomicJsonFile(backend) : backend;
  ```
- Line 57: replace `store.days[date] = list.slice(0, MAX_ENTRIES_PER_DAY);` with `store.days[date] = list;`
- Replace the `return` (line 179) with:
  ```js
    return {
      submit, getBoard, rankOf, getHistory, getWeekly, getTrend, wasChampion,
      flushSync: file.flushSync,
      flush: file.flush || (async () => {}),
      pendingStatements: file.pendingStatements || (() => []),
      status: file.status || (() => 'ok'),
    };
  ```
- Update the header comment (lines 4–5) to: `// RAM keeps 14 days (the board shows 7, the trend 14); the database keeps every day.`

Add above `module.exports`:
```js
// --- Postgres codec ----------------------------------------------------------
const { upsert, num } = require('./SqlRows');

const challengeCodec = {
  name: 'challenge_scores',
  table: 'challenge_scores',
  normalize(parsed) {
    const days = {};
    const src = parsed && parsed.days && typeof parsed.days === 'object' ? parsed.days : {};
    for (const [day, list] of Object.entries(src)) {
      if (Array.isArray(list)) days[day] = list.filter((e) => e && typeof e.name === 'string');
    }
    return { days };
  },
  *rows(doc) {
    for (const [day, list] of Object.entries(doc.days)) {
      const seen = new Set();
      for (const e of list) {
        const key = e.name.toLowerCase();
        if (seen.has(key)) continue; // submit() keeps one entry per name and day
        seen.add(key);
        yield [`${day}|${key}`, upsert('challenge_scores', ['day', 'name_key', 'name', 'score', 'at'], ['day', 'name_key'],
          [day, key, e.name, Math.round(Number(e.score) || 0), Math.round(Number(e.at) || 0)])];
      }
    }
  },
  // No deleteRow: days pruned from RAM stay in the database.
  async load(q, { all = false } = {}) {
    const cutoff = addDays(gameDay(Date.now()), -KEEP_DAYS);
    const r = all
      ? await q.query('SELECT day, name, score, at FROM challenge_scores ORDER BY day, score DESC, at')
      : await q.query('SELECT day, name, score, at FROM challenge_scores WHERE day >= $1 ORDER BY day, score DESC, at', [cutoff]);
    const days = {};
    for (const row of r.rows) (days[row.day] = days[row.day] || []).push({ name: row.name, score: num(row.score), at: num(row.at) });
    return { days };
  },
};
```

Change the exports to:
`module.exports = { createChallengeStore, challengeCodec, seedForDate, todayDate, DEFAULT_DATA_FILE };`

- [ ] **Step 4: Run the tests**

Run: `node --test test/stats-codecs.test.js test/game-day.test.js test/badges.test.js test/game-manager.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add game/ChallengeStore.js test/stats-codecs.test.js
git commit -m "feat(stats): challenge scores in Postgres, all days kept; flushable store"
```

---

### Task 7: Stammtisch in Postgres

**Files:**
- Modify: `game/StammtischStore.js` (lines 21–23, 49–50, 57–67, 73, 164, 259, 262)
- Test: `test/stats-codecs.test.js` (append)

**Interfaces:**
- Produces: `createStammtischStore(backend)` with `flush`/`pendingStatements`/`status`, and `stammtischCodec` (tables `stammtisch_tables` + `stammtisch_games`; it deletes a removed table)

- [ ] **Step 1: Write the failing tests** (append)

```js
const { createStammtischStore, stammtischCodec } = require('../game/StammtischStore');

const TABLE = {
  code: 'STAB12', name: 'Donnerstag', createdAt: 1, lastActivity: 5, owner: null, // legacy: no owner
  members: { anna: { name: 'Anna', games: 2, wins: 1, points: 300, lastSeen: 5 } },
  games: [
    { at: 3, seriesNo: 1, players: [{ name: 'Anna', isBot: false, score: 200, won: true }] },
    { at: 5, seriesNo: 1, players: [{ name: 'Anna', isBot: false, score: 100, won: false }] },
  ],
  series: { no: 1, bestOf: 3, wins: { anna: 1 }, games: 2, winner: null, finishedAt: null },
};

test('Stammtisch: no pruning of old tables, no cap on games', () => {
  const st = createStammtischStore(createMemoryDocument());
  const { table } = st.create('Alt', 'Anna', 0);
  st.create('Neu', 'Bo', Date.now()); // used to prune tables inactive for 180 days
  assert.ok(st.get(table.code), 'old table survives');
  for (let i = 0; i < 120; i++) st.recordGame(table.code, { players: [{ id: 'a', name: 'Anna' }], finalTotals: { a: 1 }, winnerId: 'a', finishedAt: i });
  assert.equal(st.summary(table.code).gamesPlayed, 120);
});

test('Stammtisch on Postgres: tables and games round-trip; remove deletes', { skip: PG }, async () => {
  const doc = { tables: { STAB12: TABLE } };
  const { again, rewritten } = await roundTrip(stammtischCodec, doc);
  assert.deepEqual(again, doc);
  assert.deepEqual(rewritten, []);
  const s = await freshSchema();
  try {
    await ensureStatsSchema(s.pool);
    const d = createPgDocument({ pool: s.pool, codec: stammtischCodec, log: quiet });
    await d.load();
    d.write(structuredClone(doc));
    await d.flush();
    d.write({ tables: {} });
    await d.flush();
    assert.equal((await s.pool.query('SELECT count(*)::int AS n FROM stammtisch_games')).rows[0].n, 0, 'games go with the table');
  } finally { await s.drop(); }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/stats-codecs.test.js`
Expected: FAIL, `stammtischCodec` is undefined

- [ ] **Step 3: Implement**

In `game/StammtischStore.js`:
- Delete lines 21–23 (`MAX_TABLES`, `MAX_GAMES_PER_TABLE`, `INACTIVE_DAYS`).
- Replace lines 49–50 with:
  ```js
  function createStammtischStore(backend = DEFAULT_DATA_FILE) {
    const file = typeof backend === 'string' ? createAtomicJsonFile(backend) : backend;
  ```
- Delete the whole `prune` function (lines 57–67), and in `create` delete the line `prune(store, now);` (line 73).
- In `recordGame`, delete `while (t.games.length > MAX_GAMES_PER_TABLE) t.games.shift();` (line 164).
- Replace the `return` (line 259) with:
  ```js
    return {
      create, get, touch, recordGame, summary, listFor, remove, leave, filePath: typeof backend === 'string' ? backend : null, SERIES_BEST_OF,
      flushSync: file.flushSync,
      flush: file.flush || (async () => {}),
      pendingStatements: file.pendingStatements || (() => []),
      status: file.status || (() => 'ok'),
    };
  ```

Add above `module.exports`:
```js
// --- Postgres codec: a table row, then one row per game (position = idx) -----
const { upsert, stableJson, num, json } = require('./SqlRows');

const TABLE_FIELDS = new Set(['code', 'name', 'owner', 'createdAt', 'lastActivity', 'members', 'games', 'series']);
const GAME_FIELDS = new Set(['at', 'seriesNo', 'players']);
const extraOf = (obj, known) => {
  const extra = {};
  for (const [k, v] of Object.entries(obj)) if (!known.has(k) && v !== undefined) extra[k] = v;
  return Object.keys(extra).length ? stableJson(extra) : null;
};
const intOrNull = (v) => (v === undefined || v === null ? null : Math.round(Number(v)));

const stammtischCodec = {
  name: 'stammtisch',
  table: 'stammtisch_tables',
  normalize(parsed) {
    return { tables: parsed && parsed.tables && typeof parsed.tables === 'object' ? parsed.tables : {} };
  },
  *rows(doc) {
    for (const [code, t] of Object.entries(doc.tables)) {
      yield [`t|${code}`, upsert('stammtisch_tables',
        ['code', 'name', 'owner', 'created_at', 'last_activity', 'members', 'series', 'extra'], ['code'],
        [code, t.name ?? null, t.owner ?? null, intOrNull(t.createdAt), intOrNull(t.lastActivity),
          stableJson(t.members || {}), stableJson(t.series), extraOf(t, TABLE_FIELDS)])];
      const games = t.games || [];
      for (let idx = 0; idx < games.length; idx++) {
        const g = games[idx];
        // Games are append-only (no cap any more), so the position is a stable key.
        yield [`g|${code}|${idx}`, upsert('stammtisch_games',
          ['code', 'idx', 'at', 'series_no', 'players', 'extra'], ['code', 'idx'],
          [code, idx, intOrNull(g.at), intOrNull(g.seriesNo), stableJson(g.players || []), extraOf(g, GAME_FIELDS)])];
      }
    }
  },
  deleteRow(key) {
    // A removed table takes its games along (ON DELETE CASCADE).
    return key.startsWith('t|') ? { text: 'DELETE FROM stammtisch_tables WHERE code = $1', values: [key.slice(2)] } : null;
  },
  async load(q) {
    const tables = {};
    for (const row of (await q.query('SELECT * FROM stammtisch_tables ORDER BY code')).rows) {
      const t = { code: row.code, name: row.name ?? undefined, createdAt: num(row.created_at), lastActivity: num(row.last_activity),
        members: row.members, games: [], series: json(row.series), owner: row.owner };
      for (const k of Object.keys(t)) if (t[k] === undefined) delete t[k];
      tables[row.code] = Object.assign(t, row.extra || {});
    }
    for (const row of (await q.query('SELECT * FROM stammtisch_games ORDER BY code, idx')).rows) {
      const g = { at: num(row.at), seriesNo: num(row.series_no), players: row.players };
      for (const k of Object.keys(g)) if (g[k] === undefined) delete g[k];
      if (tables[row.code]) tables[row.code].games.push(Object.assign(g, row.extra || {}));
    }
    return { tables };
  },
};
```

Notes on legacy tables like `TABLE` in the test:
- `owner: null` loads back as `null` (the undefined-cleanup keeps `null`).
- A table without an `owner` key comes back with `owner: null`. That's
  harmless: `ownerOf()` treats `null` and missing the same way.

Change the exports to:
`module.exports = { createStammtischStore, stammtischCodec, normalizeCode, generateCode, DEFAULT_DATA_FILE, SERIES_BEST_OF };`

- [ ] **Step 4: Run the tests**

Run: `node --test test/stats-codecs.test.js test/stammtisch-store.test.js`
Expected: PASS. If an existing Stammtisch test asserted pruning or the
100-game cap, change it to assert the opposite (nothing is pruned or capped)
and add a comment that the spec removed the limit.

- [ ] **Step 5: Commit**

```bash
git add game/StammtischStore.js test/stats-codecs.test.js test/stammtisch-store.test.js
git commit -m "feat(stats): Stammtisch tables and games in Postgres, nothing evicted"
```

---

### Task 8: Game history in Postgres (queue + async reads)

**Files:**
- Modify: `game/GameHistoryStore.js`
- Test: `test/stats-codecs.test.js` (append)

**Interfaces:**
- Consumes: `createWriteBehind` (Task 3), `upsert`/`stableJson`/`num`
- Produces:
  - `createGameHistoryStore(backend)`: file or memory; keeps `saveGame`/`listGames`/`getGame`/`loadAll`/`flushSync`, and adds `historyFor(name, limit = 20) → Promise<Array>`, `flush`, `pendingStatements`, `status`.
  - `createPgGameHistoryStore(pool, { flushDelayMs, log })` → `{ saveGame(record) → stored, historyFor(name, limit), flush, flushSync, pendingStatements, status }`
  - `gameHistoryCodec` (import only, table `game_records`)

- [ ] **Step 1: Write the failing tests** (append)

```js
const { createGameHistoryStore, createPgGameHistoryStore, gameHistoryCodec } = require('../game/GameHistoryStore');
const { createFakePool } = require('./helpers/fake-pool');

const gameRec = (finishedAt, names) => ({
  finishedAt, startedAt: finishedAt - 10, winnerId: 'p0', finalTotals: { p0: 100 },
  players: names.map((n, i) => ({ id: `p${i}`, name: n, isBot: n.startsWith('Bot') })),
  rounds: [{ totalsAfter: { p0: 100 } }],
});

test('GameHistory (memory): historyFor is async and filters by human name', async () => {
  const h = createGameHistoryStore(createMemoryDocument());
  h.saveGame(gameRec(1, ['Anna', 'Bot Bert']));
  assert.equal((await h.historyFor('anna')).length, 1);
  assert.equal((await h.historyFor('Bot Bert')).length, 0);
});

test('GameHistory (Postgres): unsaved games stay pending while the DB is down', async () => {
  const pool = createFakePool();
  const h = createPgGameHistoryStore(pool, { flushDelayMs: 60000, log: { log() {}, error() {} } });
  pool.failNext(Object.assign(new Error('down'), { code: 'ECONNREFUSED' }));
  h.saveGame(gameRec(1, ['Anna']));
  await assert.rejects(h.flush());
  assert.equal(h.status(), 'degraded');
  assert.equal(h.pendingStatements().length, 2, 'record + one seat');
  await h.flush();
  assert.deepEqual(h.pendingStatements(), []);
});

test('GameHistory on Postgres: newest first, bots ignored, unflushed games included', { skip: PG }, async () => {
  const s = await freshSchema();
  try {
    await ensureStatsSchema(s.pool);
    const h = createPgGameHistoryStore(s.pool, { flushDelayMs: 60000, log: quiet });
    const a = h.saveGame(gameRec(100, ['Anna', 'Bot Bert']));
    await h.flush();
    const b = h.saveGame(gameRec(200, ['anna', 'Bo'])); // not flushed yet
    const mine = await h.historyFor('ANNA', 20);
    assert.deepEqual(mine.map((g) => g.id), [b.id, a.id]);
    assert.equal(mine[1].won, true);
    assert.deepEqual(await h.historyFor('Bot Bert'), []);
    const all = await gameHistoryCodec.load(s.pool, { all: true });
    assert.deepEqual(all.games.map((g) => g.id), [a.id, b.id], 'flushed by historyFor');
  } finally { await s.drop(); }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/stats-codecs.test.js`
Expected: FAIL, `createPgGameHistoryStore is not a function`

- [ ] **Step 3: Implement**

In `game/GameHistoryStore.js`:
- Replace lines 17–18 with:
  ```js
  function createGameHistoryStore(backend = DEFAULT_DATA_FILE) {
    // File (tests) or memory (no database). Production uses createPgGameHistoryStore.
    const file = typeof backend === 'string' ? createAtomicJsonFile(backend) : backend;
  ```
- Replace the `return` (lines 50–51) with:
  ```js
    return {
      flushSync: file.flushSync, filePath: typeof backend === 'string' ? backend : null, loadAll, saveGame, listGames, getGame,
      historyFor: async (name, limit = 20) => historyForPlayer(loadAll(), name, limit),
      flush: file.flush || (async () => {}),
      pendingStatements: file.pendingStatements || (() => []),
      status: file.status || (() => 'ok'),
    };
  }
  ```

Add above `module.exports`:
```js
// --- Postgres: append-only queue, async reads ---------------------------------
const { upsert, stableJson } = require('./SqlRows');
const { createWriteBehind } = require('./WriteBehind');

/** Insert statements for one stored game: the record, then one row per seat. */
function gameStatements(stored) {
  const out = [upsert('game_records', ['id', 'finished_at', 'record'], ['id'],
    [stored.id, stored.finishedAt == null ? null : Math.round(Number(stored.finishedAt)), stableJson(stored)])];
  (stored.players || []).forEach((p, seat) => {
    out.push(upsert('game_record_players', ['game_id', 'seat', 'name_key', 'is_bot'], ['game_id', 'seat'],
      [stored.id, seat, String((p && p.name) || '').toLowerCase(), !!(p && p.isBot)]));
  });
  return out;
}

function createPgGameHistoryStore(pool, { flushDelayMs = 800, log = console } = {}) {
  const queue = []; // { record, statements } not yet in the database
  const wb = createWriteBehind({
    pool, name: 'game_records', flushDelayMs, log,
    collect: () => ({ statements: queue.flatMap((g) => g.statements), token: queue.length }),
    commit: (n) => { queue.splice(0, n); },
  });

  function saveGame(record) {
    const stored = { id: genId(), ...record };
    queue.push({ record: stored, statements: gameStatements(stored) });
    wb.markDirty();
    return stored;
  }

  async function historyFor(name, limit = 20) {
    const key = String(name || '').trim().toLowerCase();
    if (!key) return [];
    await wb.flush().catch(() => {}); // DB down: still answer with what is queued
    let rows = [];
    try {
      rows = (await pool.query(
        `SELECT r.record FROM game_records r
         WHERE EXISTS (SELECT 1 FROM game_record_players p WHERE p.game_id = r.id AND p.name_key = $1 AND NOT p.is_bot)
         ORDER BY r.finished_at DESC NULLS LAST LIMIT $2`, [key, limit])).rows;
    } catch (e) {
      log.error(`[stats] game history read failed: ${e.message}`);
    }
    const byId = new Map(rows.map((r) => [r.record.id, r.record]));
    for (const g of queue) byId.set(g.record.id, g.record);
    return historyForPlayer([...byId.values()], name, limit);
  }

  return {
    saveGame,
    historyFor,
    flush: wb.flush,
    flushSync() { wb.flush().catch(() => {}); },
    pendingStatements: () => queue.flatMap((g) => g.statements),
    status: wb.status,
  };
}

// Import only (games.json → Postgres) and its verification.
const gameHistoryCodec = {
  name: 'game_records',
  table: 'game_records',
  normalize: (parsed) => ({ games: parsed && Array.isArray(parsed.games) ? parsed.games.filter((g) => g && g.id) : [] }),
  *rows(doc) {
    const seen = new Set();
    for (const g of doc.games) {
      if (seen.has(g.id)) continue;
      seen.add(g.id);
      const [rec, ...seats] = gameStatements(g);
      yield [`r|${g.id}`, rec];
      for (let i = 0; i < seats.length; i++) yield [`p|${g.id}|${i}`, seats[i]];
    }
  },
  async load(q) {
    const r = await q.query('SELECT record FROM game_records ORDER BY finished_at NULLS FIRST, id');
    return { games: r.rows.map((x) => x.record) };
  },
};
```

Change the exports to:
```js
module.exports = { createGameHistoryStore, createPgGameHistoryStore, gameHistoryCodec, gameStatements, historyForPlayer, DEFAULT_DATA_FILE };
```

- [ ] **Step 4: Run the tests**

Run: `node --test test/stats-codecs.test.js test/game-history-store.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add game/GameHistoryStore.js test/stats-codecs.test.js
git commit -m "feat(stats): game history in Postgres with async per-player reads"
```

---

### Task 9: One-time JSON import with verification

**Files:**
- Create: `game/StatsImport.js`, `test/stats-import.test.js`

**Interfaces:**
- Consumes: all five codecs (Tasks 4–8), `ensureStatsSchema`
- Produces: `importStats({ pool, dataDir, log, imports? }) → Promise<Array<{ file, rows }>>`. It throws on a corrupt file or a verification mismatch; the file stays untouched.
- Produces: `DEFAULT_IMPORTS: Array<{ file, codec }>`

- [ ] **Step 1: Write the failing tests**

`test/stats-import.test.js`:
```js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { hasPg, freshSchema } = require('./helpers/pg');
const { ensureStatsSchema } = require('../game/StatsSchema');
const { importStats, DEFAULT_IMPORTS } = require('../game/StatsImport');
const { playerCodec } = require('../game/PlayerStore');

const PG = !hasPg && 'needs PIKDAME_TEST_PG_URL';
const quiet = { log() {}, error() {} };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pikimport-'));
const put = (dir, file, data) => fs.writeFileSync(path.join(dir, file), typeof data === 'string' ? data : JSON.stringify(data));
const count = async (pool, table) => (await pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;

test('import: all five files, renamed to .imported, second run is a no-op', { skip: PG }, async () => {
  const s = await freshSchema();
  const dir = tmp();
  try {
    await ensureStatsSchema(s.pool);
    put(dir, 'players.json', { players: [
      { id: 'profile-1', name: 'Oma Inge', gamesPlayed: 7, gamesWon: 3, totalScore: 900, xp: 420, teams: ['old'] },
      { id: 'profile-2', name: 'oma inge', gamesPlayed: 1 }, // unreachable duplicate
    ] });
    put(dir, 'stats.json', { games: 3, rounds: 20, pikDamesLaidOut: 1, pikDamesCaught: 2, handAusRounds: 0 });
    put(dir, 'challenges.json', { days: { '2026-10-01': [{ name: 'Anna', score: 50, at: 1 }] } });
    put(dir, 'stammtisch.json', { tables: { STAB12: { code: 'STAB12', name: 'Do', createdAt: 1, lastActivity: 2, members: {}, games: [{ at: 2, seriesNo: 1, players: [] }] } } });
    put(dir, 'games.json', { games: [{ id: 'game-1', finishedAt: 5, players: [{ id: 'p0', name: 'Anna', isBot: false }], rounds: [] }] });
    const done = await importStats({ pool: s.pool, dataDir: dir, log: quiet });
    assert.deepEqual(done.map((d) => d.file).sort(), ['challenges.json', 'games.json', 'players.json', 'stammtisch.json', 'stats.json']);
    for (const f of ['players', 'stats', 'challenges', 'stammtisch', 'games']) {
      assert.ok(fs.existsSync(path.join(dir, `${f}.json.imported`)), `${f} renamed`);
      assert.ok(!fs.existsSync(path.join(dir, `${f}.json`)));
    }
    assert.equal(await count(s.pool, 'player_profiles'), 1);
    assert.equal(await count(s.pool, 'stammtisch_games'), 1);
    assert.equal(await count(s.pool, 'game_record_players'), 1);
    assert.deepEqual(await importStats({ pool: s.pool, dataDir: dir, log: quiet }), []);
  } finally { await s.drop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('import: a verification mismatch rolls back, keeps the file and throws', { skip: PG }, async () => {
  const s = await freshSchema();
  const dir = tmp();
  try {
    await ensureStatsSchema(s.pool);
    put(dir, 'players.json', { players: [{ name: 'A', gamesPlayed: 1 }, { name: 'B', gamesPlayed: 2 }] });
    const lossy = { ...playerCodec, async load(q) { const d = await playerCodec.load(q); d.players.pop(); return d; } };
    await assert.rejects(importStats({ pool: s.pool, dataDir: dir, log: quiet, imports: [{ file: 'players.json', codec: lossy }] }),
      /players\.json: verification failed/);
    assert.ok(fs.existsSync(path.join(dir, 'players.json')), 'file untouched');
    assert.equal(await count(s.pool, 'player_profiles'), 0, 'rolled back');
  } finally { await s.drop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('import: an empty file is renamed, a corrupt one refuses the start', { skip: PG }, async () => {
  const s = await freshSchema();
  const dir = tmp();
  try {
    await ensureStatsSchema(s.pool);
    put(dir, 'stats.json', '');
    put(dir, 'players.json', '{"players": [');
    await assert.rejects(importStats({ pool: s.pool, dataDir: dir, log: quiet }), /players\.json/);
    assert.ok(fs.existsSync(path.join(dir, 'players.json')), 'corrupt file stays for a human to fix');
    assert.ok(fs.existsSync(path.join(dir, 'stats.json.imported')), 'empty file imported as nothing');
  } finally { await s.drop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('import: a table that already has rows is left alone', { skip: PG }, async () => {
  const s = await freshSchema();
  const dir = tmp();
  try {
    await ensureStatsSchema(s.pool);
    await s.pool.query("INSERT INTO player_profiles (name_key, name) VALUES ('x', 'X')");
    put(dir, 'players.json', { players: [{ name: 'A' }] });
    assert.deepEqual(await importStats({ pool: s.pool, dataDir: dir, log: quiet, imports: DEFAULT_IMPORTS.filter((i) => i.file === 'players.json') }), []);
    assert.ok(fs.existsSync(path.join(dir, 'players.json')));
  } finally { await s.drop(); fs.rmSync(dir, { recursive: true, force: true }); }
});
```

Note: `stats.json` is processed before `players.json` in `DEFAULT_IMPORTS`
(see Step 3), so the empty `stats.json` is renamed before the corrupt
`players.json` throws.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `PIKDAME_TEST_PG_URL=… node --test test/stats-import.test.js`
Expected: FAIL, `Cannot find module '../game/StatsImport'`

- [ ] **Step 3: Implement `game/StatsImport.js`**

```js
// game/StatsImport.js
// One-time move of the JSON stats files into Postgres. Per file: only into an
// empty table, one transaction, verified row by row, then renamed *.imported.
const fs = require('fs');
const path = require('path');
const { globalStatsCodec } = require('./GlobalStatsStore');
const { playerCodec } = require('./PlayerStore');
const { challengeCodec } = require('./ChallengeStore');
const { stammtischCodec } = require('./StammtischStore');
const { gameHistoryCodec } = require('./GameHistoryStore');

const DEFAULT_IMPORTS = [
  { file: 'stats.json', codec: globalStatsCodec },
  { file: 'players.json', codec: playerCodec },
  { file: 'challenges.json', codec: challengeCodec },
  { file: 'stammtisch.json', codec: stammtischCodec },
  { file: 'games.json', codec: gameHistoryCodec },
];

function rowMap(codec, doc) {
  const m = new Map();
  if (doc === undefined) return m;
  for (const [key, stmt] of codec.rows(doc)) if (!m.has(key)) m.set(key, stmt);
  return m;
}

function firstDifference(expected, actual) {
  if (expected.size !== actual.size) return `${expected.size} rows expected, ${actual.size} in the database`;
  for (const [key, stmt] of expected) {
    const got = actual.get(key);
    if (!got) return `row ${key} missing`;
    if (JSON.stringify(got.values) !== JSON.stringify(stmt.values)) return `row ${key} differs`;
  }
  return null;
}

function readJson(filePath, file) {
  const text = fs.readFileSync(filePath, 'utf8');
  if (text.trim() === '') return undefined;
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`${file}: not valid JSON (${e.message}) - fix or move the file, then restart`);
  }
}

async function importStats({ pool, dataDir, log = console, imports = DEFAULT_IMPORTS }) {
  const done = [];
  for (const { file, codec } of imports) {
    const filePath = path.join(dataDir, file);
    if (!fs.existsSync(filePath)) continue;
    const parsed = readJson(filePath, file);
    const doc = parsed === undefined ? undefined : codec.normalize(parsed);
    const expected = rowMap(codec, doc);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { n } = (await client.query(`SELECT count(*)::int AS n FROM ${codec.table}`)).rows[0];
      if (n > 0) {
        await client.query('ROLLBACK');
        log.log(`[stats] ${file}: ${codec.table} already has data - not imported, file left as is`);
        continue;
      }
      for (const stmt of expected.values()) await client.query(stmt.text, stmt.values);
      const problem = firstDifference(expected, rowMap(codec, await codec.load(client, { all: true })));
      if (problem) throw new Error(`${file}: verification failed - ${problem}`);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
    fs.renameSync(filePath, `${filePath}.imported`);
    const dropped = codec === playerCodec && doc ? doc.players.length - expected.size : 0;
    log.log(`[stats] imported ${file}: ${expected.size} rows${dropped ? `, ${dropped} unreachable duplicate profile(s) skipped` : ''}`);
    done.push({ file, rows: expected.size });
  }
  return done;
}

module.exports = { importStats, DEFAULT_IMPORTS };
```

Notes:
- `continue` inside `try` still runs `finally`, so the client is released.
- For a mismatch, `firstDifference` compares the codec's own rows on both
  sides. Because of `stableJson` and `num`, a lossless round trip yields
  identical values.

- [ ] **Step 4: Run the tests**

Run: `PIKDAME_TEST_PG_URL=… node --test test/stats-import.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add game/StatsImport.js test/stats-import.test.js
git commit -m "feat(stats): verified one-time import of the JSON stats files"
```

---

### Task 10: Server wiring, boot order, shutdown; SQLite accounts removed

**Files:**
- Modify: `server.js` (lines 14–78 setup, 100–110 probe, 155–162 `flushStoresSafely`, 306–310 `/healthz`, 1424 snapshot restore, 1723–1732 history handler, 2138–2170 shutdown/listen)
- Rewrite: `game/AccountStore.js`
- Modify: `game/ConfigReport.js:46,82-87`, `test/admin-config.test.js:14`
- Create: `test/stats-server.test.js`
- Modify tests: `test/account-store.test.js`, `test/admin-users-monitor.test.js`, `test/passkeys.test.js`, `test/game-manager.test.js:2343-2366`

**Interfaces:**
- Consumes: everything above
- Produces: server behaviour
  - With `PIKDAME_DATABASE_URL`: boots stats (schema → pending → import → load), then restores sessions, then listens.
  - Without it: play-only (no accounts, memory stats).
  - `/healthz` returns `ok` or `ok (stats degraded)`.
  - On SIGTERM it flushes and dumps leftovers to `data/pending-stats.json`.
- Produces: `createAccountStoreAuto(env, { pool }) → PgAccountStore | null`

- [ ] **Step 1: Write the failing server tests**

`test/stats-server.test.js`:
```js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { hasPg, freshSchema } = require('./helpers/pg');

const get = (port, p) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path: p }, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: b })); }).on('error', reject);
});

async function startServer(env, port) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pikstats-srv-'));
  for (const [f, data] of Object.entries(env.files || {})) fs.writeFileSync(path.join(dataDir, f), JSON.stringify(data));
  const proc = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(port), PIKDAME_DATA_DIR: dataDir, PIKDAME_ADMIN_TOKEN: '', PIKDAME_SMTP_HOST: '', PIKDAME_PUBLIC_MODE: '', ...env.vars },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  proc.stdout.on('data', (c) => { log += c; });
  proc.stderr.on('data', (c) => { log += c; });
  const deadline = Date.now() + 20000;
  for (;;) {
    try { if ((await get(port, '/healthz')).status === 200) break; } catch (e) { /* booting */ }
    if (proc.exitCode !== null) throw new Error(`server exited: ${log}`);
    if (Date.now() > deadline) throw new Error(`server did not come up: ${log}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  const stop = async () => {
    const gone = proc.exitCode !== null ? null : new Promise((r) => proc.once('exit', r));
    proc.kill('SIGTERM');
    await gone;
  };
  return { dataDir, proc, stop, log: () => log };
}

test('server without a database: play-only, no stats files written', async () => {
  const srv = await startServer({ vars: { PIKDAME_DATABASE_URL: '' } }, 18931);
  try {
    assert.equal((await get(18931, '/healthz')).body, 'ok');
    assert.match(srv.log(), /play-only/);
  } finally { await srv.stop(); }
  const files = fs.readdirSync(srv.dataDir).filter((f) => /^(players|games|stats|challenges|stammtisch)\.json$|pending-stats/.test(f));
  assert.deepEqual(files, []);
  fs.rmSync(srv.dataDir, { recursive: true, force: true });
});

test('server with Postgres: imports the files, loads stats before listening and restoring sessions', { skip: !hasPg && 'needs PIKDAME_TEST_PG_URL' }, async () => {
  const s = await freshSchema();
  const srv = await startServer({
    vars: { PIKDAME_DATABASE_URL: s.url },
    files: { 'players.json': { players: [{ id: 'profile-1', name: 'Oma Inge', gamesPlayed: 7, gamesWon: 3, totalScore: 900, xp: 420 }] } },
  }, 18932);
  try {
    assert.ok(fs.existsSync(path.join(srv.dataDir, 'players.json.imported')));
    const r = await s.pool.query("SELECT games_played, xp FROM player_profiles WHERE name_key = 'oma inge'");
    assert.deepEqual(r.rows[0], { games_played: 7, xp: '420' });
    const log = srv.log();
    assert.ok(log.indexOf('[stats] statistics loaded') !== -1, 'stats boot logged');
    assert.ok(log.indexOf('[stats] statistics loaded') < log.indexOf('Pik Dame Server läuft'), 'loaded before listening');
  } finally {
    await srv.stop();
    assert.ok(!fs.existsSync(path.join(srv.dataDir, 'pending-stats.json')), 'clean shutdown leaves nothing pending');
    fs.rmSync(srv.dataDir, { recursive: true, force: true });
    await s.drop();
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/stats-server.test.js`
Expected: FAIL. The first test fails because `play-only` is missing from the
log, and a `players.json` file appears.

- [ ] **Step 3: Rewrite `game/AccountStore.js`**

First run `grep -rn "createAccountStore\b" game server.js scripts`. Expected:
only tests reference it (they are fixed in Step 9). Then replace the whole
file with:

```js
// game/AccountStore.js
// Accounts need PostgreSQL (PgAccountStore on the server's shared pool).
// Without a database there are no accounts: the client hides the account UI.
function createAccountStoreAuto(env = process.env, { pool = null } = {}) {
  if (!pool || !env.PIKDAME_DATABASE_URL) return null;
  const { createPgAccountStore } = require('./PgAccountStore');
  return createPgAccountStore(env.PIKDAME_DATABASE_URL, { pool });
}

module.exports = { createAccountStoreAuto };
```

- [ ] **Step 4: Wire the stores in `server.js`**

1. Add after the existing `require`s (around line 37):
   ```js
   const { createPool } = require('./game/Db');
   const { createPgDocument, createMemoryDocument } = require('./game/PgDocument');
   const { ensureStatsSchema } = require('./game/StatsSchema');
   const { importStats } = require('./game/StatsImport');
   const { writePending, replayPending } = require('./game/PendingStats');
   ```
   Then extend the existing store requires to pull in the codecs:
   - `const { createPlayerStore, playerCodec } = require('./game/PlayerStore');`
   - `const { createGlobalStatsStore, globalStatsCodec } = require('./game/GlobalStatsStore');`
   - `const { createStammtischStore, stammtischCodec, normalizeCode: normalizeStammtischCode } = require('./game/StammtischStore');`
   - `const { createGameHistoryStore, createPgGameHistoryStore } = require('./game/GameHistoryStore');` (`historyForPlayer` is no longer used here)
   - `const { createChallengeStore, challengeCodec, seedForDate } = require('./game/ChallengeStore');`

2. Replace `const playerStore = createPlayerStore();` (line 42) with:
   ```js
   // One pool for accounts and stats; null = play-only (no accounts, stats in RAM).
   const dbPool = createPool(process.env);
   const statsDocs = []; // Postgres documents, loaded by bootStats() before listen
   function statsBackend(codec) {
     if (!dbPool) return createMemoryDocument();
     const doc = createPgDocument({ pool: dbPool, codec });
     statsDocs.push(doc);
     return doc;
   }
   const playerStore = createPlayerStore(statsBackend(playerCodec));
   ```
3. `const challengeStore = createChallengeStore();` → `const challengeStore = createChallengeStore(statsBackend(challengeCodec));`
4. `const globalStats = createGlobalStatsStore();` → `const globalStats = createGlobalStatsStore(statsBackend(globalStatsCodec));`
5. Replace the comment and line 58 with:
   ```js
   // Accounts need PostgreSQL; without a database the client hides the account UI.
   const accountStore = process.env.PIKDAME_ACCOUNTS === '0' ? null : createAccountStoreAuto(process.env, { pool: dbPool });
   ```
6. Line 65: change `${accountStore.backend || 'sqlite'}` to `${accountStore.backend || 'postgres'}`.
7. Line 73: change the log to `console.log('Benutzerkonten: deaktiviert (keine Datenbank - PIKDAME_DATABASE_URL fehlt - oder PIKDAME_ACCOUNTS=0)');`
8. `const gameHistoryStore = createGameHistoryStore();` → `const gameHistoryStore = dbPool ? createPgGameHistoryStore(dbPool) : createGameHistoryStore(createMemoryDocument());`
9. `const stammtischStore = createStammtischStore();` → `const stammtischStore = createStammtischStore(statsBackend(stammtischCodec));`
10. After the existing `const DATA_DIR = …` line, add:
    ```js
    const PENDING_STATS_FILE = path.join(DATA_DIR, 'pending-stats.json');
    const STATS_STORES = [playerStore, globalStats, gameHistoryStore, stammtischStore, challengeStore];
    ```
11. In the startup probe (line ~101), replace the file list with `['sessions-snapshot.json', 'pending-stats.json']`.

- [ ] **Step 5: Crash flush, `/healthz` and the history handler**

Replace the body of `flushStoresSafely()` (lines 158–162) with:
```js
function flushStoresSafely() {
  // Postgres can only be asked to start a flush here; shutdown() awaits it.
  for (const s of STATS_STORES) { try { s.flushSync(); } catch (e) { /* best effort */ } }
}
```

Replace the `/healthz` block (306–310) with:
```js
  if (filePath === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(STATS_STORES.some((s) => s.status() === 'degraded') ? 'ok (stats degraded)' : 'ok');
    return;
  }
```

Replace the `getGameHistory` block (1723–1732) with:
```js
    if (msg.type === 'getGameHistory') {
      // Personal history: same lock as profiles - nobody sees others' games in public mode.
      const reply = (games) => { try { ws.send(JSON.stringify({ type: 'gameHistory', games })); } catch (e) { /* socket gone */ } };
      if (PUBLIC_MODE) { reply([]); return; }
      gameHistoryStore.historyFor(msg.name, 20).then(reply, (e) => { logCrash('game-history', e); reply([]); });
      return;
    }
```

- [ ] **Step 6: Boot order and shutdown**

Delete the top-level call `restoreSessionsSnapshot();` (line ~1424). Restore
now runs after the stats are loaded, so bot timers of a restored game can't
finish it into unloaded stores.

Replace `function shutdown(signal) { … }` (2138–2165) with:
```js
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} empfangen - Server fährt herunter...`);
  writeSessionsSnapshot();
  try { if (adminMonitor) adminMonitor.flushSync(); } catch (e) { /* monitoring history is best effort */ }
  for (const client of wss.clients) {
    try { client.close(1001, 'Server wird neu gestartet'); } catch (e) { /* socket already closed */ }
  }
  server.close();
  flushStatsForShutdown()
    .catch((e) => logCrash('stats-shutdown', e))
    .finally(async () => {
      if (accountStore) await Promise.resolve(accountStore.close()).catch(() => {});
      if (dbPool) await dbPool.end().catch(() => {});
      process.exit(0);
    });
  // Hard exit if something hangs (keep-alives, a stuck pool).
  setTimeout(() => process.exit(0), 8000).unref();
}

/** Flush every stats store (5 s at most); whatever is still unsaved goes to pending-stats.json. */
async function flushStatsForShutdown() {
  const all = Promise.allSettled(STATS_STORES.map((s) => s.flush()));
  const timedOut = await Promise.race([all.then(() => false), new Promise((r) => setTimeout(() => r(true), 5000).unref())]);
  const pending = STATS_STORES.flatMap((s) => s.pendingStatements());
  if (writePending(PENDING_STATS_FILE, pending)) {
    console.error(`[stats] ${pending.length} unsaved statement(s) written to ${PENDING_STATS_FILE}${timedOut ? ' (flush timed out)' : ''}`);
  }
}

/** Postgres first: schema, leftovers from the last shutdown, JSON import, then the caches. */
async function bootStats() {
  if (!dbPool) {
    console.log('[stats] No PIKDAME_DATABASE_URL: play-only mode - no accounts, statistics are not saved.');
    return;
  }
  for (let attempt = 1; ; attempt++) {
    try {
      await dbPool.query('SELECT 1');
      break;
    } catch (e) {
      const wait = Math.min(30000, 1000 * attempt);
      console.error(`[stats] database not reachable (${e.message}) - retrying in ${wait / 1000}s`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  await ensureStatsSchema(dbPool);
  const replayed = await replayPending(dbPool, PENDING_STATS_FILE);
  if (replayed) console.log(`[stats] re-applied ${replayed} unsaved statement(s) from ${PENDING_STATS_FILE}`);
  await importStats({ pool: dbPool, dataDir: DATA_DIR, log: console });
  for (const doc of statsDocs) await doc.load();
  console.log('[stats] statistics loaded from PostgreSQL');
}
```

Turn `server.listen(PORT, () => { … });` into a named function and start it
after the boot. Change the first line `server.listen(PORT, () => {` to
`function onListening() {`, and the matching closing `});` to `}`. Then add:

```js
bootStats().then(
  () => {
    restoreSessionsSnapshot();
    server.listen(PORT, onListening);
  },
  (err) => {
    logCrash('stats-boot', err);
    console.error(`[stats] startup failed, refusing to start: ${err.message}`);
    process.exit(1);
  },
);
```

Check that `restoreSessionsSnapshot` doesn't need `server` to be listening:
`grep -n "function restoreSessionsSnapshot" -A 30 server.js`. It only
rebuilds `GameManager`s, so it is safe.

- [ ] **Step 7: Config report without SQLite**

In `game/ConfigReport.js`:
- Line 46 doc comment: change `accountsBackend ('postgres'|'sqlite')` to `accountsBackend ('postgres')`.
- Replace the `else if (!facts.accountsEnabled)` and `else` branches (lines 85–88) with:
  ```js
  } else if (!facts.accountsEnabled) {
    add('accounts', 'Benutzerkonten', 'off', 'aus - keine Datenbank (PIKDAME_DATABASE_URL fehlt): Spiel ohne Konten und Statistik');
  } else {
    add('accounts', 'Benutzerkonten', 'ok', 'aktiv (PostgreSQL)');
  }
  ```

In `test/admin-config.test.js:14`, change `accountsBackend: 'sqlite'` to
`accountsBackend: 'postgres'`. Then run
`grep -n "SQLite im Datenverzeichnis\|node:sqlite fehlt" test/*.js` and
update each match to the new texts.

- [ ] **Step 8: Run the new server tests**

Run: `node --test test/stats-server.test.js` (with and without `PIKDAME_TEST_PG_URL`)
Expected: PASS

- [ ] **Step 9: Remove SQLite from the existing tests**

- `test/account-store.test.js`:
  - Delete the `createAccountStore` require, the `probe`/`HAS_SQLITE`
    block, `freshStore()`, and every test with `skip: !HAS_SQLITE` or
    `node:sqlite` (line ~158 included).
  - Keep the `PgAccountStore` tests (from line 76 on).
  - Add a test that `createAccountStoreAuto({}, { pool: null })` returns
    `null`.
- `test/admin-users-monitor.test.js`:
  - Delete the two `AccountStore (SQLite)` tests and the
    `createAccountStore`/`HAS_SQLITE` lines.
  - Port the "older season" test to Postgres using `createPgAccountStore(PG_URL)`, a unique name suffix, and
    `await` on each call. Skip it without `PG_URL`.
  - In the server test (line 201):
    - change `{ skip: !HAS_SQLITE }` to `{ skip: !hasPg && 'needs PIKDAME_TEST_PG_URL' }`;
    - create `const schema = await freshSchema();` at the start, and pass
      `PIKDAME_DATABASE_URL: schema.url`;
    - call `await schema.drop()` in `t.after` after the server has exited;
    - after the healthz loop, add
      `assert.ok(fs.existsSync(path.join(dataDir, 'players.json.imported')), 'guest file imported into Postgres');`.
- `test/passkeys.test.js`: delete the `AccountStore (SQLite)` test (line
  120) and the `server (SQLite)` test (line 144). If any tests still need
  them, keep `HAS_LIB`/`PG_URL`. Delete the `HAS_SQLITE` lines.
  - For the PostgreSQL server test (line 146), pass a `freshSchema()` URL
    instead of `PG_URL`, so its accounts and stats tables don't collide
    with other test runs. Drop the schema after the server exits.
- `test/game-manager.test.js:2343-2366`: move this test into
  `test/account-store.test.js` as a `PgAccountStore` test. Use a unique
  `Flo_${suffix}` name, set expiry with
  `UPDATE users SET verify_expires = $1 WHERE username = $2` through a
  separate `pg` pool on `PG_URL`, and `await` each call. Skip it without
  `PG_URL`.

- [ ] **Step 10: Run the whole suite**

Run: `npm test` (without Postgres), then
`PIKDAME_TEST_PG_URL=postgres://pikdame:testpass@127.0.0.1:5432/pikdame_test npm test`.
Expected: both PASS. Without Postgres, the DB tests show as skipped.

Before staging, run `pgrep -af "node server.js"` and confirm that no stray
server is left (CLAUDE.md tests).

- [ ] **Step 11: Commit**

```bash
rm -f data/*.json data/crash.log
git add server.js game/AccountStore.js game/ConfigReport.js test/stats-server.test.js test/account-store.test.js test/admin-users-monitor.test.js test/passkeys.test.js test/game-manager.test.js test/admin-config.test.js
git commit -m "feat(stats)!: server keeps all stats in Postgres; SQLite accounts removed

Boot: schema, pending replay, JSON import, load, then session restore and
listen. Without PIKDAME_DATABASE_URL the game runs play-only."
```

---

### Task 11: Docs, rules, version 3.0.0

**Files:**
- Modify: `CLAUDE.md` (lines 35, 70, 162, 184–185, 199), `README.md` (39, 195, 201, 269),
  `docs/admin/configuration.md` (22–33), `docs/admin/index.md` (40–51), `docs/admin/backup-restore.md` (12–13),
  `docs/admin/operations.md` (191, 211), `docs/admin/admin-page.md` (55), `docs/admin/mail.md` (176),
  `docs/developer/contributing.md`, `CHANGELOG.md`, `package.json`, `package-lock.json`

- [ ] **Step 1: Update the rules in `CLAUDE.md`**

- Line 35: remove the `node:sqlite` example (keep the rule; use "neuere Node-Features" without the SQLite example).
- Line 70: `JSON-Stores (atomar), \`AccountStore.js\` (SQLite) / \`PgAccountStore.js\` (Postgres, Prod) — **jede Konto-Änderung in beiden**` →
  `Stats-Stores (Dokument-API; Postgres über \`PgDocument\`/Codec, ohne DB nur RAM), \`PgAccountStore.js\` (Konten, nur Postgres). Spielverlauf liest asynchron (\`historyFor\`).`
- Line 162: `rm -f data/*.json data/crash.log data/users.db` → `rm -f data/*.json data/*.imported data/crash.log`
- Lines 184–185: replace the `users.db`/SQLite "disk I/O error" sentence with:
  `Ein eigener Server auf \`data/\` importiert dort liegende JSON-Dateien in die DB und benennt sie um.`
- Line 199: `Konten: Tests laufen gegen SQLite UND Postgres` → `Konten und Statistik: Tests laufen gegen Postgres (\`PIKDAME_TEST_PG_URL\`, je Test ein eigenes Schema über \`test/helpers/pg.js\`); ohne URL werden sie übersprungen.`

- [ ] **Step 2: Admin docs**

Replace `docs/admin/configuration.md` lines 22–33 (the "Accounts: SQLite or
PostgreSQL?" section) with:

```markdown
## Database

Accounts and all statistics (profiles, achievements, game history, daily
challenge, Stammtisch, global counters) live in **PostgreSQL**
(`PIKDAME_DATABASE_URL`; the compose files set it).

**Without a database** the game runs **play-only**: everyone plays as a guest,
there are no accounts, and statistics are kept only until the next restart.

On the first start with a database, existing JSON files in the data directory
(`players.json`, `games.json`, `stats.json`, `challenges.json`,
`stammtisch.json`) are imported automatically and renamed to
`*.json.imported`. The log shows one line per file. If a file cannot be
imported exactly, the server refuses to start and names the file.

Old SQLite account files (`users.db`) are not migrated.
```

- In `docs/admin/index.md` (40–51): replace the rows for `players.json`,
  `stats.json`, `games.json`, `challenges.json`, `stammtisch.json` and
  `users.db` with one row:
  `| \`*.json.imported\` | Old statistics files after the import into PostgreSQL — keep as a backup or delete |`.
  Add a row:
  `| \`pending-stats.json\` | Only after a shutdown while the database was unreachable; applied on the next start |`.
  Update the sample log line to `Datenverzeichnis beschreibbar: /app/data [sessions-snapshot.json 2310B, pending-stats.json –]`.
- In `docs/admin/backup-restore.md` (12–13): the two rows become one row,
  `| Accounts, profiles, stats, achievements, history | PostgreSQL (\`pg_dump\`) | …people can't log in and lose their stats. |`.
  Keep the third column's wording style.
- `docs/admin/operations.md:191`: remove "SQLite WAL"; the archive covers
  the snapshot only, and stats come from `pg_dump`.
  `:211`: "sessions live in RAM, accounts and stats in PostgreSQL".
- `docs/admin/admin-page.md:55`: `players.json` → "the player profile (in PostgreSQL)".
- `docs/admin/mail.md:176`: `Backend: sqlite` → `Backend: postgres`.
- `README.md`:
  - :39: "PostgreSQL in the Docker/K8s stack (without a database: play-only, no accounts)".
  - :195: `PostgreSQL for accounts and statistics (compose sets it; without it: play-only)`.
  - :201: remove "SQLite in WAL mode".
  - :269: "accounts and stats live in PostgreSQL".
- `docs/developer/contributing.md`: add a "Tests with PostgreSQL" paragraph
  with the `docker run … postgres:18-alpine` command and the
  `PIKDAME_TEST_PG_URL` example from Task 1, Step 6.

Then run `grep -rn -i "sqlite\|users\.db" docs README.md CLAUDE.md k8s helm`.
Expected: no match except history (CHANGELOG). Fix any other match the same
way.

- [ ] **Step 3: Version and CHANGELOG**

Bump to 3.0.0. First check
`git fetch && git show origin/main:package.json | grep '"version"'`; if main
has moved, merge first (CLAUDE.md workflow 2).

```bash
npm version 3.0.0 --no-git-tag-version
```

Add at the top of `CHANGELOG.md` (under the header):

```markdown
## [3.0.0] - 2026-10-09

### Changed
- **Alle Statistiken liegen in der Datenbank**: Profile, Abzeichen, Spielverlauf, Tages-Challenge, Stammtisch und die Gesamtzahlen werden in PostgreSQL gespeichert statt in Dateien. Vorhandene Dateien werden beim ersten Start automatisch übernommen, kein Wert geht verloren
- **Keine Obergrenzen mehr**: Profile, Partien, Stammtische und Challenge-Tage werden nicht mehr nach einer Höchstzahl oder Inaktivität gelöscht

### Fixed
- Ein Challenge-Ergebnis kurz vor einem Neustart des Servers ging verloren

### Removed
- **SQLite für Konten**: Konten und Statistik brauchen PostgreSQL. Ohne Datenbank läuft das Spiel nur noch zum Spielen, ohne Konten und ohne gespeicherte Statistik
```

- [ ] **Step 4: Verify docs and the full suite**

Run: `npm run docs:check && npm test`
Expected: PASS (`docs:check` validates the generated fragments)

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md README.md docs/admin docs/developer/contributing.md CHANGELOG.md package.json package-lock.json
git commit -m "docs: statistics in PostgreSQL, play-only without a database (3.0.0)"
```

---

## Manual verification before the PR (not a task: done by the executor at the end)

1. Use `docker compose -f docker/docker-compose.yml up` with a copy of real
   `players.json`/`games.json` in the data volume. The log should show one
   `imported …` line per file. `/healthz` should return `ok`.
2. Play one bot game in the browser and open the profile and history. Both
   should show the old values plus the new game.
3. Run `docker compose stop postgres`, play a game, and check that `/healthz`
   returns `ok (stats degraded)`. Then run `docker compose start postgres`:
   the log should say `database reachable again`. The game you played should
   be in the history.
4. Stop the game container while Postgres is down. `pending-stats.json`
   should appear. Start both: the log should say `re-applied …`, and the
   file should be gone.
