// BindingLogic.js - Binding probability calculations

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
window.bindingProbabilityForParticle = bindingProbabilityForParticle;
window.hasMatchingReceptors = hasMatchingReceptors;
window.findNearestMatchingReceptor = findNearestMatchingReceptor;
window.isCollidingWithCell = isCollidingWithCell;
window.findNearestCollidingCell = findNearestCollidingCell;
