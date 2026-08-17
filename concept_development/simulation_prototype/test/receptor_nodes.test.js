// receptor_nodes.test.js — pins receptor node positions to the live midpoint of the
// two receptor tips that define them, for as long as the membrane keeps moving.
//
// Run:  node test/receptor_nodes.test.js    (from concept_development/simulation_prototype)
//
// Loads the real Cell.js and Receptor.js headlessly. The only p5 globals they need off
// the render path are noise(), map() and TWO_PI, stubbed below.
//
// The noise stub is NOT p5's Perlin, but that does not weaken these tests: every
// assertion here is an exact identity (node position == midpoint of its two tips, pair
// identities unchanged), which holds for any membrane shape. Only the drift magnitudes
// printed at the end are noise-dependent, and they are reported, not asserted.

const assert = require('node:assert');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'src');

// --- p5 stubs -----------------------------------------------------------------------
global.window = global;
global.TWO_PI = Math.PI * 2;
global.map = (v, a, b, c, d) => c + ((v - a) / (b - a)) * (d - c);

const hash2 = (x, y) => {
  let h = (x | 0) * 374761393 + (y | 0) * 668265263;
  h = (h ^ (h >> 13)) * 1274126177;
  return ((h ^ (h >> 16)) >>> 0) / 4294967295;
};
const smooth = t => t * t * (3 - 2 * t);
global.noise = (x, y = 0) => {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const sx = smooth(xf), sy = smooth(yf);
  const v00 = hash2(xi, yi), v10 = hash2(xi + 1, yi);
  const v01 = hash2(xi, yi + 1), v11 = hash2(xi + 1, yi + 1);
  return (v00 * (1 - sx) + v10 * sx) * (1 - sy) + (v01 * (1 - sx) + v11 * sx) * sy;
};
global.colorForIndex = () => 0;   // render-only

require(path.join(SRC, 'constants.js'));
require(path.join(SRC, 'Receptor.js'));
require(path.join(SRC, 'Cell.js'));

const { Cell, PHYSICS_DEFAULTS, TISSUE_COLORS } = global;
const MATCH_RADIUS = PHYSICS_DEFAULTS.particleSpriteSize * 0.6;
const CONC = [0.5, 0.5, 0.5, 0.5, 0.5, 0.5];   // 60 receptors

const midX = n => (n.receptor1.tipX + n.receptor2.tipX) / 2;
const midY = n => (n.receptor1.tipY + n.receptor2.tipY) / 2;

function makeCell({ baseRadius = 40, isTumor = false, seed = 0.37 } = {}) {
  return new Cell(400, 300, baseRadius, seed, CONC, isTumor, TISSUE_COLORS.default);
}

// Advance the membrane, optionally battering it with particle impacts the way
// Simulation does on every deflection.
function advance(cell, frames, { impacts = false } = {}) {
  for (let f = 1; f <= frames; f++) {
    cell.update(PHYSICS_DEFAULTS, f, null);
    if (impacts && f % 4 === 0) {
      const a = (f * 0.7) % (Math.PI * 2);
      cell.applyImpulse(
        cell.cx + Math.cos(a) * cell.radius,
        cell.cy + Math.sin(a) * cell.radius,
        Math.cos(a) * 0.9, Math.sin(a) * 0.9
      );
    }
  }
}

function worstOffset(cell) {
  let worst = 0;
  for (const n of cell.receptorNodes) {
    worst = Math.max(worst, Math.hypot(n.x - midX(n), n.y - midY(n)));
  }
  return worst;
}

// Identity of a node in terms of WHICH receptors it joins, order significant
function pairKeys(cell) {
  const idx = new Map(cell.receptors.map((r, i) => [r, i]));
  return new Set(cell.receptorNodes.map(n => `${idx.get(n.receptor1)}>${idx.get(n.receptor2)}`));
}

