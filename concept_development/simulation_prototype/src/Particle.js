// Particle.js - Particle entity with physics

class Particle {
  constructor(x, y, vx, vy) {
    this.x = x;
    this.y = y;
    this.vx = vx;
    this.vy = vy;
    this.angle = Math.random() * Math.PI * 2;
    this.angVel = (Math.random() - 0.5) * 0.06;
    this.bound = false;
    this.cellIndex = -1;    // Index of nearest cell (for collision tracking)
  }

  // Create a particle spawned at the left edge of a tissue area
  static spawn(renderW, renderH, flowSpeed) {
    const x = -20;  // Spawn off-screen to the left
    const y = Math.random() * (renderH - 20) + 10;

    // Base flow velocity left-to-right with minimal initial turbulence
    const baseVx = flowSpeed;
    const turbulenceX = (Math.random() - 0.5) * 0.4;
    const turbulenceY = (Math.random() - 0.5) * 0.6;

    return new Particle(x, y, baseVx + turbulenceX, turbulenceY);
  }

  // Update particle physics (movement, turbulence, boundaries)
  update(physicsParams, renderW, renderH, frameCount) {
    if (this.bound) return;

    // Update position
    this.x += this.vx;
    this.y += this.vy;
    this.angle += this.angVel;

    // Soft boundary forces (push particles back into channel)
    const boundaryMargin = 20;
    const boundaryForce = 0.3;

    if (this.y < boundaryMargin) {
      const dist = boundaryMargin - this.y;
      this.vy += (dist / boundaryMargin) * boundaryForce;
    }
    if (this.y > renderH - boundaryMargin) {
      const dist = this.y - (renderH - boundaryMargin);
      this.vy -= (dist / boundaryMargin) * boundaryForce;
    }

    // Apply continuous turbulence using Perlin noise
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

    // Map noise (0-1) to turbulent forces
    const turbulentForceX = (noiseX - 0.5) * 2 * physicsParams.turbulenceStrength * 0.1;
    const turbulentForceY = (noiseY - 0.5) * 2 * physicsParams.turbulenceStrength * 0.3;

    this.vx += turbulentForceX;
    this.vy += turbulentForceY;

    // Gentle drift back toward base flow speed
    this.vx = lerp(this.vx, physicsParams.flowSpeed, 0.01);

    // Clamp velocity to prevent runaway
    const maxSpeed = physicsParams.flowSpeed * 2;
    const speed = Math.sqrt(this.vx * this.vx + this.vy * this.vy);
    if (speed > maxSpeed) {
      this.vx = (this.vx / speed) * maxSpeed;
      this.vy = (this.vy / speed) * maxSpeed;
    }
  }

  // Check if particle is out of bounds and should be removed
  isOutOfBounds(renderW, renderH, margin = 50) {
    return (
      this.x > renderW + margin ||
      this.x < -margin ||
      this.y > renderH + margin ||
      this.y < -margin
    );
  }

  // Bind particle to a receptor
  bindTo(receptor, spriteSize) {
    const offsetDist = spriteSize * 0.5 + 2;
    this.x = receptor.tipX + receptor.nx * offsetDist;
    this.y = receptor.tipY + receptor.ny * offsetDist;
    this.vx = 0;
    this.vy = 0;
    this.angVel = 0;
    this.bound = true;
    this.angle = Math.atan2(receptor.ny, receptor.nx);
    receptor.bound = true;
  }

  // Deflect particle around a cell
  deflectAroundCell(cell, spriteRadius, flowSpeed) {
    const dx = this.x - cell.cx;
    const dy = this.y - cell.cy;
    const d = Math.sqrt(dx * dx + dy * dy) || 0.0001;
    const nx = dx / d;
    const ny = dy / d;

    // Push particle outside collision radius
    const pushOut = cell.radius + spriteRadius + 2;
    this.x = cell.cx + nx * pushOut;
    this.y = cell.cy + ny * pushOut;

    // Deflect velocity to flow around the cell
    const vDotN = this.vx * nx + this.vy * ny;
    if (vDotN < 0) {
      this.vx = this.vx - 2 * vDotN * nx;
      this.vy = this.vy - 2 * vDotN * ny;

      // Ensure rightward component is maintained
      if (this.vx < flowSpeed * 0.5) {
        this.vx = flowSpeed * 0.5 + Math.random() * 0.2;
      }
    }
  }

  // Render particle to a graphics context
  render(g, sprite, spriteSize) {
    if (sprite) {
      g.push();
      g.translate(this.x, this.y);
      g.rotate(this.angle);
      if (this.bound) {
        g.tint(255, 180);
      }
      g.imageMode(CENTER);
      g.image(sprite, 0, 0, spriteSize, spriteSize);
      if (this.bound) {
        g.noTint();
      }
      g.pop();
    } else {
      // Fallback: draw simple circle
      g.fill(this.bound ? 180 : 120);
      g.circle(this.x, this.y, 4);
    }
  }
}

// Export for browser global
window.Particle = Particle;
