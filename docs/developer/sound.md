# Sound effects

Every effect is synthesised in the browser by `public/sfx.js`; there are no
audio files. Card noises are filtered noise bursts with a short resonant body,
bells and mallets are decaying partials, the brass is a band-limited saw through
a lowpass that opens on the attack. Each play renders a fresh take (seeded
noise, a little timing and pitch jitter), so a run of discards never sounds
machine-made.

## The effects

| Effect | Sound | When |
| --- | --- | --- |
| `draw` | a card slides off the pile, its edge snips free | tap on the draw or the discard pile |
| `discard` | a breath of air, the slap on the felt | my discard, a forfeit vote |
| `meld` | three quick slaps | "Auslegen", a joker choice, a solved daily puzzle |
| `deal` | a riffle shuffle, the bridge, the deck squared | the first state of a new deal (cutting or playing), never on a reload |
| `turn` | two rising chimes, C5 and E5 (the old bell, rounder) | my turn begins |
| `error` | two dull knocks | a refused move |
| `roundEnd` | the G major arpeggio on a mallet | the result sheet |
| `unlock` | a soft chime, G5 and D6 | a badge unlock card |
| `pikdame` | a brass "Tusch", ta-ta-ta-taaa | the Queen of Spades laid by me or my partner (a watcher hears it too) |
| `pikdameLost` | a low "dun - dunnn" | laid by another seat |
| `pikdameCaught` | the sad trombone, wah wah wah waaah | round end with her in my hand, with her chip in the result sheet |
| `lucky` | a harp run up and a sparkle | a Glücksgriff when cutting |

The cat's "miau" stays an oscillator through a moving band pass in `client.js`.

## Phone speakers

- An iPhone speaker plays next to nothing below about 300 Hz. The card bodies
  therefore sit at 400 to 1000 Hz instead of a real table's thump, and the low
  cues (the "dun-dun", the trombone) live on their overtones: the ear still
  hears the low note. Every effect ends in a high-pass (12 dB/octave at 180 Hz,
  24 dB/octave at the effect's `hp`); `test/sfx.test.js` keeps less than 15 % of
  each effect's energy below 300 Hz.
- Each take is normalised to its `db`, the RMS of its sounding part (from the
  first to the last sample above -40 dB of its peak), and peaks at 0.4 at most:
  an effect on top of "Laut" music stays below full scale.
- The balance follows ear-weighted (A-weighted) loudness: the card noises below
  the turn bell, the softest a draw; the Queen's cues and the Glücksgriff above.
- The music levels hang on the turn bell; see {doc}`music`.

## Playing them

- `PikdameSfx.play(ctx, name, { volume, when })` renders a take at the
  context's sample rate (a few ms; the brass cues up to ~3) and starts it.
- `playSfx()` in `client.js` adds the sound switch, the AudioContext shared with
  the music and the idle suspend. A context that is not running yet (iOS before
  the first tap, or suspended while idle) plays the effect once it resumes,
  unless that takes over a second: then it is dropped instead of sounding at the
  next tap.
- Cues queue: the shuffle, the Queen's cues, the round end and the badge chime
  wait for the cue before them, and the bell holds the ones after it. A cue that
  would start more than 2.5 s late is dropped.
- Another seat's move plays quietly and never vibrates: `sound.draw({ quiet: true })`
  (or a volume 0..1, e.g. `sound.discard(0.3)`).

## Listening

```bash
node scripts/render-sfx.js /tmp/sfx   # every effect as a WAV, with its levels and spectrum
```

In the browser console of the running game:

```js
const ac = new AudioContext(); ac.resume(); let t = ac.currentTime + 0.2;
for (const name of PikdameSfx.NAMES) t += PikdameSfx.play(ac, name, { when: t }) + 0.6;
```

## Changing an effect

Edit its entry in `EFFECTS`, listen, then run `node --test --require
./test/helpers/setup.js test/sfx.test.js`. A changed turn bell also needs
`node scripts/render-music.js --levels`.
