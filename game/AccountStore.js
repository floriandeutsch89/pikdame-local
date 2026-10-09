// Accounts need PostgreSQL (PgAccountStore on the server's shared pool).
// Without a database there are no accounts: the client hides the account UI.
function createAccountStoreAuto(env = process.env, { pool = null } = {}) {
  if (!pool || !env.PIKDAME_DATABASE_URL) return null;
  const { createPgAccountStore } = require('./PgAccountStore');
  return createPgAccountStore(env.PIKDAME_DATABASE_URL, { pool });
}

module.exports = { createAccountStoreAuto };
