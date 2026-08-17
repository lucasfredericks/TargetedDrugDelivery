// binding_logic.test.js — headless regression tests for node-based binding.
//
// Run:  node test/binding_logic.test.js     (from concept_development/simulation_prototype)
//
// No dependencies and no browser. BindingLogic.js is a plain script whose only tie to
// the browser is the window.* export block at the bottom, so pointing `window` at
// `global` before requiring it publishes its functions as globals.
//
// These tests pin the invariant that receptors are a finite resource: adjacent receptor
// nodes SHARE a receptor, so claiming one node must take its neighbours out of play.
// Before that fix a second particle could bind a neighbouring node whose receptors were
// already latched or refractory, spending the same receptor twice and overwriting its
// latched ligand colour.

const assert = require('node:assert');
const path = require('node:path');

global.window = global;
require(path.join(__dirname, '..', 'src', 'BindingLogic.js'));

const { attemptNodeBinding, isCellNodeAvailable, getParticleNodes } = global;

// --- Geometry constants, chosen so the leading edge is predictable -------------------
// Particle sits at the origin facing a cell to its right, so the collision direction is
// +x. With angle = PI/2 the six vertex nodes land at 0, 60, ... 300 degrees, which puts
// nodes 5, 0 and 1 inside the +/-60 degree leading-edge cone.

const SPRITE = 20;
const HEX_R = SPRITE * 0.35;          // 7 — vertex distance from particle centre
const MATCH_RADIUS = SPRITE * 0.6;    // 12 — must agree with attemptNodeBinding

const PARTICLE = { x: 0, y: 0, angle: Math.PI / 2 };
const CELL_CENTRE = { cx: 100, cy: 0 };

// Node k of the particle, in world space (mirrors getParticleNodes)
function particleNodeXY(k) {
  const a = PARTICLE.angle + (-Math.PI / 2 + k * Math.PI / 3);
  return { x: PARTICLE.x + Math.cos(a) * HEX_R, y: PARTICLE.y + Math.sin(a) * HEX_R };
}

// --- Builders -----------------------------------------------------------------------

function makeReceptor(color, state = {}) {
  return {
    color,
    bound: false,
    latched: false,
    refractory: false,
    latchedLigandColor: -1,
    tipX: 0,
    tipY: 0,
    ...state
  };
}

// Mirrors Cell.computeReceptorNodes: pair identity is ordered (r1.color, r2.color)
function makeCellNode(x, y, r1, r2, state = {}) {
  return {
    x,
    y,
    pairId: `${r1.color}-${r2.color}`,
    bound: false,
    receptor1: r1,
    receptor2: r2,
    ...state
  };
}

function makeCell(receptorNodes) {
  return { ...CELL_CENTRE, receptorNodes };
}

// Place a cell node right on top of particle node k so it is comfortably in range
function atParticleNode(k, r1, r2, state) {
  const p = particleNodeXY(k);
  return makeCellNode(p.x + 2, p.y, r1, r2, state);
}

// --- Test runner --------------------------------------------------------------------

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err });
  }
}

// ====================================================================================
// Sanity: the leading edge is where we think it is
// ====================================================================================

test('leading edge contains particle nodes 5, 0, 1', () => {
  const ligands = [0, 1, 2, 3, 4, 5];
  const nodes = getParticleNodes(PARTICLE, SPRITE, ligands);
  const leading = global.getLeadingEdgeNodes(PARTICLE, makeCell([]), nodes);
  assert.deepStrictEqual(leading.map(n => n.index).sort(), [0, 1, 5]);
});

// ====================================================================================
// Baseline: a clean match binds
// ====================================================================================

test('binds when a free cell node matches a leading pair', () => {
  // Particle node 0 pairs ligand[5] with ligand[0]
  const ligands = [1, -1, -1, -1, -1, 4];   // node 0 pairId = "4-1"
  const r1 = makeReceptor(4);
  const r2 = makeReceptor(1);
  const cell = makeCell([atParticleNode(0, r1, r2)]);

  const res = attemptNodeBinding(PARTICLE, cell, ligands, SPRITE);
  assert.strictEqual(res.success, true);
  assert.strictEqual(res.matchCount, 1);
  assert.strictEqual(res.matchedCellNodes[0].receptor1, r1);
});

test('does not bind when the pair is reversed (ordering is load-bearing)', () => {
  const ligands = [1, -1, -1, -1, -1, 4];   // node 0 pairId = "4-1"
  const cell = makeCell([atParticleNode(0, makeReceptor(1), makeReceptor(4))]); // "1-4"

  assert.strictEqual(attemptNodeBinding(PARTICLE, cell, ligands, SPRITE).success, false);
});

