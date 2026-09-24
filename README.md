# FSN v2 — Draft & League Engine

A zero-build, deploy-anywhere draft room: 12-team / 15-round snake draft with
VOR-based player valuations, auto-draft bots, live board, filterable player pool
and real-time rosters.

Everything is static — open `index.html` through any web server (or drop the
folder on [Vercel Drop](https://vercel.com/new/drop)) and it runs.

## Project structure

```
index.html          Dashboard shell: header, draft board, player pool, roster panel
styles.css          Dark-mode sports-network design system (position colour coding)
js/types.js         Player / Team / Pick / DraftState shapes + roster slot template
js/playerData.js    The player pool (compact tuples → Player objects)
js/vorMath.js       Replacement levels, VOR, tiers, derived ADP, scarcity, recommendations
js/draftEngine.js   Snake-draft state machine: pick progression, bots, undo, reset
js/uiRenderer.js    DOM rendering for board, pool, rosters, recommendations, feed
js/app.js           Boot, UI state (filters/selection), event wiring, control buttons
```

Open-source dependencies are loaded from CDNs — no install step, no bundler:

| Library | Use |
| --- | --- |
| [Tailwind CSS](https://tailwindcss.com) (CDN) | utility layer / reset |
| [Lucide](https://lucide.dev) | icon set |
| Inter + JetBrains Mono (Google Fonts) | typography |

If a CDN is blocked, `styles.css` still carries the full layout and theme.

## Running locally

ES modules require HTTP (not `file://`):

```bash
python3 -m http.server 8000     # or: npx serve .
# open http://localhost:8000
```

## Deploying

**Vercel Drop:** zip or drag the project folder onto https://vercel.com/new/drop.
No framework preset, no build command — it is served as static assets.

**Vercel CLI:** `npx vercel deploy --prod`.

## How the draft works

- **Snake order** — odd rounds run team 1→12, even rounds 12→1
  (`DraftEngine.teamIdForPick`).
- **VOR** — `projection(player) − projection(replacement at that position)`,
  where replacement is the last startable player in a 12-team league
  (QB 14th, RB 30th, WR 36th, TE 14th, K/DST 12th). See `js/vorMath.js`.
- **Derived ADP** — VOR reshaped by drafter behaviour (`ADP_BIAS`), so kickers
  and defenses fall to the last rounds the way they do in real rooms.
- **Bots** — score every available player as
  `draftValue + rosterNeed + jitter`, respecting positional caps and open roster
  slots. Randomness is tunable via `new DraftEngine({ botRandomness })`.
- **Rosters** — 9 starters (QB, RB, RB, WR, WR, TE, FLEX, DST, K) + 6 bench,
  defined once in `ROSTER_SLOTS` and filled best-slot-first.

## Controls

| Control | Action |
| --- | --- |
| **Make Pick** | Drafts the player on your card (only when you are on the clock) |
| **Auto Pick** | Bot makes the current pick |
| **Simulate Round** | Bots run out the rest of the current round |
| **Sim To My Pick** | Bots run until you are back on the clock |
| **Auto-Draft** | Bots draft for your team too |
| **Undo** / **Reset** | Revert the last pick / start a fresh draft |

Keyboard: `/` focus search · `Enter` make pick · `S` simulate round · `U` undo.
Double-clicking a player in the pool drafts them. Clicking a board column loads
that franchise's roster in the sidebar.

## Configuration

```js
// js/app.js
const engine = new DraftEngine({ teamCount: 12, rounds: 15, userTeamId: 1 });
```

Swap `js/playerData.js` for a `fetch()` against your projections API — as long
as rows return `{ name, position, team, projection }`, the rest of the engine is
unchanged. `window.FSN` exposes `{ engine, ui }` in the console for tinkering.

> Projections in `js/playerData.js` are synthetic sample data for demo purposes.
