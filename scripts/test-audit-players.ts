#!/usr/bin/env node
/**
 * scripts/test-audit-players.ts   →   npm run test:audit
 * -----------------------------------------------------------------------------
 * Verifies the player audit: the team canon, the CSV reader, the matching rules,
 * the change plan and the static-pool rewrite.
 *
 * Runs clean with no credentials and no network. The nflverse reference is a
 * handful of in-memory CSV rows served through an injected `fetch`, which
 * exercises the production loader (release URLs, weekly-over-season precedence,
 * the disk cache being off) rather than a stand-in for it.
 *
 * Extra phases switch on when there is something real to talk to:
 *
 *   AUDIT_TEST_LIVE=1 (or --live) plus     a read-only round trip against the
 *   SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY   audit RPCs
 */

import assert from 'node:assert/strict';

import { parseCsv, parseCsvRows } from '../lib/services/csv.ts';
import { normalizePlayerName, playerMatchKey, teamAbbr } from '../lib/services/normalize.ts';
import {
  CANONICAL_TEAMS,
  canonicalTeam,
  espnHeadshotUrl,
  espnTeamLogoUrl,
  normalizeTeam,
  teamFromDefenseName
} from '../lib/services/teams.ts';
import { fetchNflversePlayers } from '../lib/services/nflverse.ts';
import {
  buildReferenceIndex,
  matchPlayer,
  reconcilePlayer,
  reconcilePlayers,
  toUpdatePayload
} from '../lib/services/playerIdentity.ts';
import { rewriteStaticPool } from './audit-players.ts';
import { createSupabaseSyncRepository } from '../lib/services/syncRepository.ts';
import { readEnv } from '../lib/services/env.ts';
import { silentLogger } from '../lib/services/logger.ts';
import { createTank01Provider } from '../lib/services/providers/tank01.ts';
import type { PlayerAuditRow } from '../lib/services/types.ts';

/* --------------------------------------------------------------- harness -- */

interface Outcome {
  name: string;
  ok: boolean;
  skipped?: boolean;
  error?: Error;
}

const results: Outcome[] = [];
const VERBOSE = process.argv.includes('--verbose');

class SkipCheck extends Error {}

async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    results.push({ name, ok: true });
    process.stdout.write(`  \u001b[32m✓\u001b[0m ${name}\n`);
  } catch (error) {
    if (error instanceof SkipCheck) {
      results.push({ name, ok: true, skipped: true });
      process.stdout.write(`  \u001b[33m–\u001b[0m ${name} \u001b[2m(${error.message})\u001b[0m\n`);
      return;
    }
    results.push({ name, ok: false, error: error as Error });
    process.stdout.write(`  \u001b[31m✗\u001b[0m ${name}\n      ${(error as Error).message}\n`);
    if (VERBOSE) process.stdout.write(`${(error as Error).stack}\n`);
  }
}

function phase(title: string): void {
  process.stdout.write(`\n\u001b[1m${title}\u001b[0m\n`);
}

/* ------------------------------------------------------------- fixtures -- */

/**
 * A reference feed with every case the matcher has to get right:
 *   - a player whose team moved since the pool was written (Kyler Murray)
 *   - a suffix the pool does not carry ('Deebo Samuel Sr.')
 *   - nflverse's 'LA' for the Rams
 *   - a player with no ESPN id, so the headshot has to fall back
 *   - a released player, whose team must NOT be written
 *   - two different men sharing a name, so a name match is refused
 */
const WEEKLY_CSV = [
  'season,week,team,position,status,full_name,gsis_id,espn_id,sleeper_id,rotowire_id,headshot_url,jersey_number,college,years_exp',
  '2026,3,MIN,QB,ACT,Kyler Murray,00-0035228,3917315,5849,13613,https://static.www.nfl.com/image/upload/f_auto,q_auto/league/btfruyf33adgnjzpcuen,1,Oklahoma,8',
  '2026,3,SF,WR,ACT,Deebo Samuel Sr.,00-0035719,3126486,5872,13429,https://static.www.nfl.com/image/upload/f_auto/deebo,19,South Carolina,7',
  '2026,3,LA,WR,ACT,Puka Nacua,00-0038543,4426515,8137,16603,,17,BYU,3',
  '2026,3,WAS,TE,ACT,Zach Ertz,00-0030061,,,,https://static.www.nfl.com/ertz.png,86,Stanford,13',
  '2026,3,CLE,RB,CUT,Jerome Ford,00-0037746,4362249,8162,15726,https://static.www.nfl.com/ford.png,34,Cincinnati,4',
  '2026,3,BUF,QB,ACT,Josh Allen,00-0034857,3918298,4984,12508,https://static.www.nfl.com/allen.png,17,Wyoming,8',
  '2026,3,JAX,DE,ACT,Josh Allen,00-0035261,3929920,5860,13648,https://static.www.nfl.com/allen2.png,41,Kentucky,7',
  // Week 2 rows that the week 3 rows above must win over.
  '2026,2,ARI,QB,ACT,Kyler Murray,00-0035228,3917315,5849,13613,,1,Oklahoma,8',
  '2026,2,WSH,WR,ACT,Deebo Samuel Sr.,00-0035719,3126486,5872,13429,,19,South Carolina,7'
].join('\n');

