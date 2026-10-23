# Play attempts ("Festhänger")

Which players get stuck where, and why, without anybody having to tell you:
every attempt at a **Kartenhaus** floor, at the **daily puzzle** and at the
**tutorial** leaves one row in the PostgreSQL table `play_attempts`, kept for
**90 days**. The admin tab **Festhänger** (`/admin/stuck`) shows them, one
view per mode; plain SQL works too.

## What is recorded

One row per attempt, written when it ends:

| Mode | One row per | `period` | `stage` | `turns` |
| --- | --- | --- | --- | --- |
| `tower` | try of a Kartenhaus floor | the month, `2026-10` | the floor | all seats' turns |
| `puzzle` | player name and puzzle day (live day only, not the archive) | the puzzle day, `2026-10-23` | empty | checks ("Prüfen") |
| `tutorial` | tutorial table, until the scoring of round 1 | the tutorial version, `v1` | the last lesson's position | all seats' turns |

| Outcome | Kartenhaus | Daily puzzle | Tutorial |
| --- | --- | --- | --- |
| `won` | played out with at least one star | solved (1–3 stars) | round 1 scored with the hints on |
| `lost` | played out without a star | given up: the solution was shown | – |
| `abandoned` | ended any other way (`facts.reason`) | something tried, not solved by midnight (`dayEnd`) | ended before (`facts.reason`) |

| `facts.reason` | Meaning |
| --- | --- |
| `forfeit` | Given up at the table ("Spiel aufgeben") |
| `left` | Given up from the start screen, usually to start something else |
| `timeout` | The player left and did not come back within the pause window (90 s, 20 min when paused) |
| `expired` | The table was removed while still open (idle cleanup, 24 h limit) |
| `restart` | The table could not be restored after a server restart (snapshot older than 30 min); the row carries the snapshot's time |
| `skipped` | Tutorial: the hints were switched off ("Überspringen", or the switch in "Optionen") |
| `dayEnd` | Puzzle: the day ended with something tried but neither solved nor given up |

The columns: `attempt_id`, `player_name` and `player_key` (lower case),
`mode`, `period`, `stage` (empty where there is none), `outcome`, `game_day`
(DATE, German midnight), `started_at` and `ended_at` (TIMESTAMPTZ; the
duration is `ended_at - started_at`), `turns` and `facts`. Conventions:
{doc}`../developer/schema`.

