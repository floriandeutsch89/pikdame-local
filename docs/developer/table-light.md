# Table light

The light at the table follows the time of day in German time: a cooler
morning, the familiar table by day, a warm hanging lamp over the middle in the
evening and the same lamp dimmed at night. There is no setting; players who ask
their system for more contrast (`prefers-contrast: more`) always get the day.

## Phases

| Phase | Plateau (Berlin) | Ramp into it |
| --- | --- | --- |
| Morning | 07:00–09:30 | 05:00–07:00 |
| Day | 11:00–16:30 | 09:30–11:00 |
| Evening | 18:30–22:00 | 16:30–18:30 |
| Night | 23:30–05:00 | 22:00–23:30 |

Ramps are smoothsteps. The night plateau covers 02:00–03:00, so neither DST
switch ever shows. The clock is `Europe/Berlin` via `Intl`, with UTC as the
fallback, like `game/GameDay.js`.

## How it works

- `public/table-light.js` (loaded before `client.js`, `require()`d by the tests)
  is pure: the Berlin clock and the phase weights `m`, `d`, `e`, `n` (sum 1).
- `client.js` writes them as `--tod-m/d/e/n` on `#table`: once when the table
  appears, then every 60 s while the table shows and the page is visible
  (`visibilitychange`). No animation; one step is far below a visible change.
- `style.css`, section TABLE LIGHT, turns the weights into colours. Every colour
  comes from the theme's own felt (`--bg`) or glow (`--bg-glow`), shifted with
  relative colours in OKLab (`oklab(from var(--bg) …)`), so each theme keeps its
  hue family. The layers, top to bottom: daylight glow, the pile spot, the lamp
  pool, the window band (kitchen mornings only), the room vignette, the felt.
  Everything sits under the content: card faces, `--accent`, `--drawn`, player
  colours and text colours never change.
- Card shadows: `.card` casts `--cast`, the lifted and pile cards add
  `--cast-far` after `--shadow-2`. Outside the table and at noon they are
  exactly the old shadow (`0 3px 8px rgba(0,0,0,.28)`) and nothing.
- Browsers without relative colours with numeric channels or without gradient
  colour spaces (iOS < 18) fail the `@supports` test and keep the day look,
  shadows included.

Per theme the section sets a small light budget. Dark themes: the room is
×0.88 in the evening and ×0.70 at night, the lamp brings the middle back to day
lightness (graphite +3 %, bordeaux +1 %), warm; at night it is smaller and
×0.865. The kitchen (dark ink on light wood) never gets darker: its glow and
vignette stay, the lamp lifts the middle by 3 %, and only there a window band
lights the top in the morning.

## The contract

`test/table-light-css.test.js` evaluates the section from the stylesheet
(`test/helpers/table-light-model.js`: var, calc, `oklab(from …)`, `rgb()`,
`color-mix()`), for every theme and every minute of the day:

- **Noon is today's table.** Felt, glow, vignette and card shadows at noon are
  exactly the values without the light; measured in Chromium the noon table is
  pixel-identical to the table before.
- **The room never gets lighter** under the dark themes' text (WCAG luminance),
  and the kitchen's wood never darker.
- **No text colour drops below today's floor.** For main, muted and accent text,
  the lowest contrast over the backgrounds text sits on never falls below that
  lowest contrast at noon. The backgrounds are the ones `test/theme-cascade.test.js`
  checks muted text on (felt, top glow, the spot, the two-spot pile pool, glass
  panels, pills on glass bars, the sort toggle on the hand tray), built from the
  phase's felt and glow, the middle of the table also under the lamp, plus the
  top bar over part of the glow, the vignette and the kitchen's window band.
  The lamp may use the headroom up to today's lightest text background, never
  more.
- **Composed with theme-cascade**: wherever that test holds muted text at
  4.5:1 at noon, it stays at 4.5:1 at every minute of the day.
- **One minute's step stays invisible**: CIEDE2000 below 0.5 per minute.

## Traps

- **WCAG luminance is not OKLab lightness.** The cooler morning shifted the felt
  at equal OKLab L and still lifted the luminance (bordeaux +0.25 %) or a text
  floor: every dark theme darkens its morning felt by 0.5–1.2 % (`--cool-l`) so
  the cooler light is never brighter. The red felts (Herzdame, Bordeaux) cool
  towards blue only (`--cool-a: 0`): pulling red towards green raises the
  green channel, which carries most of the luminance.
