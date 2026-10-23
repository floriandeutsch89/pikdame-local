// The migration runner (game/Migrations.js) against a real PostgreSQL schema.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Pool } = require('pg');
const { migrate, ensureMigrated, loadMigrations, MIGRATIONS_DIR } = require('../game/Migrations');
const { testDatabaseUrl } = require('./helpers/test-db');
const { createPgAccountStore } = require('../game/PgAccountStore');

function migrationsDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pikdame-mig-'));
  for (const [name, sql] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), sql);
  return dir;
}

/** The shipped migrations up to `version`: a database as an older release left it. */
function filesUpTo(version) {
  return migrationsDir(Object.fromEntries(loadMigrations().filter((m) => m.version <= version)
    .map((m) => [path.basename(m.file), fs.readFileSync(m.file, 'utf8')])));
}

async function withPool(t, url = testDatabaseUrl('mig')) {
  const pool = new Pool({ connectionString: url, max: 3 });
  t.after(() => pool.end());
  const rows = async (q) => (await pool.query(q)).rows;
  return { url, pool, rows };
}

test('migrations: the shipped files are numbered 001.. without gaps', () => {
  const all = loadMigrations();
  assert.ok(all.length >= 1);
  assert.strictEqual(all[0].name, 'baseline');
  assert.deepStrictEqual(all.map((m) => m.version), all.map((_, i) => i + 1));
});

test('migrations: a gap or a duplicate number refuses to run', () => {
  assert.throws(() => loadMigrations(migrationsDir({ '001_a.sql': '', '003_c.sql': '' })), /expected 002/);
  assert.throws(() => loadMigrations(migrationsDir({ '001_a.sql': '', '001_b.sql': '' })), /expected 002/);
});

test('migrations: a fresh database gets every file, a second run does nothing', async (t) => {
  const { pool, rows } = await withPool(t);
  const all = loadMigrations();
  assert.deepStrictEqual(await migrate(pool), all.map((m) => m.version));
  assert.deepStrictEqual((await rows('SELECT version, name FROM schema_migrations ORDER BY version')).map((r) => [r.version, r.name]),
    all.map((m) => [m.version, m.name]));
  assert.ok((await rows("SELECT to_regclass('users') AS t"))[0].t, 'the baseline created the account tables');
  assert.deepStrictEqual(await migrate(pool), []);
  assert.strictEqual(await ensureMigrated(pool), await ensureMigrated(pool), 'one run per pool');
});

test('migrations: an up-to-date database is checked without waiting for the lock', async (t) => {
  const { pool } = await withPool(t);
  await migrate(pool);
  const holder = await pool.connect();
  try {
    await holder.query('BEGIN');
    await holder.query('SELECT pg_advisory_xact_lock(726813)');
    const res = await Promise.race([migrate(pool), new Promise((r) => setTimeout(() => r('blocked'), 3000))]);
    assert.deepStrictEqual(res, []);
  } finally {
    await holder.query('COMMIT');
    holder.release();
  }
});

test('migrations: a new file on an existing database is applied once, also by racing starts', async (t) => {
  const { url, pool, rows } = await withPool(t);
  const files = { '001_one.sql': 'CREATE TABLE one (id INT);' };
  assert.deepStrictEqual(await migrate(pool, { dir: migrationsDir(files) }), [1]);
  await pool.query('INSERT INTO one VALUES (7)');
  const dir = migrationsDir({ ...files, '002_two.sql': 'ALTER TABLE one ADD COLUMN two TEXT; INSERT INTO one VALUES (8, \'x\');' });
  const pools = Array.from({ length: 4 }, () => new Pool({ connectionString: url, max: 2 }));
  try {
    const applied = await Promise.all(pools.map((p) => migrate(p, { dir })));
    assert.deepStrictEqual(applied.flat(), [2], 'exactly one start applied it');
  } finally {
    await Promise.all(pools.map((p) => p.end()));
  }
  assert.deepStrictEqual((await rows('SELECT id, two FROM one ORDER BY id')).map((r) => [r.id, r.two]), [[7, null], [8, 'x']]);
});

