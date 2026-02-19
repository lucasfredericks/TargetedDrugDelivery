// Cell.js - Cell entity with organic shape generation and receptor management

class Cell {
  constructor(cx, cy, baseRadius, seed, receptorConcentrations) {
    this.cx = cx;
    this.cy = cy;
    this.seed = seed;
    this.receptors = [];    // Array of Receptor objects
    this.receptorNodes = []; // Array of {angle, x, y, pairId} - nodes between adjacent receptors
    this.bound = 0;         // Count of bound particles on this cell
    this.absorbedDrugs = 0; // Count of drug molecules absorbed into this cell

    // Cell death state
    this.dying = false;
    this.dead = false;
    this.deathTimer = 0;
    this.deathDuration = 180; // 3 seconds at 60fps
    this.deathSegments = [];  // Membrane line segments flying apart

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

    // Compute receptor nodes between adjacent receptors
    this.computeReceptorNodes();
  }

  /**
   * Compute nodes between physically adjacent receptors on the membrane.
   * Nodes are created at the midpoint between adjacent receptor tips.
   * Each node has a "pair identity" (colorA, colorB) where order matters.
   * Receptors are sorted by angle around the cell center.
   */
  computeReceptorNodes() {
    this.receptorNodes = [];

    if (this.receptors.length < 2) return;

    // Sort receptors by angle around cell center
    const sortedReceptors = this.receptors.slice().map(r => {
      const angle = Math.atan2(r.tipY - this.cy, r.tipX - this.cx);
      return { receptor: r, angle: angle };
    }).sort((a, b) => a.angle - b.angle);

    // Create nodes between each pair of adjacent receptors (wrapping around)
    for (let i = 0; i < sortedReceptors.length; i++) {
      const curr = sortedReceptors[i];
      const next = sortedReceptors[(i + 1) % sortedReceptors.length];

      const r1 = curr.receptor;
      const r2 = next.receptor;

      // Node position is midpoint between the two receptor tips
      const nodeX = (r1.tipX + r2.tipX) / 2;
      const nodeY = (r1.tipY + r2.tipY) / 2;

      // Node angle (for matching with particle nodes)
      const nodeAngle = Math.atan2(nodeY - this.cy, nodeX - this.cx);

      // Pair identity: ordered pair of colors (going clockwise/counterclockwise)
      // The order is (current receptor color, next receptor color) in angular order
      const pairId = Cell.makePairId(r1.color, r2.color);

      this.receptorNodes.push({
        x: nodeX,
        y: nodeY,
        angle: nodeAngle,
        color1: r1.color,
        color2: r2.color,
        pairId: pairId,
        bound: false,
        receptor1: r1,
        receptor2: r2
      });
    }
  }

  /**
   * Create a unique pair ID from two colors. Order matters!
   * Returns a string like "2-5" for colors 2 and 5.
   */
  static makePairId(color1, color2) {
    return `${color1}-${color2}`;
  }

  // Update per-frame state (refractory timers, node availability, death animation)
  update(physicsParams, frameCount) {
    // Animate dying segments; skip receptor logic once death starts
    if (this.dying) {
      this.deathTimer++;
      const noiseScale = physicsParams.turbulenceScale;
      const noiseStr = physicsParams.turbulenceStrength * 0.15;
      for (let seg of this.deathSegments) {
        const mx = (seg.ax + seg.bx) * 0.5;
        const my = (seg.ay + seg.by) * 0.5;
        const nx = noise(mx * noiseScale + frameCount * 0.003 * physicsParams.turbulenceX, my * noiseScale);
        const ny = noise(mx * noiseScale + 100, my * noiseScale + frameCount * 0.003 * physicsParams.turbulenceY);
        seg.vx += (nx - 0.5) * 2 * noiseStr;
        seg.vy += (ny - 0.5) * 2 * noiseStr;
        seg.vx *= 0.97;
        seg.vy *= 0.97;
        seg.ax += seg.vx;
        seg.ay += seg.vy;
        seg.bx += seg.vx;
        seg.by += seg.vy;
      }
      if (this.deathTimer >= this.deathDuration) {
        this.dead = true;
      }
      return;
    }

    for (let receptor of this.receptors) {
      receptor.updateRefractory();
    }

    // Reconcile receptor node bound states:
    // A node becomes available again when neither of its receptors is bound, latched, or refractory
    for (let node of this.receptorNodes) {
      if (node.bound) {
        const r1free = !node.receptor1.bound && !node.receptor1.latched && !node.receptor1.refractory;
        const r2free = !node.receptor2.bound && !node.receptor2.latched && !node.receptor2.refractory;
        if (r1free && r2free) {
          node.bound = false;
        }
      }
    }
  }

  // Trigger cell death: break membrane into flying segments
  triggerDeath() {
    this.dying = true;
    this.deathTimer = 0;
    this.deathSegments = [];
    for (let i = 0; i < this.shape.length; i++) {
      const a = this.shape[i];
      const b = this.shape[(i + 1) % this.shape.length];
      // Outward radial kick from cell center
      const mx = (a.x + b.x) * 0.5;
      const my = (a.y + b.y) * 0.5;
      const radDx = mx - this.cx;
      const radDy = my - this.cy;
      const radLen = Math.sqrt(radDx * radDx + radDy * radDy) || 1;
      const radialSpeed = (Math.random() * 1.5 + 0.5);
      // Random scatter added to radial kick
      const scatterAngle = Math.random() * Math.PI * 2;
      const scatterSpeed = Math.random() * 0.8;
      this.deathSegments.push({
        ax: a.x, ay: a.y,
        bx: b.x, by: b.y,
        vx: (radDx / radLen) * radialSpeed + Math.cos(scatterAngle) * scatterSpeed,
        vy: (radDy / radLen) * radialSpeed + Math.sin(scatterAngle) * scatterSpeed
      });
    }
  }

  // Returns true once the fade animation has fully completed
  isFullyDead() {
    return this.dead;
  }

  // Render cell membrane and receptors to a graphics context
  render(g) {
    if (this.dying) {
      this.renderDying(g);
      return;
    }
    if (this.dead) return;

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

  // Render membrane segments flying apart with fade
  renderDying(g) {
    const progress = this.deathTimer / this.deathDuration;
    const alpha = Math.round(255 * (1 - progress));
    g.stroke(100, 100, 120, alpha);
    g.strokeWeight(2);
    g.noFill();
    for (let seg of this.deathSegments) {
      g.line(seg.ax, seg.ay, seg.bx, seg.by);
    }
    g.noStroke();
  }

  // Render absorbed drug count overlay (for test mode)
  renderBindingOverlay(g, showOverlay) {
    if (!showOverlay || this.absorbedDrugs === 0 || this.dying || this.dead) return;

    const count = this.absorbedDrugs;

    const boxW = 36;
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
    g.text(`${count}`, this.cx, this.cy);
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

  // Get count of bound receptor nodes
  getBoundNodeCount() {
    return this.receptorNodes.filter(n => n.bound).length;
  }

  // Get total receptor node count
  getTotalNodes() {
    return this.receptorNodes.length;
  }

  // Reset all receptor bound states
  resetBindings() {
    this.bound = 0;
    this.absorbedDrugs = 0;
    for (let receptor of this.receptors) {
      receptor.bound = false;
      receptor.latched = false;
      receptor.latchedLigandColor = -1;
      receptor.latchedLigandX = 0;
      receptor.latchedLigandY = 0;
      receptor.refractory = false;
      receptor.refractoryTimer = 0;
      receptor.refractoryColor = -1;
    }
    // Reset receptor node bound states
    for (let node of this.receptorNodes) {
      node.bound = false;
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