const SEASON_CSV = [
  'season,team,position,status,full_name,gsis_id,espn_id,sleeper_id,rotowire_id,headshot_url,jersey_number',
  // Only in the season snapshot — proves the season file fills weekly's gaps.
  '2026,KC,TE,ACT,Travis Kelce,00-0030506,15847,1466,9695,https://static.www.nfl.com/kelce.png,87'
].join('\n');

const PLAYERS_CSV = [
  'gsis_id,display_name,position,latest_team,status,espn_id,headshot,college_name',
  // An id-crosswalk-only row: no roster entry, so it must not claim a team.
  '00-0019596,Tom Brady,QB,TB,RET,2330,https://static.www.nfl.com/brady.png,Michigan'
].join('\n');

function referenceFetch(): (input: string) => Promise<Response> {
  return (url: string) => {
    const body = url.includes('roster_weekly_')
      ? WEEKLY_CSV
      : url.includes('/rosters/roster_')
        ? SEASON_CSV
        : url.includes('players.csv')
          ? PLAYERS_CSV
          : null;
    if (body === null) {
      return Promise.resolve(new Response('Not Found', { status: 404, statusText: 'Not Found' }));
    }
    return Promise.resolve(new Response(body, { status: 200, headers: { 'content-type': 'text/csv' } }));
  };
}

const loadReference = () =>
  fetchNflversePlayers({
    season: 2026,
    cacheDir: null,
    fetch: referenceFetch(),
    logger: silentLogger
  });

/** The database rows the audit has to repair — the real defects, in miniature. */
const DB_ROWS: PlayerAuditRow[] = [
  // The hand-maintained pool: stale team, no ids, no headshot.
  { id: 'p-0007', name: 'Kyler Murray', position: 'QB', team: 'ARI', provider: null, team_source: 'local' },
  { id: 'p-0123', name: 'Deebo Samuel', position: 'WR', team: 'WAS', provider: null, team_source: 'local' },
  { id: 'p-0171', name: 'Zach Ertz', position: 'TE', team: 'WAS', provider: null, team_source: 'local' },
  { id: 'p-0076', name: 'Jerome Ford', position: 'RB', team: 'CLE', provider: null, team_source: 'local' },
  { id: 'p-0200', name: 'Vikings D/ST', position: 'DST', team: 'MIN', provider: null, team_source: 'local' },
  { id: 'p-0206', name: '49ers D/ST', position: 'DST', team: 'SF', provider: null, team_source: 'local' },
  // A non-canonical spelling, and a numeric code that should never have landed.
  { id: 'p-0999', name: 'Puka Nacua', position: 'WR', team: 'LA', provider: null, team_source: 'local' },
  { id: 'p-0998', name: 'Travis Kelce', position: 'TE', team: 'KC', provider: null, team_source: 'local' },
  // The provider pool: keyed by ESPN id, which is what Tank01's playerID is.
  {
    id: 'tank01-3917315',
    name: 'Kyler Murray',
    position: 'QB',
    team: '21',
    provider: 'tank01',
    external_id: '3917315',
    team_source: 'provider'
  },
  // A player the reference does not know at all.
  { id: 'p-0997', name: 'Devin Neal', position: 'RB', team: 'NO', provider: null, team_source: 'local' }
];

/* ------------------------------------------------------- phase: team canon -- */

