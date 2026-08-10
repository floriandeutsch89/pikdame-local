// Verträge zwischen Client-JS, HTML und i18n - fängt eine ganze
// Fehlerklasse ab: el('id') auf ein fehlendes Element wirft beim LADEN
// und würde die komplette App sterben lassen (kein Rendering, keine
// Fehlermeldung fuer den Nutzer).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const clientJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'client.js'), 'utf8');

test('Client-Vertrag: jede el(...)-ID existiert im HTML', () => {
  const ids = new Set([...clientJs.matchAll(/el\('([^']+)'\)/g)].map((m) => m[1]));
  const missing = [...ids].filter((id) => !html.includes(`id="${id}"`));
  assert.deepEqual(missing, [], `el() auf fehlende IDs: ${missing.join(', ')}`);
});

test('Client-Vertrag: Rundenspruch-Liste ist zweisprachig und dublettenfrei', () => {
  // The quotes are seeded from dealer+round so the whole table sees the
  // same one - a duplicate would silently make one line twice as likely,
  // and a one-language entry would show German text to English players.
  const block = clientJs.match(/function roundQuote\([\s\S]*?const Q = \[([\s\S]*?)\n {4}\];/);
  assert.ok(block, 'Spruchliste nicht gefunden');
  const entries = block[1].split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith('['));
  assert.ok(entries.length >= 50, `nur ${entries.length} Sprueche - Liste geschrumpft?`);
  const german = [];
  for (const line of entries) {
    // ['de', 'en'],  /  ['de', "en"],
    const pair = line.match(/^\[\s*(['"])((?:\.|(?!\1).)*)\1\s*,\s*(['"])((?:\.|(?!\3).)*)\3\s*\],?$/);
    assert.ok(pair, `kein sauberes de/en-Paar: ${line.slice(0, 70)}`);
    assert.ok(pair[2].length > 3 && pair[4].length > 3, `leerer Spruch: ${line.slice(0, 70)}`);
    german.push(pair[2]);
  }
  const dupes = german.filter((v, i) => german.indexOf(v) !== i);
  assert.deepEqual(dupes, [], `doppelte Sprueche: ${dupes.join(' | ')}`);
});

test('Client-Vertrag: keine ungeschuetzten localStorage-Zugriffe', () => {
  // Nur die drei storage*-Wrapper duerfen localStorage direkt anfassen
  // (Safari-Privatmodus/volles Quota werfen sonst beim App-Start).
  const direct = (clientJs.match(/localStorage\./g) || []).length;
  assert.ok(direct <= 3, `${direct} direkte localStorage-Zugriffe (erwartet: max. 3 in den Wrappern)`);
});

test('i18n-Vertrag: alle I18N_STATIC-Eintraege existieren im HTML', () => {
  const ctx = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'i18n.js'), 'utf8'), ctx);
  const plainHtml = html.replace(/&amp;/g, '&');
  const missing = Object.keys(ctx.window.I18N_STATIC).filter((de) => !plainHtml.includes(de));
  assert.deepEqual(missing, [], `STATIC-Eintraege ohne HTML-Gegenstueck: ${missing.slice(0, 3).join(' | ')}`);
});

test('i18n-Vertrag: Server-Muster sind gueltige RegExp-Paare', () => {
  const ctx = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'i18n.js'), 'utf8'), ctx);
  for (const entry of ctx.window.I18N_SERVER_PATTERNS) {
    // instanceof RegExp scheitert cross-realm (vm-Kontext) -> Duck-Typing
    assert.ok(
      entry.length === 2 && typeof entry[0].test === 'function' && typeof entry[1] === 'string',
      `kaputtes Muster: ${String(entry[0]).slice(0, 60)}`
    );
    assert.doesNotThrow(() => entry[0].test('probe')); // Muster ist anwendbar
  }
});

