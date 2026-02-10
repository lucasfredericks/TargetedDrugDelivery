// scoring.js — deterministic scoring engine
// ligandCounts: array of length 6 (integers 0..6)
// receptors: array length 6 floats (0..1)

// Calculate theoretical binding percentage (0-100%)
// This represents the expected binding affinity based on ligand-receptor overlap
// Score = sum(ligandCounts[i] * receptors[i]) / totalLigands * 100
function scoreTissue(ligandCounts, receptors) {
  if (!ligandCounts || !receptors) return 0;

  let sum = 0;
  let totalLigands = 0;

  for (let i = 0; i < 6; i++) {
    const lc = ligandCounts[i] || 0;
    totalLigands += lc;
    sum += lc * (receptors[i] || 0);
  }

  // No ligands = 0% binding potential
  if (totalLigands === 0) return 0;

  // Normalize to percentage: sum / totalLigands gives 0-1, multiply by 100 for %
  // This represents: "what fraction of your ligands are targeting high-density receptors"
  return (sum / totalLigands) * 100;
}

// Utility: compute scores for all tissues
function scoreAll(ligandCounts, tissues) {
  // tissues: [{name, receptors:[6 floats]}]
  let out = {};
  for (let t of tissues) {
    out[t.name] = scoreTissue(ligandCounts, t.receptors);
  }
  return out;
}

// Export for browser global
window.scoreTissue = scoreTissue;
window.scoreAll = scoreAll;