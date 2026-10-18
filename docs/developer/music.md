# Background music

The music is composed as code. `scripts/render-music.js` synthesises three
pieces (Kaffeehaus, Lounge-Bossa, Kätzchen) offline and writes MP3 segments to
`public/music/`; `public/music-player.js` plays them in the browser.

## Why pre-rendered segments

Synthesising in the browser would cost a phone about a quarter of a core for
as long as the music plays: Kaffeehaus renders only about nine times faster
than real time on a server core. Decoding an MP3 costs next to nothing and
sounds exactly like the mix that was approved.

## Form

Every piece has four 8-bar segments plus an ending:

| Role | Segments | What changes |
| --- | --- | --- |
| A | `a`, `a2` | The theme. `a2` varies the melody of the last bars (Kaffeehaus, Lounge-Bossa) or adds an echo (Kätzchen). |
| B | `b`, `b2` | The bridge, on its own chords (IV, iv, iii, VI, ii, V, I, V). `b2` changes the texture: lighter drums, the guitar takes the melody, or an up-down arpeggio and a meow. |
| END | `end` | One bar with the final chord. |

The player strings them **A A B A**. Each slot takes the variant heard least
recently, so a segment never plays twice in a row and every variant comes
round. A chosen piece loops for good. "Wechselnd" plays the ending after the
first complete form past two minutes, waits two seconds after the ending has
faded and then moves to the piece that waited longest.

## Seamless playback

- Segment *k* starts at the start of the piece plus the musical lengths before
  it (`seconds` in the manifest), not at the end of the previous buffer.
- Every segment carries a 4 s tail (releases, reverb) that overlaps the next
  one; only its last second fades.
- A decoder's constant start offset (the MP3 encoder delay, where a browser
  does not trim it) shifts every segment equally, so the grid holds anyway.
- At most two segments are loaded and decoded at a time: the playing one and
  the next. The next waits until the previous tail has ended (4 s); it starts
  a whole segment later (at least 15 s), time enough on a slow connection.

## Levels

- One normalisation gain per piece (its loudest segment), the soft clip of the
  original sketches, peak 0.8 so that a tail plus the next downbeat stays below
  full scale. The pieces are trimmed to the quietest one (`trimDb`).
- **"Leise" sits 6 dB below the game's sound effects (RMS).** The renderer
  reads the `playTone()` calls in `client.js`, computes each one's RMS with its
  envelope (10 ms attack, exponential decay) and takes the median. "Mittel" and
  "Laut" add 6 dB each. The gains are in `manifest.json` (`levels`).
- Changed a sound effect? Run `node scripts/render-music.js --levels`.
  `test/music.test.js` fails until the levels match again.

## Caching

- File names carry the first 8 hex digits of the SHA-256 of their bytes. The
  server sends them with `Cache-Control: public, max-age=31536000, immutable`;
  `manifest.json` keeps its name and revalidates on every start.
- The player keeps every file it fetched in the Cache Storage
  (`pikdame-music`, no service worker). A later start fetches nothing but the
  manifest check; offline the cached manifest and files still play. Entries
  no longer in the manifest are deleted.
- Without Cache Storage (plain http, some private modes) it falls back to a
  plain `fetch` and the browser's HTTP cache.

| When | Downloaded |
| --- | --- |
| First start | the manifest, the playing segment and the next (~0.5 MB) |
| A full "Wechselnd" round (~8 min) | all 15 files once (~3.3 MB) |
| Later starts | the manifest check only |
| After a release | only segments whose bytes changed |

## Defaults

- Quiet and "Wechselnd". Off for players who switched "Soundeffekte & Vibration" off
  before and when the browser asks to save data (`navigator.connection.saveData`),
  unless the player picked a level.
- Starts after the first tap or key press (iOS only starts audio there) and
  pauses while the page is in the background. The AudioContext is shared with
  the sound effects, whose idle suspend skips while music plays.
- A one-time toast after the first start says where to change it.

## Re-rendering

```bash
node scripts/render-music.js                 # needs ffmpeg with libmp3lame
node scripts/render-music.js --preview DIR   # 2-3 min per piece, sequenced like the player
node scripts/render-music.js --levels        # sound effects changed: new levels, same files
```

Rendering is deterministic (seeded oscillator phases): an unchanged score
produces the same bytes and keeps its hashes, so players keep their cache. A
different ffmpeg or LAME version can change the bytes, so render only when the
music changes. To add a variant, add a segment with role `A` or `B` to the
piece in `TRACKS`; the player picks it up from the manifest.
