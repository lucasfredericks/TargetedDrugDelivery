// TracerParticle.js - Lightweight flow-visualization particles
// Thousands of tiny dots that follow the fluid velocity field,
// making the microfluidic environment visible. No cell interaction.

class TracerParticle {
  constructor(x, y, vx, vy) {
    this.x = x;
    this.y = y;
    this.vx = vx;
    this.vy = vy;
    this.age = 0;
    this.lifetime = 120 + Math.floor(Math.random() * 120); // 2-4 seconds at 60fps

    // Trail ring buffer (last N positions for fading trail)
    this.trailLength = 5;
    this.trail = [];
  }

  // Spawn a tracer at the left edge
  static spawnLeft(renderW, renderH, flowSpeed) {
    const wallMargin = 30;
    const x = -5;
    const y = Math.random() * (renderH - 2 * wallMargin) + wallMargin;
    const vx = flowSpeed * (0.8 + Math.random() * 0.4);
    const vy = (Math.random() - 0.5) * 0.3;
    return new TracerParticle(x, y, vx, vy);
  }

  // Spawn a tracer at a random position (for initial fill)
  static spawnRandom(renderW, renderH, flowSpeed) {
    const wallMargin = 30;
    const x = Math.random() * renderW;
    const y = Math.random() * (renderH - 2 * wallMargin) + wallMargin;
    const vx = flowSpeed * (0.8 + Math.random() * 0.4);
    const vy = (Math.random() - 0.5) * 0.3;
    const t = new TracerParticle(x, y, vx, vy);
    // Randomize age so they don't all expire at once
    t.age = Math.floor(Math.random() * t.lifetime * 0.7);
    return t;
  }

  // Update physics (follows fluid or Perlin noise, no cell collision)
  update(physicsParams, renderW, renderH, frameCount, fluidSim) {
    this.age++;

    // Store trail position before moving
    this.trail.push({ x: this.x, y: this.y });
    if (this.trail.length > this.trailLength) {
      this.trail.shift();
    }

    // Move
    this.x += this.vx;
    this.y += this.vy;

    // Wall bounce (soft)
    const wallThickness = 25;
    if (this.y < wallThickness) {
      this.y = wallThickness + 1;
      this.vy = Math.abs(this.vy) * 0.5;
    }
    if (this.y > renderH - wallThickness) {
      this.y = renderH - wallThickness - 1;
      this.vy = -Math.abs(this.vy) * 0.5;
    }

    // Advection from fluid or Perlin noise
    if (fluidSim && fluidSim.initialized) {
      const fluidVel = fluidSim.getVelocityAt(this.x, this.y);
      const blend = 0.2;
      this.vx = lerp(this.vx, fluidVel.vx + physicsParams.flowSpeed, blend);
      this.vy = lerp(this.vy, fluidVel.vy, blend);
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

  // Whether this tracer should be recycled
  isExpired() {
    return this.age >= this.lifetime;
  }

  isOutOfBounds(renderW, renderH) {
    return this.x > renderW + 20 || this.x < -20 ||
           this.y > renderH + 20 || this.y < -20;
  }

  // Render tracer dot + fading trail
  render(g) {
    // Fade in over first 10 frames, fade out over last 30 frames
    const fadeIn = Math.min(1, this.age / 10);
    const remaining = this.lifetime - this.age;
    const fadeOut = Math.min(1, remaining / 30);
    const baseAlpha = fadeIn * fadeOut;

    if (baseAlpha <= 0) return;

    // Draw trail lines (fading from old to new)
    if (this.trail.length > 1) {
      for (let i = 1; i < this.trail.length; i++) {
        const trailAlpha = (i / this.trail.length) * baseAlpha * 40;
        g.stroke(200, 210, 230, trailAlpha);
        g.strokeWeight(1);
        g.line(this.trail[i - 1].x, this.trail[i - 1].y,
               this.trail[i].x, this.trail[i].y);
      }

      // Line from last trail point to current position
      const trailAlpha = baseAlpha * 50;
      g.stroke(200, 210, 230, trailAlpha);
      g.strokeWeight(1);
      const last = this.trail[this.trail.length - 1];
      g.line(last.x, last.y, this.x, this.y);
    }

    // Draw dot
    const dotAlpha = baseAlpha * 70;
    g.noStroke();
    g.fill(210, 220, 240, dotAlpha);
    g.circle(this.x, this.y, 2);
  }
}

// Export for browser global
window.TracerParticle = TracerParticle;
