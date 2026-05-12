// Receptor.js - U-shaped receptor entity (closes into a filled quad on binding)

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

    // Refractory state (duration lives in RECEPTOR_DEFAULTS so it can be tweaked live)
    this.refractory = false;       // In refractory period (cooling down after binding)
    this.refractoryTimer = 0;      // Frames elapsed in refractory period
    this.refractoryColor = -1;     // Ligand color to fade out during refractory
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
    if (this.refractoryTimer >= window.RECEPTOR_DEFAULTS.refractoryDurationFrames) {
      this.refractory = false;
      this.refractoryTimer = 0;
      this.refractoryColor = -1;
      return true;
    }
    return false;
  }

  // Render U-shaped receptor to a graphics context
  render(g) {
    if (this.latched) {
      this.renderLatched(g);
    } else if (this.refractory) {
      this.renderRefractory(g);
    } else {
      this.renderOpen(g);
    }
  }

  // Compute the four U-shape vertices around the tip.
  // scale = 1 for the open shape, RECEPTOR_DEFAULTS.latchedScale when bound.
  // Bottom segment is perpendicular to the stem at the tip; arms rise from
  // each end of it, splayed outward by armAngleDeg from the stem axis.
  _uGeometry(scale) {
    const cfg = window.RECEPTOR_DEFAULTS;
    const halfWidth = this.branchLen * cfg.baseWidthScale * 0.5 * scale;
    const armLen = this.branchLen * cfg.armLenScale * scale;
    const armAng = (cfg.armAngleDeg * Math.PI) / 180;
    const cosA = Math.cos(armAng);
    const sinA = Math.sin(armAng);

    // Perpendicular to the outward normal
    const px = -this.ny;
    const py = this.nx;

    // Bottom segment endpoints
    const b1x = this.tipX + px * halfWidth;
    const b1y = this.tipY + py * halfWidth;
    const b2x = this.tipX - px * halfWidth;
    const b2y = this.tipY - py * halfWidth;

    // Arm directions: stem direction rotated outward by ±armAng
    const arm1DirX = this.nx * cosA + px * sinA;
    const arm1DirY = this.ny * cosA + py * sinA;
    const arm2DirX = this.nx * cosA - px * sinA;
    const arm2DirY = this.ny * cosA - py * sinA;

    return {
      b1x, b1y, b2x, b2y,
      t1x: b1x + arm1DirX * armLen,
      t1y: b1y + arm1DirY * armLen,
      t2x: b2x + arm2DirX * armLen,
      t2y: b2y + arm2DirY * armLen
    };
  }

  // Render open (unlatched) receptor — stem + flat bottom + two arms (no top)
  renderOpen(g) {
    g.strokeWeight(2);

    if (this.bound) {
      g.stroke(150, 150, 150, 120);
    } else if (typeof this.color === 'number' && this.color >= 0) {
      g.stroke(colorForIndex(this.color));
    } else {
      g.stroke(0);
    }

    g.line(this.baseX, this.baseY, this.tipX, this.tipY);

    const u = this._uGeometry(1);
    g.line(u.b1x, u.b1y, u.b2x, u.b2y);   // flat bottom
    g.line(u.b1x, u.b1y, u.t1x, u.t1y);   // arm 1
    g.line(u.b2x, u.b2y, u.t2x, u.t2y);   // arm 2

    g.noStroke();
  }

  // Render latched receptor — arms collapse inward to a single apex,
  // forming a filled triangle around the ligand
  renderLatched(g) {
    let col;
    if (typeof this.latchedLigandColor === 'number' && this.latchedLigandColor >= 0) {
      col = colorForIndex(this.latchedLigandColor);
    } else {
      col = colorForIndex(this.color);
    }

    g.strokeWeight(2);
    g.stroke(col);
    g.line(this.baseX, this.baseY, this.tipX, this.tipY);

    const u = this._uGeometry(window.RECEPTOR_DEFAULTS.latchedScale);
    const apexX = (u.t1x + u.t2x) / 2;
    const apexY = (u.t1y + u.t2y) / 2;

    g.fill(col);
    g.stroke(col);
    g.strokeWeight(1);
    g.triangle(u.b1x, u.b1y, apexX, apexY, u.b2x, u.b2y);

    g.noFill();
    g.noStroke();
  }

  // Render receptor during refractory period.
  // The ligand-colored fill fades out over refractoryDuration frames,
  // showing how much binding capacity remains.
  renderRefractory(g) {
    const progress = this.refractoryTimer / window.RECEPTOR_DEFAULTS.refractoryDurationFrames; // 0 -> 1
    const fadeAlpha = Math.round(Math.max(0, 1 - progress) * 255);  // 255 -> 0

    const receptorCol = colorForIndex(this.color);
    const u = this._uGeometry(window.RECEPTOR_DEFAULTS.latchedScale);
    const apexX = (u.t1x + u.t2x) / 2;
    const apexY = (u.t1y + u.t2y) / 2;

    // Stem in receptor color
    g.strokeWeight(2);
    g.stroke(receptorCol);
    g.line(this.baseX, this.baseY, this.tipX, this.tipY);

    // Fading fill in ligand color, but stroke stays fully opaque
    if (typeof this.refractoryColor === 'number' && this.refractoryColor >= 0) {
      const ligCol = colorForIndex(this.refractoryColor);
      g.stroke(ligCol);
      g.strokeWeight(1);
      if (fadeAlpha > 2) {
        g.fill(g.red(ligCol), g.green(ligCol), g.blue(ligCol), fadeAlpha);
      } else {
        g.noFill();
      }
      g.triangle(u.b1x, u.b1y, apexX, apexY, u.b2x, u.b2y);
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
