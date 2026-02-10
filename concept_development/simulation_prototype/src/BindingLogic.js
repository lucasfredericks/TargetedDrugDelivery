// BindingLogic.js - Binding logic with physics-based adjacency matching

// =============================================================================
// ADJACENCY-BASED BINDING SYSTEM
// Particles bind when enough ligands on the leading edge match nearby receptors
// =============================================================================

// Compute world-space positions of all 6 ligand tips on a particle
function getLigandWorldPositions(particle, spriteSize, ligandPositions) {
  // Distance from particle center to ligand tip (matches NanoparticleSprite geometry)
  const hexR = spriteSize * 0.35;
  const apothem = hexR * Math.cos(Math.PI / 6);
  const triH = hexR * 0.7;
  const ligandDist = apothem - 1 + triH;  // tip distance from center

  const positions = [];

  for (let i = 0; i < 6; i++) {
    // Local angle for ligand i (relative to particle, matching sprite generation)
    const localAngle = -Math.PI / 2 + (i + 0.5) * Math.PI / 3;
    // World angle = particle rotation + local angle
    const worldAngle = particle.angle + localAngle;

    positions.push({
      index: i,
      x: particle.x + Math.cos(worldAngle) * ligandDist,
      y: particle.y + Math.sin(worldAngle) * ligandDist,
      angle: worldAngle,
      color: ligandPositions[i]  // -1 if empty slot
    });
  }
  return positions;
}

// Find ligands on the leading edge (facing toward the cell)
function getLeadingEdgeLigands(particle, cell, ligandWorldPositions) {
  // Direction from particle to cell center
  const dx = cell.cx - particle.x;
  const dy = cell.cy - particle.y;
  const collisionAngle = Math.atan2(dy, dx);

  const leading = [];
  for (let lig of ligandWorldPositions) {
    // Angle from particle center toward this ligand
    const ligAngle = Math.atan2(lig.y - particle.y, lig.x - particle.x);

    // Angular difference (normalized to -π to π)
    let angleDiff = ligAngle - collisionAngle;
    while (angleDiff > Math.PI) angleDiff -= 2 * Math.PI;
    while (angleDiff < -Math.PI) angleDiff += 2 * Math.PI;

    // Within ±60° cone = leading edge (captures 2-3 ligands)
    if (Math.abs(angleDiff) <= Math.PI / 3) {
      leading.push(lig);
    }
  }
  return leading;
}

// Count adjacent ligand-receptor matches and return matched receptors
function countAdjacentMatches(leadingLigands, cell, matchRadius) {
  let matches = 0;
  const matchedReceptors = [];
  const matchedLigands = [];
  const usedReceptors = new Set();

  for (let lig of leadingLigands) {
    if (lig.color === -1) continue;  // Empty slot, skip

    // Find nearest unbound receptor of matching color within range
    let bestReceptor = null;
    let bestDist = Infinity;

    for (let receptor of cell.receptors) {
      if (receptor.bound) continue;
      if (usedReceptors.has(receptor)) continue;
      if (receptor.color !== lig.color) continue;

      const dx = lig.x - receptor.tipX;
      const dy = lig.y - receptor.tipY;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist < matchRadius && dist < bestDist) {
        bestDist = dist;
        bestReceptor = receptor;
      }
    }

    if (bestReceptor) {
      matches++;
      matchedReceptors.push(bestReceptor);
      matchedLigands.push(lig);
      usedReceptors.add(bestReceptor);  // Prevent double-counting
    }
  }

  return { matches, matchedReceptors, matchedLigands };
}

// Attempt adjacency-based binding. Returns true if particle binds.
function attemptAdjacencyBinding(particle, cell, ligandPositions, spriteSize, threshold = 2) {
  const matchRadius = spriteSize * 0.6;

  // Get world positions of all ligands
  const ligandWorld = getLigandWorldPositions(particle, spriteSize, ligandPositions);

  // Find ligands on the leading edge
  const leading = getLeadingEdgeLigands(particle, cell, ligandWorld);

  // Count matches with nearby receptors
  const { matches, matchedReceptors, matchedLigands } = countAdjacentMatches(leading, cell, matchRadius);

  if (matches >= threshold) {
    return {
      success: true,
      matchedReceptors,
      matchedLigands,
      matchCount: matches
    };
  }

  return { success: false, matchCount: matches };
}

// =============================================================================
// NODE-BASED BINDING SYSTEM
// Binding occurs between particle vertex nodes and cell receptor nodes
// Each node has an ordered pair identity (colorA, colorB)
// =============================================================================

/**
 * Compute the 6 vertex nodes on a particle.
 * Each vertex is between two adjacent ligands and has a pair identity.
 * A node is only active if BOTH adjacent ligands are present (not -1).
 *
 * @param {Object} particle - Particle with x, y, angle properties
 * @param {number} spriteSize - Size of particle sprite
 * @param {number[]} ligandPositions - Array of 6 ligand colors (-1 to 5)
 * @returns {Array} Array of node objects {x, y, angle, pairId, color1, color2, active}
 */