test('migrations: a failing file rolls back completely and stays unrecorded', async (t) => {
  const { pool, rows } = await withPool(t);
  const ok = { '001_one.sql': 'CREATE TABLE one (id INT);' };
  await migrate(pool, { dir: migrationsDir(ok) });
  const bad = migrationsDir({ ...ok, '002_half.sql': 'CREATE TABLE half (id INT); SELECT no_such_function();' });
  await assert.rejects(migrate(pool, { dir: bad }), /no_such_function/);
  assert.deepStrictEqual((await rows('SELECT version FROM schema_migrations')).map((r) => r.version), [1]);
  assert.strictEqual((await rows("SELECT to_regclass('half') AS t"))[0].t, null, 'its first statement is undone too');
  const fixed = migrationsDir({ ...ok, '002_half.sql': 'CREATE TABLE half (id INT);' });
  assert.deepStrictEqual(await migrate(pool, { dir: fixed }), [2], 'the fixed file applies on the next start');
});

test('migrations: the directory ships next to game/', () => {
  assert.strictEqual(MIGRATIONS_DIR, path.join(__dirname, '..', 'migrations'));
  const dockerfile = fs.readFileSync(path.join(__dirname, '..', 'docker', 'Dockerfile'), 'utf8');
  assert.match(dockerfile, /^COPY migrations \.\/migrations$/m, 'the image needs the files');
});

test('migration 005: rows of 003/004 keep their data in DATE/TIMESTAMPTZ columns, target split', async (t) => {
  require('../game/Database'); // the DATE parser: game days come back as strings
  const { pool, rows } = await withPool(t);
  await migrate(pool, { dir: filesUpTo(4) });
  const at = Date.UTC(2026, 9, 22, 18, 30, 0, 123);
  await pool.query(`INSERT INTO challenge_results (day, name_key, name, score, queens, at) VALUES
    ('2026-10-22', 'ada', 'Ada', 480, 2, ${at}), ('2026-13-45', 'bad', 'Bad', 1, 0, ${at})`);
  await pool.query(`INSERT INTO challenge_attempts (day, name_key, name, code, at, state) VALUES
    ('2026-10-22', 'ada', 'Ada', 'ABC123', ${at - 60000}, 'done'), ('2026-10-23', 'ben', 'Ben', 'XYZ789', ${at}, 'running')`);
  await pool.query(`INSERT INTO legacy_imports (name, imported_at) VALUES ('challenges.json', ${at})`);
  await pool.query(`INSERT INTO play_events (at, day, name_key, name, area, target, outcome, turns, duration_ms, attempt_id, facts) VALUES
    (${at}, '2026-10-22', 'ada', 'Ada', 'tower', '2026-11/7', 'lost', 41, 600000, 'a1', '{"cause":"queen"}'),
    (${at}, '2026-10-22', 'ben', 'Ben', 'tower', '2026-10/12', 'won', 30, NULL, 'a2', '{}'),
    (${at}, '2026-10-22', 'cy', 'Cy', 'daily', '2026-10-22', 'abandoned', NULL, NULL, NULL, '{}')`);

  assert.deepStrictEqual(await migrate(pool, { dir: filesUpTo(5) }), [5]);
  const types = await rows(`SELECT table_name || '.' || column_name AS col, data_type FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name IN ('challenge_results', 'challenge_attempts', 'legacy_imports', 'play_attempts')
      AND data_type IN ('date', 'timestamp with time zone', 'bigint') ORDER BY 1`);
  assert.deepStrictEqual(types.map((r) => `${r.col}:${r.data_type}`), [
    'challenge_attempts.game_day:date', 'challenge_attempts.started_at:timestamp with time zone',
    'challenge_attempts.updated_at:timestamp with time zone',
    'challenge_results.finished_at:timestamp with time zone', 'challenge_results.game_day:date',
    'legacy_imports.imported_at:timestamp with time zone',
    'play_attempts.ended_at:timestamp with time zone', 'play_attempts.game_day:date', 'play_attempts.id:bigint',
    'play_attempts.started_at:timestamp with time zone',
  ], 'no epoch integers left (the id is the only bigint)');

  const results = await rows('SELECT * FROM challenge_results');
  assert.deepStrictEqual(results.map((r) => [r.game_day, r.player_key, r.player_name, r.score, r.queens_caught, r.finished_at.getTime()]),
    [['2026-10-22', 'ada', 'Ada', 480, 2, at]], 'ms kept exactly; the impossible day is dropped');
  const attempts = await rows('SELECT * FROM challenge_attempts ORDER BY player_key');
  assert.deepStrictEqual(attempts.map((r) => [r.game_day, r.player_key, r.session_code, r.status, r.started_at.getTime(), r.updated_at.getTime()]),
    [['2026-10-22', 'ada', 'ABC123', 'done', at - 60000, at - 60000], ['2026-10-23', 'ben', 'XYZ789', 'running', at, at]]);
  await assert.rejects(pool.query("UPDATE challenge_attempts SET status = 'odd'"), /challenge_attempts_status_check/);
  assert.deepStrictEqual((await rows('SELECT source, imported_at FROM legacy_imports')).map((r) => [r.source, r.imported_at.getTime()]),
    [['challenges.json', at]]);

  const plays = await rows('SELECT * FROM play_attempts ORDER BY id');
  assert.deepStrictEqual(plays.map((r) => [r.id, r.attempt_id, r.player_key, r.mode, r.period, r.stage, r.game_day, r.turns,
    r.ended_at.getTime() - r.started_at.getTime(), r.ended_at.getTime(), r.facts]), [
    ['1', 'a1', 'ada', 'tower', '2026-11', 7, '2026-10-22', 41, 600000, at, { cause: 'queen' }],
    ['2', 'a2', 'ben', 'tower', '2026-10', 12, '2026-10-22', 30, 0, at, {}],
    ['3', null, 'cy', 'daily', '2026-10-22', null, '2026-10-22', null, 0, at, {}],
  ], 'started_at = end - duration, else the end');
  const next = await rows(`INSERT INTO play_attempts (player_key, player_name, mode, period, outcome, game_day, started_at, ended_at)
    VALUES ('dee', 'Dee', 'tower', '2026-11', 'won', '2026-11-01', now(), now()) RETURNING id`);
  assert.strictEqual(next[0].id, '4', 'the identity continues after the copied ids');
  assert.strictEqual((await rows("SELECT to_regclass('play_events') AS t"))[0].t, null);
  const indexes = await rows(`SELECT tablename || ':' || indexname AS i FROM pg_indexes WHERE schemaname = current_schema()
    AND tablename IN ('challenge_results', 'challenge_attempts', 'legacy_imports', 'play_attempts') ORDER BY 1`);
  assert.deepStrictEqual(indexes.map((r) => r.i), [
    'challenge_attempts:challenge_attempts_pkey', 'challenge_attempts:challenge_attempts_session_code_idx',
    'challenge_results:challenge_results_pkey', 'legacy_imports:legacy_imports_pkey',
    'play_attempts:play_attempts_attempt_id_key', 'play_attempts:play_attempts_ended_at_idx',
    'play_attempts:play_attempts_mode_period_stage_idx', 'play_attempts:play_attempts_pkey',
    'play_attempts:play_attempts_player_key_mode_ended_at_idx',
  ]);
});

