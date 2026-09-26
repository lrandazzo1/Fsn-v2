/**
 * Terminal test-suite for the player-imagery pipeline.
 *   node tests/player-assets.test.mjs
 *
 * Covers the three seams the headshots travel through: the row transform
 * (`headshot_url` -> `headshotUrl`, either spelling accepted), the merge onto the
 * draft pool (by id, then by name + position, and surviving a reset), and the
 * avatar markup with its fallback cascade.
 */

import assert from 'node:assert/strict';
import { DraftEngine } from '../js/draftEngine.js';
import { loadPlayers } from '../js/playerData.js';
import {
  applyPlayerAssets,
  avatarInitials,
  avatarSources,
  emptyPlayerAssets,
  espnHeadshotUrl,
  headshotUrlFor,
  indexPlayerAssets,
  normalizeAssetRow,
  playerMatchKey,
  playerNameKey
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

/** A scheduler that never fires on its own. */
const manualScheduler = { setInterval: () => 1, clearInterval: () => {} };

const LAMAR_HEADSHOT = 'https://a.espncdn.com/combiner/i?img=/i/headshots/nfl/players/full/3916387.png';
const BAL_LOGO = 'https://a.espncdn.com/i/teamlogos/nfl/500/bal.png';

console.log('\n\u001b[1mFSN v2 — player assets\u001b[0m\n');

/* ------------------------------------------------------ the row transform -- */

test('normalizeAssetRow reads the database spelling', () => {
  const asset = normalizeAssetRow({
    id: 'p-0001',
    name: 'Lamar Jackson',
    position: 'qb',
    team: 'bal',
    headshot_url: LAMAR_HEADSHOT,
    espn_id: '3916387'
  });

  assert.deepEqual(asset, {
    id: 'p-0001',
    name: 'Lamar Jackson',
    position: 'QB',
    team: 'BAL',
    headshotUrl: LAMAR_HEADSHOT,
    espnId: '3916387'
  });
});

test('normalizeAssetRow reads the camelCase spelling too', () => {
  const asset = normalizeAssetRow({ id: 'x', name: 'A B', headshotUrl: LAMAR_HEADSHOT, espnId: '1' });
  assert.equal(asset.headshotUrl, LAMAR_HEADSHOT);
  assert.equal(asset.espnId, '1');
});

test('normalizeAssetRow derives the headshot from an espn id when the column is null', () => {
  const asset = normalizeAssetRow({ id: 'p-0001', name: 'Lamar Jackson', headshot_url: null, espn_id: 3916387 });
  assert.equal(asset.headshotUrl, LAMAR_HEADSHOT);
});

test('normalizeAssetRow refuses a non-http src', () => {
  const asset = normalizeAssetRow({ id: 'p-0001', name: 'X', headshot_url: 'javascript:alert(1)' });
  assert.equal(asset.headshotUrl, null);
});

test('normalizeAssetRow treats empty and "null" strings as absent', () => {
  const asset = normalizeAssetRow({ id: 'p-0001', name: 'X', headshot_url: '', espn_id: 'null' });
  assert.equal(asset.headshotUrl, null);
  assert.equal(asset.espnId, null);
});

test('espnHeadshotUrl only trusts a numeric id', () => {
  assert.equal(espnHeadshotUrl('3916387'), LAMAR_HEADSHOT);
  assert.equal(espnHeadshotUrl('abc'), null);
  assert.equal(espnHeadshotUrl(null), null);
});

test('playerNameKey mirrors public.fsnv2_player_key()', () => {
  assert.equal(playerNameKey("Ja'Marr Chase"), 'jamarrchase');
  assert.equal(playerNameKey('Brian Robinson Jr.'), 'brianrobinsonjr');
  assert.equal(playerMatchKey('Lamar Jackson', 'qb'), 'lamarjackson|QB');
  assert.equal(playerMatchKey('', 'QB'), null);
});

/* ------------------------------------------------------------- the index -- */

test('indexPlayerAssets prefers the row that actually has a headshot', () => {
  const index = indexPlayerAssets([
    { id: 'p-0001', name: 'Lamar Jackson', position: 'QB', team: 'BAL', headshot_url: null },
    { id: 'tank01-3916387', name: 'Lamar Jackson', position: 'QB', team: 'BAL', headshot_url: LAMAR_HEADSHOT }
  ]);

  assert.equal(index.byKey.get('lamarjackson|QB').headshotUrl, LAMAR_HEADSHOT);
  assert.equal(index.byId.get('p-0001').headshotUrl, null);
});

test('indexPlayerAssets survives junk input', () => {
  assert.equal(indexPlayerAssets(null).size, 0);
  assert.equal(indexPlayerAssets([null, 42, {}, { name: '' }]).size, 0);
});

/* ------------------------------------------------------------- the merge -- */

test('applyPlayerAssets matches on the pool id', () => {
  const players = { 'p-0001': { id: 'p-0001', name: 'Lamar Jackson', position: 'QB', team: 'BAL', headshotUrl: null } };
  const matched = applyPlayerAssets(
    players,
    indexPlayerAssets([{ id: 'p-0001', name: 'Lamar Jackson', position: 'QB', headshot_url: LAMAR_HEADSHOT }])
  );

  assert.equal(matched, 1);
  assert.equal(players['p-0001'].headshotUrl, LAMAR_HEADSHOT);
});

test('applyPlayerAssets falls back to name + position for provider-keyed rows', () => {
  const players = { 'p-0001': { id: 'p-0001', name: 'Lamar Jackson', position: 'QB', team: 'BAL', headshotUrl: null } };
  const matched = applyPlayerAssets(
    players,
    indexPlayerAssets([
      { id: 'tank01-3916387', name: 'Lamar Jackson', position: 'QB', headshot_url: LAMAR_HEADSHOT, espn_id: '3916387' }
    ])
  );

  assert.equal(matched, 1);
  assert.equal(players['p-0001'].headshotUrl, LAMAR_HEADSHOT);
  assert.equal(players['p-0001'].espnId, '3916387');
});

test('applyPlayerAssets never blanks a headshot that is already on screen', () => {
  const players = { 'p-0001': { id: 'p-0001', name: 'Lamar Jackson', position: 'QB', headshotUrl: LAMAR_HEADSHOT } };
  const matched = applyPlayerAssets(
    players,
    indexPlayerAssets([{ id: 'p-0001', name: 'Lamar Jackson', position: 'QB', headshot_url: null }])
  );

  assert.equal(matched, 0);
  assert.equal(players['p-0001'].headshotUrl, LAMAR_HEADSHOT);
});

test('a position change stops a name-only match', () => {
  const players = { 'p-0001': { id: 'p-0001', name: 'Lamar Jackson', position: 'QB', headshotUrl: null } };
  applyPlayerAssets(players, indexPlayerAssets([{ id: 'other', name: 'Lamar Jackson', position: 'WR', headshot_url: LAMAR_HEADSHOT }]));
  assert.equal(players['p-0001'].headshotUrl, null);
});

/* ------------------------------------------------------------- the engine -- */

test('loadPlayers declares the imagery fields', () => {
  const player = loadPlayers()[1];
  assert.equal(player.name, 'Lamar Jackson');
  assert.equal(player.headshotUrl, null);
  assert.equal(player.espnId, null);
});

test('setPlayerAssets merges into the live pool and reports the count', () => {
  const engine = new DraftEngine({ scheduler: manualScheduler });
  const matched = engine.setPlayerAssets(
    indexPlayerAssets([{ id: 'p-0001', name: 'Lamar Jackson', position: 'QB', headshot_url: LAMAR_HEADSHOT }])
  );

  assert.equal(matched, 1);
  assert.equal(engine.playersById['p-0001'].headshotUrl, LAMAR_HEADSHOT);
});

test('reset() rebuilds the pool without losing the headshots', () => {
  const engine = new DraftEngine({ scheduler: manualScheduler });
  engine.setPlayerAssets(
    indexPlayerAssets([{ id: 'p-0001', name: 'Lamar Jackson', position: 'QB', headshot_url: LAMAR_HEADSHOT }])
  );
  engine.reset();

  assert.equal(engine.playersById['p-0001'].headshotUrl, LAMAR_HEADSHOT);
});

test('setPlayerAssets(null) is a no-op, not a crash', () => {
  const engine = new DraftEngine({ scheduler: manualScheduler });
  assert.equal(engine.setPlayerAssets(null), 0);
  assert.equal(engine.playerAssets.size, emptyPlayerAssets().size);
});

/* ------------------------------------------------------------- the avatar -- */

test('avatarSources cascades headshot -> team logo', () => {
  const sources = avatarSources({ name: 'Lamar Jackson', position: 'QB', team: 'BAL', headshotUrl: LAMAR_HEADSHOT });
  assert.equal(sources.src, LAMAR_HEADSHOT);
  assert.equal(sources.fallback, BAL_LOGO);
  assert.equal(sources.teamLogo, BAL_LOGO);
  assert.equal(sources.initials, 'LJ');
  assert.equal(sources.isHeadshot, true);
});

test('avatarSources uses the team logo as the image when there is no headshot', () => {
  const sources = avatarSources({ name: 'Hollywood Brown', position: 'WR', team: 'PHI' });
  assert.equal(sources.src, 'https://a.espncdn.com/i/teamlogos/nfl/500/phi.png');
  assert.equal(sources.fallback, null, 'nothing left to hop to — the initials chip takes over');
  assert.equal(sources.teamLogo, null, 'no corner logo on top of a logo');
  assert.equal(sources.initials, 'HB');
});

test('a D/ST keeps its logo and skips the corner overlay', () => {
  const sources = avatarSources({ name: 'Ravens D/ST', position: 'DST', team: 'BAL', headshotUrl: BAL_LOGO });
  assert.equal(sources.src, BAL_LOGO);
  assert.equal(sources.teamLogo, null);
  assert.equal(sources.initials, 'BAL');
});

test('headshotUrlFor reads a raw database row as happily as a Player', () => {
  assert.equal(headshotUrlFor({ headshot_url: LAMAR_HEADSHOT }), LAMAR_HEADSHOT);
  assert.equal(headshotUrlFor({ espn_id: '3916387' }), LAMAR_HEADSHOT);
  assert.equal(headshotUrlFor({}), null);
  assert.equal(headshotUrlFor(null), null);
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
  assert.match(html, /player-avatar__team/);
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
  return {
    tagName: 'IMG',
    src,
    dataset: { onError: 'remove', ...(fallback ? { fallback } : {}) },
    classes: [],
    removed: false,
    classList: { add(name) { this.owner.classes.push(name); } },
    getAttribute() { return this.src; },
    remove() { this.removed = true; }
  };
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
  img.classList.owner = img;

  handler({ target: img });

  assert.equal(img.src, BAL_LOGO);
  assert.equal(img.removed, false);
  assert.equal(img.dataset.fallback, undefined, 'the hop happens once, never in a loop');
  assert.deepEqual(img.classes, ['is-fallback']);
});

test('a failed fallback removes the image and reveals the initials chip', () => {
  const handler = captureHandler();
  const img = fakeImage({ src: BAL_LOGO });
  img.classList.owner = img;

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
