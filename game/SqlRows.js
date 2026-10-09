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
