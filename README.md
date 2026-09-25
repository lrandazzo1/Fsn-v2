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
lib/services/sportsData.ts        Ingestion facade: the four sync methods
lib/services/providers/           Provider registry + the Tank01 / RapidAPI fetcher
lib/services/syncRepository.ts    Batched UPSERTs through the fsnv2_sync_* RPCs
lib/services/{env,logger,httpClient,normalize,types}.ts   Config, logging, HTTP, mapping helpers
lib/fixtures/tank01/    Recorded provider payloads (the `fixture` provider)
lib/api/syncRoute.ts    The weekly cron handler (bundled to api/sync.js)
scripts/build-api.mjs   esbuild bundle for that one function
vercel.json             Build + cron schedule + function limits
scripts/sync-data.ts    Sync CLI (npm run sync:data)
scripts/test-sync-data.ts  Sync verification CLI (npm run test:sync-data)
supabase/migrations/    Schema + RPC migrations (0004 adds the sync tables, 0005 the derivations)
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
`supabase/migrations/`). `0004_fsnv2_sports_data_sync.sql` adds the ingestion
tables and RPCs — apply it before the first sync run. Tables live in a dedicated `fsnv2` schema so they
never collide with the existing `public.*` tables.

| Table | Columns |
| --- | --- |
| `fsnv2.leagues` | `id`, `name`, `total_teams`, `roster_settings` (jsonb), `scoring_type`, timestamps |
| `fsnv2.drafts` | `id`, `league_id`, `current_pick`, `status`, `timer_seconds`, `rounds`, `draft_type`, `teams` (jsonb), timestamps |
| `fsnv2.draft_picks` | `id`, `draft_id`, `pick_number`, `round`, `team_id`, `player_id`, `picked_at`, `auto`, `source` |
| `fsnv2.players` | `id`, `name`, `position`, `team`, `adp`, `stats` (jsonb), timestamps |
| `fsnv2.matchups` | `id`, `league_id`, `week`, `team_a_id`, `team_b_id`, `team_a_score`, `team_b_score`, `status` |
| `fsnv2.player_week_scores` | `id`, `league_id`, `week`, `team_id`, `player_id`, `slot`, `starter`, `projected`, `points` |
| `fsnv2.nfl_teams` | `id`, `provider`, `external_id`, `abbr`, `city`, `name`, `conference`, `division`, `bye_week`, `logo_url`, `raw`, `synced_at` |
| `fsnv2.projections` | `id`, `provider`, `external_player_id`, `player_id`, `season`, `week`, `season_type`, `scoring_format`, `fantasy_points`, `stats` (jsonb), `raw`, `synced_at` |
| `fsnv2.weekly_stats` | `id`, `provider`, `external_player_id`, `player_id`, `season`, `week`, `game_external_id`, `team`, `opponent`, `fantasy_points`, `stats`, `snap_counts`, `synced_at` |
| `fsnv2.nfl_matchups` | `id`, `provider`, `external_id`, `season`, `week`, `home_team`, `away_team`, `home_score`, `away_score`, `kickoff`, `status`, `venue` |
| `fsnv2.sync_runs` | `id`, `task`, `provider`, `season`, `week`, `status`, `fetched`, `written`, `skipped`, `duration_ms`, `error`, `detail`, timestamps |

Migration `0004` also extends `fsnv2.players` in place with `provider`,
`external_id`, `nfl_team_external_id`, `jersey`, `status`, `injury`, `bye_week`,
`age`, `experience`, `college` and `synced_at`, under a
`unique (provider, external_id)`. The synthetic pool in `js/playerData.js` keeps
its `p-0001` ids and null provider, so the draft board is untouched; synced rows
sit beside them keyed `<provider>-<external_id>`.

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
| `fsnv2_sync_nfl_teams` / `fsnv2_sync_players` | **upsert** franchises and rosters (service_role only) |
| `fsnv2_sync_projections` / `fsnv2_sync_weekly_stats` / `fsnv2_sync_schedules` | **upsert** a week of projections, box scores, games |
| `fsnv2_log_sync_run(...)` | one audit row per sync attempt |
| `fsnv2_projections` / `fsnv2_weekly_stats` / `fsnv2_nfl_schedule` / `fsnv2_nfl_teams` | reads for the UI |
| `fsnv2_sync_status(limit)` | row counts, freshness and the last sync attempts |

Every `fsnv2_sync_*` function returns
`{"inserted": n, "updated": n, "skipped": n, "total": n}` and conflicts on a
unique key, so re-running a sync refreshes rows and never duplicates them. They
are granted to **`service_role` only** — the sync service runs server-side with
the secret key, and nothing in the browser can rewrite projections. The read
RPCs stay open to `anon`/`authenticated` like the rest of the surface.

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

