// Cell.js - Cell entity with organic shape generation and receptor management

class Cell {
  constructor(cx, cy, baseRadius, seed, receptorConcentrations) {
    this.cx = cx;
    this.cy = cy;
    this.seed = seed;
    this.receptors = [];    // Array of Receptor objects
    this.bound = 0;         // Count of bound particles on this cell

    // Store receptor concentrations
    this.receptorConcentrations = receptorConcentrations || [0, 0, 0, 0, 0, 0];
    this.totalExpression = this.receptorConcentrations.reduce((sum, c) => sum + (c || 0), 0);

    // Calculate total receptors needed (each color gets its full allocation)
    const maxPerColor = PHYSICS_DEFAULTS.maxReceptorsPerColor;
    this.totalReceptorsNeeded = 0;
    for (let i = 0; i < 6; i++) {
      this.totalReceptorsNeeded += Math.round((this.receptorConcentrations[i] || 0) * maxPerColor);
    }

    // Scale size based on expression (0.6x to 1.2x)
    const { minSizeFactor, maxSizeFactor, maxExpression } = EXPRESSION_SCALING;
    const expressionRatio = Math.min(this.totalExpression / maxExpression, 1);
    this.sizeFactor = minSizeFactor + expressionRatio * (maxSizeFactor - minSizeFactor);
    this.radius = baseRadius * this.sizeFactor;

    // Shape points must accommodate all receptors needed
    // Use at least minShapePoints, but scale up if more receptors are needed
    const { minShapePoints } = EXPRESSION_SCALING;
    this.numShapePoints = Math.max(minShapePoints, this.totalReceptorsNeeded);

    // Generate shape with enough points for all receptors
    this.shape = Cell.generateShape(cx, cy, this.radius, seed, this.numShapePoints);

    // Auto-allocate receptors based on concentrations
    this.allocateReceptors();
  }

  // Generate organic cell shape using Perlin noise
  static generateShape(cx, cy, baseRadius, seed, numPoints = 32) {
    const points = [];

    for (let i = 0; i < numPoints; i++) {
      const angle = (i / numPoints) * TWO_PI;
      // Use Perlin noise to create organic variation in radius
      const noiseVal = noise(Math.cos(angle) * 2 + seed, Math.sin(angle) * 2 + seed);
      const radiusVariation = map(noiseVal, 0, 1, 0.8, 1.2);
      const r = baseRadius * radiusVariation;
      points.push({
        x: cx + Math.cos(angle) * r,
        y: cy + Math.sin(angle) * r
      });
    }
    return points;
  }

  // Allocate Y-shaped receptors around the cell membrane
  allocateReceptors() {
    this.receptors = [];
    const maxPerColor = PHYSICS_DEFAULTS.maxReceptorsPerColor;

    // Calculate receptor count for each color (full allocation, no scaling)
    const receptorCounts = [];
    let totalReceptors = 0;
    for (let color = 0; color < 6; color++) {
      const count = Math.round((this.receptorConcentrations[color] || 0) * maxPerColor);
      receptorCounts.push(count);
      totalReceptors += count;
    }

    if (totalReceptors === 0 || !this.shape || this.shape.length === 0) {
      return;
    }

    // Create shuffled indices for random distribution around the membrane
    const availableSlots = this.shape.length;
    const indices = [];
    for (let i = 0; i < availableSlots; i++) {
      indices.push(i);
    }
    for (let i = indices.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = indices[i];
      indices[i] = indices[j];
      indices[j] = t;
    }

    // Allocate all receptors (each color gets its full count)
    let pointIdx = 0;
    for (let color = 0; color < 6; color++) {
      const count = receptorCounts[color];
      for (let k = 0; k < count; k++) {
        if (pointIdx >= indices.length) break;

        const shapeIdx = indices[pointIdx++];
        const point = this.shape[shapeIdx];
        const baseX = point.x;
        const baseY = point.y;

        // Calculate outward direction from cell center
        const dx = baseX - this.cx;
        const dy = baseY - this.cy;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const nx = dx / dist;
        const ny = dy / dist;

        // Receptor stems point outward
        const branchLen = Math.min(6, this.radius * 0.15);
        const stemLen = branchLen * 2;
        const tipX = baseX + nx * stemLen;
        const tipY = baseY + ny * stemLen;

        this.receptors.push(new Receptor(baseX, baseY, tipX, tipY, color, nx, ny, branchLen));
      }
    }
  }

