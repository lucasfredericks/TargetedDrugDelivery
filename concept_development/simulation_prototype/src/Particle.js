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

    // Absorption state
    this.absorbing = false;   // Drug is accelerating toward cell center
    this.absorbed = false;    // Drug is inside the cell, drifting gently
    this.targetCell = null;   // Cell being absorbed into
    this.absorbTimer = 0;     // Frames since absorption started

    // Fade-out state (released when host cell dies)
    this.fading = false;
    this.fadeTimer = 0;
    this.fadeDuration = 30;   // 0.5 seconds at 60fps
  }

  // Create a particle spawned at the left edge of a tissue area
  // Particles spawn within the channel (between top and bottom walls)
  static spawn(renderW, renderH, flowSpeed) {
    const x = -20;  // Spawn off-screen to the left
    // Account for wall boundaries (wallThickness ~25px on each side)
    const wallMargin = 40; // Stay clear of walls
    const minY = wallMargin;
    const maxY = renderH - wallMargin;
    const y = Math.random() * (maxY - minY) + minY;

    // Base flow velocity left-to-right with minimal initial turbulence
    const baseVx = flowSpeed;
    const turbulenceX = (Math.random() - 0.5) * 0.4;
    const turbulenceY = (Math.random() - 0.5) * 0.6;

    return new Particle(x, y, baseVx + turbulenceX, turbulenceY);
  }

  // Update particle physics (movement, turbulence, boundaries)
  // If fluidSim is provided, uses GPU-computed fluid velocities instead of Perlin noise
  update(physicsParams, renderW, renderH, frameCount, fluidSim = null) {
    if (this.bound) return;

    // Update position
    this.x += this.vx;
    this.y += this.vy;
    this.angle += this.angVel;

    // Wall boundary collision (top and bottom walls)
    // Wall thickness in render coordinates (matches FluidSimulation wall boundaries)
    const wallThickness = 25; // Slightly larger than fluid sim walls for safety margin
    const bounceRestitution = 0.6; // Energy retained after bounce (0-1)
    const minBounceVel = 0.5; // Minimum velocity after bounce to prevent sticking

    // Top wall bounce
    if (this.y < wallThickness) {
      this.y = wallThickness + 1;
      if (this.vy < 0) {
        this.vy = -this.vy * bounceRestitution;
        // Ensure minimum outward velocity
        if (this.vy < minBounceVel) {
          this.vy = minBounceVel + Math.random() * 0.5;
        }
        // Add slight random deflection
        this.vx += (Math.random() - 0.5) * 0.3;
      }
    }

    // Bottom wall bounce
    if (this.y > renderH - wallThickness) {
      this.y = renderH - wallThickness - 1;
      if (this.vy > 0) {
        this.vy = -this.vy * bounceRestitution;
        // Ensure minimum outward velocity
        if (this.vy > -minBounceVel) {
          this.vy = -minBounceVel - Math.random() * 0.5;
        }
        // Add slight random deflection
        this.vx += (Math.random() - 0.5) * 0.3;
      }
    }

    // Apply turbulence from fluid simulation or Perlin noise
    if (fluidSim && fluidSim.initialized) {
      // GPU fluid-based advection
      const fluidVel = fluidSim.getVelocityAt(this.x, this.y);

      // Blend particle velocity toward fluid velocity
      // Higher blend = more responsive to fluid, lower = more inertia
      const blendFactor = 0.15;
      this.vx = lerp(this.vx, fluidVel.vx + physicsParams.flowSpeed, blendFactor);
      this.vy = lerp(this.vy, fluidVel.vy, blendFactor);
    } else {
      // Fallback: Perlin noise turbulence
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
      const turbulentForceX = (noiseX - 0.5) * 2 * physicsParams.turbulenceStrength * physicsParams.turbulenceX;
      const turbulentForceY = (noiseY - 0.5) * 2 * physicsParams.turbulenceStrength * physicsParams.turbulenceY;

      this.vx += turbulentForceX;
      this.vy += turbulentForceY;

      // Gentle drift back toward base flow speed
      this.vx = lerp(this.vx, physicsParams.flowSpeed, 0.01);
    }

    // Clamp velocity to prevent runaway
    const maxSpeed = physicsParams.flowSpeed * 2.5;
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

  // Bind particle to a single receptor (legacy method)
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

  // Bind particle to multiple receptors with centroid positioning
  // matchedReceptors: array of Receptor objects that matched
  // matchedLigands: array of ligand objects with {index, x, y, angle, color}
  bindToMultiple(matchedReceptors, matchedLigands, spriteSize) {
    if (matchedReceptors.length === 0) return;

    // Calculate centroid of matched receptor tips
    let centroidX = 0;
    let centroidY = 0;
    let avgNx = 0;
    let avgNy = 0;

    for (let receptor of matchedReceptors) {
      centroidX += receptor.tipX;
      centroidY += receptor.tipY;
      avgNx += receptor.nx;
      avgNy += receptor.ny;
    }

    centroidX /= matchedReceptors.length;
    centroidY /= matchedReceptors.length;
    avgNx /= matchedReceptors.length;
    avgNy /= matchedReceptors.length;

    // Normalize average normal
    const normLen = Math.sqrt(avgNx * avgNx + avgNy * avgNy) || 1;
    avgNx /= normLen;
    avgNy /= normLen;

    // Position particle so ligands touch receptor tips
    // Offset from centroid along the average outward normal
    const offsetDist = spriteSize * 0.3;
    this.x = centroidX + avgNx * offsetDist;
    this.y = centroidY + avgNy * offsetDist;

    // Orient particle so it faces the cell (opposite to outward normal)
    this.angle = Math.atan2(-avgNy, -avgNx) + Math.PI / 2;

    // Stop motion
    this.vx = 0;
    this.vy = 0;
    this.angVel = 0;
    this.bound = true;

    // Store binding info for potential visual feedback
    this.boundReceptors = matchedReceptors;
    this.boundLigands = matchedLigands;

    // Mark all matched receptors as bound and latched
    for (let i = 0; i < matchedReceptors.length; i++) {
      const receptor = matchedReceptors[i];
      const ligand = matchedLigands[i];
      receptor.bound = true;
      receptor.latched = true;
      receptor.latchedLigandColor = ligand.color;
      // Store the ligand's world position for visual connection
      receptor.latchedLigandX = ligand.x;
      receptor.latchedLigandY = ligand.y;
    }
  }

  // Bind particle via matched node pairs
  // matchedParticleNodes: array of particle node objects
  // matchedCellNodes: array of cell receptor node objects
  bindToNodes(matchedParticleNodes, matchedCellNodes, spriteSize) {
    if (matchedCellNodes.length === 0) return;

    // Calculate centroid of matched cell nodes
    let centroidX = 0;
    let centroidY = 0;

    for (let node of matchedCellNodes) {
      centroidX += node.x;
      centroidY += node.y;
    }

    centroidX /= matchedCellNodes.length;
    centroidY /= matchedCellNodes.length;

    // Calculate average outward direction from cell center
    // (Use the first matched cell node's receptors to get the cell center)
    const firstNode = matchedCellNodes[0];
    const cellCx = (firstNode.receptor1.baseX + firstNode.receptor2.baseX) / 2;
    const cellCy = (firstNode.receptor1.baseY + firstNode.receptor2.baseY) / 2;

    let avgNx = centroidX - cellCx;
    let avgNy = centroidY - cellCy;
    const normLen = Math.sqrt(avgNx * avgNx + avgNy * avgNy) || 1;
    avgNx /= normLen;
    avgNy /= normLen;

    // Position particle with offset from centroid
    const offsetDist = spriteSize * 0.3;
    this.x = centroidX + avgNx * offsetDist;
    this.y = centroidY + avgNy * offsetDist;

    // Orient particle to face the cell
    this.angle = Math.atan2(-avgNy, -avgNx) + Math.PI / 2;

    // Stop motion
    this.vx = 0;
    this.vy = 0;
    this.angVel = 0;
    this.bound = true;

    // Mark all matched cell nodes and their receptors as bound
    for (let i = 0; i < matchedCellNodes.length; i++) {
      const cellNode = matchedCellNodes[i];
      const particleNode = matchedParticleNodes[i];

      cellNode.bound = true;

      // Also mark the two receptors forming this node as bound/latched
      cellNode.receptor1.bound = true;
      cellNode.receptor1.latched = true;
      cellNode.receptor1.latchedLigandColor = particleNode.color1;

      cellNode.receptor2.bound = true;
      cellNode.receptor2.latched = true;
      cellNode.receptor2.latchedLigandColor = particleNode.color2;
    }
  }

  // Begin absorption: drug hexagon accelerates toward cell center
  startAbsorption(cell, boundReceptors) {
    this.absorbing = true;
    this.absorbed = false;
    this.bound = true; // keep it flagged as bound so normal physics skip it
    this.targetCell = cell;
    this.absorbTimer = 0;
    this.angVel = 0;
    this.boundReceptorList = boundReceptors || []; // receptors to put into refractory
  }

  // Update absorption physics each frame
  updateAbsorption(physicsParams, frameCount) {
    if (this.absorbing && !this.absorbed) {
      this.absorbTimer++;

      // Accelerate toward cell center
      const dx = this.targetCell.cx - this.x;
      const dy = this.targetCell.cy - this.y;
      const dist = Math.sqrt(dx * dx + dy * dy);

      // Transition to absorbed once inside the cell membrane
      // Keep momentum so the drug carries inward and bounces around
      const membraneRadius = this.targetCell.radius * 0.85;
      if (dist < membraneRadius) {
        this.absorbing = false;
        this.absorbed = true;
        // Dampen entry speed but keep direction
        this.vx *= 0.4;
        this.vy *= 0.4;
        // Increment the cell's absorbed drug counter
        this.targetCell.absorbedDrugs++;
        // Trigger refractory period on the receptors that captured this drug
        for (let r of this.boundReceptorList) {
          r.startRefractory();
        }
        this.boundReceptorList = [];
        return;
      }

      // Accelerate toward center to push through membrane
      const accel = 0.8 + this.absorbTimer * 0.1;
      const nx = dx / dist;
      const ny = dy / dist;
      this.vx += nx * accel;
      this.vy += ny * accel;

      // Clamp speed
      const maxAbsorbSpeed = 12;
      const speed = Math.sqrt(this.vx * this.vx + this.vy * this.vy);
      if (speed > maxAbsorbSpeed) {
        this.vx = (this.vx / speed) * maxAbsorbSpeed;
        this.vy = (this.vy / speed) * maxAbsorbSpeed;
      }

      this.x += this.vx;
      this.y += this.vy;
      this.angle += 0.05; // gentle spin during absorption
    } else if (this.absorbed) {
      // Gentle drag to slowly lose speed over time
      this.vx *= 0.995;
      this.vy *= 0.995;

      // Small Perlin noise nudges (additive, not replacing velocity)
      const noiseScale = physicsParams.turbulenceScale * 2;
      const noiseIntensity = 0.08;
      const noiseX = noise(
        this.x * noiseScale + 500,
        this.y * noiseScale + 500,
        frameCount * 0.005
      );
      const noiseY = noise(
        this.x * noiseScale + 1500,
        this.y * noiseScale + 500,
        frameCount * 0.005
      );

      this.vx += (noiseX - 0.5) * 2 * physicsParams.turbulenceStrength * noiseIntensity;
      this.vy += (noiseY - 0.5) * 2 * physicsParams.turbulenceStrength * noiseIntensity;

      this.x += this.vx;
      this.y += this.vy;
      this.angle += 0.01;

      // Bounce off inner cell wall
      const dx = this.x - this.targetCell.cx;
      const dy = this.y - this.targetCell.cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const wallRadius = this.targetCell.radius * 0.8;
      if (dist > wallRadius) {
        // Reflect velocity off the inner membrane
        const nx = dx / dist;
        const ny = dy / dist;
        const vDotN = this.vx * nx + this.vy * ny;
        if (vDotN > 0) {
          this.vx -= 2 * vDotN * nx;
          this.vy -= 2 * vDotN * ny;
          // Lose a little energy on bounce
          this.vx *= 0.8;
          this.vy *= 0.8;
        }
        // Push back inside
        this.x = this.targetCell.cx + nx * (wallRadius - 1);
        this.y = this.targetCell.cy + ny * (wallRadius - 1);
      }
    }
  }

  // Release particle from its cell and begin fade-out (called when host cell dies)
  startFading() {
    this.fading = true;
    this.fadeTimer = 0;
    this.absorbing = false;
    this.absorbed = false;
    this.bound = false;
    this.targetCell = null;
    this.boundReceptorList = [];
    // Give a small random scatter kick so they don't all sit in the same spot
    const angle = Math.random() * Math.PI * 2;
    this.vx += Math.cos(angle) * 0.5;
    this.vy += Math.sin(angle) * 0.5;
  }

  // Update physics for a fading particle (turbulence drift, no cell interaction)
  updateFading(physicsParams, frameCount) {
    this.fadeTimer++;
    const noiseScale = physicsParams.turbulenceScale * 2;
    const noiseX = noise(this.x * noiseScale + 500, this.y * noiseScale + 500, frameCount * 0.005);
    const noiseY = noise(this.x * noiseScale + 1500, this.y * noiseScale + 500, frameCount * 0.005);
    this.vx += (noiseX - 0.5) * 2 * physicsParams.turbulenceStrength * 0.06;
    this.vy += (noiseY - 0.5) * 2 * physicsParams.turbulenceStrength * 0.06;
    this.vx *= 0.99;
    this.vy *= 0.99;
    this.x += this.vx;
    this.y += this.vy;
    this.angle += 0.02;
  }

  isFadeExpired() {
    return this.fading && this.fadeTimer >= this.fadeDuration;
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
  render(g, sprite, spriteSize, toxicity) {
    if (this.fading) {
      const fadeAlpha = Math.round(255 * (1 - this.fadeTimer / this.fadeDuration));
      this.renderDrugHexagon(g, spriteSize, toxicity, fadeAlpha);
      return;
    }

    if (this.absorbing || this.absorbed) {
      // Draw only the drug hexagon (no ligands)
      this.renderDrugHexagon(g, spriteSize, toxicity);
      return;
    }

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

  // Render just the drug hexagon (during/after absorption, or while fading)
  renderDrugHexagon(g, spriteSize, toxicity, alphaOverride) {
    const hexR = spriteSize * 0.35;
    const alpha = alphaOverride !== undefined ? alphaOverride : (this.absorbed ? 200 : 255);

    g.push();
    g.translate(this.x, this.y);
    g.rotate(this.angle);

    const toxColor = TOXICITY_COLORS[toxicity] || TOXICITY_COLORS[2];
    g.fill(g.red(g.color(toxColor)), g.green(g.color(toxColor)), g.blue(g.color(toxColor)), alpha);
    g.stroke(34, 34, 34, alpha);
    g.strokeWeight(0.6);
    g.beginShape();
    for (let i = 0; i < 6; i++) {
      const a = -Math.PI / 2 + i * Math.PI * 2 / 6;
      g.vertex(Math.cos(a) * hexR, Math.sin(a) * hexR);
    }
    g.endShape(CLOSE);
    g.noStroke();
    g.pop();
  }
}

// Export for browser global
window.Particle = Particle;
