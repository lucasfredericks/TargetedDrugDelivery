// scoring.js — Adjacency-aware scoring for node-based binding
//
// scoreTissue is the single source of truth for "Binding Affinity": the dashboard
// bar, the Pi display, and Simulation.getStats() all read this one model. Do not add
// a second implementation elsewhere — two of them disagreeing is what this replaced.
//
// It calculates affinity from:
// 1. The multiset of colors in the particle's ligand configuration
// 2. The tissue's receptor concentrations (probability of each color being present)
// 3. The simulation's deterministic rule: a collision binds when at least one
//    ordered ligand pair on the leading edge matches an adjacent receptor pair
//
// Because Simulation permutes the arrangement per particle, the live model
// (scoreTissueNodes) averages over arrangements in closed form instead of enumerating
// collision orientations. The order- and orientation-dependent models further down are
// unreferenced and kept only for reference.

// Define the 6 possible leading edges (each contains 3 adjacent ligand indices)
// These correspond to the 6 possible collision orientations of the hexagonal particle
const LEADING_EDGES = [
  [5, 0, 1],  // Top-right edge
  [0, 1, 2],  // Right edge
  [1, 2, 3],  // Bottom-right edge
  [2, 3, 4],  // Bottom-left edge
  [3, 4, 5],  // Left edge
  [4, 5, 0]   // Top-left edge
];

/**
 * Calculate P(k or more successes) for independent Bernoulli trials
 * @param {number[]} probs - Array of success probabilities for each trial
 * @param {number} k - Minimum number of successes required
 * @returns {number} Probability of k or more successes
 */
function probabilityOfKOrMore(probs, k) {
  const n = probs.length;

  if (n === 0 || k > n) return 0;
  if (k <= 0) return 1;

  // For small n (2-3), enumerate all outcomes directly
  if (n === 1) {
    return k <= 1 ? probs[0] : 0;
  }

  if (n === 2) {
    const [p0, p1] = probs;
    const q0 = 1 - p0, q1 = 1 - p1;

    if (k === 1) {
      // P(at least 1) = 1 - P(none)
      return 1 - (q0 * q1);
    } else { // k === 2
      // P(both)
      return p0 * p1;
    }
  }

  if (n === 3) {
    const [p0, p1, p2] = probs;
    const q0 = 1 - p0, q1 = 1 - p1, q2 = 1 - p2;

    if (k === 1) {
      // P(at least 1) = 1 - P(none)
      return 1 - (q0 * q1 * q2);
    } else if (k === 2) {
      // P(at least 2) = P(exactly 2) + P(all 3)
      const pExactly2 = (p0 * p1 * q2) + (p0 * q1 * p2) + (q0 * p1 * p2);
      const pAll3 = p0 * p1 * p2;
      return pExactly2 + pAll3;
    } else { // k === 3
      // P(all 3)
      return p0 * p1 * p2;
    }
  }

  // For larger n, use dynamic programming
  // dp[i][j] = probability of exactly j successes in first i trials
  let dp = new Array(n + 1).fill(null).map(() => new Array(n + 1).fill(0));
  dp[0][0] = 1;

  for (let i = 0; i < n; i++) {
    const p = probs[i];
    const q = 1 - p;
    for (let j = 0; j <= i; j++) {
      if (dp[i][j] > 0) {
        dp[i + 1][j] += dp[i][j] * q;     // Failure
        dp[i + 1][j + 1] += dp[i][j] * p; // Success
      }
    }
  }

  // Sum probabilities for k or more successes
  let result = 0;
  for (let j = k; j <= n; j++) {
    result += dp[n][j];
  }
  return result;
}

/**
 * Calculate the probability of 2+ matches for a single leading edge
 * @param {number[]} ligandPositions - Array of 6 ligand colors (-1 to 5, -1 = empty)
 * @param {number[]} receptors - Array of 6 receptor concentrations (0 to 1)
 * @param {number[]} edgeIndices - Array of 3 ligand indices forming this edge
 * @param {number} threshold - Minimum matches required (default 2)
 * @returns {number} Probability of meeting the threshold
 */