async function phaseTeams(): Promise<void> {
  phase('Team codes — one spelling per franchise');

  await check('32 canonical franchises', () => {
    assert.equal(CANONICAL_TEAMS.length, 32);
  });

  await check("aliases resolve ('ARZ'->ARI, 'WSH'->WAS, nflverse 'LA'->LAR)", () => {
    assert.equal(canonicalTeam('ARZ'), 'ARI');
    assert.equal(canonicalTeam('arz'), 'ARI');
    assert.equal(canonicalTeam('WSH'), 'WAS');
    assert.equal(canonicalTeam('WFT'), 'WAS');
    assert.equal(canonicalTeam('LA'), 'LAR');
    assert.equal(canonicalTeam('STL'), 'LAR');
    assert.equal(canonicalTeam('JAC'), 'JAX');
    assert.equal(canonicalTeam('OAK'), 'LV');
    assert.equal(canonicalTeam('SD'), 'LAC');
    assert.equal(canonicalTeam('GNB'), 'GB');
  });

  await check('a numeric team id is refused, never stored as a franchise', () => {
    // The original defect: Tank01's teamID reaching the team column.
    assert.equal(canonicalTeam('21'), null);
    assert.equal(canonicalTeam(21), null);
    assert.equal(canonicalTeam('0'), null);
    assert.equal(normalizeTeam('21'), 'FA');
    assert.equal(teamAbbr('21'), 'FA');
  });

  await check('an unknown code falls back rather than being stored verbatim', () => {
    assert.equal(canonicalTeam('XYZ'), null);
    assert.equal(teamAbbr('XYZ'), 'FA');
    assert.equal(teamAbbr(''), 'FA');
    assert.equal(teamAbbr(null), 'FA');
  });

  await check('a canonical code passes through untouched', () => {
    for (const abbr of CANONICAL_TEAMS) assert.equal(canonicalTeam(abbr), abbr);
  });

  await check("defense rows resolve to a franchise ('Vikings D/ST' -> MIN)", () => {
    assert.equal(teamFromDefenseName('Vikings D/ST'), 'MIN');
    assert.equal(teamFromDefenseName('49ers D/ST'), 'SF');
    assert.equal(teamFromDefenseName('Buccaneers D/ST'), 'TB');
    assert.equal(teamFromDefenseName('Commanders D/ST'), 'WAS');
    assert.equal(teamFromDefenseName('DST-SF'), 'SF');
    assert.equal(teamFromDefenseName('Kyler Murray'), null);
  });

  await check('headshot and logo URLs are built from ids, not guessed', () => {
    assert.equal(
      espnHeadshotUrl('3917315'),
      'https://a.espncdn.com/combiner/i?img=/i/headshots/nfl/players/full/3917315.png'
    );
    assert.equal(espnHeadshotUrl(''), null);
    assert.equal(espnHeadshotUrl('abc'), null);
    assert.equal(espnTeamLogoUrl('WAS'), 'https://a.espncdn.com/i/teamlogos/nfl/500/wsh.png');
    assert.equal(espnTeamLogoUrl('MIN'), 'https://a.espncdn.com/i/teamlogos/nfl/500/min.png');
  });
}

/* -------------------------------------------------------------- phase: CSV -- */

async function phaseCsv(): Promise<void> {
  phase('CSV — the reference feed quotes its delimiters');

  await check('a quoted field containing commas stays one field', () => {
    // Both of these appear in nflverse's own columns; a split(',') mis-shifts
    // every field after them and files players under the wrong team.
    const rows = parseCsv(
      'name,headshot,college\n' +
        'Kyler Murray,"https://x/upload/f_auto,q_auto/league/abc","Oklahoma; Texas A&M"\n'
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].headshot, 'https://x/upload/f_auto,q_auto/league/abc');
    assert.equal(rows[0].college, 'Oklahoma; Texas A&M');
  });

  await check('escaped quotes, CRLF, a BOM and a trailing newline', () => {
    const rows = parseCsv('﻿a,b\r\n"say ""hi""",2\r\n');
    assert.deepEqual(rows, [{ a: 'say "hi"', b: '2' }]);
  });

  await check('a quoted embedded newline is one cell', () => {
    const cells = parseCsvRows('a,b\n"line1\nline2",x\n');
    assert.deepEqual(cells[1], ['line1\nline2', 'x']);
  });

  await check('a short row reads as empty strings, not undefined', () => {
    const rows = parseCsv('a,b,c\n1,2\n');
    assert.deepEqual(rows, [{ a: '1', b: '2', c: '' }]);
  });
}

/* -------------------------------------------------------- phase: reference -- */

