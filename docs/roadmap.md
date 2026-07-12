# Roadmap

:::{note}
This is a hobby project built for a family card round. There are no deadlines and
no promises — this page is a statement of intent, not a commitment. Things get
built when they are useful and when there is time.
:::

## Being worked on

- **Discoverability.** SEO basics are in place (structured data, sitemap, real
  indexable content). The remaining work is off-page: search-console
  registration and a few genuine backlinks.

## Likely next

- **Better bots through measurement.** The A/B harness (`scripts/sim-ab.js`) is
  in place and has already rejected four plausible-sounding ideas. More ideas to
  try — the bar is a statistically significant win, not a good story.
- **ONNX bot as a first-class option.** Training is documented; making a trained
  policy easy to enable in the standard image is the missing piece.
- **Accessibility.** Keyboard play, screen-reader labels, and honouring
  `prefers-reduced-motion` more thoroughly than today.

## Considered, not committed

- **Spectator mode.** Watch a table without a seat.
- **Tournaments / seasons** on top of the existing statistics.
- **More house rules** (a longer list of the variants families actually play).

## Explicitly *not* planned

- **Ads or tracking.** Never. There is no telemetry and no third-party service in
  the game path, and that will not change.
- **Multi-replica scaling.** A single process handles 200+ concurrent games
  comfortably. Adding a distributed state store to solve a problem nobody has
  would make the project worse. See {doc}`faq`.
- **A frontend framework.** The no-build-step client is a feature.

## Have an idea?

Open an issue. Game-rule bugs and "the bots do something dumb in this situation"
reports are the most valuable — especially with an exported game.
