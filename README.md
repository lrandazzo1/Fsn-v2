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
js/playerData.js        Offline fallback pool (compact tuples -> Player objects)
js/liveData.js          Maps the synced rows onto the pool / projection / slate shapes
js/playerAssets.js      Player imagery: headshot URLs and the avatar's fallback cascade
js/vorMath.js           Replacement levels, VOR, tiers, scarcity, value indicator
js/sleeperMarket.js     Sleeper ADP / search-rank mapping and market comparator
api/draft-ranks.js      Daily cached Sleeper player metadata for the draft room
js/draftTimer.js        The pick clock (injectable scheduler so tests run instantly)
js/draftEngine.js       Snake state machine: pick progression, clock expiry, bots, undo, hydrate
js/seasonEngine.js      Round-robin schedule, weekly score engine, W-L / PF / PA standings
js/nflTeams.js          NFL colours, logo URLs, team-code aliases and the synced weekly slate
js/persistence.js       DraftRepository + SeasonRepository — Supabase RPCs, live reads, localStorage mirror
js/router.js            Hash router for the app shell
js/uiRenderer.js        Draft-room rendering + shared view helpers (incl. the headshot avatar)
js/views/home.js        Home Dashboard
js/views/league.js      League Overview (season standings + roster composition)
js/views/matchup.js     Matchup / Scoreboard hub
js/views/team.js        Team Roster
js/app.js               Boot, live-data load, state restore, event wiring, control handlers
lib/services/sportsData.ts        Ingestion facade: the four sync methods
lib/services/providers/           Provider registry + the Tank01 / RapidAPI fetcher
lib/services/syncRepository.ts    Batched UPSERTs through the fsnv2_sync_* RPCs
lib/services/teams.ts             The 32 franchises + every alias the feeds use for them
lib/services/nflverse.ts          The nflverse reference dataset (rosters + id crosswalk)
lib/services/playerIdentity.ts    Reconciles fsnv2.players against that reference
lib/services/csv.ts               RFC 4180 CSV reader (the reference feed quotes its commas)
lib/services/{env,logger,httpClient,normalize,types}.ts   Config, logging, HTTP, mapping helpers
lib/fixtures/tank01/    Recorded provider payloads (the `fixture` provider)
lib/api/syncRoute.ts    The weekly cron handler (bundled to api/sync.js)
scripts/build-api.mjs   esbuild bundle for that one function
vercel.json             Build + cron schedule + function limits
scripts/sync-data.ts    Sync CLI (npm run sync:data)
scripts/test-sync-data.ts  Sync verification CLI (npm run test:sync-data)
scripts/audit-players.ts   Player audit CLI (npm run audit:players)
scripts/test-audit-players.ts  Audit verification CLI (npm run test:audit)
supabase/migrations/    Schema + RPC migrations (0004 adds the sync tables, 0005 the derivations,
                        0006 the team refresh, 0007 player identity + headshots)
tests/engine.test.mjs   41 assertions: snake order, clock expiry, rosters, hydration
tests/season.test.mjs   51 assertions: schedule, simulation, standings, NFL matchups, hydration
tests/player-assets.test.mjs  19 assertions: headshot transform, avatar markup, onError cascade
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

1. calls `bestAvailableByAdp()` — the lowest Sleeper ADP (or search rank when
   ADP is absent) that fits an open roster slot and early position limits;
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
  (QB vs QB, RB vs RB, FLEX vs FLEX), each player with their headshot, that
  week's opponent (`@ MIA`, `vs NYJ`) and projected or actual points.
- **Live win probability** — a logistic fit to the projected margin
  (`1 / (1 + e^(-1.702 * margin / 28))`), with the projected totals above it.
  A finished game reports the result instead of a forecast.
- **League Scoreboard** — all six of the week's games as a grid; clicking a
  card opens that head-to-head.