async function phaseReference(): Promise<void> {
  phase('nflverse reference — the freshest roster row wins');

  const dataset = await loadReference();

  await check('the release URLs are the ones nflreadr resolves to', async () => {
    const seen: string[] = [];
    await fetchNflversePlayers({
      season: 2026,
      cacheDir: null,
      logger: silentLogger,
      fetch: (url: string) => {
        seen.push(url);
        return referenceFetch()(url);
      }
    });
    assert.ok(
      seen.some((url) =>
        url.endsWith('/releases/download/weekly_rosters/roster_weekly_2026.csv')
      ),
      `weekly roster URL not requested: ${seen.join(', ')}`
    );
    assert.ok(seen.some((url) => url.endsWith('/releases/download/rosters/roster_2026.csv')));
    assert.ok(seen.some((url) => url.endsWith('/releases/download/players/players.csv')));
    // The path in the original brief 404s — nothing should depend on it.
    assert.ok(!seen.some((url) => url.includes('raw.githubusercontent.com')));
  });

  await check('week 3 beats week 2 for the same player', () => {
    const murray = dataset.players.find((player) => player.espn_id === '3917315');
    assert.ok(murray, 'Kyler Murray missing from the reference');
    assert.equal(murray.team, 'MIN');
    assert.equal(murray.week, 3);
  });

  await check("nflverse's 'LA' is stored as LAR", () => {
    const nacua = dataset.players.find((player) => player.full_name === 'Puka Nacua');
    assert.equal(nacua?.team, 'LAR');
  });

  await check('the season snapshot fills what the weekly file misses', () => {
    const kelce = dataset.players.find((player) => player.full_name === 'Travis Kelce');
    assert.equal(kelce?.team, 'KC');
    assert.equal(kelce?.team_source, 'season_roster');
  });

  await check('a released player is marked off-roster', () => {
    const ford = dataset.players.find((player) => player.full_name === 'Jerome Ford');
    assert.equal(ford?.rostered, false);
    assert.equal(ford?.status, 'CUT');
  });

  await check('the ESPN combiner is preferred, published headshot is the fallback', () => {
    const murray = dataset.players.find((player) => player.espn_id === '3917315');
    assert.equal(
      murray?.headshot_url,
      'https://a.espncdn.com/combiner/i?img=/i/headshots/nfl/players/full/3917315.png'
    );
    // Zach Ertz has no espn_id in the fixture, so his published portrait stands.
    const ertz = dataset.players.find((player) => player.full_name === 'Zach Ertz');
    assert.equal(ertz?.headshot_url, 'https://static.www.nfl.com/ertz.png');
  });

  await check('ids arrive as strings, with no float tail', () => {
    const rows = parseCsv('gsis_id,espn_id,full_name,team,position,status\nx,3917315.0,A B,MIN,QB,ACT\n');
    assert.equal(rows[0].espn_id, '3917315.0');
    const parsed = dataset.players.find((player) => player.full_name === 'Josh Allen');
    assert.ok(parsed?.espn_id && !parsed.espn_id.includes('.'));
  });
}

/* ------------------------------------------------------------ phase: names -- */

async function phaseNames(): Promise<void> {
  phase('Name matching — suffixes, punctuation and accents');

  await check('generational suffixes are dropped', () => {
    assert.equal(normalizePlayerName('Deebo Samuel Sr.'), 'deebosamuel');
    assert.equal(normalizePlayerName('Deebo Samuel'), 'deebosamuel');
    assert.equal(normalizePlayerName('Kenneth Walker III'), 'kennethwalker');
    assert.equal(normalizePlayerName('Odell Beckham Jr.'), 'odellbeckham');
    assert.equal(normalizePlayerName('Marvin Harrison Jr'), 'marvinharrison');
  });

  await check('punctuation and accents fold away', () => {
    assert.equal(normalizePlayerName("Ja'Marr Chase"), 'jamarrchase');
    assert.equal(normalizePlayerName('A.J. Brown'), 'ajbrown');
    assert.equal(normalizePlayerName('Amon-Ra St. Brown'), 'amonrastbrown');
    assert.equal(normalizePlayerName('José Ramírez'), 'joseramirez');
  });

  await check('a one-word name is not eaten by the suffix rule', () => {
    assert.equal(normalizePlayerName('Sr.'), 'sr');
    assert.equal(normalizePlayerName('V'), 'v');
  });

  await check('the match key carries the position', () => {
    assert.equal(playerMatchKey('Deebo Samuel Sr.', 'WR'), 'deebosamuel|WR');
    assert.notEqual(playerMatchKey('Josh Allen', 'QB'), playerMatchKey('Josh Allen', 'DST'));
  });
}

