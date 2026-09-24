# FSN v2 — Draft & League Engine

A zero-build, deploy-anywhere fantasy football platform: a 12-team / 15-round
snake draft room with VOR valuations, a live pick clock with auto-draft on
expiry, bot managers, a 14-week season with a head-to-head scoreboard, and
Postgres-backed persistence on Supabase.

Everything is static — open `index.html` through any web server (or drop the
folder on [Vercel Drop](https://vercel.com/new/drop)) and it runs.

## Navigation flow

```
Home Dashboard -> League Overview -> Draft Room -> Matchup / Scoreboard -> Team Roster
      #/              #/league          #/draft        #/matchups           #/team/:id
```

A hash router (`js/router.js`) swaps `<section data-view>` panes, so each screen
is its own module and the draft engine stays a single shared instance.

| Route | Screen | What it shows |
| --- | --- | --- |
| `#/` | Home Dashboard | Draft status, your next pick, roster fill, team VOR, latest picks |
| `#/league` | League Overview | Settings, W-L / Points For / Points Against standings, roster composition |
| `#/draft` | Draft Room | Board grid, pick clock, next-up strip, player pool, roster panel, recommendations |
| `#/matchups` | Matchup / Scoreboard | Week selector 1-14, side-by-side lineups, win probability, all 6 games |
| `#/matchups/:week` | Matchup / Scoreboard | The same hub, deep-linked to one week |
| `#/team/:id` | Team Roster | Starters + bench, that week's game, that team's draft log |

## Project structure

```
index.html              App shell: nav bar + the four view panes
styles.css              Dark sports-network design system (position colour coding)
js/config.js            Supabase credentials + league defaults (override via window.FSN_CONFIG)
js/types.js             Player / Team / Pick / DraftState shapes + roster slot template
js/playerData.js        The player pool (compact tuples -> Player objects)
js/vorMath.js           Replacement levels, VOR, tiers, derived ADP, scarcity, recommendations
js/draftTimer.js        The pick clock (injectable scheduler so tests run instantly)
js/draftEngine.js       Snake state machine: pick progression, clock expiry, bots, undo, hydrate
js/seasonEngine.js      Round-robin schedule, weekly score engine, W-L / PF / PA standings
js/nflTeams.js          NFL colours, logo URLs and the synthetic weekly opponent slate
js/persistence.js       DraftRepository + SeasonRepository — Supabase RPCs, localStorage mirror
js/router.js            Hash router for the app shell
js/uiRenderer.js        Draft-room rendering + shared view helpers
js/views/home.js        Home Dashboard
js/views/league.js      League Overview (season standings + roster composition)
js/views/matchup.js     Matchup / Scoreboard hub
js/views/team.js        Team Roster
js/app.js               Boot, state restore, event wiring, control handlers
supabase/migrations/    The three migrations applied to the database
tests/engine.test.mjs   41 assertions: snake order, clock expiry, rosters, hydration
tests/season.test.mjs   42 assertions: schedule, simulation, standings, hydration
tests/draft-sim.test.mjs Full 15-round simulation + optional database round-trip
```

Open-source dependencies load from CDNs — no install step, no bundler: Tailwind
(utility layer), Lucide (icons), Inter + JetBrains Mono. If a CDN is blocked,
`styles.css` still carries the full layout and theme.

## Snake draft rotation

```
Round 1 (odd)   teams  1  2  3  4  5  6  7  8  9 10 11 12
Round 2 (even)  teams 12 11 10  9  8  7  6  5  4  3  2  1
Round 3 (odd)   teams  1  2  3  4  5  6  7  8  9 10 11 12
```

Two pure helpers own this (`js/draftEngine.js`), plus their Postgres mirror:

```js
// pick -> team.  snakeTeamId() is the same thing, 1-based.
export function snakeTeamIndex(overallPick, totalTeams) {
  const round       = Math.ceil(overallPick / totalTeams);
  const pickInRound = ((overallPick - 1) % totalTeams) + 1;
  return round % 2 === 1 ? pickInRound - 1 : totalTeams - pickInRound;
}

// team -> pick (the inverse, used by the board matrix)
export function snakePickNumber(round, teamId, totalTeams) {
  const pickInRound = round % 2 === 1 ? teamId : totalTeams - teamId + 1;
  return (round - 1) * totalTeams + pickInRound;
}
```

```sql
-- mirrored in Postgres so the database can reject a wrong pick
select public.fsnv2_snake_team(pick_number, total_teams);
```

Team 1 therefore owns picks **1, 24, 25, 48** through round 4; team 12 owns
**12, 13, 36, 37**. `currentRound`, `currentSlot`, `currentTeamId`, the "on the
clock" header, the board highlight, `nextUp(n)` and every auto-pick path derive
from the same pair, so all indicators move together on each selection.

### Board matrix

The board grid is keyed by **team column**, not by pick order: for each round
row, cell *c* holds `pickNumberFor(round, c)`. So round 2 shows pick 13 in
column 12 and counts down to pick 24 in column 1, and every cell — including
the "on the clock" highlight and the click target that loads a roster — sits
under the franchise that actually owns it.

## The pick clock

`js/draftTimer.js` counts down from `timer_seconds` (60 by default) and fires
`onExpire` exactly once at zero. On expiry the engine:

1. calls `bestAvailableByAdp()` — the lowest ADP number still on the board that
   fits an open roster slot;
2. records the pick with `source: 'timer_expiry'`;
3. advances `currentPick`, restarts the clock for the next team, and emits
   `change` + `expire` so the board, next-up strip and rosters repaint.

The scheduler is injectable, so the test-suite drives expiry synchronously
instead of waiting on real seconds.

## The season: 14 weeks, 84 games

The draft ends at pick 180 with twelve filled rosters. `js/seasonEngine.js`
turns them into a season.

```
Weeks  1-11   the complete round robin — every team plays every other once
Weeks 12-14   a randomised rotation — three of those same rounds, drawn by a
              seeded shuffle, with home and away flipped for the rematch
```

Twelve teams give exactly eleven round-robin rounds (the circle method: team 1
stays put, the other eleven rotate one seat per round), which is why weeks 1-11
land so neatly. The closing three weeks pick rounds out of that same set rather
than inventing new pairings, so every week is guaranteed to be a valid perfect
matching — all twelve franchises playing, nobody twice, nobody idle.

Two pure helpers own it, and both are mirrored in Postgres:

```js
lcgShuffle(count, seed)   // deterministic Fisher-Yates (Park-Miller minstd)
roundRobinRounds(entries) // circle method -> n-1 rounds of n/2 pairs
```

```sql
select public.fsnv2_lcg_shuffle(11, 20260208);  -- {2,10,4,1,5,3,7,0,8,9,6}
select public.fsnv2_round_robin(12);
select public.fsnv2_generate_schedule(:league_id);
```

The Park-Miller multiplier (16807) is small enough that `state * 16807` stays
inside the exact-integer range of an IEEE-754 double, so JavaScript Numbers and
Postgres bigints walk the identical stream. That is what lets the browser
rebuild the schedule offline and still agree with the rows in the database —
all 84 games, in the same order. `tests/season.test.mjs` pins the shuffle
against vectors read back from Postgres, so a drift between the two fails
there first.

`fsnv2_generate_schedule` is idempotent (it returns the existing schedule
unless `p_replace` is true) and asserts the perfect matching before it commits:

```
generated schedule is not a perfect matching (N offending team-weeks)
```

## Matchup & Scoreboard hub

`#/matchups` is the Phase 1 matchup panel grown into its own screen:

- **Week selector** — weeks 1-14, marking which are final.
- **My Matchup** — the two starting lineups side by side, slot against slot
  (QB vs QB, RB vs RB, FLEX vs FLEX), each player with their NFL team logo,
  that week's opponent (`@ MIA`, `vs NYJ`) and projected or actual points.
- **Live win probability** — a logistic fit to the projected margin
  (`1 / (1 + e^(-1.702 * margin / 28))`), with the projected totals above it.
  A finished game reports the result instead of a forecast.
- **League Scoreboard** — all six of the week's games as a grid; clicking a
  card opens that head-to-head.

Team logos load from a CDN, and — like the Tailwind and Lucide layers — the UI
has to survive that CDN being blocked. The logo sits on top of a chip carrying
the team's abbreviation in its primary colour, so a failed load degrades to the
chip instead of a broken-image icon.

> The weekly NFL opponents are synthetic, exactly like the projections in
> `playerData.js`: a 32-team round robin over the same seeded shuffle. They are
> display context next to a player's name, never an input to scoring.

## Simulate Week (the dummy score engine)

The dev toolbar in the Matchup hub header drives the season without waiting on
real games:

| Control | What it does |
| --- | --- |
| **Simulate Week** | Scores every rostered player for the selected week |
| **Sim Through N** | Plays every unplayed week up to the selected one |
| **Reset Season** | Rolls every week back to unplayed, keeping the schedule |

A player's weekly score is their season projection spread over 17 games, moved
by position-weighted noise — defenses swing far harder than quarterbacks:

```js
const VOLATILITY = { QB: 0.24, RB: 0.36, WR: 0.42, TE: 0.38, K: 0.32, DST: 0.58 };
points = max(0, (projection / 17) * (1 + VOLATILITY[pos] * noise()))
```

`noise()` is Bates(3) — the mean of three uniforms — so it is bell-shaped and
blow-ups and busts stay rare instead of being as likely as an average week.

Only the nine **starters** count toward a team's total; bench scores are
recorded but never summed. Each simulated week writes through
`fsnv2_simulate_week`, which stores the box score and then **re-sums the team
totals from those rows** rather than trusting the numbers the client sent, so a
matchup score can never drift from the box score underneath it.

W-L records, Points For and Points Against on `#/league` are derived from the
matchup rows, so every simulated week moves the table the moment it goes final.

## Database (Supabase / Postgres)

Applied to the Supabase project **FSN** as `fsnv2_draft_engine_schema`,
`fsnv2_draft_engine_rpc` and `fsnv2_season_matchups` (checked in under
`supabase/migrations/`). Tables live in a dedicated `fsnv2` schema so they
never collide with the existing `public.*` tables.

| Table | Columns |
| --- | --- |
| `fsnv2.leagues` | `id`, `name`, `total_teams`, `roster_settings` (jsonb), `scoring_type`, timestamps |
| `fsnv2.drafts` | `id`, `league_id`, `current_pick`, `status`, `timer_seconds`, `rounds`, `draft_type`, `teams` (jsonb), timestamps |
| `fsnv2.draft_picks` | `id`, `draft_id`, `pick_number`, `round`, `team_id`, `player_id`, `picked_at`, `auto`, `source` |
| `fsnv2.players` | `id`, `name`, `position`, `team`, `adp`, `stats` (jsonb), timestamps |
| `fsnv2.matchups` | `id`, `league_id`, `week`, `team_a_id`, `team_b_id`, `team_a_score`, `team_b_score`, `status` |
| `fsnv2.player_week_scores` | `id`, `league_id`, `week`, `team_id`, `player_id`, `slot`, `starter`, `projected`, `points` |

Constraints that keep a board honest: `unique (draft_id, pick_number)`,
`unique (draft_id, player_id)`, and a FK from `draft_picks.player_id` to
`players.id`. `matchups` adds `team_a_id <> team_b_id` plus a unique constraint
on each side per week; `fsnv2_generate_schedule` is the only writer and asserts
the full perfect matching before committing.

`player_week_scores` deliberately carries **no** FK to `fsnv2.players`: the
projection pool syncs asynchronously on boot, and a slow sync must never be
able to reject a simulated week.

RLS is enabled with **no** direct-table policies. The browser only ever calls
security-definer RPCs in `public`:

| Function | Purpose |
| --- | --- |
| `fsnv2_snake_team(pick, teams[, type])` | canonical snake math |
| `fsnv2_create_league(...)` / `fsnv2_start_draft(...)` | provision a league + draft |
| `fsnv2_upsert_players(jsonb)` | bulk-sync the projection pool |
| `fsnv2_record_pick(draft, pick_number, player_id[, team_id, auto, source])` | **validates and persists one pick** |
| `fsnv2_undo_pick` / `fsnv2_reset_draft` | rewind |
| `fsnv2_draft_state(draft)` / `fsnv2_players(limit)` / `fsnv2_leagues()` | reads |
| `fsnv2_lcg_shuffle(count, seed)` / `fsnv2_round_robin(teams)` | canonical schedule math |
| `fsnv2_generate_schedule(league[, weeks, seed, replace])` | **builds the 14 weeks**, idempotent |
| `fsnv2_simulate_week(league, week, scores)` | stores a box score and re-sums the team totals |
| `fsnv2_reset_season(league[, week])` | rolls a week — or the season — back to unplayed |
| `fsnv2_matchups` / `fsnv2_season_standings` / `fsnv2_season_state` | reads |

`fsnv2_record_pick` re-derives the round and team from `pick_number` inside the
transaction and raises on anything inconsistent, so a buggy client cannot write
a broken board:

```
out of order pick: got 5, draft is on pick 1
snake order violation: pick 1 belongs to team 1, got 7
duplicate key value violates unique constraint "draft_picks_unique_player"
```

Every selection in the UI is written through this RPC; `js/persistence.js`
queues writes with retries, keeps a localStorage mirror, and reports status in
the nav bar (`db synced` / `syncing` / `local only` / `sync error`). On load the
app restores from the database first, then localStorage, then a fresh room.

### Configuration

`js/config.js` carries the project URL and the **publishable** key (safe in the
browser — it only reaches the RPCs above), plus the season length and schedule
seed. `season.seed` must match `p_seed` in `fsnv2_generate_schedule` or the
browser and the database will disagree about weeks 12-14. Override without
editing the file:

```html
<script>
  window.FSN_CONFIG = {
    supabase: { url: 'https://<project>.supabase.co', key: 'sb_publishable_…' },
    league:   { name: 'My League', totalTeams: 12, rounds: 15, timerSeconds: 60 },
    season:   { weeks: 14, seed: 20260208 }
  };
</script>
```

Set `supabase.enabled = false` to run fully offline on localStorage.

## Running locally

ES modules require HTTP (not `file://`):

```bash
npm run dev            # python3 -m http.server 8000
# open http://localhost:8000
```

## Tests

```bash
npm test               # engine + season suites, then the full 15-round simulation
npm run test:engine    # draft engine only
npm run test:season    # season matchup engine only
npm run test:db        # also persist the simulation to Supabase and verify
```

`tests/engine.test.mjs` (41 assertions) covers snake rotation across 15 rounds
and odd team counts, on-the-clock indexing through the turn, next-up previews,
clock expiry (ADP pick, clean advance, single fire), full-draft roster legality,
undo and hydration.

`tests/season.test.mjs` (42 assertions) covers the schedule — 84 games, six a
week, every team once a week, all 66 pairings exactly once across weeks 1-11,
weeks 12-14 as valid perfect matchings with the sides swapped — the shuffle
vectors read back from Postgres, the score engine (totals equal the sum of the
starters; scores sit near but not on the projection), the standings invariants
(wins balance losses, league Points For equals Points Against) and the
persistence round trip.

`tests/draft-sim.test.mjs` drafts all 180 picks — alternating VOR bot picks and
simulated clock expiries — prints the board by round, verifies the order, and
writes `tests/out/draft-sim.json`. With `--db` it pushes every pick through
`fsnv2_record_pick` and reads the board back. That payload can also be replayed
straight into Postgres (the file header has the SQL).

## Deploying

**Vercel Drop:** drag the project folder onto https://vercel.com/new/drop — no
framework preset, no build command.
**Vercel CLI:** `npx vercel deploy --prod`.

> Projections in `js/playerData.js` are synthetic sample data. Swap that module
> for a `fetch()` against your projections API — as long as rows return
> `{ name, position, team, projection }`, nothing else changes.