// Shortest/longest membrane edge. Heads toward 0 as the polygon degenerates, which the
// stub noise can provoke at tumorNoiseAmplitude on a small radius. Real Perlin may not,
// so tests guard on this rather than asserting against collapsed geometry.
function edgeRatio(shape) {
  let min = Infinity, max = 0;
  for (let i = 0; i < shape.length; i++) {
    const j = (i + 1) % shape.length;
    const d = Math.hypot(shape[j].x - shape[i].x, shape[j].y - shape[i].y);
    min = Math.min(min, d); max = Math.max(max, d);
  }
  return min / max;
}
const DEGENERATE = 0.15;

const EPS = 1e-9;
const results = [];
function test(name, fn) {
  try { fn(); results.push({ name, ok: true }); }
  catch (err) { results.push({ name, ok: false, err }); }
}

// ====================================================================================

test('nodes start at their tip midpoints', () => {
  const cell = makeCell();
  assert.ok(cell.receptorNodes.length > 0, 'expected some receptor nodes');
  assert.ok(worstOffset(cell) < EPS, `offset at construction was ${worstOffset(cell)}`);
});

test('nodes still track their tip midpoints after the membrane relaxes', () => {
  const cell = makeCell();
  advance(cell, 900);
  const off = worstOffset(cell);
  assert.ok(off < EPS, `node drifted ${off.toFixed(3)}px from its tip midpoint`);
});

test('nodes track through particle impacts', () => {
  const cell = makeCell({ baseRadius: 90 });
  advance(cell, 600, { impacts: true });
  const off = worstOffset(cell);
  assert.ok(off < EPS, `node drifted ${off.toFixed(3)}px under impacts`);
});

test('nodes track on tumor cells (high noise amplitude)', () => {
  const cell = makeCell({ baseRadius: 90, isTumor: true });
  advance(cell, 900);
  const off = worstOffset(cell);
  assert.ok(off < EPS, `node drifted ${off.toFixed(3)}px on a tumor cell`);
});

test('refresh moves nodes by a distance that actually mattered', () => {
  // Guards against the test passing trivially because nothing moves: confirm the
  // membrane really does travel far enough for the stale cache to have been wrong.
  const cell = makeCell();
  const cached = cell.receptorNodes.map(n => ({ x: n.x, y: n.y }));
  advance(cell, 900);
  let worst = 0;
  for (let i = 0; i < cell.receptorNodes.length; i++) {
    const n = cell.receptorNodes[i];
    worst = Math.max(worst, Math.hypot(n.x - cached[i].x, n.y - cached[i].y));
  }
  assert.ok(worst > 1, `membrane barely moved (${worst.toFixed(2)}px) — test proves little`);
});

test('refresh touches only x/y, never pair identity or receptor links', () => {
  const cell = makeCell();
  const before = cell.receptorNodes.map(n => ({
    pairId: n.pairId, r1: n.receptor1, r2: n.receptor2, bound: n.bound
  }));
  advance(cell, 600, { impacts: true });
  cell.receptorNodes.forEach((n, i) => {
    assert.strictEqual(n.pairId, before[i].pairId, `pairId changed at node ${i}`);
    assert.strictEqual(n.receptor1, before[i].r1, `receptor1 changed at node ${i}`);
    assert.strictEqual(n.receptor2, before[i].r2, `receptor2 changed at node ${i}`);
    assert.strictEqual(n.bound, before[i].bound, `bound changed at node ${i}`);
  });
});

test('caching pairId is safe: angular sort order survives deformation', () => {
  // updateReceptorNodePositions() only refreshes x/y, on the assumption that a full
  // computeReceptorNodes() would still pair the same receptors. Tips sway independently,
  // so this is an empirical property of the current spacing-vs-sway ratio, not a
  // guarantee — if tuning ever packs receptors tighter or raises sway, this fails.
  for (const opts of [{ baseRadius: 40 }, { baseRadius: 65, isTumor: true },
                      { baseRadius: 90, isTumor: true }, { baseRadius: 130, isTumor: true }]) {
    const cell = makeCell(opts);
    const before = pairKeys(cell);
    advance(cell, 1200, { impacts: true });

    if (edgeRatio(cell.shape) < DEGENERATE) continue;   // stub-noise collapse, not a real shape

    cell.computeReceptorNodes();        // rebuild from scratch at the deformed shape
    const after = pairKeys(cell);

    assert.strictEqual(after.size, before.size, `node count changed at r${opts.baseRadius}`);
    for (const key of before) {
      assert.ok(after.has(key),
        `pairing ${key} lost at baseRadius ${opts.baseRadius} — sort order is NOT stable`);
    }
  }
});

