#!/usr/bin/env node
/** Refresh the checked-in fallback with the same narrow fields as the API route. */
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { RAW_PLAYERS } from '../js/playerData.js';

const wanted = new Set(RAW_PLAYERS.map(([name]) => name));
const response = await fetch('https://api.sleeper.app/v1/players/nfl');
if (!response.ok) throw new Error(`Sleeper returned ${response.status}`);
const all = await response.json();
const selected = {};
for (const [id, row] of Object.entries(all)) {
  if (!wanted.has(row.full_name)) continue;
  selected[row.full_name] = {
    player_id: id, team: row.team ?? null,
    status: row.status ?? null,
    injury_status: row.injury_status ?? null,
    news_status: row.news_status ?? null,
    search_rank: row.search_rank ?? null,
    adp_ppr: row.adp_ppr ?? null,
    adp_half_ppr: row.adp_half_ppr ?? null,
    adp_std: row.adp_std ?? null
  };
}
const output = fileURLToPath(new URL('../js/sleeperRanksSnapshot.js', import.meta.url));
await writeFile(output, `// Sleeper player metadata snapshot refreshed ${new Date().toISOString().slice(0, 10)}.\nexport const sleeperRanksSnapshot = ${JSON.stringify(selected, null, 2)};\n`);
console.log(`Saved ${Object.keys(selected).length} Sleeper records to ${output}`);
