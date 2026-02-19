// Receptor.js - Y-shaped receptor entity

class Receptor {
  constructor(baseX, baseY, tipX, tipY, color, nx, ny, branchLen) {
    this.baseX = baseX;      // Position on cell membrane
    this.baseY = baseY;
    this.tipX = tipX;        // Position of receptor tip (where binding occurs)
    this.tipY = tipY;
    this.color = color;      // Color index (0-5)
    this.nx = nx;            // Outward normal x component
    this.ny = ny;            // Outward normal y component
    this.branchLen = branchLen;
    this.bound = false;      // Whether a particle is bound to this receptor
    this.latched = false;    // Whether receptor is latched to a ligand
    this.latchedLigandColor = -1;  // Color of latched ligand
    this.latchedLigandX = 0;       // Position of latched ligand
    this.latchedLigandY = 0;

    // Refractory state
    this.refractory = false;       // In refractory period (cooling down after binding)
    this.refractoryTimer = 0;      // Frames elapsed in refractory period
    this.refractoryDuration = 10000; // Effectively permanent for the duration of a test run
    this.refractoryColor = -1;       // Ligand color to fade out during refractory
  }

  // Begin refractory period (called when the drug has been absorbed)
  startRefractory() {
    this.refractory = true;
    this.refractoryTimer = 0;
    this.refractoryColor = this.latchedLigandColor;
    // Clear the latched/bound state so it renders as refractory, not latched
    this.latched = false;
    this.bound = false;
    this.latchedLigandColor = -1;
  }

  // Tick refractory timer. Returns true if refractory just ended.
  updateRefractory() {
    if (!this.refractory) return false;
    this.refractoryTimer++;
    if (this.refractoryTimer >= this.refractoryDuration) {
      this.refractory = false;
      this.refractoryTimer = 0;
      this.refractoryColor = -1;
      return true;
    }
    return false;
  }

  // Render Y-shaped receptor to a graphics context
  render(g) {
    const ang = Math.atan2(this.ny, this.nx);

    if (this.latched) {
      this.renderLatched(g, ang);
    } else if (this.refractory) {
      this.renderRefractory(g, ang);
    } else {
      this.renderOpen(g, ang);
    }
  }

  // Render open (unlatched) receptor
  renderOpen(g, ang) {
    g.strokeWeight(2);

    if (this.bound) {
      g.stroke(150, 150, 150, 120);
    } else if (typeof this.color === 'number' && this.color >= 0) {
      g.stroke(colorForIndex(this.color));
    } else {
      g.stroke(0);
    }

    // Draw stem
    g.line(this.baseX, this.baseY, this.tipX, this.tipY);

    // Draw Y branches (open at 30° each side)
    const a1 = ang + Math.PI / 6;
    const a2 = ang - Math.PI / 6;
    const b1x = this.tipX + Math.cos(a1) * this.branchLen;
    const b1y = this.tipY + Math.sin(a1) * this.branchLen;
    const b2x = this.tipX + Math.cos(a2) * this.branchLen;
    const b2y = this.tipY + Math.sin(a2) * this.branchLen;

    g.line(this.tipX, this.tipY, b1x, b1y);
    g.line(this.tipX, this.tipY, b2x, b2y);

    g.noStroke();
  }

  // Render latched receptor as a filled triangle (Y with fork filled in)
  renderLatched(g, ang) {
    // Determine color
    let col;
    if (typeof this.latchedLigandColor === 'number' && this.latchedLigandColor >= 0) {
      col = colorForIndex(this.latchedLigandColor);
    } else {
      col = colorForIndex(this.color);
    }

    // Draw stem
    g.strokeWeight(2);
    g.stroke(col);
    g.line(this.baseX, this.baseY, this.tipX, this.tipY);

    // Draw filled triangle from tip to the two branch endpoints (Y fork filled in)
    const branchAngle = Math.PI / 6; // 30° same as open Y
    const latchedLen = this.branchLen * 1.2;
    const a1 = ang + branchAngle;
    const a2 = ang - branchAngle;
    const b1x = this.tipX + Math.cos(a1) * latchedLen;
    const b1y = this.tipY + Math.sin(a1) * latchedLen;
    const b2x = this.tipX + Math.cos(a2) * latchedLen;
    const b2y = this.tipY + Math.sin(a2) * latchedLen;

    g.fill(col);
    g.stroke(col);
    g.strokeWeight(1);
    g.triangle(this.tipX, this.tipY, b1x, b1y, b2x, b2y);

    g.noFill();
    g.noStroke();
  }

  // Render receptor during refractory period.
  // The ligand color triangle fades out over refractoryDuration frames,
  // showing how much binding capacity remains.
  renderRefractory(g, ang) {
    const progress = this.refractoryTimer / this.refractoryDuration; // 0 -> 1
    const fadeAlpha = Math.round(Math.max(0, 1 - progress) * 255);  // 255 -> 0

    const receptorCol = colorForIndex(this.color);
    const branchAngle = Math.PI / 6;
    const latchedLen = this.branchLen * 1.2;
    const a1 = ang + branchAngle;
    const a2 = ang - branchAngle;
    const b1x = this.tipX + Math.cos(a1) * latchedLen;
    const b1y = this.tipY + Math.sin(a1) * latchedLen;
    const b2x = this.tipX + Math.cos(a2) * latchedLen;
    const b2y = this.tipY + Math.sin(a2) * latchedLen;

    // Stem in receptor color
    g.strokeWeight(2);
    g.stroke(receptorCol);
    g.line(this.baseX, this.baseY, this.tipX, this.tipY);

    // Fading filled triangle in ligand color
    if (fadeAlpha > 2 && typeof this.refractoryColor === 'number' && this.refractoryColor >= 0) {
      const ligCol = colorForIndex(this.refractoryColor);
      g.fill(g.red(ligCol), g.green(ligCol), g.blue(ligCol), fadeAlpha);
      g.stroke(g.red(ligCol), g.green(ligCol), g.blue(ligCol), fadeAlpha);
      g.strokeWeight(1);
      g.triangle(this.tipX, this.tipY, b1x, b1y, b2x, b2y);
      g.noFill();
    }

    g.noStroke();
  }

  // Check if a point is near this receptor tip
  isNearTip(x, y, radius) {
    const dx = x - this.tipX;
    const dy = y - this.tipY;
    return Math.sqrt(dx * dx + dy * dy) <= radius;
  }
}

// Export for browser global
window.Receptor = Receptor;