test('migration players: every known name gets a player, the challenge and attempt rows point at it', async (t) => {
  require('../game/Database'); // the DATE parser
  const { pool, rows } = await withPool(t);
  const version = loadMigrations().find((m) => m.name === 'players').version;
  await migrate(pool, { dir: filesUpTo(version - 1) });
  const at = (h) => new Date(Date.UTC(2026, 9, 22, h));
  await pool.query(`INSERT INTO challenge_results (game_day, player_key, player_name, score, queens_caught, finished_at) VALUES
    ('2026-10-22', 'ada', 'ada', 480, 2, $1), ('2026-10-22', 'ben', 'Ben', 300, 0, $1), ('2026-10-22', '', '', 1, 0, $1)`, [at(10)]);
  await pool.query(`INSERT INTO challenge_attempts (game_day, player_key, player_name, session_code, started_at, status) VALUES
    ('2026-10-22', 'ben', 'Ben', 'ABC123', $1, 'done'), ('2026-10-23', 'cy', 'Cy', 'XYZ789', $2, 'running')`, [at(9), at(12)]);
  await pool.query(`INSERT INTO play_attempts (attempt_id, player_key, player_name, mode, period, stage, outcome, game_day, started_at, ended_at)
    VALUES ('a1', 'ada', 'Ada', 'tower', '2026-10', 1, 'won', '2026-10-22', $1, $2), ('a2', 'dee', 'Dee', 'tower', '2026-10', 2, 'lost', '2026-10-22', $1, $1)`,
  [at(8), at(11)]);

  assert.deepStrictEqual(await migrate(pool, { dir: filesUpTo(version) }), [version]);
  const players = await rows('SELECT id, player_key, player_name, created_at, last_seen_at, games_played FROM players ORDER BY player_key');
  assert.deepStrictEqual(players.map((p) => [p.player_key, p.player_name, p.created_at, p.last_seen_at.getTime(), p.games_played]), [
    ['ada', 'Ada', null, at(11).getTime(), 0], ['ben', 'Ben', null, at(10).getTime(), 0],
    ['cy', 'Cy', null, at(12).getTime(), 0], ['dee', 'Dee', null, at(8).getTime(), 0],
  ], 'one player per key, its newest name, age unknown, no profile yet');
  const id = Object.fromEntries(players.map((p) => [p.player_key, p.id]));
  const linked = await rows(`SELECT 'r:' || player_key AS k, player_id FROM challenge_results
    UNION ALL SELECT 'a:' || player_key, player_id FROM challenge_attempts
    UNION ALL SELECT 'p:' || player_key, player_id FROM play_attempts ORDER BY 1`);
  assert.deepStrictEqual(linked.map((r) => [r.k, r.player_id]), [
    ['a:ben', id.ben], ['a:cy', id.cy], ['p:ada', id.ada], ['p:dee', id.dee], ['r:ada', id.ada], ['r:ben', id.ben],
  ], 'every row points at its player; the empty name is gone');
  await assert.rejects(pool.query(`INSERT INTO challenge_results (game_day, player_key, player_name, score, finished_at)
    VALUES ('2026-10-23', 'eve', 'Eve', 1, now())`), /player_id/, 'NOT NULL from now on');
  await assert.rejects(pool.query("INSERT INTO players (player_key, player_name) VALUES ('', '')"), /players_player_key_check/);
  await assert.rejects(pool.query("INSERT INTO players (player_key, player_name, favorite_badges) VALUES ('x', 'X', '{a,b,c,d}')"),
    /players_favorite_badges_check/);

  // Deleting a player takes everything of theirs along (a guest's deletion request).
  await pool.query("DELETE FROM players WHERE player_key = 'ada'");
  assert.deepStrictEqual((await rows('SELECT player_key FROM challenge_results UNION ALL SELECT player_key FROM play_attempts ORDER BY 1'))
    .map((r) => r.player_key), ['ben', 'dee']);

  const named = await rows(`SELECT tablename || ':' || indexname AS i FROM pg_indexes WHERE schemaname = current_schema()
    AND tablename LIKE 'player%' ORDER BY 1`);
  assert.deepStrictEqual(named.map((r) => r.i), [
    'player_badges:player_badges_pkey', 'player_card_backs:player_card_backs_pkey', 'player_puzzles:player_puzzles_pkey',
    'player_quests:player_quests_pkey', 'player_tower_stars:player_tower_stars_pkey',
    'players:players_games_won_total_score_idx', 'players:players_pkey', 'players:players_player_key_key',
  ]);
  const constraints = await rows(`SELECT conname FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
    WHERE n.nspname = current_schema() AND contype IN ('c', 'f') AND conname ~ '^(player|challenge|play_attempts_player)' ORDER BY 1`);
  assert.deepStrictEqual(constraints.map((r) => r.conname), [
    'challenge_attempts_player_id_fkey', 'challenge_attempts_status_check', 'challenge_results_player_id_fkey',
    'play_attempts_player_id_fkey', 'player_badges_player_id_fkey', 'player_card_backs_player_id_fkey',
    'player_puzzles_player_id_fkey', 'player_puzzles_stars_check', 'player_quests_player_id_fkey',
    'player_tower_stars_player_id_fkey', 'player_tower_stars_stars_check', 'player_tower_stars_tower_month_check',
    'players_favorite_badges_check', 'players_player_key_check',
  ]);
});

