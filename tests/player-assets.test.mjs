/**
 * Terminal test-suite for the player-imagery pipeline.
 *   node tests/player-assets.test.mjs
 *
 * Three seams: the transform that carries `headshot_url` off a `fsnv2.players`
 * row and onto the Player the UI renders, the avatar's fallback cascade, and
 * the delegated `onError` handler that walks it.
 */

import assert from 'node:assert/strict';
import { buildLivePool } from '../js/liveData.js';
import { loadPlayers } from '../js/playerData.js';
import {
  avatarInitials,
  avatarSources,
  espnHeadshotUrl,
  espnIdFor,
  headshotUrlFor
} from '../js/playerAssets.js';
import { installImageFallbacks, playerAvatar } from '../js/uiRenderer.js';

/* --------------------------------------------------------------- harness -- */

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
    console.log(`  \u001b[32m✓\u001b[0m ${name}`);
  } catch (error) {
    results.push({ name, ok: false, error });
    console.log(`  \u001b[31m✗\u001b[0m ${name}\n      ${error.message}`);
  }
}

const LAMAR_HEADSHOT = 'https://a.espncdn.com/combiner/i?img=/i/headshots/nfl/players/full/3916387.png';
const BAL_LOGO = 'https://a.espncdn.com/i/teamlogos/nfl/500/bal.png';

/** A `fsnv2_players` row, the shape PostgREST hands the browser. */
function row(overrides = {}) {
  return {
    id: 'p-0001',
    name: 'Lamar Jackson',
    position: 'QB',
    team: 'BAL',
    stats: { projection: 380 },
    headshot_url: LAMAR_HEADSHOT,
    espn_id: '3916387',
    ...overrides
  };
}

console.log('\n\u001b[1mFSN v2 — player headshots\u001b[0m\n');

/* ---------------------------------------------------------- the transform -- */

test('buildLivePool carries headshot_url onto the Player', () => {
  const [player] = buildLivePool([row()]);
  assert.equal(player.headshotUrl, LAMAR_HEADSHOT);
  assert.equal(player.espnId, '3916387');
});

test('buildLivePool derives the headshot from espn_id when the column is null', () => {
  const [player] = buildLivePool([row({ headshot_url: null })]);
  assert.equal(player.headshotUrl, LAMAR_HEADSHOT);
});

test('buildLivePool leaves the imagery null rather than absent', () => {
  const [player] = buildLivePool([row({ headshot_url: null, espn_id: null })]);
  assert.equal(player.headshotUrl, null);
  assert.equal(player.espnId, null);
  assert.ok('headshotUrl' in player, 'the field is declared even when empty');
});

test('buildLivePool refuses a non-http src', () => {
  const [player] = buildLivePool([row({ headshot_url: 'javascript:alert(1)', espn_id: null })]);
  assert.equal(player.headshotUrl, null);
});

test('a D/ST row keeps the team logo the audit stored for it', () => {
  const [player] = buildLivePool([
    row({ id: 'p-0196', name: 'Ravens D/ST', position: 'DST', headshot_url: BAL_LOGO, espn_id: null })
  ]);
  assert.equal(player.headshotUrl, BAL_LOGO);
});

test('loadPlayers declares the imagery fields for the offline pool', () => {
  const player = loadPlayers()[1];
  assert.equal(player.name, 'Lamar Jackson');
  assert.equal(player.headshotUrl, null);
  assert.equal(player.espnId, null);
});

test('headshotUrlFor and espnIdFor read either spelling', () => {
  assert.equal(headshotUrlFor({ headshot_url: LAMAR_HEADSHOT }), LAMAR_HEADSHOT);
  assert.equal(headshotUrlFor({ headshotUrl: LAMAR_HEADSHOT }), LAMAR_HEADSHOT);
  assert.equal(headshotUrlFor({ espn_id: '3916387' }), LAMAR_HEADSHOT);
  assert.equal(headshotUrlFor({ espnId: 3916387 }), LAMAR_HEADSHOT);
  assert.equal(headshotUrlFor({}), null);
  assert.equal(headshotUrlFor(null), null);
  assert.equal(espnIdFor({ espn_id: '3916387' }), '3916387');
  assert.equal(espnIdFor({ espn_id: 'nope' }), null);
});

test('espnHeadshotUrl only trusts a numeric id', () => {
  assert.equal(espnHeadshotUrl('3916387'), LAMAR_HEADSHOT);
  assert.equal(espnHeadshotUrl('abc'), null);
  assert.equal(espnHeadshotUrl(null), null);
});

/* ------------------------------------------------------------- the avatar -- */

test('avatarSources cascades headshot -> team logo', () => {
  const sources = avatarSources({ name: 'Lamar Jackson', position: 'QB', team: 'BAL', headshotUrl: LAMAR_HEADSHOT });
  assert.equal(sources.src, LAMAR_HEADSHOT);
  assert.equal(sources.fallback, BAL_LOGO);
  assert.equal(sources.team, 'BAL', 'the corner badge shows the club');
  assert.equal(sources.initials, 'LJ');
  assert.equal(sources.isHeadshot, true);
});

