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
  }

  // Render Y-shaped receptor to a graphics context
  render(g) {
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

    // Draw Y branches
    const ang = Math.atan2(this.ny, this.nx);
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

  // Check if a point is near this receptor tip
  isNearTip(x, y, radius) {
    const dx = x - this.tipX;
    const dy = y - this.tipY;
    return Math.sqrt(dx * dx + dy * dy) <= radius;
  }
}

// Export for browser global
window.Receptor = Receptor;