// --- v1.36.1: changelog ordering guard -------------------------------------------
test('CHANGELOG: Versionen stehen streng absteigend (neueste ganz oben)', () => {
  const fs = require('fs');
  const path = require('path');
  const text = fs.readFileSync(path.join(__dirname, '..', 'CHANGELOG.md'), 'utf8');
  const versions = [...text.matchAll(/^## \[(\d+)\.(\d+)\.(\d+)\]/gm)].map((m) =>
    m.slice(1, 4).map(Number)
  );
  assert.ok(versions.length > 10, 'parser sanity');
  for (let i = 1; i < versions.length; i++) {
    const [a, b] = [versions[i - 1], versions[i]];
    const newerFirst = a[0] > b[0] || (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] > b[2])));
    assert.ok(newerFirst, `Reihenfolge kaputt: ${a.join('.')} steht vor ${b.join('.')}`);
  }
});

// --- v1.78.1: UI-Größenstufen dürfen die Hand nie sprengen ----------------------
test('CSS contract: every uiscale card height fits into the matching #hand min-height', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');
  const FAN_DIP = 6; // capped fan dip (see #hand base comment)
  const SELECT_LIFT = 14; // .card.selected { top: -14px }
  const baseHand = Number((css.match(/#hand \{[^}]*min-height:\s*(\d+)px/s) || [])[1]);
  const baseCard = Number((css.match(/\.card \{[^}]*height:\s*(\d+)px/s) || [])[1]);
  assert.ok(baseHand >= baseCard + FAN_DIP + SELECT_LIFT, `base: hand ${baseHand} >= card ${baseCard}+dip+lift`);
  for (const scale of ['large', 'xlarge']) {
    const cardM = css.match(new RegExp(`html\\[data-uiscale="${scale}"\\] #hand \\.card[^{]*\\{[^}]*height:\\s*(\\d+)px`));
    assert.ok(cardM, `${scale}: card height rule exists`);
    const cardH = Number(cardM[1]);
    // Die Stufe muss eine EIGENE #hand-min-height mitbringen, sobald ihre
    // Karten höher sind als die Basis-Reserve - sonst ragen die Karten über
    // die Werkzeugleiste (Live-Bug-Report mit Foto, uiscale xlarge).
    const handM = css.match(new RegExp(`html\\[data-uiscale="${scale}"\\] #hand \\{[^}]*min-height:\\s*(\\d+)px`));
    const handH = handM ? Number(handM[1]) : baseHand;
    assert.ok(handH >= cardH + FAN_DIP + SELECT_LIFT,
      `${scale}: #hand min-height ${handH}px must cover card ${cardH}px + dip + selection lift`);
  }
});

// --- v1.82.2: Themes müssen den vollen Variablensatz definieren -------------------
test('CSS contract: every data-theme defines the same variable set as the reference', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');
  const themeVars = (name) => {
    const m = css.match(new RegExp(`\\[data-theme="${name}"\\] \\{([\\s\\S]*?)\\n\\}`));
    assert.ok(m, `theme block ${name} exists`);
    return new Set([...m[1].matchAll(/(--[a-z0-9-]+):/g)].map((x) => x[1]));
  };
  const themes = [...css.matchAll(/\[data-theme="([a-z]+)"\]/g)].map((m) => m[1]);
  const ref = themeVars('night');
  for (const t of new Set(themes)) {
    const missing = [...ref].filter((v) => !themeVars(t).has(v));
    // Ein unvollständiges Theme erbt die Werte eines ANDEREN Themes - im
    // hellen Küchentisch-Theme wurden Hinweistexte dadurch weiß auf hell
    // und unlesbar (Foto-Report). Vollständigkeit ist Pflicht.
    assert.deepEqual(missing, [], `theme '${t}' must define: ${missing.join(', ')}`);
  }
});

// --- v1.84.4: Sichtbarkeits-Verträge für Glow und Jackpot-Overlay ----------------
test('CSS contract: the just-drawn marker rests on a full-strength accent ring', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');
  const frames = css.match(/@keyframes drawnGlow \{([\s\S]*?)\n\}/);
  assert.ok(frames, 'drawnGlow keyframes exist');
  // Der Ruhezustand (100%) muss die VOLLE Akzentfarbe tragen. Klingt er in
  // --accent-soft aus (~0.28 Alpha), ist die Markierung nach dem Aufblitzen
  // praktisch unsichtbar - genau der gemeldete Fehler, in jedem Theme.
  const resting = frames[1].match(/100%[^}]*\}/);
  assert.ok(resting, '100% frame exists');
  assert.match(resting[0], /0 0 0 3px var\(--accent\)/, 'resting ring uses the full accent colour');

  const block = css.match(/\.card\.just-drawn \{([\s\S]*?)\n\}/);
  assert.ok(block, '.card.just-drawn block exists');
  // Kommentare rauswerfen: geprüft werden DEKLARATIONEN, nicht Prosa (der
  // Block erklärt in Worten, warum es hier kein z-index gibt).
  const declarations = block[1].replace(/\/\*[\s\S]*?\*\//g, '');
  // Lektion aus .selected: eine nach vorn geholte Karte verdeckt den
  // Klickstreifen der rechten Nachbarkarte im Fächer.
  assert.doesNotMatch(declarations, /z-index\s*:/, 'must not raise z-index (hides the neighbour click strip)');
});

