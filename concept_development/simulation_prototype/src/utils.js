// utils.js - Helper functions for the simulation

// Read query string param from page URL
function getQueryParam(name) {
  try {
    const params = new URLSearchParams(window.location.search);
    return params.has(name) ? params.get(name) : null;
  } catch (e) {
    return null;
  }
}

// Convert ligandPositions array (6 slots, each -1 to 5) to ligandCounts array (6 counts)
function computeLigandCountsFromPositions(ligandPositions) {
  const counts = [0, 0, 0, 0, 0, 0];
  for (let i = 0; i < 6; i++) {
    const v = ligandPositions[i];
    if (typeof v === 'number' && v >= 0 && v < 6) {
      counts[v]++;
    }
  }
  return counts;
}

// Convert ligandCounts to ligandPositions (for backward compatibility)
function computePositionsFromLigandCounts(ligandCounts) {
  const positions = [];
  for (let color = 0; color < 6; color++) {
    let count = Math.max(0, Math.floor(ligandCounts[color] || 0));
    for (let k = 0; k < count && positions.length < 6; k++) {
      positions.push(color);
    }
  }
  while (positions.length < 6) {
    positions.push(-1);
  }
  return positions.slice(0, 6);
}

// --- Puzzle JSON named-form converters ---
// On disk, receptors and ligands are arrays of {color, value/count} pairs so
// they are human-readable.  Internally the simulation indexes by color number,
// so these helpers convert at the JSON boundary.

function _colorIndex(name) {
  const idx = COLOR_NAMES.indexOf(name);
  if (idx < 0) console.warn('Unknown color name in puzzle JSON:', name);
  return idx;
}

// Snap a receptor concentration to tenths; values below 0.1 collapse to 0 so
// no receptors are drawn for trace/noise expression.
function snapReceptorValue(v) {
  const n = Number(v) || 0;
  if (n < 0.1) return 0;
  return Math.round(n * 10) / 10;
}

function receptorsFromNamed(named) {
  const out = [0, 0, 0, 0, 0, 0];
  if (!Array.isArray(named)) return out;
  for (const entry of named) {
    const i = _colorIndex(entry.color);
    if (i >= 0) out[i] = snapReceptorValue(entry.value);
  }
  return out;
}

function receptorsToNamed(arr) {
  const out = [];
  for (let i = 0; i < 6; i++) {
    out.push({ color: COLOR_NAMES[i], value: snapReceptorValue(arr[i]) });
  }
  return out;
}

function ligandCountsFromNamed(named) {
  const out = [0, 0, 0, 0, 0, 0];
  if (!Array.isArray(named)) return out;
  for (const entry of named) {
    const i = _colorIndex(entry.color);
    if (i >= 0) out[i] += Math.max(0, Math.floor(entry.count || 0));
  }
  return out;
}

function ligandCountsToNamed(arr) {
  const out = [];
  for (let i = 0; i < 6; i++) {
    out.push({ color: COLOR_NAMES[i], count: Math.max(0, Math.floor(arr[i] || 0)) });
  }
  return out;
}

// Convert a freshly-loaded puzzle JSON (named form) into the internal array
// form expected by the simulation.  Mutates the passed object in place and
// returns it.  Safe to call on already-normalized puzzles (no-op).
function normalizePuzzle(p) {
  if (!p) return p;
  if (Array.isArray(p.tissues)) {
    for (const t of p.tissues) {
      if (t && Array.isArray(t.receptors) && t.receptors.length > 0) {
        if (typeof t.receptors[0] === 'object' && t.receptors[0] !== null) {
          t.receptors = receptorsFromNamed(t.receptors);
        } else {
          t.receptors = t.receptors.map(snapReceptorValue);
        }
      }
    }
  }
  if (Array.isArray(p.ligands)) {
    p.ligandCounts = ligandCountsFromNamed(p.ligands);
    delete p.ligands;
  }
  return p;
}

// Get color hex value from index
function colorForIndex(i) {
  return COLORS[i % COLORS.length];
}

// Get p5 color object for lerping/blending
function getComputedColor(idx) {
  const c = COLORS[(idx % 6 + 6) % 6];
  return color(c);
}

// Calculate display areas for multi-tissue layout
function calculateDisplayAreas(canvasWidth, canvasHeight, layout) {
  const cols = 2;
  const rows = 2;
  const margin = layout.canvasMargin || LAYOUT_DEFAULTS.canvasMargin;
  const gap = layout.areaGap || LAYOUT_DEFAULTS.areaGap;
  const maxWidth = layout.maxAreaWidth || LAYOUT_DEFAULTS.maxAreaWidth;

  const availableW = Math.max(640, canvasWidth - 2 * margin);
  const areaWidth = Math.min(maxWidth, Math.floor((availableW - (cols - 1) * gap - 2 * margin) / cols));
  const areaHeight = Math.floor(areaWidth * 9 / 16);

  const areas = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      areas.push({
        x: margin + c * (areaWidth + gap),
        y: margin + 32 + r * (areaHeight + gap),
        w: areaWidth,
        h: areaHeight
      });
    }
  }
  return areas;
}

// Calculate required canvas size for multi-tissue layout
function calculateCanvasSize(singleMode, layout) {
  const margin = layout.canvasMargin || LAYOUT_DEFAULTS.canvasMargin;
  const gap = layout.areaGap || LAYOUT_DEFAULTS.areaGap;
  const maxWidth = layout.maxAreaWidth || LAYOUT_DEFAULTS.maxAreaWidth;

  if (singleMode) {
    return {
      width: Math.min(windowWidth, RENDER_RESOLUTION.width),
      height: Math.min(windowHeight, RENDER_RESOLUTION.height)
    };
  }

  const cols = 2;
  const rows = 2;
  const availableW = Math.max(640, windowWidth - 2 * margin);
  const areaWidth = Math.min(maxWidth, Math.floor((availableW - (cols - 1) * gap - 2 * margin) / cols));
  const areaHeight = Math.floor(areaWidth * 9 / 16);

  return {
    width: cols * areaWidth + (cols - 1) * gap + margin * 2,
    height: rows * areaHeight + (rows - 1) * gap + margin * 2 + 40
  };
}

// Export for browser global
window.getQueryParam = getQueryParam;
window.computeLigandCountsFromPositions = computeLigandCountsFromPositions;
window.computePositionsFromLigandCounts = computePositionsFromLigandCounts;
window.snapReceptorValue = snapReceptorValue;
window.receptorsFromNamed = receptorsFromNamed;
window.receptorsToNamed = receptorsToNamed;
window.ligandCountsFromNamed = ligandCountsFromNamed;
window.ligandCountsToNamed = ligandCountsToNamed;
window.normalizePuzzle = normalizePuzzle;
window.colorForIndex = colorForIndex;
window.getComputedColor = getComputedColor;
window.calculateDisplayAreas = calculateDisplayAreas;
window.calculateCanvasSize = calculateCanvasSize;