test('migration stammtische: tables, keys and checks named by the conventions; codes only of the lookup shape', async (t) => {
  const { pool, rows } = await withPool(t);
  const version = loadMigrations().find((m) => m.name === 'stammtische').version;
  await migrate(pool, { dir: filesUpTo(version) });
  const named = await rows(`SELECT tablename || ':' || indexname AS i FROM pg_indexes WHERE schemaname = current_schema()
    AND tablename LIKE 'stammtisch%' ORDER BY 1`);
  assert.deepStrictEqual(named.map((r) => r.i), [
    'stammtisch_game_seats:stammtisch_game_seats_pkey', 'stammtisch_games:stammtisch_games_pkey',
    'stammtisch_members:stammtisch_members_pkey', 'stammtisch_series_wins:stammtisch_series_wins_pkey',
    'stammtisch_weeks:stammtisch_weeks_pkey', 'stammtische:stammtische_pkey', 'stammtische:stammtische_stammtisch_code_key',
  ]);
  const constraints = await rows(`SELECT conname FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
    WHERE n.nspname = current_schema() AND contype IN ('c', 'f') AND conname LIKE 'stammtisch%' ORDER BY 1`);
  assert.deepStrictEqual(constraints.map((r) => r.conname), [
    'stammtisch_game_seats_player_id_fkey', 'stammtisch_game_seats_stammtisch_id_game_no_fkey',
    'stammtisch_games_stammtisch_id_fkey', 'stammtisch_members_player_id_fkey', 'stammtisch_members_stammtisch_id_fkey',
    'stammtisch_series_wins_player_id_fkey', 'stammtisch_series_wins_stammtisch_id_fkey', 'stammtisch_weeks_stammtisch_id_fkey',
    'stammtische_owner_player_id_fkey', 'stammtische_stammtisch_code_check',
  ]);
  await assert.rejects(pool.query("INSERT INTO stammtische (stammtisch_code, stammtisch_name) VALUES ('st-1', 'x')"), /stammtische_stammtisch_code_check/);
  const types = await rows(`SELECT table_name || '.' || column_name AS col FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name LIKE 'stammtisch%' AND data_type IN ('bigint', 'integer')
      AND column_name ~ '(_at|_day)$'`);
  assert.deepStrictEqual(types, [], 'no epoch integers');
});