function getParticleNodes(particle, spriteSize, ligandPositions) {
  const hexR = spriteSize * 0.35;
  // Vertex distance from center (at the corners of the hexagon)
  const vertexDist = hexR;

  const nodes = [];

  for (let i = 0; i < 6; i++) {
    // Vertex i is at angle: -π/2 + i * π/3 (vertices at 0°, 60°, 120°, etc from top)
    const localAngle = -Math.PI / 2 + i * Math.PI / 3;
    const worldAngle = particle.angle + localAngle;

    const nodeX = particle.x + Math.cos(worldAngle) * vertexDist;
    const nodeY = particle.y + Math.sin(worldAngle) * vertexDist;

    // Node i is between ligand (i+5)%6 (counterclockwise) and ligand i (clockwise)
    // Going around the hexagon clockwise, the pair is (left ligand, right ligand)
    const leftLigandIdx = (i + 5) % 6;
    const rightLigandIdx = i;

    const color1 = ligandPositions[leftLigandIdx];
    const color2 = ligandPositions[rightLigandIdx];

    // Node is only active if both ligands are present
    const active = (typeof color1 === 'number' && color1 >= 0 && color1 < 6) &&
                   (typeof color2 === 'number' && color2 >= 0 && color2 < 6);

    const pairId = active ? `${color1}-${color2}` : null;

    nodes.push({
      index: i,
      x: nodeX,
      y: nodeY,
      angle: worldAngle,
      color1: color1,
      color2: color2,
      pairId: pairId,
      active: active
    });
  }

  return nodes;
}

/**
 * Find particle nodes on the leading edge (facing toward the cell).
 *
 * @param {Object} particle - Particle with x, y properties
 * @param {Object} cell - Cell with cx, cy properties
 * @param {Array} particleNodes - Array from getParticleNodes()
 * @returns {Array} Subset of nodes that are on the leading edge
 */
function getLeadingEdgeNodes(particle, cell, particleNodes) {
  // Direction from particle to cell center
  const dx = cell.cx - particle.x;
  const dy = cell.cy - particle.y;
  const collisionAngle = Math.atan2(dy, dx);

  const leading = [];

  for (let node of particleNodes) {
    if (!node.active) continue;

    // Angle from particle center toward this node
    const nodeAngle = Math.atan2(node.y - particle.y, node.x - particle.x);

    // Angular difference (normalized to -π to π)
    let angleDiff = nodeAngle - collisionAngle;
    while (angleDiff > Math.PI) angleDiff -= 2 * Math.PI;
    while (angleDiff < -Math.PI) angleDiff += 2 * Math.PI;

    // Within ±60° cone = leading edge (captures 2-3 nodes typically)
    if (Math.abs(angleDiff) <= Math.PI / 3) {
      leading.push(node);
    }
  }

  return leading;
}

/**
 * Attempt node-based binding between particle and cell.
 * Binding succeeds if at least one leading-edge particle node matches
 * a nearby receptor node with the same ordered pair identity.
 *
 * @param {Object} particle - Particle with x, y, angle properties
 * @param {Object} cell - Cell with receptorNodes array
 * @param {number[]} ligandPositions - Array of 6 ligand colors
 * @param {number} spriteSize - Size of particle sprite
 * @param {number} threshold - Minimum node matches required (default 1)
 * @returns {Object} {success, matchedNodes, matchCount}
 */
function attemptNodeBinding(particle, cell, ligandPositions, spriteSize, threshold = 1) {
  const matchRadius = spriteSize * 0.6;

  // Get particle vertex nodes
  const particleNodes = getParticleNodes(particle, spriteSize, ligandPositions);

  // Find nodes on the leading edge
  const leadingNodes = getLeadingEdgeNodes(particle, cell, particleNodes);

  if (leadingNodes.length === 0) {
    return { success: false, matchCount: 0 };
  }

  // Try to match leading particle nodes with cell receptor nodes
  let matches = 0;
  const matchedParticleNodes = [];
  const matchedCellNodes = [];
  const usedCellNodes = new Set();

  for (let pNode of leadingNodes) {
    // Find nearest unbound cell node with matching pair identity
    let bestCellNode = null;
    let bestDist = Infinity;

    for (let i = 0; i < cell.receptorNodes.length; i++) {
      const cNode = cell.receptorNodes[i];

      if (cNode.bound) continue;
      if (usedCellNodes.has(i)) continue;

      // Check if pair identity matches exactly
      if (cNode.pairId !== pNode.pairId) continue;

      const dx = pNode.x - cNode.x;
      const dy = pNode.y - cNode.y;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist < matchRadius && dist < bestDist) {
        bestDist = dist;
        bestCellNode = { node: cNode, index: i };
      }
    }

    if (bestCellNode) {
      matches++;
      matchedParticleNodes.push(pNode);
      matchedCellNodes.push(bestCellNode.node);
      usedCellNodes.add(bestCellNode.index);
    }
  }

  if (matches >= threshold) {
    return {
      success: true,
      matchedParticleNodes,
      matchedCellNodes,
      matchCount: matches
    };
  }

  return { success: false, matchCount: matches };
}