/* ---------------------------------------------------------- phase: matching -- */

async function phaseMatching(): Promise<void> {
  phase('Reconciliation — which reference row a database row is');

  const dataset = await loadReference();
  const index = buildReferenceIndex(dataset.players);

  await check("a Tank01 external_id matches on ESPN id (Tank01's playerID *is* espn_id)", () => {
    const row = DB_ROWS.find((candidate) => candidate.id === 'tank01-3917315') as PlayerAuditRow;
    const match = matchPlayer(row, index);
    assert.equal(match.method, 'provider_external_id');
    assert.equal(match.player?.team, 'MIN');
  });

  await check("a suffix mismatch still matches ('Deebo Samuel' -> 'Deebo Samuel Sr.')", () => {
    const row = DB_ROWS.find((candidate) => candidate.id === 'p-0123') as PlayerAuditRow;
    const match = matchPlayer(row, index);
    assert.equal(match.method, 'name_position');
    assert.equal(match.player?.full_name, 'Deebo Samuel Sr.');
    assert.equal(match.player?.team, 'SF');
  });

  await check('a stored id beats a name, and wins outright', () => {
    const row: PlayerAuditRow = {
      id: 'x',
      name: 'Wrong Name Entirely',
      position: 'QB',
      team: 'FA',
      espn_id: '3917315'
    };
    const match = matchPlayer(row, index);
    assert.equal(match.method, 'espn_id');
    assert.equal(match.player?.full_name, 'Kyler Murray');
  });

  await check('two different men sharing a name do not cross-match', () => {
    // Josh Allen QB (BUF) and Josh Allen DE (JAX) are both in the reference.
    const qb = matchPlayer({ id: 'a', name: 'Josh Allen', position: 'QB', team: 'BUF' }, index);
    assert.equal(qb.player?.team, 'BUF');
    // A position with no compatible reference row must not silently take the DE.
    const kicker = matchPlayer({ id: 'b', name: 'Josh Allen', position: 'K', team: 'FA' }, index);
    assert.equal(kicker.player, null);
    assert.equal(kicker.method, 'unmatched');
  });

  await check('a defense is matched on its franchise, not as a person', () => {
    const row = DB_ROWS.find((candidate) => candidate.id === 'p-0200') as PlayerAuditRow;
    const match = matchPlayer(row, index);
    assert.equal(match.method, 'defense_team');
    assert.equal(match.player, null);
  });

  await check('a player the reference does not carry reads as unmatched', () => {
    const row = DB_ROWS.find((candidate) => candidate.id === 'p-0997') as PlayerAuditRow;
    assert.equal(matchPlayer(row, index).method, 'unmatched');
  });
}

/* ------------------------------------------------------------- phase: plan -- */

