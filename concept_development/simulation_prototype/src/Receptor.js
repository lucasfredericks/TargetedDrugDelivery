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
  }

  // Render Y-shaped receptor to a graphics context
  render(g) {
    const ang = Math.atan2(this.ny, this.nx);

    if (this.latched) {
      // Latched state: branches close around the ligand
      this.renderLatched(g, ang);
    } else {
      // Normal state: open Y-shape
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

  // Render latched (closed) receptor gripping the ligand
  renderLatched(g, ang) {
    g.strokeWeight(2.5);

    // Use the ligand's color for the latched receptor (shows successful binding)
    if (typeof this.latchedLigandColor === 'number' && this.latchedLigandColor >= 0) {
      g.stroke(colorForIndex(this.latchedLigandColor));
    } else {
      g.stroke(colorForIndex(this.color));
    }

    // Draw stem
    g.line(this.baseX, this.baseY, this.tipX, this.tipY);

    // Closed branches: pinch together (5° instead of 30°)
    const closedAngle = Math.PI / 36;  // ~5 degrees
    const a1 = ang + closedAngle;
    const a2 = ang - closedAngle;

    // Extend branches slightly when latched
    const latchedLen = this.branchLen * 1.2;
    const b1x = this.tipX + Math.cos(a1) * latchedLen;
    const b1y = this.tipY + Math.sin(a1) * latchedLen;
    const b2x = this.tipX + Math.cos(a2) * latchedLen;
    const b2y = this.tipY + Math.sin(a2) * latchedLen;

    g.line(this.tipX, this.tipY, b1x, b1y);
    g.line(this.tipX, this.tipY, b2x, b2y);

    // Draw a small circle at the grip point to emphasize the latch
    g.noStroke();
    if (typeof this.latchedLigandColor === 'number' && this.latchedLigandColor >= 0) {
      g.fill(colorForIndex(this.latchedLigandColor));
    } else {
      g.fill(colorForIndex(this.color));
    }
    const gripX = this.tipX + Math.cos(ang) * (latchedLen * 0.6);
    const gripY = this.tipY + Math.sin(ang) * (latchedLen * 0.6);
    g.circle(gripX, gripY, 4);

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