// =============================================================================
// LEGACY PROBABILISTIC SYSTEM (kept for reference/fallback)
// =============================================================================

// Calculate binding probability for a particle based on ligand-receptor match
function bindingProbabilityForParticle(ligandCounts, receptors, toxicityMult, fidelityParam) {
  // Use the deterministic prototype scoring formula: sum(ligandCount[i] * receptor[i]) * toxicityMult
  // Ligand and receptor indices correspond by color
  let sum = 0;
  let totalLigands = 0;

  for (let i = 0; i < 6; i++) {
    const lc = ligandCounts[i] || 0;
    totalLigands += lc;
    sum += lc * (receptors[i] || 0);
  }

  // If there are no ligands or no matching ligand-receptor pairs, particle cannot bind
  if (totalLigands === 0 || sum <= 1e-9) {
    return 0;
  }

  const tox = toxicityMult || 1;
  let attractiveness = sum * tox;

  // Use square root curve to make high scores more effective
  // Max theoretical score is 6 ligands * 1.0 receptors * 3 toxicity = 18
  const normalizedScore = attractiveness / 18;
  let baseP = Math.sqrt(normalizedScore);
  baseP = Math.min(1, Math.max(0, baseP));

  // At maximum fidelity, make binding deterministic
  if (fidelityParam >= 0.99) {
    return baseP;
  }

  // Add fidelity-driven noise (lower fidelity => more randomness)
  const noiseScale = 0.15;
  let noiseVal = (1 - fidelityParam) * noiseScale * (Math.random() - 0.5) * 2;
  let p = Math.min(1, Math.max(0, baseP + noiseVal));

  return p;
}

// Check if a particle has any matching receptors on a cell
function hasMatchingReceptors(particle, cell, ligandCounts, spriteRadius) {
  const receptorHitRadius = cell.radius * 0.3 + spriteRadius;

  for (let receptor of cell.receptors) {
    if (!receptor.bound && typeof receptor.color === 'number' && receptor.color >= 0) {
      if ((ligandCounts[receptor.color] || 0) > 0) {
        if (receptor.isNearTip(particle.x, particle.y, receptorHitRadius)) {
          return true;
        }
      }
    }
  }
  return false;
}

// Find the nearest unbound matching receptor
function findNearestMatchingReceptor(particle, cell, ligandCounts) {
  let nearest = null;
  let nearestDist = Infinity;

  for (let receptor of cell.receptors) {
    if (!receptor.bound && typeof receptor.color === 'number' && receptor.color >= 0) {
      if ((ligandCounts[receptor.color] || 0) > 0) {
        const dx = particle.x - receptor.tipX;
        const dy = particle.y - receptor.tipY;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < nearestDist) {
          nearestDist = d;
          nearest = receptor;
        }
      }
    }
  }

  return nearest;
}

// Check if particle is colliding with a cell
function isCollidingWithCell(particle, cell, spriteRadius) {
  const dx = particle.x - cell.cx;
  const dy = particle.y - cell.cy;
  const d = Math.sqrt(dx * dx + dy * dy);
  const collisionDistance = cell.radius + spriteRadius + 2;
  return d < collisionDistance;
}

// Find nearest cell that particle is colliding with
function findNearestCollidingCell(particle, cells, spriteRadius) {
  let nearestCell = null;
  let nearestDist = Infinity;

  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i];
    const dx = particle.x - cell.cx;
    const dy = particle.y - cell.cy;
    const d = Math.sqrt(dx * dx + dy * dy);
    const collisionDistance = cell.radius + spriteRadius + 2;

    if (d < collisionDistance && d < nearestDist) {
      nearestCell = cell;
      nearestDist = d;
      particle.cellIndex = i;
    }
  }

  return nearestCell;
}

// Export for browser global
window.getLigandWorldPositions = getLigandWorldPositions;
window.getLeadingEdgeLigands = getLeadingEdgeLigands;
window.countAdjacentMatches = countAdjacentMatches;
window.attemptAdjacencyBinding = attemptAdjacencyBinding;
window.getParticleNodes = getParticleNodes;
window.getLeadingEdgeNodes = getLeadingEdgeNodes;
window.attemptNodeBinding = attemptNodeBinding;
window.bindingProbabilityForParticle = bindingProbabilityForParticle;
window.hasMatchingReceptors = hasMatchingReceptors;
window.findNearestMatchingReceptor = findNearestMatchingReceptor;
window.isCollidingWithCell = isCollidingWithCell;
window.findNearestCollidingCell = findNearestCollidingCell;