async function phasePlan(): Promise<void> {
  phase('The change plan — what the audit will and will not write');

  const dataset = await loadReference();
  const index = buildReferenceIndex(dataset.players);
  const report = reconcilePlayers(DB_ROWS, index);
  const find = (id: string) => report.changes.find((change) => change.id === id);

  await check('a moved player is reassigned, on both rows for him', () => {
    const local = find('p-0007');
    assert.equal(local?.after.team, 'MIN');
    assert.equal(local?.before.team, 'ARI');
    const provider = find('tank01-3917315');
    assert.equal(provider?.after.team, 'MIN');
    // …and the numeric code it was carrying is gone.
    assert.equal(provider?.before.team, '21');
  });

  await check('a suffix-mismatched player is reassigned (Deebo Samuel -> SF)', () => {
    const change = find('p-0123');
    assert.equal(change?.before.team, 'WAS');
    assert.equal(change?.after.team, 'SF');
    assert.equal(change?.match, 'name_position');
  });

  await check("a non-canonical code is normalized ('LA' -> LAR)", () => {
    const change = find('p-0999');
    assert.equal(change?.after.team, 'LAR');
    assert.ok(report.counts.normalizedTeamCodes >= 1);
  });

  await check('a released player keeps his team, and is flagged', () => {
    const change = find('p-0076');
    assert.ok(!change?.fields.includes('team'), 'a CUT player must not be reassigned');
    assert.ok(
      change?.notes.some((note) => note.includes('off a roster')),
      `expected an off-roster note, got ${JSON.stringify(change?.notes)}`
    );
  });

  await check('identifiers are filled from the reference', () => {
    const change = find('p-0007');
    assert.equal(change?.after.espn_id, '3917315');
    assert.equal(change?.after.sleeper_id, '5849');
    assert.equal(change?.after.gsis_id, '00-0035228');
    assert.equal(change?.after.rotowire_id, '13613');
  });

  await check('a conflicting identifier is reported, never overwritten', () => {
    const rows: PlayerAuditRow[] = [
      { id: 'p-0007', name: 'Kyler Murray', position: 'QB', team: 'MIN', espn_id: '3917315', sleeper_id: '9999' }
    ];
    const change = reconcilePlayer(rows[0], index);
    assert.ok(!change.fields.includes('sleeper_id'), 'a conflicting id must not be written');
    assert.ok(change.notes.some((note) => note.includes('sleeper_id conflict')));
    assert.equal(reconcilePlayers(rows, index).counts.conflicts, 1);
  });

  await check('headshots: ESPN combiner for a player, team logo for a defense', () => {
    assert.equal(
      find('p-0007')?.after.headshot_url,
      'https://a.espncdn.com/combiner/i?img=/i/headshots/nfl/players/full/3917315.png'
    );
    assert.equal(
      find('p-0200')?.after.headshot_url,
      'https://a.espncdn.com/i/teamlogos/nfl/500/min.png'
    );
    assert.equal(find('p-0206')?.after.headshot_url, 'https://a.espncdn.com/i/teamlogos/nfl/500/sf.png');
  });

  await check('an existing headshot is left alone unless --refresh-headshots', () => {
    const row: PlayerAuditRow = {
      id: 'p-0007',
      name: 'Kyler Murray',
      position: 'QB',
      team: 'MIN',
      espn_id: '3917315',
      headshot_url: 'https://example.test/old.png'
    };
    assert.ok(!reconcilePlayer(row, index).fields.includes('headshot_url'));
    assert.ok(reconcilePlayer(row, index, { refreshHeadshots: true }).fields.includes('headshot_url'));
  });

  await check('an already-correct row produces no change at all', () => {
    const row: PlayerAuditRow = {
      id: 'clean',
      name: 'Josh Allen',
      position: 'QB',
      team: 'BUF',
      espn_id: '3918298',
      sleeper_id: '4984',
      gsis_id: '00-0034857',
      rotowire_id: '12508',
      headshot_url: 'https://a.espncdn.com/combiner/i?img=/i/headshots/nfl/players/full/3918298.png'
    };
    assert.deepEqual(reconcilePlayer(row, index).fields, []);
  });

  await check('--only=teams and --only=headshots each touch one column', () => {
    const teamsOnly = reconcilePlayers(DB_ROWS, index, { skipHeadshots: true });
    assert.equal(teamsOnly.counts.headshots, 0);
    assert.ok(teamsOnly.counts.teams > 0);
    const headshotsOnly = reconcilePlayers(DB_ROWS, index, { skipTeams: true });
    assert.equal(headshotsOnly.counts.teams, 0);
    assert.ok(headshotsOnly.counts.headshots > 0);
  });

  await check('the write payload carries only the columns that changed', () => {
    const payload = toUpdatePayload(report.changes);
    const murray = payload.find((row) => row.id === 'p-0007');
    assert.ok(murray);
    assert.deepEqual(Object.keys(murray).sort(), [
      'espn_id',
      'gsis_id',
      'headshot_url',
      'id',
      'rotowire_id',
      'sleeper_id',
      'team'
    ]);
    const ford = payload.find((row) => row.id === 'p-0076');
    assert.ok(ford && !Object.hasOwn(ford, 'team'), 'the CUT player must carry no team');
  });

  await check('re-running the audit over its own output is a no-op', () => {
    const applied: PlayerAuditRow[] = DB_ROWS.map((row) => {
      const change = report.changes.find((candidate) => candidate.id === row.id);
      return change ? ({ ...row, ...change.after } as PlayerAuditRow) : row;
    });
    const second = reconcilePlayers(applied, index);
    assert.equal(
      second.changes.length,
      0,
      `second pass still wants to change: ${JSON.stringify(second.changes.map((c) => [c.id, c.fields]))}`
    );
  });
}

/* ------------------------------------------------------ phase: static pool -- */