test('CSS contract: the raid/lucky overlay is a real panel with theme colours', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');
  const panel = css.match(/\.raidWarning \{([\s\S]*?)\n\}/);
  assert.ok(panel, '.raidWarning block exists');
  // Ohne Hintergrund/Polster/Maximalbreite malt der Glanz-Schatten ein
  // hartkantiges Rechteck um den Textblock und die Überschrift läuft
  // seitlich heraus (Foto-Report).
  for (const prop of ['background', 'padding', 'max-width', 'border-radius']) {
    assert.match(panel[1], new RegExp(`\\n\\s*${prop}:`), `panel must define ${prop}`);
  }
  // Farben aus Theme-Variablen: hart kodierte helle Töne waren auf dem
  // hellen Küchentisch-Theme unlesbar.
  for (const sel of [/\.raidWarning \.rwTitle \{([\s\S]*?)\n\}/, /\.raidWarning\.lucky \.rwTitle \{([^}]*)\}/]) {
    const m = css.match(sel);
    assert.ok(m, `block ${sel} exists`);
    const colour = m[1].match(/(?:^|\s)color:\s*([^;]+);/);
    assert.ok(colour, 'title defines a colour');
    assert.match(colour[1], /var\(--/, `title colour must come from a theme variable, got: ${colour[1]}`);
  }
});

// --- v1.88.2: Bedienelemente in Overlay-Karten müssen HELLE Töne nutzen ----------
test('CSS contract: overlay controls use card colours, not the dark-table palette', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');
  // .overlay-card ist in JEDEM Theme hell (dort werden --text-muted und
  // --glass-border lokal umgesetzt). Wer darin --text oder --glass-strong
  // benutzt, malt die Töne des DUNKLEN Tisches: weiß auf weiß. Genau so war
  // das Einstellungs-Menü beim ersten Wurf unlesbar (Foto-Report).
  const card = css.match(/\.overlay-card \{([\s\S]*?)\n\}/);
  assert.ok(card, '.overlay-card block exists');
  assert.match(card[1], /--text-muted:/, 'the card still remaps muted text locally');

  // Der ganze Abschnitt darf genau EINMAL vorkommen. Ein versehentlich
  // doppelt angehängter Block gewinnt als spätere Regel gleicher
  // Spezifität - so überlebte die unlesbare Fassung einen Release, während
  // dieser Test nur die (korrekte) erste Definition prüfte.
  const sections = css.match(/\/\* --- Einstellungs-Menü/g) || [];
  assert.equal(sections.length, 1, `the settings CSS section exists ${sections.length}x - a duplicate would override the fixed one`);

  // v2.0.0: .resultTabBtn / .settingsRow* live in the same light card. The
  // result tabs shipped as var(--text) on rgba(255,255,255,0.05) - near-white
  // on white, so the inactive tab was unreadable.
  for (const selector of ['.settingsSelect', '.settingsAction', '.settingsCheckbox', '.settingsLabel', '.settingsList',
    '.resultTabBtn', '.settingsRow', '.sheetRowValue']) {
    // ALLE Vorkommen prüfen, nicht nur das erste: Ein versehentlich doppelt
    // im Stylesheet stehender Block gewinnt als SPÄTERE Regel gleicher
    // Spezifität - genau so überlebte die unlesbare Fassung einen Release,
    // während dieser Test die (korrekte) erste Definition prüfte.
    const blocks = [...css.matchAll(new RegExp(`\\${selector}[^{]*\\{([\\s\\S]*?)\\n\\}`, 'g'))];
    assert.ok(blocks.length > 0, `${selector} block exists`);
    for (const block of blocks) {
      const declarations = block[1].replace(/\/\*[\s\S]*?\*\//g, '');
      assert.doesNotMatch(
        declarations,
        /(?:^|\s)(?:color|background|background-color):[^;]*var\(--(?:text|glass-strong|glass)\)/,
        `${selector} must not paint with the dark-table palette inside a light overlay card`
      );
    }
  }
});

