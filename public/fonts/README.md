# Fonts

The display face for the wordmark, overlay and section titles and the big
score numbers. Served from this origin like every other asset: no font CDN,
CSP `font-src 'self'`.

| File | Source | SHA-256 |
|---|---|---|
| `rubik-latin-wght.woff2` | npm `@fontsource-variable/rubik@5.3.0`, `files/rubik-latin-wght-normal.woff2`, **unchanged** (package integrity `sha512-yQUf8qle24MJYA+EuauyF+cqjjN6I715nGjitt3sGmwZA0XfA4fWJcLq1C/diREZl4Qzn1E80nLMc0ipC/a4Lg==`) | `691cd1d9b4c0cdf31a1dcf04259c86f92c85e69f6622abab7964d81e36890691` |

- Rubik, Copyright 2015 The Rubik Project Authors, SIL Open Font License 1.1
  (`OFL.txt`, shipped next to the font as the licence requires).
- Variable weight axis 300-900, Latin subset (German umlauts and ß included),
  tabular figures via `font-variant-numeric: tabular-nums`. The card suits
  (♠♥♦♣) are not in the subset and fall back to the system font.
- To update: replace the file with the same file from a newer package version
  and update the hash above. The `@font-face` rule lives at the top of
  `public/style.css`.
