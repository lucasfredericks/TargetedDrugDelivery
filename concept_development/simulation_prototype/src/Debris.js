// Debris.js - Free-floating ligand debris after drug absorption
// These are the ligand triangles left behind when the drug hexagon enters the cell.
// They float freely in the fluid, affected by turbulence and cell collisions,
// but do NOT interact with receptors.

class Debris {
  constructor(x, y, vx, vy, angle, colorIndex) {
    this.x = x;
    this.y = y;
    this.vx = vx;
    this.vy = vy;
    this.angle = angle;
    this.angVel = (Math.random() - 0.5) * 0.08;
    this.colorIndex = colorIndex;  // Ligand color (0-5)
    this.age = 0;                  // Frames since spawn
    this.lifetime = 180;           // 3 seconds at 60fps
  }

  // Create debris pieces from a bound particle's ligand positions
  static spawnFromParticle(particle, ligandPositions, spriteSize) {
    const debris = [];
    const hexR = spriteSize * 0.35;
    const apothem = hexR * Math.cos(Math.PI / 6);
    const triH = hexR * 0.7;
    const ligandDist = apothem - 1 + triH * 0.5; // center of the triangle

    for (let i = 0; i < 6; i++) {
      if (ligandPositions[i] === -1) continue; // skip empty slots

      // World position of this ligand
      const localAngle = -Math.PI / 2 + (i + 0.5) * Math.PI / 3;
      const worldAngle = particle.angle + localAngle;

      const lx = particle.x + Math.cos(worldAngle) * ligandDist;
      const ly = particle.y + Math.sin(worldAngle) * ligandDist;

      // Small outward scatter velocity
      const scatter = 0.5 + Math.random() * 0.5;
      const svx = Math.cos(worldAngle) * scatter + (Math.random() - 0.5) * 0.3;
      const svy = Math.sin(worldAngle) * scatter + (Math.random() - 0.5) * 0.3;

      debris.push(new Debris(lx, ly, svx, svy, worldAngle, ligandPositions[i]));
    }
    return debris;
  }

  // Whether this debris has expired
  isExpired() {
    return this.age >= this.lifetime;
  }

  // Current opacity (0-255), fading over lifetime
  getAlpha() {
    const fadeStart = 0.4; // start fading at 40% of lifetime
    const progress = this.age / this.lifetime;
    if (progress < fadeStart) return 255;
    return Math.round(255 * (1 - (progress - fadeStart) / (1 - fadeStart)));
  }

  // Update physics (same as a free particle but no binding)
  update(physicsParams, renderW, renderH, frameCount, fluidSim, cells) {
    this.age++;
    this.x += this.vx;
    this.y += this.vy;
    this.angle += this.angVel;

    // Wall bouncing
    const wallThickness = 25;
    if (this.y < wallThickness) {
      this.y = wallThickness + 1;
      if (this.vy < 0) this.vy = -this.vy * 0.6;
    }
    if (this.y > renderH - wallThickness) {
      this.y = renderH - wallThickness - 1;
      if (this.vy > 0) this.vy = -this.vy * 0.6;
    }

    // Bounce off cells
    if (cells) {
      for (let cell of cells) {
        const dx = this.x - cell.cx;
        const dy = this.y - cell.cy;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const minDist = cell.radius + 4;
        if (dist < minDist) {
          const nx = dx / (dist || 1);
          const ny = dy / (dist || 1);
          this.x = cell.cx + nx * (minDist + 1);
          this.y = cell.cy + ny * (minDist + 1);
          const vDotN = this.vx * nx + this.vy * ny;
          if (vDotN < 0) {
            this.vx -= 2 * vDotN * nx;
            this.vy -= 2 * vDotN * ny;
          }
        }
      }
    }

    // Turbulence
    if (fluidSim && fluidSim.initialized) {
      const fluidVel = fluidSim.getVelocityAt(this.x, this.y);
      const blendFactor = 0.15;
      this.vx = lerp(this.vx, fluidVel.vx + physicsParams.flowSpeed, blendFactor);
      this.vy = lerp(this.vy, fluidVel.vy, blendFactor);
    } else {
      const noiseX = noise(
        this.x * physicsParams.turbulenceScale,
        this.y * physicsParams.turbulenceScale,
        frameCount * 0.01
      );
      const noiseY = noise(
        this.x * physicsParams.turbulenceScale + 1000,
        this.y * physicsParams.turbulenceScale,
        frameCount * 0.01
      );
      this.vx += (noiseX - 0.5) * 2 * physicsParams.turbulenceStrength * physicsParams.turbulenceX;
      this.vy += (noiseY - 0.5) * 2 * physicsParams.turbulenceStrength * physicsParams.turbulenceY;
      this.vx = lerp(this.vx, physicsParams.flowSpeed, 0.01);
    }

    // Clamp velocity
    const maxSpeed = physicsParams.flowSpeed * 2.5;
    const speed = Math.sqrt(this.vx * this.vx + this.vy * this.vy);
    if (speed > maxSpeed) {
      this.vx = (this.vx / speed) * maxSpeed;
      this.vy = (this.vy / speed) * maxSpeed;
    }
  }

  // Check if out of bounds
  isOutOfBounds(renderW, renderH, margin = 50) {
    return (
      this.x > renderW + margin ||
      this.x < -margin ||
      this.y > renderH + margin ||
      this.y < -margin
    );
  }

  // Render a single ligand triangle (with fade)
  render(g, spriteSize) {
    const alpha = this.getAlpha();
    if (alpha <= 0) return;

    const hexR = spriteSize * 0.35;
    const triH = hexR * 0.7;
    const triS = (2 * triH) / Math.sqrt(3);
    const halfBase = triS / 2;

    g.push();
    g.translate(this.x, this.y);
    g.rotate(this.angle);

    // Triangle pointing "up" in local space (tip at top, base at bottom)
    const tipY = -triH * 0.5;
    const baseY = triH * 0.5;

    const col = colorForIndex(this.colorIndex);
    g.noStroke();
    g.fill(g.red(col), g.green(col), g.blue(col), alpha);
    g.triangle(0, tipY, -halfBase, baseY, halfBase, baseY);
    g.pop();
  }
}

// Export for browser global
window.Debris = Debris;
