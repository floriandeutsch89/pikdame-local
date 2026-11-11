// The boss floors at the table (public/boss-fight.js): the rules as words, the last
// turn's events as effects, and the client's wiring. The module decides no rule.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const Boss = require('../public/boss-fight.js');
const BossFight = require('../game/BossFight');

const pub = path.join(__dirname, '..', 'public');
const DE = (de) => de;
const EN = (de, en) => en;
const viewOf = (stage, play = () => {}) => {
  const boss = BossFight.BOSSES[stage];
  const s = BossFight.start(boss);
  play(s, boss);
  return BossFight.publicView(s, boss);
};

test('every boss of the engine has a face, a name and an entrance line in both languages', () => {
  for (const stage of Object.keys(BossFight.BOSSES)) {
    const view = viewOf(stage);
    assert.ok(Boss.known(view), `floor ${stage}`);
    assert.match(Boss.portraitSvg(view.id), /^<svg[^>]*aria-hidden="true"/);
    for (const L of [DE, EN]) {
      assert.ok(Boss.nameOf(view.id, L).length > 3);
      assert.ok(Boss.introLine(view, L).length > 10);
      assert.ok(Boss.lifeRule(view, L).text.includes('25'));
    }
  }
  assert.strictEqual(Boss.known({ id: 'dragon' }), false, 'an unknown boss draws nothing');
  assert.deepStrictEqual(Boss.traits({ id: 'dragon' }, DE), []);
});

test('every rule the server sends becomes a chip with an explanation; none is invented', () => {
  const keys = (stage) => Boss.traits(viewOf(stage), DE).map((t) => t.key);
  assert.deepStrictEqual(keys(10), ['ambush', 'combo']);
  assert.deepStrictEqual(keys(15), ['armor', 'combo']);
  assert.deepStrictEqual(keys(20), ['scratch', 'curse', 'crit', 'combo']);
  for (const stage of [10, 15, 20]) {
    for (const L of [DE, EN]) {
      for (const t of Boss.traits(viewOf(stage), L)) {
        assert.ok(t.label && t.title && t.text.length > 20 && t.icon, `${stage}/${t.key}`);
      }
    }
  }
  const de = Boss.traits(viewOf(10), DE).find((t) => t.key === 'ambush');
  assert.ok(de.label.includes('1,5') && Boss.traits(viewOf(10), EN)[0].label.includes('1.5'), 'the decimal mark follows the language');
});

test('the chips follow the fight: the ambush is spent after its hit, rage shows only when enraged', () => {
  const spent = viewOf(10, (s, boss) => BossFight.bossTurn(s, boss, { points: 40, newMelds: 1 }));
  assert.strictEqual(Boss.traits(viewOf(10), DE)[0].cls, 'armed');
  assert.strictEqual(Boss.traits(spent, DE)[0].cls, 'spent');
  const raging = viewOf(10, (s, boss) => {
    BossFight.playerTurn(s, boss, { points: 300, newMelds: 1 });
    BossFight.roundEnd(s, boss, {});
  });
  assert.strictEqual(raging.enraged, true);
  assert.strictEqual(Boss.traits(raging, DE)[0].key, 'rage');
  const catsDown = viewOf(20, (s, boss) => BossFight.playerTurn(s, boss, { points: 200, newMelds: 1 }));
  assert.strictEqual(Boss.traits(catsDown, DE).find((t) => t.key === 'scratch').cls, 'spent');
});

test('effects: my strike is one effect with its reason, then what struck me, each event once', () => {
  const view = viewOf(20, (s, boss) => BossFight.playerTurn(s, boss, { points: 80, newMelds: 2, holdsQueen: true }));
  const fx = Boss.effectsOf(view, 0, DE);
  assert.deepStrictEqual(fx.map((f) => [f.fx, f.amount]), [['strike', 120], ['claws', 3], ['curse', 10]]);
  assert.deepStrictEqual(fx[0].adds, [{ add: 0, amount: 100 }, { add: 1, amount: 20 }]);
  assert.strictEqual(fx[0].boss, 0, 'the cats took it all');
  assert.match(fx[0].label, /KOMBO ×1,5/);
  assert.deepStrictEqual(Boss.effectsOf(view, 99, DE), [], 'nothing twice');

  const hit = viewOf(10, (s, boss) => BossFight.bossTurn(s, boss, { points: 40, newMelds: 1 }));
  const [slash] = Boss.effectsOf(hit, 0, EN);
  assert.deepStrictEqual([slash.fx, slash.amount, slash.heavy], ['slash', 60, true]);
  assert.match(slash.label, /AMBUSH ×1\.5/);

  const armour = viewOf(15, (s, boss) => BossFight.playerTurn(s, boss, { points: 40, newMelds: 1 }));
  assert.match(Boss.effectsOf(armour, 0, DE)[0].label, /RÜSTUNG −10/);
});

test('the round end tells what the hand cards cost each side', () => {
  const view = viewOf(10, (s, boss) => BossFight.roundEnd(s, boss, { myHand: 35, bossHand: 20 }));
  assert.deepStrictEqual(Boss.handDamage(view), { me: 35, boss: 20 });
  assert.deepStrictEqual(Boss.handDamage(viewOf(10)), { me: 0, boss: 0 });
});

test('client contract: the module is loaded before client.js, switchable, and never a second rule', () => {
  const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
  const client = fs.readFileSync(path.join(pub, 'client.js'), 'utf8');
  const css = fs.readFileSync(path.join(pub, 'style.css'), 'utf8');
  const src = fs.readFileSync(path.join(pub, 'boss-fight.js'), 'utf8');
  assert.ok(html.indexOf('/boss-fight.js') > 0 && html.indexOf('/boss-fight.js') < html.indexOf('/client.js'));
  assert.match(html, /id="bossFxCheckbox"/, 'new animations can be switched off (CLAUDE.md 2c)');
  assert.match(html, /<symbol id="i-heart"/);
  assert.match(client, /window\.PikdameBoss \|\| null/, 'a stale cached page without the module still boots');
  assert.match(client, /fx: \(\) => bossFxOn/);
  // Life points are the server's: the module only reads them.
  assert.doesNotMatch(src, /\.(hp|me)\s*[-+]?=[^=]/, 'the table never changes a life');
  // Effects stay under every dialog; nothing shakes the whole table.
  assert.match(css, /#bossFx \{[^}]*z-index: var\(--z-table-fx\)/);
  assert.doesNotMatch(css, /#table\.bossFight[^{]*\{[^}]*animation/);
  // Reduced motion: no vortex, no pulse.
  const reduced = css.slice(css.lastIndexOf('.bossPanel.rage::before, .bossPanel.rage .bossPortrait, .biRing'));
  assert.match(reduced, /animation: none/);
  assert.ok(Boss.INTRO_MS + 240 < 2000, 'the entrance ends within two seconds');
  assert.ok(Boss.FX_MS <= 400);
});
