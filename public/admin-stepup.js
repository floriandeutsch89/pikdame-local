// public/admin-stepup.js - the step-up page in front of /admin (game/AdminPage.js).
// Takes the game sign-in from this browser's storage (same origin) and posts it in
// the request body - never in a URL - together with a fresh passkey assertion or
// the account's password. The answer sets the admin cookie; then the page reloads.
// A file, not inline: the site's CSP allows no inline script here.
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const status = $('suStatus');
  const passkeyBtn = $('suPasskeyBtn');
  const passwordForm = $('suPasswordForm');
  const retryBtn = $('suRetryBtn');
  let flowId = null;
  let options = null;

  function accountToken() {
    try { return window.localStorage.getItem('pikdame_account_token') || ''; } catch (e) { return ''; }
  }

  function say(text, isError) {
    status.textContent = text;
    status.classList.toggle('err', !!isError);
  }

  async function post(path, body) {
    try {
      const res = await fetch(path, {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      return { status: res.status, ...data };
    } catch (e) {
      return { status: 0, error: 'Server nicht erreichbar.' };
    }
  }

  // GET of the same address: after a POST without a session the browser must not resend it.
  const enter = () => window.location.replace(window.location.href);

  function show({ passkey = false, password = false, retry = false }) {
    passkeyBtn.hidden = !passkey;
    passwordForm.hidden = !password;
    retryBtn.hidden = !retry;
  }

  async function start() {
    show({});
    const token = accountToken();
    if (!token) {
      say('Melde dich zuerst im Spiel mit deinem Konto an (Konto → Anmelden), dann komm hierher zurück.', true);
      return;
    }
    say('Prüfe dein Konto …');
    const r = await post('/admin/step-up/start', { token });
    if (!r.ok) {
      say(r.error || 'Das hat nicht geklappt.', true);
      show({ retry: r.status === 0 || r.status >= 500 });
      return;
    }
    if (r.method === 'passkey') {
      flowId = r.flowId;
      options = r.options;
      const lib = window.SimpleWebAuthnBrowser;
      if (!lib || !lib.browserSupportsWebAuthn()) {
        say('Dieser Browser kann keine Passkeys. Öffne den Admin-Bereich auf einem Gerät mit deinem Passkey.', true);
        return;
      }
      say(`Konto: ${r.username}. Bestätige mit deinem Passkey (Face ID, Fingerabdruck oder PIN).`);
      show({ passkey: true });
    } else {
      $('suUser').value = r.email || r.username || '';
      say(`Konto: ${r.username}. Dein Konto hat keinen Passkey - bestätige mit seinem Passwort.`);
      show({ password: true });
      $('suPassword').focus();
    }
  }

  async function verify(body) {
    const r = await post('/admin/step-up/verify', { token: accountToken(), ...body });
    if (r.ok) {
      say('Bestätigt - einen Moment …');
      enter();
      return;
    }
    say(r.error || 'Das hat nicht geklappt.', true);
    // A passkey flow is single use: the next try fetches a new one.
    if (r.reason === 'locked' || r.status === 403) show({});
    else if (flowId) show({ retry: true });
  }

  passkeyBtn.addEventListener('click', async () => {
    const lib = window.SimpleWebAuthnBrowser;
    passkeyBtn.disabled = true;
    try {
      const response = await lib.startAuthentication({ optionsJSON: options });
      await verify({ flowId, response });
    } catch (e) {
      const cancelled = e && (e.name === 'NotAllowedError' || e.name === 'AbortError' || e.code === 'ERROR_CEREMONY_ABORTED');
      say(cancelled ? 'Abgebrochen.' : 'Der Passkey konnte nicht geprüft werden.', !cancelled);
      show({ retry: true });
    } finally {
      passkeyBtn.disabled = false;
    }
  });

  passwordForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const field = $('suPassword');
    say('Prüfe …');
    await verify({ password: field.value });
    field.value = '';
  });

  retryBtn.addEventListener('click', () => { start(); });

  start();
}());
