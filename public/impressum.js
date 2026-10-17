// Provider and contact for the legal page; the e-mail enters the DOM only after a click.
// A file, not inline: the CSP only hashes index.html's inline scripts (contract test).
(function () {
  var n = ['Florian Deutsch', 'Grindelallee 40', '20146 ' + 'Ham' + 'burg', 'Deutschland'];
  document.getElementById('providerBlock').innerHTML = n.join('<br />');
  var el = document.getElementById('contactBlock');
  var btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn-secondary';
  btn.textContent = 'E-Mail-Adresse anzeigen';
  btn.addEventListener('click', function () {
    var u = ['fde', 'pikdame'].join('\u002b');
    var d = ['mailbox', 'org'].join('\u002e');
    var a = u + '\u0040' + d;
    var link = document.createElement('a');
    link.href = 'mailto:' + a;
    link.textContent = a;
    el.innerHTML = '';
    el.appendChild(document.createTextNode('E-Mail: '));
    el.appendChild(link);
  });
  el.appendChild(btn);
})();
