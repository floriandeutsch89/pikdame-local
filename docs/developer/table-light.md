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

## Measuring on pixels

The contract is computed; the pixels are measured too. For every view (phone,
landscape, desktop), theme and phase (plus the ramp midpoints), the real client
with an engine-built table is shot twice in Chromium: once as is, once with the
table's text transparent. Under every text the contrast between its colour and
each background pixel is computed, and the 5th percentile per text is compared
with the same text on `origin/main`. Looping animations are held on their first
frame, so two runs of the same build match exactly.