Every image loads from a CDN, and — like the Tailwind and Lucide layers — the UI
has to survive that CDN being blocked. Each player wears a headshot avatar that
degrades in steps, down to initials on a team-coloured chip; see
[Player headshots](#player-headshots).

### Where a player's team and matchup come from

Both come from the provider payload, and from nothing else.

* **Team** — `js/liveData.js` builds the pool from the synced `fsnv2_players`
  rows, so a player's team is Tank01's own `teamAbv` (canonicalised: `WSH` →
  `WAS`, `JAC` → `JAX`, `OAK` → `LV`). The team column in `js/playerData.js` is
  the offline seed and is replaced the moment the database answers.
* **Matchup** — `setLiveSlate()` is handed the real games from
  `fsnv2_nfl_schedule` and writes both sides of each one, so the label is a
  lookup: `@ HOME` when the player's team is the away side, `vs AWAY` when it is
  the home side, `BYE` when a synced week holds no game for that franchise, and
  `—` when the week has not been synced at all.

There is **no generated slate** behind any of that. A synthetic round robin is
indistinguishable from a real fixture on screen, which is precisely how players
came to be labelled "vs CLE" / "@ PIT" / "@ SEA" against teams they were not
playing. An unknown week now says so.

## Player headshots

Every row that names a player — the pool in the draft room, the starting lineup
and bench, the head-to-head grid, the Team page's week summary — renders a
**Player Headshot Avatar** rather than a bare team badge.

The images are not in `js/playerData.js`. That pool is four columns wide by
design, so `loadPlayers()` can only ever produce `headshotUrl: null`; the
portraits live in Postgres, on `fsnv2.players.headshot_url`, written by the
player audit (migration `0007`) next to the external ids it resolved. They reach
the screen on the live-data path the app already walks at boot — no second read:

```
fsnv2_players  (repo.liveBundle)            row.headshot_url, row.espn_id
  -> buildLivePool()      js/liveData.js    carries them onto the Player
  -> headshotUrlFor()     js/playerAssets.js  headshot_url -> headshotUrl
  -> engine.usePlayerPool()                  the pool the whole UI renders
  -> avatarSources() + playerAvatar()        js/uiRenderer.js — the <img> itself
```

The transform is the part that was missing: the pool builder mapped six columns
onto a Player and dropped the imagery, so the views had only `player.team` left
to draw and every row showed a club badge. `headshotUrlFor()` accepts
`headshot_url` **or** `headshotUrl` (and `espn_id` or `espnId`), derives the URL
from the ESPN id when the column is null, and refuses anything that is not
`http(s)` before it reaches an `src`.

Images come from a CDN, and — like the Tailwind and Lucide layers — the UI has
to survive that CDN being blocked, a 404 for a player the audit could not
resolve, or the database being unreachable and the offline pool standing in. The
avatar is three layers deep and degrades one step at a time:

| Layer | Shown when |
| --- | --- |
| the headshot (`player.headshotUrl`) | the database had one and it loads |
| the team logo (`data-fallback`) | the headshot 404s, or there is no headshot |
| initials on a team-coloured chip | both images fail, or there is no live data |

The hop is driven by one capture-phase `error` listener on the document
(`installImageFallbacks()`), not an inline `onerror` per tag: `error` does not
bubble from an `<img>`, but it does reach a capture listener, so one handler
covers markup that is rewritten on every render, with no inline JavaScript and
nothing to re-bind. An image walks its `data-fallback` once, then removes itself
to reveal the chip.

The team badge survives as a small overlay on the avatar's corner — still
`teamLogoHtml()`, so a club change moves every badge at once — and a D/ST skips
it, because the audit stored the team logo as that row's "headshot" and the
avatar already *is* the badge.

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

**Apply them in order, all six.** `0006_fsnv2_player_team_refresh.sql` is not
optional: without it `fsnv2_upsert_players` still carries its original 0002
body, and the browser overwrites every synced roster on each page load (see
[Team affiliations](#team-affiliations) below). Every
migration is idempotent, so re-applying one on a project that already has it is
a no-op.

```bash
# in order — 0006 replaces the 0002 definition of fsnv2_upsert_players
for f in supabase/migrations/000*.sql; do psql "$DATABASE_URL" -f "$f"; done
```

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

### Live data in the browser

The UI reads the synced data directly rather than shipping it. On boot
`js/app.js` calls `DraftRepository.liveBundle()`, which reads three RPCs — all
granted to `anon`, so the publishable key is enough and no secret ever reaches
the browser:

| RPC | Replaces |
| --- | --- |
| `fsnv2_players` | the static pool in `js/playerData.js` |
| `fsnv2_projections` | the `season projection / 17` weekly estimate |
| `fsnv2_nfl_schedule` | the real slate behind the `@ MIA` / `vs NYJ` / `BYE` tags |

`js/liveData.js` maps the rows onto the shapes the app already speaks and is
pure — no network, so it is trivially testable. It mirrors `fsnv2_player_key`
and `fsnv2_team_abbr` in JavaScript so client-side matching agrees with the
database, and it keys team defenses by abbreviation because the provider names
them `MIN D/ST` where the pool says `Vikings D/ST`.

Two deliberate limits:

- **The pool is built only from rows with a real `stats.projection`.** The sync
  writes ~540 roster rows with `adp` 999 and no projection; letting those into
  the pool would drag every replacement level to zero and make VOR meaningless.
  They still inform the team/bye index.
- **Weeks the sync has not stored do not get an invented fixture.** The weekly
  points estimate still falls back to `season projection / 17`, but the opponent
  reads `—` and renders dimmed (`.is-projected`), as does a `BYE`. Nothing on
  screen is ever a fabricated opponent.

`annotatePlayers()` stamps `{ team, opponent, opponentTeam, isHome, onBye }`
onto every player for the week being shown, so the starting-lineup and bench
components read `{player.team}` and `{player.opponent}` straight off the
payload; `playerOpponentLabel()` falls back to a direct slate lookup, so a
component can never render a stale stamp.

Every step is optional. A disabled, unreachable or unsynced database leaves the
fallback in place and the app runs exactly as it did before — which is what
`npm run dev` with no credentials does, and what the Node test-suite uses.
Set `sportsData.enabled = false` to ignore the synced data deliberately.

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
    season:   { weeks: 14, seed: 20260208 },
    sportsData: { season: 2026, seasonType: 'reg', scoringFormat: 'ppr', enabled: true }
  };
</script>
```

Set `supabase.enabled = false` to run fully offline on localStorage, or
`sportsData.enabled = false` to keep the database but ignore the synced player
pool, projections and schedule. `sportsData.season` defaults to the season the
current date falls in (September–February belongs to the earlier year), matching
`lib/services/env.ts` so the browser and the sync service agree.

## Background sports-data sync

The sync service pulls real NFL data — players, rosters, weekly projections,
box scores and the schedule — into Postgres on a schedule of its own. The UI
then reads it back through the RPCs above (see
[Live data in the browser](#live-data-in-the-browser)); `js/playerData.js` is
only the offline fallback for when there is nothing synced to read.

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

A `players` run also repairs the browser's own pool rows: since migration
`0006`, `fsnv2_sync_players` calls `fsnv2_refresh_player_teams()` at the end of
every player sync, so no follow-up step is needed. Run it by hand only to patch
rows without re-syncing — see [Team affiliations](#team-affiliations).

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

Migrations `0003`, `0004`, `0005` and `0006` must be applied to the Supabase
project before the first run, or every write fails with `Could not find the
function public.fsnv2_sync_players`.

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

### Team affiliations

A player's club is whatever roster the sync read him from — never the `team`
field on his own record, which a vendor leaves pointing at his former club for a
while after a trade. `fetchPlayers` reads `getNFLTeams?rosters=true` and takes
the enclosing franchise's abbreviation and id (only the flat `getNFLPlayerList`
fallback, which has no enclosing roster, uses the entry's own fields), and
`fsnv2_sync_players` overwrites `team` and `nfl_team_external_id` on every run
rather than coalescing them.

Two things then keep the rest of the app in step (migration `0006`):

| | |
| --- | --- |
| `fsnv2_refresh_player_teams()` | copies the current team, NFL team id and bye week onto the synthetic `js/playerData.js` rows (provider null), matched on normalised name + position. `fsnv2_sync_players` calls it at the end of every player sync, and it can be run on its own as a patch: `select public.fsnv2_refresh_player_teams();` |
| `fsnv2_upsert_players` | the browser re-pushes its local pool on every page load; it now resolves each row's `team` against the synced pool first, so a static file can never write a former club back over a synced one |

`fsnv2_team_abbr()` gives every franchise one spelling on the way in — Tank01
sends Washington as `WSH`, other feeds send `JAC`, `OAK` or `LA` — because the
UI keys its colours, logos and opponents on the 32 abbreviations in
`js/nflTeams.js`, and an abbreviation it does not know renders as a grey chip
with no logo. The same alias table lives in `lib/services/normalize.ts` (new
rows), in the SQL function (rows already stored) and in `js/nflTeams.js`
(rendering, via `normalizeAbbr()`).

The team badge itself is `teamLogoHtml()` in `js/nflTeams.js`, shared by the
matchup board, the player pool, the roster slots and the Team page, and driven
entirely by the player's current `team` — so a player who changes clubs shows
his new badge everywhere as soon as the sync lands.

> **Why `nfl_matchups` and not `matchups`?** `fsnv2.matchups` is the *fantasy*
> head-to-head schedule: league-scoped, integer franchise slots 1-12, with the
> unique constraints `fsnv2_generate_schedule` asserts against. Real NFL games
> have none of that shape, so they land in `fsnv2.nfl_matchups` instead of being
> forced into a table the season engine owns. Both are read through RPCs, so UI
> code never has to know which is which.

## Player audit & migration pipeline

Migration `0006` above closes the loop between our two pools: the synthetic rows
take their team from the synced provider rows, every franchise has one spelling,
and the browser can no longer push a former club back over a synced one.

It cannot close the loop with the league. Both of those pools can be wrong
*together* — a player who moved and whom the vendor has not re-rostered, or one
the roster feed never carried at all — and there is then nothing inside the
database to compare against. Two more gaps sat alongside it:

- `fsnv2.players` had no `headshot_url`, so the UI had nowhere to read a portrait
  from. It has one now, and the avatars read it — see
  [Player headshots](#player-headshots).
- It carried no cross-feed id either, so every reconciliation had to go through a
  name. `fsnv2_player_key()` reduces a name to letters and digits, which handles
  `Wan'Dale Robinson` but not `Deebo Samuel` vs `Deebo Samuel Sr.` — and a
  generational suffix is exactly what two feeds disagree about. 42 of the 208
  synthetic rows failed to match on that alone, which left their teams frozen at
  whatever they were seeded with.

So the audit (`npm run audit:players`) adds an outside reference and the columns
needed to match against it without trusting a name.

### The ground truth

[nflverse](https://github.com/nflverse/nflverse-data) — the community mirror of
the league's own feeds, the same data `nflreadpy`/`nflreadr` load. Read straight
from the release assets, so this project needs no Python and no R:

| File | What it answers |
| --- | --- |
| `weekly_rosters/roster_weekly_<season>.csv` | who is on which roster, **by week** — the only current view |
| `rosters/roster_<season>.csv` | the season snapshot, covering anyone the weekly file has not listed |
| `players/players.csv` | the cumulative id crosswalk (`gsis_id`, `espn_id`, `sleeper_id`, `rotowire_id`) |

Note the URLs: nflverse publishes these as **release assets**, so the
`raw.githubusercontent.com/.../master/players/players.csv` path 404s. The release
URLs in `lib/services/nflverse.ts` are what `nflreadr` itself resolves to.

Which file answers "what team is this player on" matters. `players.csv` carries
`latest_team`, but that is a derived column and it lags; a player's team is taken
from the **highest week he appears in**, preferring an on-roster row, so a
mid-season move shows up the week it happens. Downloads are cached on disk, so a
`--dry-run` followed by the real run costs one download.

### Matching

Descending order of how much each key can be trusted:

| Key | Notes |
| --- | --- |
| `espn_id` | including a Tank01 `external_id` — Tank01 keys players **by** their ESPN id, which is why `tank01-3917315` and espn_id `3917315` are the same man |
| `sleeper_id` / `gsis_id` / `rotowire_id` | whichever the row already carries |
| normalized name + position | accents folded, punctuation and `Jr./Sr./III` dropped; position guards against the two Josh Allens |
| franchise, for team defenses | `Vikings D/ST` → MIN; no person's id applies |

An id match wins over a name match even when the names disagree — a name is what
*changes*, an id is what does not. Suffix stripping is what the first
reconciliation pass was missing: 42 of the 208 hand-maintained rows failed to
match on `Sr.` alone, which left their teams frozen at whatever they were seeded
with (`Deebo Samuel` vs `Deebo Samuel Sr.` is the canonical example).

### What it will and will not overwrite

| Column | Rule |
| --- | --- |
| `team` | rewritten only when the reference has the player **on a roster**. Released or retired → keeps his last team and is reported, not blanked; blanking a bench mid-season is worse than a stale code. IR and practice squad *are* on the team, so those do move. |
| `espn_id` etc. | filled when missing. A **conflicting** id is never overwritten — it is reported, because two feeds disagreeing about identity is a data question, not something a migration should guess at. |
| `headshot_url` | filled when missing (`--refresh-headshots` to re-point). ESPN's combiner for a player, ESPN's team logo for a DST row. |
| team code | canonicalized even on a row that matched nothing at all. |

### Running it

```bash
npm run audit:players:dry            # report the diff, write nothing
npm run audit:players                # apply
node scripts/audit-players.ts --only=headshots        # one column at a time
node scripts/audit-players.ts --refresh-headshots     # re-point every portrait
node scripts/audit-players.ts --static=js/playerData.js   # also fix the static pool
node scripts/audit-players.ts --sql-out=audit.sql    # emit SQL, leave the database alone
node scripts/audit-players.ts --snapshot=players.json --sql-out=audit.sql   # fully offline
```

`--snapshot` reads the table from a JSON file instead of the RPC, so the audit can
be run and reviewed on a machine with no service-role key: export the rows once,
reconcile offline, apply the SQL through the editor. `--dry-run` changes nothing
anywhere; `--sql-out` only diverts the *database* half, so a run can emit SQL for
review and still correct the static pool in the working tree.

`--static` matters more than it looks. `js/persistence.js` pushes
`js/playerData.js` into the table on every draft-board load, so a team left stale
there is re-applied to the database the next time anyone opens the app. Migration
`0006` stops it overwriting a verified assignment; correcting the file is what
stops the two disagreeing at all. Only the third element of each tuple is
touched, by an anchored per-line replacement, so projections and row order — which
the `p-0007`-style ids depend on — are untouched.

### The database half (migration `0007`)

| Added | Purpose |
| --- | --- |
| `fsnv2.canonical_team(text)` | the strict half of `fsnv2_team_abbr`: **NULL** — never a guess — for a numeric team id or an unknown code. A number is a provider's internal team id, and storing it as a franchise is what produced rows like `"21"` and the `DST-10` of migration `0005`. `fsnv2_team_abbr` now reads its alias table from here, so the list is maintained in one place; its own contract (alias, else the code uppercased) is unchanged, because `fsnv2_refresh_player_teams()` writes its result into a NOT NULL column |
| `players.gsis_id/espn_id/sleeper_id/rotowire_id` | the cross-feed identity the reconcile step matches on (indexed, deliberately **not** unique — the pool and a provider each keep their own row for the same human) |
| `players.headshot_url` | the portrait the UI had nowhere to read from |
| `players.team_source` / `audited_at` | who last set `team`, so a verified assignment outranks a client push |
| `fsnv2_players_audit_snapshot()` | what the script reads |
| `fsnv2_preview_player_audit(jsonb)` | the read-only twin — what `--dry-run` reports |
| `fsnv2_apply_player_audit(jsonb, boolean)` | what the script writes, per column and counted |
| `fsnv2_player_audit_status()` | a standing view: what is still missing, per franchise |

Both write paths keep every guard `0006` gave them and gain the identity columns,
so the two sets of rules compose instead of taking turns:

- **`fsnv2_upsert_players`** (the anon seed) still takes `team` from the synced
  pool when that pool knows the player. Added: an audited team
  (`team_source = 'nflverse'`) outranks the client too — which covers the one
  class of player the provider pool has never heard of, and is the only place the
  external reference can hold — and a code that is not a franchise never lands.
  Projections, ADP and VOR still come from the client; those are the pool's own
  numbers.
- **`fsnv2_sync_players`** (the provider path) still overwrites `team` from the
  roster it read the player off and still calls `fsnv2_refresh_player_teams()`
  once the batch lands. Added: the provider's identity columns are carried through
  instead of dropped; a payload that names *no* franchise no longer overwrites a
  stored one with `FA` (a roster feed only lists rostered players, so that means
  "the payload did not say"); and a verified team is propagated between the two
  rows for one player **by `espn_id`**, which reaches the rows whose names
  disagree and `fsnv2_player_key()` therefore cannot match. It also returns
  `unmapped_teams`, so a mapper regression shows up in the sync log instead of
  quietly filing a roster under `FA`.

One trap worth recording: the apply function's counters were first computed in the
UPDATE's `RETURNING` clause, which yields the **NEW** row — so `p.espn_id is null`
was false by the time it was evaluated and the function reported
`updated: 0, teams: 0, headshots: 0` while writing every row correctly. The diff
now comes from a CTE that joins the payload against `fsnv2.players` in the same
statement snapshot.

### The Tank01 mapper

Team resolution is unchanged from **Team affiliations** above — the enclosing
roster first, the entry's own fields only in the flat-list fallback, the `teamID`
dictionary behind both. What the audit adds is identity: `mapRosterPlayer` now
carries `espn_id`, `sleeper_id`, `gsis_id`, `rotowire_id` and a headshot through,
so the keys the audit matches on stay fresh between runs without it having to
re-derive them from the reference every time.

Tank01 keys players by their ESPN id, so `playerID` **is** the `espn_id` — which
is why `tank01-3917315` and `espn_id` `3917315` are the same man, and why an id
match is available for every provider row with no crosswalk lookup at all.

`canonicalTeam()` in `lib/services/teams.ts` also refuses anything numeric, so a
`teamID` reaching a column that holds franchises is now impossible at both ends:
the mapper resolves it through the dictionary, and the SQL rejects it if anything
ever slips past.

## Running locally

ES modules require HTTP (not `file://`):

```bash
npm run dev            # python3 -m http.server 8000
# open http://localhost:8000
```

## Tests

```bash
npm test               # engine, season and player-asset suites, then the full simulation
npm run test:engine    # draft engine only
npm run test:season    # season matchup engine only
npm run test:assets    # headshot transform and avatar markup only
npm run test:db        # also persist the simulation to Supabase and verify
npm run test:sync-data # the sports-data ingestion layer (no network, no keys)
npm run test:audit     # the player audit: team canon, matching, change plan (no network, no keys)
npm run typecheck      # tsc over api, lib and scripts (needs npm install)
```

`tests/engine.test.mjs` (41 assertions) covers snake rotation across 15 rounds
and odd team counts, on-the-clock indexing through the turn, next-up previews,
clock expiry (ADP pick, clean advance, single fire), full-draft roster legality,
undo and hydration.

`tests/season.test.mjs` (51 assertions) covers the schedule — 84 games, six a
week, every team once a week, all 66 pairings exactly once across weeks 1-11,
weeks 12-14 as valid perfect matchings with the sides swapped — the shuffle
vectors read back from Postgres, the score engine (totals equal the sum of the
starters; scores sit near but not on the projection), the standings invariants
(wins balance losses, league Points For equals Points Against), the NFL matchup
layer (both game shapes parsed, home and away agreeing on each side, `BYE` only
inside a synced week, `—` when nothing is synced, feed spellings folded, and the
live pool's team beating the seed's) and the persistence round trip.

`tests/player-assets.test.mjs` (19 assertions) covers the headshot pipeline:
`buildLivePool()` carrying `headshot_url` and `espn_id` onto the Player, the URL
derived from an ESPN id when the column is null, non-`http` URLs refused, a
D/ST's team logo kept as its portrait, the avatar's fallback cascade and
attribute escaping, and the delegated `error` handler hopping to the team logo
once and then removing the image.

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

`tests/draft-sim.test.mjs` drafts all 180 picks — alternating market bot picks and
simulated clock expiries — prints the board by round, verifies the order, and
writes `tests/out/draft-sim.json`. With `--db` it pushes every pick through
`fsnv2_record_pick` and reads the board back. That payload can also be replayed
straight into Postgres (the file header has the SQL).

## Deploying

**Vercel Drop:** drag the project folder onto https://vercel.com/new/drop — no
framework preset, no build command.
**Vercel CLI:** `npx vercel deploy --prod`.

The app itself is static. `vercel.json` adds the weekly sync cron and
`api/draft-ranks.js` provides a daily cached slice of Sleeper's player map.
The checked-in `js/sleeperRanksSnapshot.js` is an offline fallback; refresh it
with `npm run sync:draft-ranks`. Sleeper currently leaves the scoring-specific
`adp_*` fields empty for many players, so the UI labels its `search_rank`
fallback as a Sleeper rank rather than an observed ADP. Projections remain
synthetic, and VOR is only a value indicator, never a draft sort key.

> Projections in `js/playerData.js` are synthetic sample data. The background
> sync service above is the production path: point `SPORTS_DATA_PROVIDER` at a
> vendor, run `npm run sync:data -- all --week=N`, and the real rows land in
> `fsnv2.players`, `fsnv2.projections`, `fsnv2.weekly_stats` and
> `fsnv2.nfl_matchups` for the UI to read through the `fsnv2_*` RPCs.