## Background sports-data sync

The draft board runs on the synthetic pool in `js/playerData.js`. The sync
service replaces that with real NFL data — players, rosters, weekly projections,
box scores and the schedule — on a schedule of its own, without the UI having to
know where any of it came from.

```
lib/services/sportsData.ts          the facade: four methods, one result shape
  └── providers/index.ts            registry — SPORTS_DATA_PROVIDER picks one
        ├── tank01.ts               default fetcher (Tank01 / generic RapidAPI)
        └── fixtureTransport.ts     the same mapper over recorded payloads
  └── syncRepository.ts             batched UPSERTs -> public.fsnv2_sync_*
```

```js
import { createSportsDataService } from './lib/services/sportsData.ts';

const service = createSportsDataService();

await service.syncPlayersAndRosters();     // fsnv2.nfl_teams + fsnv2.players
await service.syncSchedules();             // fsnv2.nfl_matchups
await service.syncWeeklyProjections(3);    // fsnv2.projections
await service.syncBoxScores(3);            // fsnv2.weekly_stats
```

Every method resolves to the same `SyncResult`:

```js
{
  task: 'weekly_projections', provider: 'tank01', ok: true,
  season: 2026, week: 3,
  fetched: 612, written: 612, inserted: 41, updated: 571, skipped: 0,
  batches: 6, durationMs: 4182, errors: [], runId: '…', detail: { … }
}
```

Expected failures — a provider 500, a rate limit, a rejected batch — come back as
`ok: false` with `errors` filled in and an `error` row in `fsnv2.sync_runs`, so one
bad task in a nightly run never aborts the others. Programmer errors (an unknown
provider, a week outside 1-22, missing credentials) still throw.

### Swapping providers

`SPORTS_DATA_PROVIDER` is the only switch. A new vendor is one file implementing
`SportsDataProvider` plus one `registerProvider()` call — no schema change, no
RPC change, no UI change, because the provider's only job is to return the rows
in `lib/services/types.ts`:

```ts
registerProvider('sportradar', ({ env, logger }) => createSportradarProvider({ env, logger }));
```

| Variable | Default | What it does |
| --- | --- | --- |
| `SPORTS_DATA_PROVIDER` | `tank01` | `tank01` \| `fixture` \| anything registered |
| `SPORTS_DATA_API_KEY` | — | sent as `x-rapidapi-key` |
| `SPORTS_DATA_API_HOST` | — | sent as `x-rapidapi-host`, and the default base URL |
| `SPORTS_DATA_BASE_URL` | `https://$HOST` | for a non-RapidAPI deployment |
| `SPORTS_DATA_ENDPOINT_*` | Tank01 paths | `…_TEAMS`, `…_PLAYER_LIST`, `…_PROJECTIONS`, `…_GAMES`, `…_BOX_SCORE` |
| `SPORTS_DATA_SEASON` | current season | Sep-Feb belongs to the earlier year |
| `SPORTS_DATA_SCORING` | `ppr` | drives the provider's fantasy-point maths |
| `SPORTS_DATA_BATCH_SIZE` | `120` | rows per upsert RPC call |
| `SPORTS_DATA_MAX_RETRIES` | `3` | exponential backoff on 429/5xx/socket errors |
| `SPORTS_DATA_RATE_LIMIT_MS` | `0` | minimum gap between provider calls |
| `SPORTS_DATA_DRY_RUN` | `0` | fetch and map, write nothing |
| `SUPABASE_SERVICE_ROLE_KEY` | — | the sync RPCs are granted to `service_role` only |

`.env.example` carries the full list. The browser app is unaffected: it keeps its
publishable key in `js/config.js` and reads through the `fsnv2_*` read RPCs.

### Running a sync

```bash
npm run sync:data -- players                    # teams + rosters
npm run sync:data -- schedules                  # the whole season's games
npm run sync:data -- projections boxscores --week=3
npm run sync:data -- all --week=3 --dry-run     # map everything, write nothing
npm run sync:data -- all --week=3 --provider=fixture
```

Node 22+ runs the TypeScript directly (`--experimental-strip-types` is the
default from 22.6), so the service keeps the project's no-build promise: no
bundler, no `node_modules`, nothing to compile before a cron job can call it.

### Scheduled runs on Vercel

`lib/api/syncRoute.ts` is the scheduled entrypoint, and `vercel.json` points a
weekly Cron Job at it:

