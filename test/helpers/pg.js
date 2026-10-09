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