// --- v1.90.0: Ziel-Markierungen gehören AUSSCHLIESSLICH ins Tutorial -----------
test('client contract: target highlights are gated on the tutorial being active', () => {
  const client = fs.readFileSync(path.join(__dirname, '..', 'public', 'client.js'), 'utf8');
  // Wunsch des Nutzers: Die neuen Ziel-Markierungen (Ziehstapel, Abwerfen-
  // Knopf) dürfen NUR im Tutorial erscheinen. Im Rauchtest lässt sich das
  // nicht prüfen, weil die Hinweise dort durchgehend aktiv sind - deshalb
  // wird die Bedingung hier direkt am Quelltext festgehalten.
  // Zeilenweise statt per Klammer-Regex: die Bedingung enthält
  // verschachtelte Klammern (Array.isArray(...)), an denen ein naiver
  // Ausdruck scheitert.
  const branch = client.split('\n').find((line) => line.includes('hl.targets') && line.includes('if ('));
  assert.ok(branch, 'the targets branch exists');
  assert.match(
    branch,
    /tutorialActive/,
    'target highlights must be guarded by tutorialActive - they must never show up in a normal game'
  );
  // Und die Klasse darf nirgends sonst gesetzt werden.
  const setters = client.match(/classList\.add\('tutorialGlowTarget'\)/g) || [];
  assert.equal(setters.length, 1, 'exactly one place may add the target highlight class');
});

// --- v1.94.0: icon sprite replaces the emoji chrome ---------------------------
test('icon contract: every <use href="#i-..."> resolves to a defined <symbol>', () => {
  // A typo in a sprite reference fails SILENTLY - the button just renders
  // empty, which no other test would notice.
  const symbols = new Set([...html.matchAll(/<symbol id="(i-[a-z0-9-]+)"/g)].map((m) => m[1]));
  const used = [...html.matchAll(/<use href="#(i-[a-z0-9-]+)"/g)].map((m) => m[1]);
  const clientJs2 = fs.readFileSync(path.join(__dirname, '..', 'public', 'client.js'), 'utf8');
  // client.js swaps icons at runtime (sound on/off, bulb, fullscreen).
  for (const m of clientJs2.matchAll(/setRowIcon\([^,]+,\s*(?:on|enabled)\s*\?\s*'(i-[a-z0-9-]+)'\s*:\s*'(i-[a-z0-9-]+)'/g)) {
    used.push(m[1], m[2]);
  }
  assert.ok(symbols.size >= 15, `sprite looks empty (${symbols.size} symbols)`);
  const dangling = [...new Set(used)].filter((id) => !symbols.has(id));
  assert.deepEqual(dangling, [], `<use> without a matching <symbol>: ${dangling.join(', ')}`);
});

test('icon contract: icon-only buttons keep an accessible name', () => {
  // Replacing an emoji with an <svg> removes the text a screen reader used to
  // announce - every icon-only control must carry aria-label or title.
  const missing = [];
  for (const m of html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)) {
    const [, attrs, inner] = m;
    const hasIcon = /<use href="#i-/.test(inner);
    const textLeft = inner.replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/<[^>]+>/g, '').trim();
    if (!hasIcon || textLeft) continue; // has a visible label -> fine
    if (!/aria-label=|title=/.test(attrs)) {
      missing.push((attrs.match(/id="([^"]+)"/) || [, '(no id)'])[1]);
    }
  }
  assert.deepEqual(missing, [], `icon-only buttons without an accessible name: ${missing.join(', ')}`);
});