```json
{
  "buildCommand": "npm run build:api",
  "outputDirectory": ".",
  "crons": [{ "path": "/api/sync", "schedule": "17 9 * * 2" }],
  "functions": { "api/sync.js": { "maxDuration": 60 } }
}
```

`npm run build:api` bundles that one file to `api/sync.js` with esbuild — the
project's only build step, and the only reason it has devDependencies. Vercel's
own TypeScript step compiles a function's entrypoint but leaves its `.ts` import
specifiers untouched and does not trace them, so a deployed `api/sync.ts` dies on
first request with `ERR_MODULE_NOT_FOUND: /var/task/lib/services/sportsData.ts`.
Bundling inlines the service instead, which also means the function does not
depend on runtime type stripping. Everything else still runs unbuilt: the browser
app is static, and the CLI and tests import the `.ts` modules directly.

Tuesday 09:17 UTC, because an NFL week's games run Thursday through Monday night
— by Tuesday morning the week just played is final and the next one is worth
projecting. The route works out which weeks matter from the calendar rather than
from configuration (`weekFocus()` in `lib/services/env.ts`: kickoff is the
Thursday after Labor Day, and week N runs Thursday to Wednesday):

| When it fires | players | schedules | projections | box scores |
| --- | --- | --- | --- | --- |
| Tue/Wed — week N finished | ✓ | N-1, N, N+1 | **N+1** | **N** |
| Thu-Mon — week N in play | ✓ | N-1, N, N+1 | **N** | **N-1** |
| Before the opener | ✓ | 1, 2 | 1 | — (nothing played yet) |

Called by hand it takes the same tasks the CLI does:

```
/api/sync                             the weekly bundle (what cron runs)
/api/sync?task=players
/api/sync?task=projections&week=3
/api/sync?task=boxscores&week=2&season=2026
/api/sync?task=schedules&weeks=1,2,3
/api/sync?task=all&week=3&dry_run=1   fetch and map, write nothing
```

It answers with the per-task `SyncResult` list and a `200` only when every task
succeeded — a failure or a skipped task returns `500`, so a bad run shows up as a
failed invocation on Vercel's Cron dashboard instead of passing quietly. Tasks
run in order and stop starting new work near the function's time limit, reporting
`skipped_tasks` rather than dying mid-flight at the 60-second ceiling.

**Environment variables** (Vercel project settings → Environment Variables):

| Variable | Why |
| --- | --- |
| `SPORTS_DATA_API_KEY`, `SPORTS_DATA_API_HOST` | the provider |
| `SUPABASE_SERVICE_ROLE_KEY` | the sync RPCs are granted to `service_role` only |
| `CRON_SECRET` | Vercel Cron sends it as `Authorization: Bearer $CRON_SECRET`; the route requires it once set, and warns in its response while it is missing |
| `SUPABASE_URL` | optional — defaults to the project in `js/config.js` |

Migrations `0003`, `0004` and `0005` must be applied to the Supabase project
before the first run, or every write fails with `Could not find the function
public.fsnv2_sync_players`.

### Mapping

| Our table | Provider payload | Notes |
| --- | --- | --- |
| `fsnv2.nfl_teams` | `getNFLTeams` | bye week read out of `byeWeeks[season]` |
| `fsnv2.players` | `getNFLTeams?rosters=true` | one call for players *and* their team; falls back to `getNFLPlayerList` |
| `fsnv2.projections` | `getNFLProjections` | `playerProjections` + `teamDefenseProjections` (`DST-<ABBR>`) |
| `fsnv2.weekly_stats` | `getNFLGamesForWeek` → `getNFLBoxScore` | per-game, opponent derived from the game; the `DST` node is keyed `home`/`away` and carries no fantasy total, so team-defense points are computed |
| `fsnv2.nfl_matchups` | `getNFLGamesForWeek` | kickoff from `gameTime_epoch`, else `gameDate` + `gameTime` (US Eastern) |

Provider quirks are absorbed in `lib/services/normalize.ts`: string-typed
numbers, `PK` → `K` and `DEF` → `DST`, positions the fantasy pool has no slot for
(OL, LB, CB) dropped rather than fatal, nested stat groups flattened to
`{"passing.passYds": 248.6}`, and game status text mapped onto
`scheduled | in_progress | final | postponed | canceled`.

Team defenses need one more thing the feed does not provide: a box score's `DST`
node is raw stats only, so their fantasy points are computed in the mapper from
the same defensive weights the provider is asked to use for skill players, plus
the conventional points-allowed tiers (shutout 10, 1-6 → 7, 7-13 → 4, 14-20 → 1,
21-27 → 0, 28-34 → -1, 35+ → -4). Projections do carry a defensive total, and
that one is kept as sent.

