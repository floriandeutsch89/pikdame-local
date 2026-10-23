'use strict';
// An admin session for server tests: a confirmed account with a password (made in the
// database), its game sign-in and the password step-up that sets the admin cookie.
// The server must list the account's address in PIKDAME_ADMINS.
const http = require('http');
const { createPgAccountStore } = require('../../game/PgAccountStore');

const ADMIN = { name: 'Chefin', email: 'chefin@example.org', password: 'admin-pass-1' };

/** A confirmed account with a password; before or after the server starts. */
async function createAdminAccount(databaseUrl, account = ADMIN) {
  const store = createPgAccountStore(databaseUrl);
  try {
    const r = await store.register(account.name, account.email, account.password);
    if (r.error) throw new Error(r.error);
    const v = await store.verifyEmail(r.verifyToken);
    if (v.error) throw new Error(v.error);
  } finally {
    await store.close();
  }
  return account;
}

/** One HTTP request: { status, headers, body, json }. `form` is sent urlencoded. */
function call(port, method, urlPath, { json, form, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const h = { ...headers };
    let payload = null;
    if (json) { payload = JSON.stringify(json); h['Content-Type'] = 'application/json'; }
    else if (form) { payload = form; h['Content-Type'] = 'application/x-www-form-urlencoded'; }
    if (payload) h['Content-Length'] = Buffer.byteLength(payload);
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method, headers: h }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(data); } catch (e) { /* html */ }
        resolve({ status: res.statusCode, headers: res.headers, body: data, json: parsed });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** Game sign-in + password step-up: { cookie: 'pikdame_admin=…', token, csrf }. */
async function adminLogin(port, account = ADMIN, headers = {}) {
  const login = await call(port, 'POST', '/api/login', { json: { username: account.email, password: account.password }, headers });
  if (login.status !== 200) throw new Error(`login failed: ${login.status} ${login.body}`);
  const token = login.json.token;
  const v = await call(port, 'POST', '/admin/step-up/verify', { json: { token, password: account.password }, headers });
  if (v.status !== 200) throw new Error(`step-up failed: ${v.status} ${v.body}`);
  const cookie = v.headers['set-cookie'][0].split(';')[0];
  const page = await call(port, 'GET', '/admin', { headers: { ...headers, Cookie: cookie } });
  const csrf = (page.body.match(/name="csrf" value="([a-f0-9]+)"/) || [])[1];
  if (!csrf) throw new Error('no CSRF token on /admin');
  return { cookie, token, csrf };
}

module.exports = { ADMIN, createAdminAccount, adminLogin, call };