test('icon contract: labels next to an icon live in their own <span>', () => {
  // applyStaticLang() writes textContent when switching language, and only
  // inventories LEAF elements. A bare text node beside an <svg> would both
  // escape translation and get wiped along with the icon.
  const offenders = [];
  for (const m of html.matchAll(/<(button|h2)\b([^>]*)>([\s\S]*?)<\/\1>/g)) {
    const [, tag, attrs, inner] = m;
    if (!/<use href="#i-/.test(inner)) continue;
    const bare = inner.replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, '').trim();
    if (bare) offenders.push(`${tag}#${(attrs.match(/id="([^"]+)"/) || [, '?'])[1]}: "${bare}"`);
  }
  assert.deepEqual(offenders, [], `label text beside an icon must be wrapped in <span>: ${offenders.join(' | ')}`);
});

test('CSS contract: the type scale is defined and control heights meet the touch minimum', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');
  for (const token of ['--fs-title', '--fs-body', '--fs-label', '--fs-hint', '--tap-min', '--ctl-h']) {
    assert.ok(css.includes(`${token}:`), `${token} must be defined in :root`);
  }
  const tap = css.match(/--tap-min:\s*(\d+)px/);
  assert.ok(tap && Number(tap[1]) >= 44, 'touch targets must be at least 44px (Apple HIG; phone is the primary device)');
  // The bare .btn-icon rule (not the .seatControls variant) must use the token.
  const btnIcon = css.match(/^\.btn-icon\s*\{[^}]*\}/m);
  assert.ok(btnIcon, '.btn-icon rule exists');
  assert.match(btnIcon[0], /width:\s*var\(--tap-min\)/, '.btn-icon must size itself from --tap-min');
});

test('CSS contract: scrollable regions declare both fade edges', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');
  const clientJs3 = fs.readFileSync(path.join(__dirname, '..', 'public', 'client.js'), 'utf8');
  // Fade edges are the ONLY scroll affordance on iOS (the overlay scrollbar is
  // hidden at rest). Both the hand and the melds need each edge class styled
  // AND actually toggled - a stale call site once left the hand without any.
  for (const cls of ['canScrollL', 'canScrollR', 'canScrollUp', 'canScrollDown']) {
    assert.ok(css.includes('.' + cls), `${cls} must be styled`);
    assert.ok(
      clientJs3.includes(`classList.toggle('${cls}'`),
      `${cls} must be toggled from client.js - a styled edge nobody sets is the v1.70.0 bug all over again`
    );
  }
});

test('icon contract: elements carrying an icon are never written with textContent', () => {
  // Assigning textContent to a button that holds an <svg class="icon"> DELETES
  // the icon. It bit langBtnLobby, rulesTitle and accountBtn in turn - the
  // label came back as an emoji and the icon was gone. Write the <span>
  // instead (setLabelText / setRowValue).
  const clientSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'client.js'), 'utf8');
  const iconIds = new Set();
  for (const m of html.matchAll(/<(?:button|h2)\b[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/(?:button|h2)>/g)) {
    if (/<use href="#i-/.test(m[2])) iconIds.add(m[1]);
  }
  assert.ok(iconIds.size >= 5, `expected several icon-bearing elements, found ${iconIds.size}`);
  const offenders = [...iconIds].filter((id) => {
    if (clientSrc.includes(`el('${id}').textContent =`)) return true;
    if (clientSrc.includes(`el('${id}').innerHTML =`)) return true;
    // ...also when the element is first parked in a local: `const rfBtn =
    // el('resultForfeitBtn'); ... rfBtn.textContent = ...` slipped past the
    // direct check and silently wiped the icon. Only the block right after
    // the declaration counts - names like `btn` are reused all over the file
    // and a whole-file search reports every one of them.
    const decl = new RegExp('(?:const|let|var)\\s+(\\w+)\\s*=\\s*el\\(\'' + id + '\'\\)', 'g');
    for (const m of clientSrc.matchAll(decl)) {
      const window = clientSrc.slice(m.index, m.index + 900);
      if (new RegExp('\\b' + m[1] + '\\.(?:textContent|innerHTML)\\s*=').test(window)) return true;
    }
    return false;
  });
  assert.deepEqual(offenders, [], `these carry an icon but are written wholesale: ${offenders.join(', ')}`);
});