- **8-bit rounding.** On screen the felt is an 8-bit colour. Around the end of
  the morning ramp the shift is a fraction of a level, and one channel can round
  up a level before the others round down: measured text contrast then dips by
  up to 0.03 for a few minutes. No hue shift avoids that; only a pure darkening
  would, and the computed contract is exact.
- **Translucent text follows its background.** `--text-muted` is translucent: a
  darker felt also darkens the text. On a very dark felt (the night theme) more
  darkness can cost muted text contrast. The floor test covers it.
- **`color-mix()` changes the gradient.** A `color-mix()` or `oklab()` stop is
  not a legacy colour, so the gradient interpolates in OKLab instead of sRGB.
  The daylight layer says `in srgb`, or noon would differ by 1–2 levels in the
  glow.
- **Shadows on light wood.** On the kitchen's light felt a wider evening blur
  crept above the cards into the meld headers (dark ink): its cast keeps a
  12 px blur in the evening and at night.
- **Screenshots depend on the hour.** The `ui-shots` skill pins the light to
  noon; `--light morning|evening|night|HH:MM|now` shoots another time.

## Marks in the felt

On an occasion the felt carries a large, faint picture behind every card:
`client.js` sets `#table[data-mark="<id>"]`, `style.css` (section "Occasion days
at the table") gives each id its art (`public/occasions/<id>-table.svg`, used as
a CSS mask: only alpha counts) and its `--mark-tint`. Each theme mixes the tint
into its own ink (`--mark-ink`); the kitchen gets a pale inlay instead. Static,
no animation, no tap target, gone with `prefers-contrast: more`. Every mark sits
in the same box, centred in the felt between the opponents and the folded hand
bar; only the shared `#table[data-mark]::before` rules place it.

- **Which mark** (`tableMarkFor`): a birthday at this table, else the day's holiday
  from `game/Holidays.js` (Halloween, Nikolaus, Christmas, New Year's Eve, New
  Year, Easter), else the player's own mark, else none.
- **The player's own mark** (`TABLE_MARKS` in `client.js`, art in
  `public/marks/`): picked under "Optionen" → "Darstellung" → "Tischmotiv",
  stored like the card back (`pikdame_table_mark`, this device only) and never
  sent, so nobody else at the table sees it. Unlocked like the card backs, from
  the own name-based profile: by level (`myLevel`) or by a badge
  (`profile.badges`), rare ones by preference (`game/BadgeRarity.js`). A stored
  choice that is not (yet) unlocked draws nothing and stays stored, so it comes
  back with the profile. The gallery's swatch (`.markSwatch`) shares each mark's
  art and tint rule with the table; level marks appear among the level rewards,
  badge marks on that badge's unlock card. Ids never name an occasion.
- **The birthday** is the table's, not the device's: `state.birthdayToday` is true
  when a seat whose account was verified at join has its `PIKDAME_BIRTHDAY` day
  today (`game/GameDay.js`). Only at a private table (opened with "Tisch
  erstellen") and at the Stammtisch: never in the daily challenge, the
  Kartenhaus or the tutorial, and on a public server (`PIKDAME_PUBLIC_MODE=1`)
  only at the Stammtisch. Guest names never count. The flag carries no date and
  no seat (`game/GreetingDays.js` `greetingAtTable`).
- **Strength**: a tint at the pumpkin's strength would push a lighter colour over
  the contrast budget, so a lighter tint brings its own alpha
  (`rgb(… / 0.84)`): its heaviest theme stays at ~88 % of the budget. Pick a
  saturated tint: a light neutral (ivory) mostly lifts lightness, the one thing
  the budget limits, and hit it at a visible step of only ~2.5 on Nacht.
- **Contract** (`test/occasion-table.test.js`): over every mark, in every theme at
  every quarter hour, no main, muted or accent text drops below the table's noon
  floor of the section above, and every mark keeps a visible step (CIEDE2000 ≥ 3.8)
  on the bare felt; every holiday of `game/Holidays.js`, the birthday and every
  own mark have their art. The own marks' gallery and precedence:
  `test/table-marks-client.test.js`.

## Measuring on pixels

The contract is computed; the pixels are measured too. For every view (phone,
landscape, desktop), theme and phase (plus the ramp midpoints), the real client
with an engine-built table is shot twice in Chromium: once as is, once with the
table's text transparent. Under every text the contrast between its colour and
each background pixel is computed, and the 5th percentile per text is compared
with the same text on `origin/main`. Looping animations are held on their first
frame, so two runs of the same build match exactly.
