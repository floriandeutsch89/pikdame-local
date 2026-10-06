---
name: ui-review
description: Design review for the Pik Dame client against this project's own rules (mobile first, landscape at ~400 px, tokens, icons, i18n) and the patterns that worked in past reviews. Use it whenever the user asks for UI feedback or proposals ("Vorschläge als UI-Experte", "schau dir X an", "wirkt unaufgeräumt", "zu klein", "abgeschnitten"), before opening a PR that changes anything visible, and when reviewing someone else's UI diff - even if they only ask about one screen.
---

# UI review for Pik Dame

A review that only reads code misses what players see. Look first, then
judge against the rules below, then propose. Findings come with evidence
(a screenshot or an audit line), proposals with a reason.

## 1. Look

Run the `ui-shots` skill with the audit on the screens in question:

```bash
node .claude/skills/ui-shots/scripts/ui-shots.js --out /tmp/review \
  --views phone,land,desk,se --scenes <scenes> --audit
```

Open the PNGs (Read tool) and `/tmp/review/audit.md`. The audit finds
truncated text, tap targets under 44 px, icon buttons without a name and a
portrait start screen that needs scrolling. It does **not** judge
hierarchy, wording or meaning; that is your part. Adjust the mock data in
the script when the default data hides a problem (long names, 4 players,
negative scores, a solved puzzle).

Audit lines are evidence, not verdicts. Some are deliberate: a
`text-overflow` ellipsis on an opponent list that opens in full on tap is
fine, while a status like "Noch nicht g…" is not. Say which is which.

## 2. Judge: the project's hard rules (CLAUDE.md)

- **iPhone 393×852 is the yardstick**; the start screen fits without
  scrolling. Landscape has ~400 px of height; check that the essential
  content is above the fold there too. Desktop must not look stretched.
- **Sizes from the scale only** (`--fs-*`, `--ctl-h`), tap targets ≥
  `--tap-min` (44 px).
- **Emoji are content, not icons.** Icons come from the inline SVG sprite;
  text next to an icon sits in its own `<span>`.
- **`--accent` means selection.** Player colours come from `PLAYER_COLORS`
  only and never compete with it.
- **Every visible text is bilingual** (`I18N_STATIC` / `L(de, en)`).
- **No native dialogs**; confirm by two taps.

## 3. Judge: patterns that held up in past reviews

Each one fixed a real complaint; cite them when they apply.

- **Your own numbers first, the comparison second.** The stats overlay
  used to open with server totals; players open it to see themselves.
- **Status on the tile, not behind a tap.** Daily puzzle and challenge
  looked unimportant until the tile said "Neu" / "Platz 3".
- **Say each thing once per screen.** The round winner's +270 in a hero
  *and* in the list, the name in the chip *and* on the account button:
  the duplicate costs space and makes people look for a difference.
- **Nothing opens by itself.** An auto-opened "Mehr" pushed half the
  ranking below the fold.
- **A mark must explain itself or go.** An unlabelled goal tick in every
  row read as "this player's marker". If a mark needs a legend to be read
  correctly, label it inline or remove it.
- **Meaning never by colour alone.** Signs (+/−), labels, filled vs.
  outlined shapes carry the meaning; colour only reinforces it.
- **Things that happen daily belong together; lifetime progress elsewhere.**
  Level and streak sit on the identity chip, the daily items in "Heute".
- **Fewer, wider controls beat more, cramped ones.** Four tiles in a row
  cut "Stammtisch" off at 393 px; two wide ones fit at every size.
- **Emphasis follows the question of the screen.** Round end: the round's
  delta leads. Game over: rank and total lead.

## 4. Report

Answer in German (the user's language), short and direct:

1. **Findings by severity**: what is wrong, where (screen + layout), the
   evidence, why it matters to a player.
2. **Proposals**: concrete changes, each with the reason. When a wish is
   ambiguous, give 2–4 numbered options with a recommendation
   (CLAUDE.md: ask before building the most likely reading).
3. **Quick wins vs. larger changes**, so the user can pick.

Do not build before the user chose, unless it is an unambiguous bug with
evidence.

## 5. After building

Re-run `ui-shots --audit` on the same scenes. New findings in your own
change are yours to fix before the PR. Put before/after screenshots in the
PR (see `ui-shots`).