function edgeBindingProbability(ligandPositions, receptors, edgeIndices, threshold = 2) {
  // Get the ligand colors for this edge, filtering out empty slots
  const ligandColors = [];
  for (let idx of edgeIndices) {
    const color = ligandPositions[idx];
    if (typeof color === 'number' && color >= 0 && color < 6) {
      ligandColors.push(color);
    }
  }

  // If not enough ligands to meet threshold, probability is 0
  if (ligandColors.length < threshold) {
    return 0;
  }

  // Get the match probability for each ligand (= receptor concentration for that color)
  const matchProbs = ligandColors.map(color => receptors[color] || 0);

  // Calculate P(threshold or more matches)
  return probabilityOfKOrMore(matchProbs, threshold);
}

/**
 * Calculate theoretical binding score using adjacency-aware combinatorial probability
 *
 * This models the actual simulation behavior:
 * 1. The particle can hit the cell from any of 6 orientations (equally likely)
 * 2. For each orientation, 3 adjacent ligands form the "leading edge"
 * 3. Each ligand has a probability of matching a receptor (= receptor concentration)
 * 4. Binding occurs if 2+ ligands on the leading edge find matches
 *
 * The score is the average binding probability across all 6 orientations.
 *
 * @param {number[]} ligandPositions - Array of 6 ligand colors (-1 to 5, -1 = empty)
 * @param {number[]} receptors - Array of 6 receptor concentrations (0 to 1)
 * @param {number} threshold - Minimum adjacent matches required (default 2)
 * @returns {number} Theoretical binding percentage (0-100)
 */
function scoreTissueAdjacency(ligandPositions, receptors, threshold = 2) {
  if (!ligandPositions || !receptors) return 0;

  // Count total ligands (non-empty slots)
  let totalLigands = 0;
  for (let i = 0; i < 6; i++) {
    const c = ligandPositions[i];
    if (typeof c === 'number' && c >= 0 && c < 6) {
      totalLigands++;
    }
  }

  // Early return: Can't achieve threshold matches if total ligands < threshold
  // This is critical - with 1 ligand, you can never get 2+ matches
  if (totalLigands < threshold) return 0;

  // Calculate binding probability for each of the 6 possible orientations
  let totalProbability = 0;

  for (let edge of LEADING_EDGES) {
    const edgeProb = edgeBindingProbability(ligandPositions, receptors, edge, threshold);
    totalProbability += edgeProb;
  }

  // Average across all 6 orientations, convert to percentage
  return (totalProbability / LEADING_EDGES.length) * 100;
}

/**
 * Calculate probability of exactly k successes for independent Bernoulli trials
 * @param {number[]} probs - Array of success probabilities for each trial
 * @param {number} k - Exact number of successes required
 * @returns {number} Probability of exactly k successes
 */
function probabilityOfExactlyK(probs, k) {
  const n = probs.length;

  if (n === 0) return k === 0 ? 1 : 0;
  if (k < 0 || k > n) return 0;

  // Use dynamic programming
  // dp[i][j] = probability of exactly j successes in first i trials
  let dp = new Array(n + 1).fill(null).map(() => new Array(n + 1).fill(0));
  dp[0][0] = 1;

  for (let i = 0; i < n; i++) {
    const p = probs[i];
    const q = 1 - p;
    for (let j = 0; j <= i; j++) {
      if (dp[i][j] > 0) {
        dp[i + 1][j] += dp[i][j] * q;     // Failure
        dp[i + 1][j + 1] += dp[i][j] * p; // Success
      }
    }
  }

  return dp[n][k];
}

/**
 * Node-based scoring, averaged over ligand arrangements. This is the live model.
 *
 * Binding acts on *adjacent ligand pairs* (nodes), and Simulation permutes the designed
 * arrangement for every particle, so a dose samples all orderings of the colors the
 * visitor chose rather than the single one shown in the preview. This returns the
 * expectation over that permutation, which makes it order-independent by construction —
 * exactly like the simulation it models. That is also why no collision-orientation loop
 * is needed: once slot order is uniformly random, all six orientations are equivalent.
 *
 * Let f_i = r[L_i] / totalConc be the chance a random membrane receptor matches the
 * ligand in slot i (0 for an empty slot). Under a uniform permutation each of the 6
 * nodes presents a uniformly random ordered pair of distinct slots, so
 *
 *   E[matching pairs] = 6 · (Σ_{i≠j} f_i·f_j) / (6·5) = ((Σf)² − Σf²) / 5
 *
 * The result is an expected count of matching pairs per particle, scaled to a 0–100
 * bar — it is an affinity, not a per-collision probability. A single filled slot scores
 * 0, matching the simulation's rule that a node needs both of its ligands present.
 *
 * @param {number[]} ligandPositions - Array of 6 ligand colors (-1 to 5, -1 = empty)
 * @param {number[]} receptors - Array of 6 receptor concentrations (0 to 1)
 * @returns {number} Theoretical binding percentage (0-100)
 */