A replayed snapshot cannot write an attempt twice: `attempt_id` is unique (a
puzzle's is `puzzle:<day>:<name>`, so a name has at most one row per day).
Writing happens in the background; a database problem never holds up or breaks
a game, it is logged as `[play-events] … not stored: …`.

### Kartenhaus

`facts`, all derived from the game itself:

| Field | Meaning |
| --- | --- |
| `stars`, `score`, `bestBot`, `handicap` | Stars (0–3), own round score, best bot's score, the bots' head start |
| `margin` | `score − handicap − bestBot`: above 0 is a star, from 100 two. For an abandoned attempt the provisional value (laid out minus hand) |
| `end` | `me` (went out), `bot` (a bot went out), `emptyDraw` (draw pile empty), `stalemate` (160 turns without a meld) |
| `queenInHand`, `jokersInHand`, `handCards`, `handPoints` | What was left in hand |
| `queenLaid`, `mods` | Queens of Spades melded; the floor's modifiers (11–20) |
| `cause` | Why there was no star: `queen` or `jokers` (they alone cost the star), `goOut` (enough points, but did not go out on a `goOut` floor), `emptyDraw`, `stalemate`, `margin` (simply short), `abandoned` |
| `reason` | Abandoned attempts only (table above) |

### Daily puzzle

An attempt starts when a named player opens the day's puzzle and ends with
the solve, with "Lösung zeigen" or at midnight. Only the live day counts:
archive days are graded but stay out, and so does the public mode (no names).
Open attempts live in the server's memory and in the session snapshot, so a
restart neither loses nor doubles them. `started_at` is the first look, so
`ended_at - started_at` of a solved attempt is the time to solve.

| Field | Meaning |
| --- | --- |
| `kind` | `meld` (best single meld), `turn` (most points in one turn), `out` (go out) |
| `stars` | Solved attempts: 3, 2 or 1, as the player got them |
| `mistakes` | Checks without a solve plus melds refused while laying them |
| `wrong` | The mistakes by type: `meld` (no valid set or run), `discard` (no card left to discard), `points` (valid, short of the target), `notOut` (valid, cards left over), `other` (malformed answer) |
| `firstWrong` | The type of the first mistake |
| `gaveUp` | `true` when the solution was shown |
| `cause` | Unsolved attempts: the type most mistakes share (ties: the order above), `noTry` without any mistake |
| `reason` | `dayEnd` for abandoned attempts |

A puzzle attempt is **stuck** when it ended without a solve, given up or
with at least 3 mistakes.

### Tutorial

The lessons run in the player's browser; the client reports which lesson was
**shown** or **done** and when the hints are switched **off** (WebSocket
message `tutorialStep`, see {doc}`../developer/protocol`). The server only
accepts the lessons of `game/TutorialSteps.js` for its own tutorial seat,
keeps the first report per lesson, times them on its own clock and counts its
own refusals; a report carries no name and no time. The attempt ends with the
scoring of round 1 (`won`), when the hints go off (`skipped`) or when the
table ends earlier.

| Field | Meaning |
| --- | --- |
| `step` | The last lesson shown (`roundend` when won); `stage` is its position in `TutorialSteps.js` |
| `reached`, `done` | Lessons shown (in order) and lessons completed |
| `sec` | Seconds from a lesson's first appearance until it was done (the last one: until the end) |
| `errors`, `refusals` | Moves the server refused while a lesson was open, per lesson; all refusals of round 1 |
| `reason` | Abandoned attempts only (table above) |
| `cause` | Abandoned attempts: `stuck` (3+ refusals at the last lesson), `skipped`, `left` (left or gave up), `away` (did not come back, table expired, restart) |

`period` is `TUTORIAL_VERSION`: a version gets a new number whenever lessons
are added, removed or reordered, so the funnels of two tutorials never mix.

## The admin tab

A switch on top picks the mode.

**Kartenhaus**

- **Month**: attempts, players, win rate, abandon rate and the number of stuck
  players; the current month first, earlier months with data as buttons.
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

**Rätsel** (the last 7, 14, 30 or 90 days, 14 by default)

- Attempts, players, solve and give-up rate, stuck players.
- **Arten**: per kind solve rate (bar), attempts, checks until solved, give-up
  rate, median time to solve and the most common mistake.
- **Tage**: the same per day; the three days with the lowest solve rate (at
  least 5 attempts) are marked **schwer**.
- **Festhänger**: players with stuck days, most days first (up to 50): their
  mistakes, the last stuck day and the most common cause, e.g. "zu wenig
  Punkte (2 von 3)". A click shows the player's puzzle attempts: result, mistakes,
  checks, time and the first and most common mistake.

**Tutorial** (one version; older versions with data as buttons)

- Starts, completion, skip and abandon rate, median duration of a completed
  tutorial.
- **Schritte**: every lesson with the share of starts that reached it (bar),
  how many completed it, how many attempts ended there, the median time on it
  and the refusals while it was open. A lesson where at least twice as many
  players stop as on average (at least 5 reached and 3 stopped) is marked
  **Knick**. Bonus lessons only come up in some table situations.
- **Wie sie aufhören**: the causes of the early ends.

## Retention and deletion

- Rows older than 90 days are deleted a minute after each start and then every
  six hours (log: `[play-events] … older than 90 days deleted`), in every mode.
- **Deleting an account** (tab Benutzer) deletes all attempts of that name,
  in every mode.
- A guest asks for deletion: one statement deletes the player with the
  profile, badges, challenge rows and attempts (see below).
- The privacy page states the 90 days.

## SQL

```bash
cd docker
docker compose exec postgres psql -U pikdame pikdame
```

**Kartenhaus.** Where the curve breaks this month, floor by floor:

```sql
SELECT stage AS floor,
       count(*) AS attempts,
       count(DISTINCT player_key) AS players,
       round(100.0 * count(*) FILTER (WHERE outcome = 'won') / count(*)) AS win_pct,
       round(100.0 * count(*) FILTER (WHERE outcome = 'abandoned') / count(*)) AS abandon_pct
  FROM play_attempts
 WHERE mode = 'tower' AND period = '2026-10'
 GROUP BY 1 ORDER BY 1;
```

Why players fail on one floor:

```sql
SELECT facts->>'cause' AS cause, count(*),
       percentile_disc(0.5) WITHIN GROUP (ORDER BY -(facts->>'margin')::int) AS median_miss
  FROM play_attempts
 WHERE mode = 'tower' AND period = '2026-10' AND stage = 7 AND outcome <> 'won'
 GROUP BY 1 ORDER BY 2 DESC;
```

**Daily puzzle.** The last two weeks by day: solve and give-up rate, checks
until solved, median time to solve:

```sql
SELECT period AS day, min(facts->>'kind') AS kind, count(*) AS attempts,
       round(100.0 * count(*) FILTER (WHERE outcome = 'won') / count(*)) AS solved_pct,
       round(100.0 * count(*) FILTER (WHERE outcome = 'lost') / count(*)) AS gave_up_pct,
       round(avg(turns) FILTER (WHERE outcome = 'won'), 1) AS checks_to_solve,
       percentile_disc(0.5) WITHIN GROUP (ORDER BY ended_at - started_at)
         FILTER (WHERE outcome = 'won') AS median_solve
  FROM play_attempts
 WHERE mode = 'puzzle' AND period >= '2026-10-10'
 GROUP BY 1 ORDER BY 1 DESC;
```

What goes wrong on one day, and who got stuck:

```sql
SELECT w.key AS mistake, sum(w.value::int) AS n
  FROM play_attempts, jsonb_each_text(facts->'wrong') AS w
 WHERE mode = 'puzzle' AND period = '2026-10-23'
 GROUP BY 1 ORDER BY 2 DESC;

SELECT player_name, outcome, turns AS checks, facts->>'mistakes' AS mistakes,
       facts->>'firstWrong' AS first, facts->>'cause' AS cause
  FROM play_attempts
 WHERE mode = 'puzzle' AND period = '2026-10-23' AND outcome <> 'won'
   AND (outcome = 'lost' OR (facts->>'mistakes')::int >= 3);
```

**Tutorial.** The funnel of version `v1`: how many reached and completed each
lesson, and how many stopped there:

```sql
SELECT r.key AS lesson, count(*) AS reached,
       count(*) FILTER (WHERE a.facts->'done' ? r.key) AS done,
       count(*) FILTER (WHERE a.outcome = 'abandoned' AND a.facts->>'step' = r.key) AS stopped_here
  FROM play_attempts a, jsonb_array_elements_text(a.facts->'reached') AS r(key)
 WHERE a.mode = 'tutorial' AND a.period = 'v1'
 GROUP BY 1 ORDER BY 2 DESC;
```

Where and why tutorials end early:

```sql
SELECT stage, facts->>'step' AS lesson, facts->>'cause' AS cause, count(*)
  FROM play_attempts
 WHERE mode = 'tutorial' AND period = 'v1' AND outcome = 'abandoned'
 GROUP BY 1, 2, 3 ORDER BY 4 DESC;
```

**Support.** One player's attempts, newest first, and deleting only those.
`player_key` is the name in lower case:

```sql
SELECT ended_at, mode, period, stage, outcome, turns, ended_at - started_at AS took,
       facts->>'cause' AS cause
  FROM play_attempts WHERE player_key = 'oma inge'
 ORDER BY ended_at DESC LIMIT 20;

DELETE FROM play_attempts WHERE player_key = 'oma inge';
```

A guest's deletion request: the player row and everything that points at it
(profile, badges, quests, puzzle days, Kartenhaus stars, challenge results and
attempts, play attempts, Stammtisch memberships and series wins) go with one
statement. The Stammtisch matches keep the name as it was played, without the
link; the groups' record stays theirs:

```sql
DELETE FROM players WHERE player_key = 'oma inge';
```
