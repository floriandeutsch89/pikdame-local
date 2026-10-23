# Play attempts ("Festhänger")

Which players get stuck where in the Kartenhaus, and why, without anybody
having to tell you: every attempt at a floor leaves one row in the PostgreSQL
table `play_events`, kept for **90 days**. The admin tab **Festhänger**
(`/admin/stuck`) shows them; plain SQL works too.

## What is recorded

One row per attempt, written when it ends:

| Outcome | When |
| --- | --- |
| `won` | The floor was played out with at least one star |
| `lost` | Played out without a star |
| `abandoned` | It ended any other way (`facts.reason` below) |

| `facts.reason` | Meaning |
| --- | --- |
| `forfeit` | Given up at the table ("Spiel aufgeben") |
| `left` | Given up from the start screen, usually to start something else |
| `timeout` | The player left and did not come back within the pause window (90 s, 20 min when paused) |
| `expired` | The table was removed while still open (idle cleanup, 24 h limit) |
| `restart` | The table could not be restored after a server restart (snapshot older than 30 min); the row carries the snapshot's time |

The columns: `at` (ms), `day` (game day, German midnight), `name` and
`name_key` (lower case), `area` (`tower`; puzzle, challenge and tutorial can
follow), `target` (`2026-10/7` = floor 7 of October 2026's tower), `outcome`,
`turns` (all seats together), `duration_ms`, `attempt_id` and `facts`.

`facts` of a Kartenhaus attempt, all derived from the game itself:

| Field | Meaning |
| --- | --- |
| `stars`, `score`, `bestBot`, `handicap` | Stars (0–3), own round score, best bot's score, the bots' head start |
| `margin` | `score − handicap − bestBot`: above 0 is a star, from 100 two. For an abandoned attempt the provisional value (laid out minus hand) |
| `end` | `me` (went out), `bot` (a bot went out), `emptyDraw` (draw pile empty), `stalemate` (160 turns without a meld) |
| `queenInHand`, `jokersInHand`, `handCards`, `handPoints` | What was left in hand |
| `queenLaid`, `mods` | Queens of Spades melded; the floor's modifiers (11–20) |
| `cause` | Why there was no star: `queen` or `jokers` (they alone cost the star), `goOut` (enough points, but did not go out on a `goOut` floor), `emptyDraw`, `stalemate`, `margin` (simply short), `abandoned` |
| `reason` | Abandoned attempts only (table above) |

A replayed snapshot cannot write an attempt twice: `attempt_id` is unique.
Writing happens in the background; a database problem never holds up or breaks
a game, it is logged as `[play-events] … not stored: …`.

## The admin tab

- **Kartenhaus · month**: attempts, players, win rate, abandon rate and the
  number of stuck players; the current month first, earlier months with data
  as buttons.
- **Etagen**: per floor players, how many of them earned a star, attempts, win
  rate (bar), abandons, median turns of played-out attempts and stuck players.
  A floor whose win rate is at most half the floor below's (both with at
  least 5 attempts) is marked **Knick**: that is where the curve breaks.
- **Festhänger**: players with at least 3 attempts on one floor and no star,
  most attempts first (up to 50), with their last attempt and most common
  reason, e.g. "Schwelle um 40 Pkt verfehlt (4 von 6)", "Pik Dame kassiert",
  "abgebrochen in Zug 12".
- **Spieler nachschlagen**: a name (or a click in the list) shows that player's
  last 50 attempts with result, distance to the star and why.

## Retention and deletion

- Rows older than 90 days are deleted a minute after each start and then every
  six hours (log: `[play-events] … older than 90 days deleted`).
- **Deleting an account** (tab Benutzer) deletes all attempts of that name.
- A guest asks for deletion: the profile lives in `players.json`, the attempts
  go with one statement (see below).
- The privacy page states the 90 days. The guest profiles' 500-profile limit
  does not delete attempts: it is a storage limit, not a request.

## SQL

```bash
cd docker
docker compose exec postgres psql -U pikdame pikdame
```

Where the curve breaks this month, floor by floor:

```sql
SELECT split_part(target, '/', 2)::int AS floor,
       count(*) AS attempts,
       count(DISTINCT name_key) AS players,
       round(100.0 * count(*) FILTER (WHERE outcome = 'won') / count(*)) AS win_pct,
       round(100.0 * count(*) FILTER (WHERE outcome = 'abandoned') / count(*)) AS abandon_pct
  FROM play_events
 WHERE area = 'tower' AND target LIKE '2026-10/%'
 GROUP BY 1 ORDER BY 1;
```

Why players fail on one floor:

```sql
SELECT facts->>'cause' AS cause, count(*),
       percentile_disc(0.5) WITHIN GROUP (ORDER BY -(facts->>'margin')::int) AS median_miss
  FROM play_events
 WHERE area = 'tower' AND target = '2026-10/7' AND outcome <> 'won'
 GROUP BY 1 ORDER BY 2 DESC;
```

One player's attempts, newest first, and deleting them (a guest's request).
`name_key` is the name in lower case:

```sql
SELECT to_timestamp(at / 1000) AS at, target, outcome, turns,
       facts->>'cause' AS cause, facts->>'margin' AS margin
  FROM play_events WHERE name_key = 'oma inge' ORDER BY at DESC LIMIT 20;

DELETE FROM play_events WHERE name_key = 'oma inge';
```