async function phaseStaticPool(): Promise<void> {
  phase('js/playerData.js — the file that re-seeds the table');

  await check('only the team field of a matched tuple is rewritten', () => {
    const source = [
      'export const RAW_PLAYERS = [',
      "  ['Kyler Murray', 'QB', 'ARI', 335],",
      "  ['Deebo Samuel', 'WR', 'WAS', 180],",
      "  ['Josh Allen', 'QB', 'BUF', 385],",
      "  ['Vikings D/ST', 'DST', 'MIN', 130]",
      '];'
    ].join('\n');
    const teams = new Map([
      ['kylermurray|QB', 'MIN'],
      ['deebosamuel|WR', 'SF'],
      ['joshallen|QB', 'BUF'],
      ['vikingsdst|DST', 'MIN']
    ]);
    const { text, changed } = rewriteStaticPool(source, teams);
    assert.equal(changed.length, 2);
    assert.ok(text.includes("['Kyler Murray', 'QB', 'MIN', 335],"));
    assert.ok(text.includes("['Deebo Samuel', 'WR', 'SF', 180],"));
    // Untouched rows stay byte-identical, projections included.
    assert.ok(text.includes("['Josh Allen', 'QB', 'BUF', 385],"));
    assert.ok(text.includes("['Vikings D/ST', 'DST', 'MIN', 130]"));
  });

  await check('a double-quoted name is rewritten too', () => {
    // The pool switches quote style for a name containing an apostrophe, so the
    // rewrite has to match on whichever quote the line opened with.
    const source = "  [\"Wan'Dale Robinson\", 'WR', 'NYG', 142],";
    const { text, changed } = rewriteStaticPool(source, new Map([["wandalerobinson|WR", 'TEN']]));
    assert.equal(changed.length, 1);
    assert.equal(text, "  [\"Wan'Dale Robinson\", 'WR', 'TEN', 142],");
  });

  await check('a name the audit did not resolve is left exactly as it was', () => {
    const source = "  ['Nobody Known', 'WR', 'XYZ', 10],";
    const { text, changed } = rewriteStaticPool(source, new Map());
    assert.equal(changed.length, 0);
    assert.equal(text, source);
  });

  await check('the real js/playerData.js parses to the tuples we expect', async () => {
    // The browser module is plain JS with no declaration file, hence the cast.
    const module = (await import('../js/playerData.js' as string)) as unknown as {
      RAW_PLAYERS: Array<[string, string, string, number]>;
    };
    const { RAW_PLAYERS } = module;
    assert.ok(RAW_PLAYERS.length > 100, `only ${RAW_PLAYERS.length} rows`);
    const nonCanonical = RAW_PLAYERS.filter(([, , team]) => canonicalTeam(team) !== team);
    assert.deepEqual(nonCanonical, [], 'the static pool carries a non-canonical team code');
  });
}

/* --------------------------------------------------------- phase: provider -- */

async function phaseProviderMapping(): Promise<void> {
  phase('Tank01 ingestion — a team id must never become a team code');

  /** A rosters payload whose entries identify their team only by numeric id. */
  const payload = {
    statusCode: 200,
    body: {
      '21': {
        teamID: '21',
        teamAbv: 'MIN',
        teamCity: 'Minnesota',
        teamName: 'Vikings',
        byeWeeks: { '2026': ['6'] },
        Roster: {
          '3917315': { playerID: '3917315', longName: 'Kyler Murray', pos: 'QB', teamID: '21', jerseyNum: '1' }
        }
      },
      '28': {
        teamID: '28',
        teamAbv: 'SF',
        teamCity: 'San Francisco',
        teamName: '49ers',
        byeWeeks: { '2026': ['9'] },
        Roster: {
          // `team` here is the numeric id, which is exactly what used to leak.
          '3126486': { playerID: '3126486', longName: 'Deebo Samuel Sr.', pos: 'WR', team: '28', teamID: '28' }
        }
      }
    }
  };

  const provider = createTank01Provider({
    env: { ...readEnv({}), apiKey: 'test', apiHost: 'test.local' },
    logger: silentLogger,
    http: {
      getJson: () => Promise.resolve({ status: 200, json: payload, headers: new Headers() })
    } as never
  });

  const players = await provider.fetchPlayers({
    season: 2026,
    seasonType: 'reg',
    scoringFormat: 'ppr'
  });

  await check('a roster entry whose only team field is numeric resolves to the franchise', () => {
    const deebo = players.find((player) => player.external_id === '3126486');
    assert.equal(deebo?.team, 'SF', `got ${deebo?.team}`);
    const murray = players.find((player) => player.external_id === '3917315');
    assert.equal(murray?.team, 'MIN');
  });

  await check('no mapped player carries a numeric team code', () => {
    for (const player of players) {
      assert.ok(
        canonicalTeam(player.team) === player.team || player.team === 'FA',
        `${player.name} mapped to a non-franchise team "${player.team}"`
      );
    }
  });

  await check("the provider carries the ESPN id through (Tank01's playerID)", () => {
    const murray = players.find((player) => player.external_id === '3917315');
    assert.equal(murray?.espn_id, '3917315');
    assert.equal(
      murray?.headshot_url,
      'https://a.espncdn.com/combiner/i?img=/i/headshots/nfl/players/full/3917315.png'
    );
  });

  await check('the recorded fixture still maps to canonical franchises', async () => {
    const { resolveProvider } = await import('../lib/services/providers/index.ts');
    const fixture = resolveProvider({
      env: { ...readEnv({}), provider: 'fixture' },
      logger: silentLogger
    });
    const rows = await fixture.fetchPlayers({ season: 2026, seasonType: 'reg', scoringFormat: 'ppr' });
    assert.ok(rows.length > 0, 'the fixture provider mapped no players');
    const bad = rows.filter((row) => canonicalTeam(row.team) !== row.team);
    assert.deepEqual(
      bad.map((row) => [row.name, row.team]),
      [],
      'a fixture player mapped to a non-canonical team'
    );
  });
}