function scoreTissueNodes(ligandPositions, receptors) {
  if (!ligandPositions || !receptors) return 0;

  // Total receptor concentration, for normalization
  let totalConc = 0;
  for (let c = 0; c < 6; c++) {
    totalConc += receptors[c] || 0;
  }
  if (totalConc < 0.01) return 0;  // No receptors

  // Per-slot match chance; empty slots contribute nothing
  let sum = 0;
  let sumSquares = 0;
  for (let i = 0; i < 6; i++) {
    const color = ligandPositions[i];
    if (!(typeof color === 'number' && color >= 0 && color < 6)) continue;

    const f = (receptors[color] || 0) / totalConc;
    sum += f;
    sumSquares += f * f;
  }

  const expectedMatches = (sum * sum - sumSquares) / 5;

  return Math.min(100, Math.max(0, expectedMatches * 100));
}


/**
 * Legacy scoring function - kept for compatibility
 * Uses simple weighted average (ligandCounts * receptors)
 */
function scoreTissueLegacy(ligandCounts, receptors) {
  if (!ligandCounts || !receptors) return 0;

  let sum = 0;
  let totalLigands = 0;

  for (let i = 0; i < 6; i++) {
    const lc = ligandCounts[i] || 0;
    totalLigands += lc;
    sum += lc * (receptors[i] || 0);
  }

  if (totalLigands === 0) return 0;
  return (sum / totalLigands) * 100;
}

/**
 * Main scoring function - uses node-based combinatorial model
 *
 * IMPORTANT: This function expects ligandPositions - an array of 6 color indices
 * where each value is -1 (empty) or 0-5 (color index).
 *
 * For backward compatibility, it also accepts ligandCounts (array of 6 counts),
 * but this is detected by checking if any value > 5 (which can't be a valid position).
 *
 * Delegates to scoreTissueNodes, which averages over the per-particle arrangement
 * permutation. The result is an affinity — the expected number of matching ligand/
 * receptor pairs per particle on a 0–100 scale — not a per-collision bind probability.
 *
 * @param {number[]} ligandPositions - Array of 6 ligand colors (-1 to 5)
 * @param {number[]} receptors - Array of 6 receptor concentrations (0 to 1)
 * @returns {number} Theoretical binding percentage (0-100)
 */
function scoreTissue(ligandPositions, receptors) {
  if (!ligandPositions || !receptors) return 0;

  // Check if input is ligandCounts (any value > 5 means it's a count, not a color index)
  // This is a rare case for backward compatibility - normally positions are passed
  const isCounts = ligandPositions.some(v => typeof v === 'number' && v > 5);

  let positions;
  if (isCounts) {
    // Convert counts to positions
    positions = [];
    for (let color = 0; color < 6; color++) {
      const count = Math.max(0, Math.floor(ligandPositions[color] || 0));
      for (let k = 0; k < count && positions.length < 6; k++) {
        positions.push(color);
      }
    }
    while (positions.length < 6) {
      positions.push(-1);
    }
  } else {
    positions = ligandPositions;
  }

  return scoreTissueNodes(positions, receptors);
}

/**
 * Utility: compute scores for all tissues
 */
function scoreAll(ligandPositionsOrCounts, tissues) {
  let out = {};
  for (let t of tissues) {
    out[t.name] = scoreTissue(ligandPositionsOrCounts, t.receptors);
  }
  return out;
}

// Export for browser global
window.scoreTissue = scoreTissue;
window.scoreTissueNodes = scoreTissueNodes;
window.scoreTissueAdjacency = scoreTissueAdjacency;
window.scoreTissueLegacy = scoreTissueLegacy;
window.scoreAll = scoreAll;
window.probabilityOfKOrMore = probabilityOfKOrMore;
window.probabilityOfExactlyK = probabilityOfExactlyK;
window.edgeBindingProbability = edgeBindingProbability;
window.LEADING_EDGES = LEADING_EDGES;
