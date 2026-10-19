// Provider and contact for the legal page; the e-mail enters the DOM only after a click.
// A file, not inline: the CSP only hashes index.html's inline scripts (contract test).
(function () {
  function decode(el) {
    var raw = el && el.getAttribute('data-imprint');
    if (!raw) return null;
    try { return JSON.parse(decodeURIComponent(atob(raw))); } catch (e) { return null; }
  }
  var providerEl = document.getElementById('providerBlock');
  var lines = decode(providerEl);
  // Not configured: the server already wrote the notice into the block.
  if (!lines) return;
  providerEl.textContent = '';
  lines.forEach(function (line, i) {
    if (i) providerEl.appendChild(document.createElement('br'));
    providerEl.appendChild(document.createTextNode(line));
  });
  var el = document.getElementById('contactBlock');
  var mail = decode(el);
  if (!mail) return;
  el.textContent = '';
  var btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn-secondary';
  btn.textContent = 'E-Mail-Adresse anzeigen';
  btn.addEventListener('click', function () {
    var link = document.createElement('a');
    link.href = 'mailto:' + mail;
    link.textContent = mail;
    el.textContent = '';
    el.appendChild(document.createTextNode('E-Mail: '));
    el.appendChild(link);
  });
  el.appendChild(btn);
})();
