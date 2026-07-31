# Brand assets — not covered by the MIT licence

The **source code** of Pik Dame is MIT licensed (see [LICENSE](LICENSE)).
The **Flodex Interactive brand is not**. This file states what is reserved and
what you may still do, so that forking the code stays easy while the brand
stays identifiable.

## What is reserved

- the name **Flodex Interactive**
- the **studio mark** — the five-blade swirl — in every colour, size, crop and
  file format, including single-colour versions
- the **start-up animation** of that mark: its choreography, timings and the
  code that produces it. In this repository that is the `#studioSplash` block
  in `public/index.html`, the `.ss*` rules in `public/style.css` and the
  studio-splash section in `public/client.js`
- any exported logo files added to this repository later

All rights to these are reserved by Florian Deutsch. They are excluded from the
MIT grant even though they live inside MIT-licensed files.

## What you may do without asking

- **run, fork and modify the software**, including with the mark left in place
  while you use it privately or inside your family
- **name the origin**: "based on Pik Dame", "a fork of Pik Dame" — plain,
  factual references to the project are fine and welcome
- use **unmodified screenshots** of the running app, for example in a review,
  a bug report or a blog post

## What needs written permission

- using the mark or the name as the identity of **your own** product, service,
  company, app listing or fork
- **publishing or distributing** a modified version that still carries the mark
  or the name in a way that suggests it comes from Flodex Interactive
- registering the mark, the name, or anything confusingly similar, anywhere

## Removing the brand from a fork

If you publish a modified version, please replace the mark and the name with
your own. Two ways to switch the splash off:

- in the app: **⚙️ Settings → Studio logo → Off**
- in the code: delete the `#studioSplash` block from `public/index.html` — the
  splash is optional by design and the game never depends on it

## Why this exists

The MIT licence grants rights to the *code*. Because the mark is drawn by code
that ships inside MIT-licensed files, it would otherwise be handed out along
with them. Trademark rights are a separate matter from copyright — MIT grants
no trademark licence in the first place — but the drawing itself is a
copyrighted work, so it needs this explicit carve-out.

Questions or a permission request: please open a GitHub issue.
