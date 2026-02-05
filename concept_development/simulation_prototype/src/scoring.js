// scoring.js — deterministic scoring engine
// ligandCounts: array of length 6 (integers 0..6)
// receptors: array length 6 floats (0..1)
// toxicity: integer multiplier (1=green,2=yellow,3=red)

function scoreTissue(ligandCounts, receptors, toxicityMultiplier) {
  if (!ligandCounts || !receptors) return 0;
  let sum = 0;
  for (let i = 0; i < 6; i++) {
    sum += (ligandCounts[i] || 0) * (receptors[i] || 0);
  }
  return sum * (toxicityMultiplier || 1);
}

// Utility: compute scores for all tissues
function scoreAll(ligandCounts, tissues, toxicityMultiplier) {
  // tissues: [{name, receptors:[6 floats]}]
  let out = {};
  for (let t of tissues) {
    out[t.name] = scoreTissue(ligandCounts, t.receptors, toxicityMultiplier);
  }
  return out;
}

// Export for browser global
window.scoreTissue = scoreTissue;
window.scoreAll = scoreAll;