test('does not bind through an empty ligand slot', () => {
  const ligands = [1, -1, -1, -1, -1, -1];  // node 0 pair = (-1, 1) -> inactive
  const cell = makeCell([atParticleNode(0, makeReceptor(-1), makeReceptor(1))]);

  assert.strictEqual(attemptNodeBinding(PARTICLE, cell, ligands, SPRITE).success, false);
});

test('does not bind beyond matchRadius', () => {
  const ligands = [1, -1, -1, -1, -1, 4];
  const r1 = makeReceptor(4);
  const r2 = makeReceptor(1);
  const p = particleNodeXY(0);
  const cell = makeCell([makeCellNode(p.x + MATCH_RADIUS + 1, p.y, r1, r2)]);

  assert.strictEqual(attemptNodeBinding(PARTICLE, cell, ligands, SPRITE).success, false);
});

// ====================================================================================
// The regression: a neighbour node sharing a spent receptor must not be claimable
// ====================================================================================

// Two adjacent cell nodes, A and B, sharing receptor `shared`:
//   A = (rA, shared)   B = (shared, rB)
// A has already been claimed by an earlier particle, so A.bound is set and both of its
// receptors are latched. B was never flagged — the old code checked only cNode.bound,
// so B stayed claimable even though `shared` was already spent.
function sharedReceptorCell({ sharedState, nodeAState = {} }) {
  const rA = makeReceptor(4);
  const shared = makeReceptor(1, sharedState);
  const rB = makeReceptor(2);

  const nodeA = atParticleNode(0, rA, shared, nodeAState);   // pairId "4-1"
  const nodeB = atParticleNode(1, shared, rB);               // pairId "1-2"
  return { cell: makeCell([nodeA, nodeB]), rA, shared, rB, nodeA, nodeB };
}

// Ligands giving node 0 -> "4-1" and node 1 -> "1-2"
const SHARED_LIGANDS = [1, 2, -1, -1, -1, 4];

test('neighbour node is blocked while the shared receptor is latched', () => {
  const { cell } = sharedReceptorCell({
    sharedState: { bound: true, latched: true, latchedLigandColor: 4 },
    nodeAState: { bound: true }
  });

  const res = attemptNodeBinding(PARTICLE, cell, SHARED_LIGANDS, SPRITE);
  assert.strictEqual(res.success, false, 'bound a node whose receptor was already latched');
});

test('neighbour node is blocked while the shared receptor is refractory', () => {
  // startRefractory() clears bound/latched and sets refractory
  const { cell } = sharedReceptorCell({
    sharedState: { bound: false, latched: false, refractory: true },
    nodeAState: { bound: true }
  });

  const res = attemptNodeBinding(PARTICLE, cell, SHARED_LIGANDS, SPRITE);
  assert.strictEqual(res.success, false, 'bound a node whose receptor was refractory');
});

test('neighbour node becomes claimable again once the receptor recovers', () => {
  const { cell, nodeA } = sharedReceptorCell({ sharedState: {} });
  nodeA.bound = true;  // A still flagged, but every receptor is free

  const res = attemptNodeBinding(PARTICLE, cell, SHARED_LIGANDS, SPRITE);
  assert.strictEqual(res.success, true);
  assert.strictEqual(res.matchCount, 1);
  assert.strictEqual(res.matchedCellNodes[0].pairId, '1-2', 'should have matched node B');
});

// ====================================================================================
// Within a single attempt: two matched nodes may not share a receptor
// ====================================================================================

test('one attempt cannot claim two nodes sharing a receptor', () => {
  const { cell, shared } = sharedReceptorCell({ sharedState: {} });
  // Both nodes free, both in range, both matching a distinct leading particle node.
  const res = attemptNodeBinding(PARTICLE, cell, SHARED_LIGANDS, SPRITE);

  assert.strictEqual(res.success, true);
  assert.strictEqual(res.matchCount, 1, 'double-counted the shared receptor');

  const claimed = res.matchedCellNodes.flatMap(n => [n.receptor1, n.receptor2]);
  assert.strictEqual(new Set(claimed).size, claimed.length, 'a receptor was claimed twice');
  assert.strictEqual(claimed.filter(r => r === shared).length, 1);
});

