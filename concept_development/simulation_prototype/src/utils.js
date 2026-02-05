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
window.colorForIndex = colorForIndex;
window.getComputedColor = getComputedColor;
window.calculateDisplayAreas = calculateDisplayAreas;
window.calculateCanvasSize = calculateCanvasSize;