test('migration account conventions: epoch milliseconds become exact TIMESTAMPTZ, names and keys renamed', async (t) => {
  require('../game/Database'); // the DATE parser
  const { url, pool, rows } = await withPool(t);
  const version = loadMigrations().find((m) => m.name === 'account_conventions').version;
  await migrate(pool, { dir: filesUpTo(version - 1) });
  const ms = (d, h, milli) => Date.UTC(2026, 9, d, h, 7, 9, milli);
  const [created, expires, linkExpires, codeExpires, reviewChanged, used, finalized, signedIn] =
    [ms(1, 8, 123), ms(3, 9, 1), ms(4, 10, 999), ms(5, 11, 500), ms(6, 12, 42), ms(7, 13, 7), ms(8, 14, 0), ms(9, 15, 250)];
  await pool.query(`INSERT INTO users (username, email, password_hash, salt, verified, created_at, login_token_hash, login_expires,
      review_mail, review_mail_at, games, wins)
    VALUES ('Ada', 'ada@example.org', '\\x00', 's1', TRUE, $1, 'h1', $2, TRUE, $3, 4, 2)`, [created, linkExpires, reviewChanged]);
  await pool.query(`INSERT INTO users (username, email, password_hash, salt, verified, verify_token, verify_expires, created_at,
      verify_code_hash, verify_code_expires) VALUES ('Ben', 'ben@example.org', '\\x00', '', FALSE, 't2', $1, $2, 'c2', $3)`,
  [expires, created, codeExpires]);
  const [ada] = (await rows('SELECT id FROM users ORDER BY id')).map((r) => r.id);
  await pool.query('INSERT INTO sessions (token, user_id, created_at) VALUES ($1, $2, $3)', ['tok', ada, signedIn]);
  await pool.query(`INSERT INTO webauthn_credentials (id, user_id, public_key, counter, name, created_at, last_used_at)
    VALUES ('cred-1', $1, '\\x01', 7, 'iPhone', $2, $3), ('cred-2', $1, '\\x02', 0, NULL, $2, NULL)`, [ada, created, used]);
  await pool.query("INSERT INTO season_finals (season, finalized_at, ranked) VALUES ('2026-09', $1, 3)", [finalized]);
  await pool.query("INSERT INTO season_results (user_id, season, place, season_xp, season_games) VALUES ($1, '2026-09', 1, 500, 9)", [ada]);
  await pool.query("INSERT INTO season_meta (key, value) VALUES ('archive_from', '2026-09')");

  assert.deepStrictEqual(await migrate(pool, { dir: filesUpTo(version) }), [version]);
  const time = (d) => (d ? d.getTime() : null);
  const users = await rows(`SELECT username, password_salt, email_verified, games_played, games_won, created_at, updated_at,
      verify_expires_at, login_expires_at, verify_code_expires_at, review_mail_changed_at, player_id FROM users ORDER BY id`);
  assert.deepStrictEqual(users.map((u) => [u.username, u.password_salt, u.email_verified, u.games_played, u.games_won,
    time(u.created_at), time(u.updated_at), time(u.verify_expires_at), time(u.login_expires_at), time(u.verify_code_expires_at),
    time(u.review_mail_changed_at), u.player_id]), [
    ['Ada', 's1', true, 4, 2, created, created, null, linkExpires, null, reviewChanged, null],
    ['Ben', '', false, 0, 0, created, created, expires, null, codeExpires, null, null],
  ], 'every instant to the millisecond; updated_at starts at created_at; the store links the player');
  const [session] = await rows('SELECT session_token, user_id, created_at FROM login_sessions');
  assert.deepStrictEqual([session.session_token, session.user_id, time(session.created_at)], ['tok', ada, signedIn]);
  const creds = await rows('SELECT credential_id, credential_name, sign_count, created_at, last_used_at, updated_at FROM webauthn_credentials ORDER BY 1');
  assert.deepStrictEqual(creds.map((c) => [c.credential_id, c.credential_name, Number(c.sign_count), time(c.created_at), time(c.last_used_at), time(c.updated_at)]), [
    ['cred-1', 'iPhone', 7, created, used, used], ['cred-2', null, 0, created, null, created],
  ]);
  assert.strictEqual(time((await rows('SELECT finalized_at FROM season_finals'))[0].finalized_at), finalized);
  assert.deepStrictEqual(await rows('SELECT meta_key, meta_value FROM season_meta'), [{ meta_key: 'archive_from', meta_value: '2026-09' }]);
  assert.ok((await rows('SELECT updated_at FROM season_results'))[0].updated_at instanceof Date);

  const named = await rows(`SELECT tablename || ':' || indexname AS i FROM pg_indexes WHERE schemaname = current_schema()
    AND tablename IN ('users', 'login_sessions', 'webauthn_credentials') ORDER BY 1`);
  assert.deepStrictEqual(named.map((r) => r.i), [
    'login_sessions:login_sessions_created_at_idx', 'login_sessions:login_sessions_pkey', 'login_sessions:login_sessions_user_id_idx',
    'users:users_login_token_hash_idx', 'users:users_lower_email_key', 'users:users_lower_username_key', 'users:users_pkey',
    'users:users_player_id_key', 'users:users_review_unsub_hash_idx', 'users:users_season_season_xp_idx',
    'users:users_verify_expires_at_idx', 'users:users_verify_token_idx',
    'webauthn_credentials:webauthn_credentials_pkey', 'webauthn_credentials:webauthn_credentials_user_id_idx',
  ]);
  const constraints = await rows(`SELECT conname FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
    WHERE n.nspname = current_schema() AND conrelid::regclass::text IN ('users', 'login_sessions', 'webauthn_credentials') ORDER BY 1`);
  assert.deepStrictEqual(constraints.map((r) => r.conname), [
    'login_sessions_pkey', 'login_sessions_user_id_fkey', 'users_pkey', 'users_player_id_fkey', 'users_player_id_key',
    'webauthn_credentials_pkey', 'webauthn_credentials_user_id_fkey',
  ]);
  const epoch = await rows(`SELECT table_name || '.' || column_name AS col FROM information_schema.columns
    WHERE table_schema = current_schema() AND data_type IN ('bigint', 'integer') AND column_name ~ '_at$'
      AND table_name <> 'schema_migrations'`);
  assert.deepStrictEqual(epoch, [], 'no epoch integers left');

  // The store links confirmed accounts by the stores' key (JS lower case). Two accounts on
  // one key (a database whose lower() differs; here: its unique index dropped) keep the first.
  await pool.query("INSERT INTO players (player_key, player_name, games_played) VALUES ('ada', 'Ada', 3)");
  await pool.query('DROP INDEX users_lower_username_key');
  await pool.query(`INSERT INTO users (username, email, password_hash, password_salt, email_verified)
    VALUES ('ADA', 'ada2@example.org', '\\x00', '', TRUE)`);
  const store = createPgAccountStore(url);
  t.after(() => store.close());
  assert.strictEqual(await store.isRegisteredName('Ada'), true);
  const links = await rows('SELECT u.username, p.player_key, p.games_played FROM users u LEFT JOIN players p ON p.id = u.player_id ORDER BY u.id');
  assert.deepStrictEqual(links.map((l) => [l.username, l.player_key, l.games_played]), [
    ['Ada', 'ada', 3], ['Ben', null, null], ['ADA', null, null],
  ], 'the guest profile goes to the first account; unconfirmed and the second one stay unlinked');
});