test('avatarSources uses the team logo as the image when there is no headshot', () => {
  const sources = avatarSources({ name: 'Hollywood Brown', position: 'WR', team: 'PHI' });
  assert.equal(sources.src, 'https://a.espncdn.com/i/teamlogos/nfl/500/phi.png');
  assert.equal(sources.fallback, null, 'nothing left to hop to — the initials chip takes over');
  assert.equal(sources.team, null, 'no corner badge on top of a logo');
  assert.equal(sources.initials, 'HB');
});

test('avatarSources normalises the abbreviation the badge keys on', () => {
  const sources = avatarSources({ name: 'Terry McLaurin', position: 'WR', team: 'WSH', headshotUrl: LAMAR_HEADSHOT });
  assert.equal(sources.team, 'WAS');
  assert.equal(sources.fallback, 'https://a.espncdn.com/i/teamlogos/nfl/500/wsh.png');
});

test('a D/ST keeps its logo and skips the corner badge', () => {
  const sources = avatarSources({ name: 'Ravens D/ST', position: 'DST', team: 'BAL', headshotUrl: BAL_LOGO });
  assert.equal(sources.src, BAL_LOGO);
  assert.equal(sources.team, null);
  assert.equal(sources.initials, 'BAL');
});

test('avatarInitials handles one-word and suffixed names', () => {
  assert.equal(avatarInitials({ name: 'Prince', position: 'WR' }), 'PR');
  assert.equal(avatarInitials({ name: 'Brian Robinson Jr.', position: 'RB' }), 'BJ');
  assert.equal(avatarInitials({ name: '', position: 'RB' }), '');
});

test('playerAvatar renders the img, the alt text and the fallback URL', () => {
  const html = playerAvatar({ name: 'Lamar Jackson', position: 'QB', team: 'BAL', headshotUrl: LAMAR_HEADSHOT });
  assert.match(html, /class="player-avatar player-avatar--sm has-team"/);
  assert.match(html, /alt="Lamar Jackson"/);
  assert.match(html, /data-fallback="https:\/\/a\.espncdn\.com\/i\/teamlogos\/nfl\/500\/bal\.png"/);
  assert.match(html, /data-on-error="remove"/);
  assert.match(html, /player-avatar__initials[^>]*>LJ</);
  assert.match(html, /player-avatar__team[\s\S]*class="team-logo"/, 'the corner reuses teamLogoHtml');
});

test('playerAvatar escapes the name it puts in an attribute', () => {
  const html = playerAvatar({ name: 'A" onload="x', position: 'WR', team: 'BAL', headshotUrl: LAMAR_HEADSHOT });
  assert.ok(!html.includes('" onload="'), 'the quote must not close the attribute');
  assert.match(html, /alt="A&quot; onload=&quot;x"/);
});

test('playerAvatar renders nothing for an empty slot', () => {
  assert.equal(playerAvatar(null), '');
});

/* ------------------------------------------------- the onError cascade -- */

/** A stand-in for an <img> that records what the handler did to it. */
function fakeImage({ src, fallback }) {
  const img = {
    tagName: 'IMG',
    src,
    dataset: { onError: 'remove', ...(fallback ? { fallback } : {}) },
    classes: [],
    removed: false,
    getAttribute() { return this.src; },
    remove() { this.removed = true; }
  };
  img.classList = { add: (name) => img.classes.push(name) };
  return img;
}

/** Installs the delegated handler against a fake root and returns it. */
function captureHandler() {
  let handler = null;
  installImageFallbacks({ addEventListener: (type, fn) => { if (type === 'error') handler = fn; } });
  assert.ok(handler, 'installImageFallbacks must register an error listener');
  return handler;
}

test('a failed headshot hops to the team logo', () => {
  const handler = captureHandler();
  const img = fakeImage({ src: LAMAR_HEADSHOT, fallback: BAL_LOGO });

  handler({ target: img });

  assert.equal(img.src, BAL_LOGO);
  assert.equal(img.removed, false);
  assert.equal(img.dataset.fallback, undefined, 'the hop happens once, never in a loop');
  assert.deepEqual(img.classes, ['is-fallback']);
});

test('a failed fallback removes the image and reveals the initials chip', () => {
  const handler = captureHandler();
  const img = fakeImage({ src: BAL_LOGO });

  handler({ target: img });

  assert.equal(img.removed, true);
});

test('the handler ignores anything that is not an image', () => {
  const handler = captureHandler();
  assert.doesNotThrow(() => handler({ target: { tagName: 'DIV', dataset: {} } }));
  assert.doesNotThrow(() => handler({ target: null }));
});

/* ------------------------------------------------------------------ report */

const failed = results.filter((r) => !r.ok);
console.log(
  `\n\u001b[1m${results.length - failed.length}/${results.length} passed\u001b[0m` +
    (failed.length ? ` — \u001b[31m${failed.length} failed\u001b[0m\n` : '\n')
);
process.exit(failed.length ? 1 : 0);