test('one attempt CAN claim two nodes that share nothing', () => {
  const a1 = makeReceptor(4), a2 = makeReceptor(1);
  const b1 = makeReceptor(1), b2 = makeReceptor(2);
  const cell = makeCell([
    atParticleNode(0, a1, a2),   // "4-1"
    atParticleNode(1, b1, b2)    // "1-2"
  ]);

  const res = attemptNodeBinding(PARTICLE, cell, SHARED_LIGANDS, SPRITE);
  assert.strictEqual(res.matchCount, 2, 'stricter check should not block disjoint nodes');

  const claimed = res.matchedCellNodes.flatMap(n => [n.receptor1, n.receptor2]);
  assert.strictEqual(new Set(claimed).size, 4);
});

// ====================================================================================
// Capacity impact of the fix, measured directly
// ====================================================================================
// Builds a cell the way Cell.computeReceptorNodes does — receptors sorted by angle,
// nodes at the midpoint between angular neighbours, wrapping around — then greedily
// claims nodes until none are available. Under the old rule (node.bound only) every
// node could be claimed. Under the new rule claiming node i also blocks nodes i-1 and
// i+1, so the conflict graph is a cycle and capacity is its maximum independent set:
// floor(N/2), NOT N/3 — the blocked neighbours of adjacent claims overlap, so claiming
// every second node around the ring is achievable.
//
// This is a static capacity count, not a throughput measurement of the running sim,
// but it bounds how many particles can sit on one cell at once.

function buildRingCell(receptorCount) {
  const receptors = [];
  for (let i = 0; i < receptorCount; i++) {
    const a = (i / receptorCount) * Math.PI * 2;
    const r = makeReceptor(i % 6);
    r.tipX = Math.cos(a) * 50;
    r.tipY = Math.sin(a) * 50;
    receptors.push(r);
  }
  const nodes = [];
  for (let i = 0; i < receptors.length; i++) {
    const r1 = receptors[i];
    const r2 = receptors[(i + 1) % receptors.length];
    nodes.push(makeCellNode((r1.tipX + r2.tipX) / 2, (r1.tipY + r2.tipY) / 2, r1, r2));
  }
  return { receptors, nodes };
}

// Claim nodes greedily under a given availability predicate, mimicking how Simulation
// marks a successful bind, and return how many fit.
function countConcurrentClaims(nodes, available) {
  let claims = 0;
  let progress = true;
  while (progress) {
    progress = false;
    for (const n of nodes) {
      if (!available(n)) continue;
      n.bound = true;
      n.receptor1.bound = n.receptor1.latched = true;
      n.receptor2.bound = n.receptor2.latched = true;
      claims++;
      progress = true;
      break;
    }
  }
  return claims;
}

function capacityReport(receptorCount) {
  const oldRule = buildRingCell(receptorCount);
  const newRule = buildRingCell(receptorCount);
  return {
    receptors: receptorCount,
    nodes: oldRule.nodes.length,
    before: countConcurrentClaims(oldRule.nodes, n => !n.bound),
    after: countConcurrentClaims(newRule.nodes, n => isCellNodeAvailable(n, new Set()))
  };
}

test('capacity: halves, because claiming a node blocks both angular neighbours', () => {
  for (const n of [12, 24, 25, 36, 60]) {
    const r = capacityReport(n);
    assert.strictEqual(r.before, n, `old rule should have allowed all ${n} nodes`);
    assert.strictEqual(r.after, Math.floor(n / 2),
      `new rule should allow floor(${n}/2) — max independent set of a cycle`);
  }
});

// --- Report -------------------------------------------------------------------------

let failed = 0;
for (const r of results) {
  if (r.ok) {
    console.log(`  PASS  ${r.name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${r.name}`);
    console.log(`        ${r.err.message}`);
  }
}

console.log(`\n${results.length - failed}/${results.length} passed`);

// Guarded so that running this against a checkout predating isCellNodeAvailable
// reports the test failures above rather than dying in a stack trace here.
try {
  console.log('\nConcurrent particles per cell (static capacity):');
  console.log('  receptors  nodes  before  after');
  for (const n of [12, 24, 36, 60]) {
    const r = capacityReport(n);
    console.log(
      `  ${String(r.receptors).padStart(9)}  ${String(r.nodes).padStart(5)}` +
      `  ${String(r.before).padStart(6)}  ${String(r.after).padStart(5)}`
    );
  }
} catch (err) {
  console.log(`  (capacity report unavailable: ${err.message})`);
}

process.exit(failed === 0 ? 0 : 1);