/* ------------------------------------------------------------- phase: live -- */

async function phaseLive(): Promise<void> {
  phase('Live database (opt-in)');

  const wantsLive = process.argv.includes('--live') || process.env.AUDIT_TEST_LIVE === '1';
  const env = readEnv();

  await check('the audit RPCs answer', async () => {
    if (!wantsLive) throw new SkipCheck('set AUDIT_TEST_LIVE=1 (or --live) to run');
    if (env.supabaseKeySource !== 'secret') throw new SkipCheck('no SUPABASE_SERVICE_ROLE_KEY');

    const repository = createSupabaseSyncRepository({
      url: env.supabaseUrl,
      key: env.supabaseKey,
      provider: env.provider,
      logger: silentLogger
    });

    const rows = (await repository.playersAuditSnapshot?.(5)) ?? [];
    assert.ok(rows.length > 0, 'fsnv2_players_audit_snapshot returned nothing');
    assert.ok(rows[0].id && rows[0].name, 'a snapshot row is missing id/name');

    // A dry run must write nothing, so this is safe against production.
    const preview = await repository.applyPlayerAudit?.(
      [{ id: rows[0].id, team: rows[0].team ?? 'FA' }],
      true
    );
    assert.equal(preview?.dry_run, true);
  });

  await check('the standing audit status view answers', async () => {
    if (!wantsLive) throw new SkipCheck('set AUDIT_TEST_LIVE=1 (or --live) to run');
    if (!env.supabaseKey) throw new SkipCheck('no Supabase key');
    const repository = createSupabaseSyncRepository({
      url: env.supabaseUrl,
      key: env.supabaseKey,
      provider: env.provider,
      logger: silentLogger
    });
    const status = (await repository.auditStatus?.()) as Record<string, unknown>;
    assert.ok(status && typeof status.players === 'number', 'no player count came back');
  });
}

/* ----------------------------------------------------------------- report -- */

async function main(): Promise<number> {
  process.stdout.write('\u001b[1mFSN v2 — player audit verification\u001b[0m\n');

  await phaseTeams();
  await phaseCsv();
  await phaseReference();
  await phaseNames();
  await phaseMatching();
  await phasePlan();
  await phaseStaticPool();
  await phaseProviderMapping();
  await phaseLive();

  const failed = results.filter((result) => !result.ok);
  const skipped = results.filter((result) => result.skipped);
  process.stdout.write(
    `\n\u001b[1m${results.length - failed.length - skipped.length}/${results.length - skipped.length} passed\u001b[0m` +
      (skipped.length ? ` \u001b[33m(${skipped.length} skipped)\u001b[0m` : '') +
      (failed.length ? ` — \u001b[31m${failed.length} failed\u001b[0m\n` : '\n')
  );
  return failed.length ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error: Error) => {
    process.stderr.write(`\u001b[31m${error.stack ?? error.message}\u001b[0m\n`);
    process.exit(1);
  });