test('CSS contract: buttons in a flex row carry no per-ID box overrides', () => {
  // Twice now a leftover #id rule from an older layout broke a row it was no
  // longer part of: #forfeitBtn kept a muted colour inside the light settings
  // sheet, and #tutorialBtn kept margin-top:8px inside .menuChips, rendering
  // 8px shorter than the Challenge button beside it. Row spacing and colour
  // belong to the container/class, never to one member's ID.
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');
  const rowClasses = ['menuChips', 'dialog-actions', 'lobbyTools', 'headerRight', 'sheetList'];
  const ids = new Set();
  for (const cls of rowClasses) {
    // Locate each container by class, then take the buttons up to its close
    // tag. Plain indexOf on purpose - a RegExp built from a template literal
    // silently eats its own escapes.
    let from = 0;
    for (;;) {
      const open = html.indexOf('class="' + cls, from);
      if (open === -1) break;
      const gt = html.indexOf('>', open);
      const end = html.indexOf('</div>', gt);
      const inner = html.slice(gt + 1, end === -1 ? undefined : end);
      for (const idm of inner.matchAll(/<button[^>]*id="([^"]+)"/g)) ids.add(idm[1]);
      from = gt + 1;
    }
  }
  assert.ok(ids.size >= 4, `expected buttons inside flex rows, found ${ids.size}`);
  const offenders = [];
  const BAD_PROPS = /(?:^|[;{\s])(margin[a-z-]*|width|height|flex|color)\s*:/;
  for (const id of ids) {
    const re = new RegExp('(?:^|\\n)#' + id + '\\s*\\{([^}]*)\\}', 'g');
    for (const m of css.matchAll(re)) {
      const decls = m[1].replace(/\/\*[\s\S]*?\*\//g, '');
      const bad = decls.match(BAD_PROPS);
      if (bad) offenders.push('#' + id + ' sets ' + bad[1]);
    }
  }
  assert.deepEqual(offenders, [], `per-ID box/colour overrides inside a flex row: ${offenders.join(' | ')}`);
});

test('CSS contract: nothing in the hand fan raises z-index', () => {
  // The fan overlaps by design, so each card shows only a narrow strip. Any
  // rule that lifts one card above its right-hand neighbours covers exactly
  // those strips: .selected and .just-drawn were fixed for this before, and
  // :hover still did it - on a PC the pointer got stuck on the raised card
  // and could not reach the next one.
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');
  const selectors = ['#hand .card:hover', '.card.selected', '.card.just-drawn'];
  for (const sel of selectors) {
    const idx = css.indexOf(sel + ' {');
    if (idx === -1) continue; // rule may be written differently; other tests cover those
    const block = css.slice(idx, css.indexOf('}', idx));
    const decls = block.replace(/\/\*[\s\S]*?\*\//g, '');
    assert.doesNotMatch(decls, /z-index\s*:/, `${sel} must not raise z-index (it hides the neighbour's click strip)`);
  }
});

// --- Sprachwechsel: jede Funktion, die Text ERZEUGT, muss auffrischbar sein ----
test('client contract: functions that build translated markup are refreshed by cycleLang', () => {
  const client = fs.readFileSync(path.join(__dirname, '..', 'public', 'client.js'), 'utf8');

  // Hintergrund: Dreimal derselbe Fehler (Weiterspielen-Knopf 1.88.1,
  // Einstellungs-Auswahlfelder 1.88.1, Tagesaufgaben 2.12.1). Jedes Mal war
  // die Übersetzung korrekt - aber der erzeugte Text wurde beim Umschalten
  // nicht neu gebaut. Statischer Text aus dem HTML ist über I18N_STATIC
  // abgedeckt; gefährlich ist nur Text, den JS SELBST ins DOM schreibt.
  const lines = client.split('\n');

  // 1) Alle Funktionsrümpfe einsammeln (Namen + Bereich).
  const functions = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*function ([A-Za-z_][\w]*)\s*\(/);
    if (!m) continue;
    const indent = lines[i].search(/\S/);
    let end = lines.length - 1;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].search(/\S/) === indent && /^\s*\}/.test(lines[j])) { end = j; break; }
    }
    functions.push({ name: m[1], body: lines.slice(i, end + 1).join('\n') });
  }
  assert.ok(functions.length > 20, 'the parser found the functions');

  // 2) Welche davon schreiben ÜBERSETZTEN Text ins DOM?
  //    WICHTIG: auch INDIREKT. renderQuests() etwa ruft kein L(), sondern
  //    questMeta(), das die Texte übersetzt - genau dieser Fall war der Bug
  //    aus 2.12.1, und eine reine "enthält L("-Prüfung hätte ihn verfehlt.
  const usesLDeep = (body, depth = 0) => {
    if (/\bL\(/.test(body)) return true;
    if (depth > 2) return false;
    for (const call of body.matchAll(/\b([A-Za-z_][\w]*)\s*\(/g)) {
      const fn = functions.find((f) => f.name === call[1]);
      if (fn && fn.body !== body && usesLDeep(fn.body, depth + 1)) return true;
    }
    return false;
  };
  const writesTranslatedMarkup = (body) => {
    const writes = /\.(innerHTML|textContent)\s*=|\.appendChild\(|\.insertAdjacentHTML\(/.test(body);
    return writes && usesLDeep(body);
  };

  // 3) Von cycleLang aus erreichbar? (direkt oder über eine gerufene Funktion)
  const cycle = functions.find((f) => f.name === 'cycleLang');
  assert.ok(cycle, 'cycleLang exists');
  const reachable = new Set();
  const walk = (body, depth) => {
    if (depth > 3) return;
    for (const call of body.matchAll(/\b([A-Za-z_][\w]*)\s*\(/g)) {
      const name = call[1];
      if (reachable.has(name)) continue;
      const fn = functions.find((f) => f.name === name);
      if (!fn) continue;
      reachable.add(name);
      walk(fn.body, depth + 1);
    }
  };
  walk(cycle.body, 0);
  // render() ist der Haupt-Zeichner und wird von cycleLang gerufen.
  assert.ok(reachable.has('render'), 'cycleLang triggers the main render');

  // 4) Ausnahmen: Funktionen, die NUR auf Ereignis laufen (Toasts, Overlays,
  //    die beim Öffnen ohnehin neu bauen) - sie können nicht veralten.
  const EVENT_ONLY = new Set([
    'showToast', 'showHint', 'showRaidWarning', 'celebrateProgress', 'showTip',
    'renderMiniMarkdown', 'renderReplayRound', 'renderScoreChart', 'renderStats',
    'renderChallengeBoard', 'renderTutorialChecklist', 'renderDiscardPreview',
    'renderCutOverlay', 'renderResultOverlay', 'renderSessionBanner',
    'tutorialExplainError', 'questMeta', 'badgeProgressFor', 'updateTutorial',
    'flashLevelUp', 'openOverlay', 'renderLadder', 'renderProfileList',
    // Verbindungsanzeige: schreibt bei JEDEM Zustandswechsel neu, und die
    // Sprache ist beim naechsten Ereignis (spaetestens dem Verbindungsaufbau)
    // wieder aktuell - ein Sprachwechsel im Sekundenfenster dazwischen
    // korrigiert sich von selbst.
    'scheduleReconnect', 'connect',
    // Overlays, die ihren Inhalt beim OEFFNEN aufbauen: Wer die Sprache
    // wechselt, hat sie zu; beim naechsten Oeffnen stehen sie richtig.
    'openChangelog', 'openCardbackGallery',
    // Aktualisierungs-Hinweis: erscheint einmalig und fuehrt zum Neuladen.
    'showUpdateBanner',
  ]);

  const stale = functions
    .filter((f) => writesTranslatedMarkup(f.body))
    .map((f) => f.name)
    .filter((name) => !reachable.has(name) && !EVENT_ONLY.has(name) && name !== 'cycleLang');

  assert.deepEqual(
    stale, [],
    'these build translated markup but cycleLang never re-runs them - they would stay in the old language:\n  '
      + stale.join('\n  ')
      + '\nEither call them from cycleLang or add them to EVENT_ONLY if they cannot go stale.'
  );
});