Two columns the feed simply does not carry are derived in SQL instead
(migration `0005`), from data the database already holds:

| Column | Derived from | Why not in the mapper |
| --- | --- | --- |
| `projections.opponent` | `fsnv2.nfl_matchups` — the other side of that team's game that week | the projections endpoint has no opponent field, and the schedule is already synced |
| `weekly_stats.position` | `fsnv2.players` — same provider and external id | box-score entries have no position, and the roster is already synced |

Deriving on write costs no extra provider calls and works for any provider. It
does depend on sync order — players and schedules before projections and box
scores — which is the order the weekly bundle already runs in. A row whose game
or player has not synced yet keeps a null rather than failing, and a re-run never
trades a derived value back for the provider's null.

> **Why `nfl_matchups` and not `matchups`?** `fsnv2.matchups` is the *fantasy*
> head-to-head schedule: league-scoped, integer franchise slots 1-12, with the
> unique constraints `fsnv2_generate_schedule` asserts against. Real NFL games
> have none of that shape, so they land in `fsnv2.nfl_matchups` instead of being
> forced into a table the season engine owns. Both are read through RPCs, so UI
> code never has to know which is which.

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
npm run test:sync-data # the sports-data ingestion layer (no network, no keys)
npm run typecheck      # tsc over api, lib and scripts (needs npm install)
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

`npm run test:sync-data` verifies the ingestion layer in four phases and exits 0
on a machine with no credentials and no network:

1. **Configuration** — env defaults, `SPORTS_DATA_PROVIDER` swapping the
   provider, an unknown provider failing fast, a missing API key refusing to run,
   `SPORTS_DATA_ENDPOINT_*` overrides, week validation.
2. **Endpoint responses → rows** — the recorded payloads in `lib/fixtures/tank01`
   run through the *production* Tank01 mapper: bye weeks, `PK` → `K`, injury
   designations, flattened stat lines, team defenses, UTC kickoffs from both
   date paths, and a provider 500 coming back as a failed result rather than a
   crash.
3. **Database writes** — the *production* repository drives the `fsnv2_sync_*`
   contract (batching, counting, retries) against an in-memory stand-in that
   mirrors migrations 0004 and 0005: the same unique keys, and the same
   derivation of `projections.opponent` and `weekly_stats.position`. Each task
   runs **twice**: the second pass must insert 0 rows and update the same count,
   which is what "upsert, no duplicates" means in terms the runner can check.
   Batch sizing, a rejected batch still being audited, `--dry-run` writing
   nothing, derivation with and without its source data, and a re-run keeping a
   derived value are covered too.
4. **The cron route** — the calendar maths (kickoff dates, week boundaries, what
   a Tuesday run versus a mid-week run should fetch), then `/api/sync` itself:
   the weekly bundle, explicit `task`/`week` parameters, `dry_run` writing
   nothing, `CRON_SECRET` enforced when set, malformed requests rejected as 400
   before anything is written, and a run that exhausts its time budget reporting
   `skipped_tasks` with a 500.
5. **Live** — with `SPORTS_DATA_API_KEY` set it hits the real endpoints; with
   `--live` and a `SUPABASE_SERVICE_ROLE_KEY` it upserts, re-upserts and reads
   back through `fsnv2_sync_status`. Without those it reports both as skipped.

`tests/draft-sim.test.mjs` drafts all 180 picks — alternating VOR bot picks and
simulated clock expiries — prints the board by round, verifies the order, and
writes `tests/out/draft-sim.json`. With `--db` it pushes every pick through
`fsnv2_record_pick` and reads the board back. That payload can also be replayed
straight into Postgres (the file header has the SQL).

## Deploying

**Vercel Drop:** drag the project folder onto https://vercel.com/new/drop — no
framework preset, no build command.
**Vercel CLI:** `npx vercel deploy --prod`.

The app itself is static. `vercel.json` adds one serverless function — the weekly
sync cron — so a Vercel deployment runs `npm run build:api` to bundle it, and
serves the repository root as-is for everything else. That function is the only
part of the deployment that needs environment variables (see *Scheduled runs on
Vercel* above).

> Projections in `js/playerData.js` are synthetic sample data. The background
> sync service above is the production path: point `SPORTS_DATA_PROVIDER` at a
> vendor, run `npm run sync:data -- all --week=N`, and the real rows land in
> `fsnv2.players`, `fsnv2.projections`, `fsnv2.weekly_stats` and
> `fsnv2.nfl_matchups` for the UI to read through the `fsnv2_*` RPCs.