  // Render cell membrane and receptors to a graphics context
  render(g) {
    // Draw cell membrane outline with organic shape
    g.fill(220, 230, 240, 180);
    g.stroke(100, 100, 120, 120);
    g.strokeWeight(2);
    g.beginShape();
    for (let pt of this.shape) {
      g.vertex(pt.x, pt.y);
    }
    g.endShape(CLOSE);
    g.noStroke();

    // Draw Y-shaped receptors
    for (let receptor of this.receptors) {
      receptor.render(g);
    }
  }

  // Render binding percentage overlay (for test mode)
  renderBindingOverlay(g, showOverlay) {
    if (!showOverlay || this.receptors.length === 0) return;

    const boundReceptors = this.receptors.filter(r => r.bound).length;
    const totalReceptors = this.receptors.length;
    const percentage = (boundReceptors / totalReceptors * 100).toFixed(1);

    const boxW = 50;
    const boxH = 24;
    g.fill(255, 255, 255, 220);
    g.stroke(0, 0, 0, 200);
    g.strokeWeight(1.5);
    g.rectMode(CENTER);
    g.rect(this.cx, this.cy, boxW, boxH, 4);
    g.noStroke();

    g.fill(0, 0, 0, 255);
    g.textSize(14);
    g.textAlign(CENTER, CENTER);
    g.textStyle(BOLD);
    g.text(`${percentage}%`, this.cx, this.cy);
    g.textStyle(NORMAL);
    g.rectMode(CORNER);
  }

  // Get count of bound receptors
  getBoundCount() {
    return this.receptors.filter(r => r.bound).length;
  }

  // Get total receptor count
  getTotalReceptors() {
    return this.receptors.length;
  }

  // Reset all receptor bound states
  resetBindings() {
    this.bound = 0;
    for (let receptor of this.receptors) {
      receptor.bound = false;
    }
  }

  // Clear receptors (for regeneration when tissue config changes)
  clearReceptors() {
    this.receptors = [];
    this.bound = 0;
  }

  // Update receptor concentrations and regenerate cell (size, shape, receptors)
  updateConcentrations(receptorConcentrations, baseRadius) {
    this.receptorConcentrations = receptorConcentrations || [0, 0, 0, 0, 0, 0];
    this.totalExpression = this.receptorConcentrations.reduce((sum, c) => sum + (c || 0), 0);

    // Calculate total receptors needed (each color gets its full allocation)
    const maxPerColor = PHYSICS_DEFAULTS.maxReceptorsPerColor;
    this.totalReceptorsNeeded = 0;
    for (let i = 0; i < 6; i++) {
      this.totalReceptorsNeeded += Math.round((this.receptorConcentrations[i] || 0) * maxPerColor);
    }

    // Recalculate size factor
    const { minSizeFactor, maxSizeFactor, maxExpression } = EXPRESSION_SCALING;
    const expressionRatio = Math.min(this.totalExpression / maxExpression, 1);
    this.sizeFactor = minSizeFactor + expressionRatio * (maxSizeFactor - minSizeFactor);
    this.radius = baseRadius * this.sizeFactor;

    // Shape points must accommodate all receptors needed
    const { minShapePoints } = EXPRESSION_SCALING;
    this.numShapePoints = Math.max(minShapePoints, this.totalReceptorsNeeded);

    // Regenerate shape and receptors
    this.shape = Cell.generateShape(this.cx, this.cy, this.radius, this.seed, this.numShapePoints);
    this.allocateReceptors();
  }
}

// Export for browser global
window.Cell = Cell;
