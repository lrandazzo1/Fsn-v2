# FSN v2 — Draft & League Engine

A zero-build, deploy-anywhere fantasy football platform: a 12-team / 15-round
snake draft room with VOR valuations, a live pick clock with auto-draft on
expiry, bot managers, and Postgres-backed persistence on Supabase.

Everything is static — open `index.html` through any web server (or drop the
folder on [Vercel Drop](https://vercel.com/new/drop)) and it runs.

## Navigation flow

```
Home Dashboard  ->  League Overview  ->  Draft Room / Board  ->  Team Roster / Matchup
     #/                 #/league              #/draft                 #/team/:id
```

A hash router (`js/router.js`) swaps `<section data-view>` panes, so each screen
is its own module and the draft engine stays a single shared instance.

| Route | Screen | What it shows |
| --- | --- | --- |
| `#/` | Home Dashboard | Draft status, your next pick, roster fill, team VOR, latest picks |
| `#/league` | League Overview | Settings, live standings by projected starter points, per-team position counts |
| `#/draft` | Draft Room | Board grid, pick clock, next-up strip, player pool, roster panel, recommendations |
| `#/team/:id` | Team Roster / Matchup | Starters + bench, head-to-head projection, that team's draft log |

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
js/persistence.js       DraftRepository — Supabase RPC writes, retry queue, localStorage mirror
js/router.js            Hash router for the app shell
js/uiRenderer.js        Draft-room rendering + shared view helpers
js/views/home.js        Home Dashboard
js/views/league.js      League Overview
js/views/team.js        Team Roster / Matchup
js/app.js               Boot, state restore, event wiring, control handlers
supabase/migrations/    The two migrations applied to the database
tests/engine.test.mjs   28 assertions: snake order, clock expiry, rosters, hydration
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

One formula owns this, in both places it matters:

```js
// js/draftEngine.js
teamIdForPick(overall) {
  const index = overall - 1;
  const round = Math.floor(index / this.teamCount);
  const slot  = index % this.teamCount;
  return round % 2 === 0 ? slot + 1 : this.teamCount - slot;
}
```

```sql
-- mirrored in Postgres so the database can reject a wrong pick
select public.fsnv2_snake_team(pick_number, total_teams);
```

`currentRound`, `currentSlot`, `currentTeamId`, the "on the clock" header, the
board highlight and `nextUp(n)` all derive from it, so every indicator moves
together on each selection — including the double pick at a turn (12 → 12).

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

## Database (Supabase / Postgres)

Applied to the Supabase project **FSN** as `fsnv2_draft_engine_schema` and
`fsnv2_draft_engine_rpc` (checked in under `supabase/migrations/`). Tables live
in a dedicated `fsnv2` schema so they never collide with the existing
`public.*` tables.

| Table | Columns |
| --- | --- |
| `fsnv2.leagues` | `id`, `name`, `total_teams`, `roster_settings` (jsonb), `scoring_type`, timestamps |
| `fsnv2.drafts` | `id`, `league_id`, `current_pick`, `status`, `timer_seconds`, `rounds`, `draft_type`, `teams` (jsonb), timestamps |
| `fsnv2.draft_picks` | `id`, `draft_id`, `pick_number`, `round`, `team_id`, `player_id`, `picked_at`, `auto`, `source` |
| `fsnv2.players` | `id`, `name`, `position`, `team`, `adp`, `stats` (jsonb), timestamps |

Constraints that keep a board honest: `unique (draft_id, pick_number)`,
`unique (draft_id, player_id)`, and a FK from `draft_picks.player_id` to
`players.id`.

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
browser — it only reaches the RPCs above). Override without editing the file:

```html
<script>
  window.FSN_CONFIG = {
    supabase: { url: 'https://<project>.supabase.co', key: 'sb_publishable_…' },
    league:   { name: 'My League', totalTeams: 12, rounds: 15, timerSeconds: 60 }
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
npm test               # engine suite + full 15-round simulation
npm run test:db        # also persist the simulation to Supabase and verify
```

`tests/engine.test.mjs` (28 assertions) covers snake rotation across 15 rounds
and odd team counts, on-the-clock indexing through the turn, next-up previews,
clock expiry (ADP pick, clean advance, single fire), full-draft roster legality,
undo and hydration.

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