test('a rebuilt node set lands where the incremental refresh already had it', () => {
  const cell = makeCell({ baseRadius: 90, isTumor: true });
  advance(cell, 900, { impacts: true });
  assert.ok(edgeRatio(cell.shape) >= DEGENERATE, 'geometry collapsed; test inconclusive');

  // Match by which receptors a node joins, not by array index: computeReceptorNodes
  // sorts by atan2, so the rebuilt array can come back cyclically rotated when
  // deformation changes which receptor holds the minimum angle.
  const idx = new Map(cell.receptors.map((r, i) => [r, i]));
  const key = n => `${idx.get(n.receptor1)}>${idx.get(n.receptor2)}`;
  const incremental = new Map(
    cell.receptorNodes.map(n => [key(n), { x: n.x, y: n.y, pairId: n.pairId }])
  );

  cell.computeReceptorNodes();

  assert.strictEqual(cell.receptorNodes.length, incremental.size, 'node count changed');
  for (const n of cell.receptorNodes) {
    const was = incremental.get(key(n));
    assert.ok(was, `rebuild produced an unexpected pairing ${key(n)}`);
    assert.ok(Math.hypot(n.x - was.x, n.y - was.y) < EPS,
      `rebuild disagreed with incremental refresh at ${key(n)}`);
    assert.strictEqual(n.pairId, was.pairId);
  }
});

test('degenerate geometry is the only case that reorders receptors', () => {
  // Documents the boundary found while building this: pairings only went stale on a
  // membrane collapsed to minEdge/maxEdge ~0.1. If a healthy cell ever reorders, the
  // assumption above is wrong for a reason other than stub noise and needs revisiting.
  const cell = makeCell({ baseRadius: 40, isTumor: true });
  const before = pairKeys(cell);
  advance(cell, 1200, { impacts: true });
  const ratio = edgeRatio(cell.shape);

  cell.computeReceptorNodes();
  const after = pairKeys(cell);
  let lost = 0;
  for (const key of before) if (!after.has(key)) lost++;

  if (lost > 0) {
    assert.ok(ratio < DEGENERATE,
      `healthy cell (edgeRatio ${ratio.toFixed(3)}) reordered ${lost} pairings`);
  }
});

// --- Report -------------------------------------------------------------------------

let failed = 0;
for (const r of results) {
  if (r.ok) console.log(`  PASS  ${r.name}`);
  else { failed++; console.log(`  FAIL  ${r.name}`); console.log(`        ${r.err.message}`); }
}
console.log(`\n${results.length - failed}/${results.length} passed`);

// Informational only — magnitudes depend on the noise stub, so nothing asserts on them.
console.log(`\nHow far the cached positions would have been wrong (matchRadius ${MATCH_RADIUS}px):`);
console.log('  cell                 max offset from construction cache');
for (const [label, opts] of [
  ['normal r36        ', { baseRadius: 40 }],
  ['normal r81        ', { baseRadius: 90 }],
  ['tumor  r81        ', { baseRadius: 90, isTumor: true }],
  ['normal r81 impacts', { baseRadius: 90, impacts: true }]
]) {
  const cell = makeCell(opts);
  const cached = cell.receptorNodes.map(n => ({ x: n.x, y: n.y }));
  advance(cell, 900, { impacts: !!opts.impacts });
  let worst = 0;
  for (let i = 0; i < cell.receptorNodes.length; i++) {
    const n = cell.receptorNodes[i];
    worst = Math.max(worst, Math.hypot(n.x - cached[i].x, n.y - cached[i].y));
  }
  console.log(`  ${label}   ${worst.toFixed(1).padStart(5)} px` +
              `  (${((worst / MATCH_RADIUS) * 100).toFixed(0)}% of matchRadius)`);
}

process.exit(failed === 0 ? 0 : 1);
