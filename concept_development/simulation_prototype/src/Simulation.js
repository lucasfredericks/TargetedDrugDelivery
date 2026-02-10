// Simulation.js - Core simulation class for a single tissue

class Simulation {
  /**
   * Create a new Simulation instance
   * @param {Object} config Configuration object
   * @param {Object} config.tissue - Tissue configuration {name, receptors[6]}
   * @param {Array} config.ligandPositions - Length-6 array of color indices (-1 to 5)
   * @param {number} config.toxicity - Drug toxicity multiplier (1, 2, or 3)
   * @param {number} config.fidelity - Simulation fidelity (0.0 to 1.0)
   * @param {number} config.width - Render width (default 1920)
   * @param {number} config.height - Render height (default 1080)
   * @param {number} config.tissueIndex - Index of this tissue in puzzle (for single-tissue mode)
   */
  constructor(config) {
    // Tissue configuration
    this.tissue = config.tissue || { name: 'Tissue', receptors: [0, 0, 0, 0, 0, 0] };
    this.tissueIndex = config.tissueIndex !== undefined ? config.tissueIndex : 0;

    // Drug parameters
    this.ligandPositions = config.ligandPositions ? config.ligandPositions.slice(0, 6) : [-1, -1, -1, -1, -1, -1];
    this.toxicity = config.toxicity || 2;
    this.fidelity = config.fidelity || 0.8;

    // Render dimensions
    this.width = config.width || RENDER_RESOLUTION.width;
    this.height = config.height || RENDER_RESOLUTION.height;

    // Physics parameters
    this.physicsParams = {
      flowSpeed: PHYSICS_DEFAULTS.flowSpeed,
      turbulenceScale: PHYSICS_DEFAULTS.turbulenceScale,
      turbulenceStrength: PHYSICS_DEFAULTS.turbulenceStrength,
      cellsPerTissue: PHYSICS_DEFAULTS.cellsPerTissue,
      particleSpriteSize: PHYSICS_DEFAULTS.particleSpriteSize
    };

    // Internal state
    this.particles = [];
    this.cells = [];
    this.buffer = null;
    this.particleSprite = null;
    this.initialized = false;

    // Test mode state
    this.testMode = false;
    this.testParticlesTotal = 0;
    this.testParticlesReleased = 0;
    this.testStartFrame = 0;
    this.testDuration = PHYSICS_DEFAULTS.testDuration;

    // Statistics
    this.bound = 0;
    this.attempts = 0;
  }

  /**
   * Initialize the simulation (create buffer, generate cells, build sprite)
   * Must be called after p5 setup
   */
  initialize() {
    // Create off-screen buffer at full resolution
    this.buffer = createGraphics(this.width, this.height);
    this.buffer.noStroke();

    // Generate cells
    this.generateCells();

    // Generate particle sprite
    this.regenerateSprite();

    this.initialized = true;
  }

  /**
   * Generate cells for this tissue
   */
  generateCells() {
    this.cells = [];
    // Store base radius range for later use when updating concentrations
    this.minCellRadius = Math.min(this.width, this.height) * 0.08;
    this.maxCellRadius = Math.min(this.width, this.height) * 0.12;

    // Minimum padding = 2x nanoparticle diameter
    const nanoparticleDiameter = this.physicsParams.particleSpriteSize;
    this.minCellPadding = nanoparticleDiameter * 2;

    const maxAttempts = 200;

    // Calculate max possible radius (for margin calculation)
    // This accounts for expression scaling: maxCellRadius * maxSizeFactor
    const maxPossibleRadius = this.maxCellRadius * (EXPRESSION_SCALING?.maxSizeFactor || 1.2);

    // Calculate number of cells to fill screen space
    const targetCoverage = 1.0;
    const screenArea = this.width * this.height;
    const avgBaseRadius = (this.minCellRadius + this.maxCellRadius) / 2;
    // Account for average expression scaling (assume ~50% expression on average)
    const avgSizeFactor = (EXPRESSION_SCALING?.minSizeFactor + EXPRESSION_SCALING?.maxSizeFactor) / 2 || 0.9;
    const avgRadius = avgBaseRadius * avgSizeFactor;
    // Effective footprint includes the cell plus half the padding on each side
    const effectiveRadius = avgRadius + this.minCellPadding / 2;
    const avgCellFootprint = Math.PI * effectiveRadius * effectiveRadius;
    const targetCellCount = Math.floor((targetCoverage * screenArea) / avgCellFootprint);
    // Clamp to reasonable range
    const cellCount = Math.max(5, Math.min(50, targetCellCount));

    for (let i = 0; i < cellCount; i++) {
      let placed = false;
      let attemptCount = 0;

      while (!placed && attemptCount < maxAttempts) {
        const margin = maxPossibleRadius + this.minCellPadding;
        const cx = Math.random() * (this.width - 2 * margin) + margin;
        const cy = Math.random() * (this.height - 2 * margin) + margin;
        // Base radius before expression scaling
        const baseRadius = Math.random() * (this.maxCellRadius - this.minCellRadius) + this.minCellRadius;
        const seed = Math.random() * 1000;

        // Create cell with receptor concentrations (constructor calculates actual radius)
        const cell = new Cell(cx, cy, baseRadius, seed, this.tissue.receptors);
        // Store base radius on cell for later updates
        cell.baseRadius = baseRadius;

        // Check for overlaps using actual (scaled) radius + minimum padding
        let overlaps = false;
        for (let existingCell of this.cells) {
          const dx = cx - existingCell.cx;
          const dy = cy - existingCell.cy;
          const d = Math.sqrt(dx * dx + dy * dy);
          if (d < cell.radius + existingCell.radius + this.minCellPadding) {
            overlaps = true;
            break;
          }
        }

        if (!overlaps) {
          this.cells.push(cell);
          placed = true;
        }
        attemptCount++;
      }
    }
  }

  /**
   * Regenerate particle sprite based on current ligand configuration
   */
  regenerateSprite() {
    this.particleSprite = generateParticleSprite(
      this.physicsParams.particleSpriteSize,
      this.ligandPositions,
      this.toxicity
    );
  }

  /**
   * Update simulation physics for one frame
   * @param {number} frameCount Current frame number
   */
  update(frameCount) {
    // Handle test mode particle spawning
    if (this.testMode) {
      this.updateTestModeSpawning(frameCount);
    }

    // Update particle physics
    this.updateParticles(frameCount);
  }

  /**
   * Handle particle spawning in test mode
   */
  updateTestModeSpawning(frameCount) {
    const elapsedFrames = frameCount - this.testStartFrame;

    if (this.testParticlesReleased < this.testParticlesTotal && elapsedFrames < this.testDuration) {
      // Use sine-based curve for smooth start and end
      const progress = elapsedFrames / this.testDuration;
      const targetReleased = Math.floor(this.testParticlesTotal * (1 - Math.cos(progress * Math.PI)) / 2);
      const particlesToSpawn = Math.max(0, targetReleased - this.testParticlesReleased);

      for (let i = 0; i < particlesToSpawn; i++) {
        const particle = Particle.spawn(this.width, this.height, this.physicsParams.flowSpeed);
        this.particles.push(particle);
        this.testParticlesReleased++;
      }
    }
  }

  /**
   * Update all particles (physics, collision, binding)
   * Uses node-based binding: particles bind when a vertex node (between two ligands)
   * matches a receptor node (between two adjacent receptors) with the same ordered pair.
   */
  updateParticles(frameCount) {
    const spriteRadius = this.physicsParams.particleSpriteSize * 0.5;
    const spriteSize = this.physicsParams.particleSpriteSize;
    const bindingThreshold = 1;  // Require 1 node match to bind

    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];

      if (p.bound) continue;

      // Update particle physics
      p.update(this.physicsParams, this.width, this.height, frameCount);

      // Remove out-of-bounds particles
      if (p.isOutOfBounds(this.width, this.height)) {
        this.particles.splice(i, 1);
        continue;
      }

      // Check collision with cells
      const nearestCell = findNearestCollidingCell(p, this.cells, spriteRadius);

      if (nearestCell) {
        this.attempts++;

        // Attempt node-based binding
        const result = attemptNodeBinding(
          p,
          nearestCell,
          this.ligandPositions,
          spriteSize,
          bindingThreshold
        );

        if (result.success) {
          // Bind particle via matched nodes
          p.bindToNodes(
            result.matchedParticleNodes,
            result.matchedCellNodes,
            spriteSize
          );
          this.bound++;
          nearestCell.bound += result.matchCount;
        } else {
          // Deflect around cell
          p.deflectAroundCell(nearestCell, spriteRadius, this.physicsParams.flowSpeed);
        }
      }
    }
  }

  /**
   * Render simulation to internal buffer
   */
  render() {
    if (!this.buffer) return;

    this.buffer.background(250);
    this.buffer.push();

    // Background
    this.buffer.fill(240, 240, 255);
    this.buffer.rect(0, 0, this.width, this.height, 6);

    // Draw flow direction indicators
    this.renderFlowIndicators();

    // Render cells
    for (let cell of this.cells) {
      cell.render(this.buffer);
      cell.renderBindingOverlay(this.buffer, this.testMode);
    }

    // Render particles
    this.renderParticles();

    this.buffer.pop();
  }

  /**
   * Render flow direction indicators (animated arrows)
   */
  renderFlowIndicators() {
    this.buffer.stroke(200, 200, 220, 100);
    this.buffer.strokeWeight(1);

    const numArrows = 5;
    const arrowSpacing = this.height / (numArrows + 1);
    const arrowLength = 20;
    const offset = (frameCount * 0.5) % 40;

    for (let j = 0; j < numArrows; j++) {
      const arrowY = arrowSpacing * (j + 1);
      const numArrowsInRow = Math.floor(this.width / 40);

      for (let k = 0; k < numArrowsInRow; k++) {
        const arrowX = k * 40 - offset;
        if (arrowX > -20 && arrowX < this.width + 20) {
          this.buffer.line(arrowX, arrowY, arrowX + arrowLength, arrowY);
          this.buffer.line(arrowX + arrowLength, arrowY, arrowX + arrowLength - 4, arrowY - 2);
          this.buffer.line(arrowX + arrowLength, arrowY, arrowX + arrowLength - 4, arrowY + 2);
        }
      }
    }
    this.buffer.noStroke();
  }

  /**
   * Render all particles to buffer
   */
  renderParticles() {
    for (let p of this.particles) {
      p.render(this.buffer, this.particleSprite, this.physicsParams.particleSpriteSize);
    }
  }

  /**
   * Get the graphics buffer for composition
   * @returns {p5.Graphics} The internal buffer
   */
  getBuffer() {
    return this.buffer;
  }

  // --- Configuration Updates ---

  /**
   * Update ligand positions and regenerate sprite
   */
  setLigandPositions(positions) {
    this.ligandPositions = positions.slice(0, 6);
    this.regenerateSprite();
  }

  /**
   * Update toxicity and regenerate sprite
   */
  setToxicity(toxicity) {
    this.toxicity = toxicity;
    this.regenerateSprite();
  }

  /**
   * Update fidelity parameter
   */
  setFidelity(fidelity) {
    this.fidelity = fidelity;
  }

  /**
   * Update tissue configuration (regenerates cells if receptors changed)
   */
  setTissue(tissue) {
    const receptorsChanged = !this.tissue.receptors ||
      this.tissue.receptors.some((v, idx) => v !== (tissue.receptors[idx] || 0));

    this.tissue = tissue;

    if (receptorsChanged) {
      // Regenerate all cells with new concentrations
      // Cell count adjusts based on expression level (larger cells = fewer cells)
      this.generateCells();
    }
  }

  // --- Test Mode Control ---

  /**
   * Start test mode with specified particle count
   */
  startTest(totalParticles, duration) {
    this.testMode = true;
    this.testParticlesTotal = totalParticles || PHYSICS_DEFAULTS.defaultTestParticles;
    this.testParticlesReleased = 0;
    this.testStartFrame = frameCount;
    this.testDuration = duration || PHYSICS_DEFAULTS.testDuration;

    // Clear particles and reset binding states
    this.particles = [];
    this.bound = 0;
    this.attempts = 0;

    for (let cell of this.cells) {
      cell.resetBindings();
    }
  }

  /**
   * Stop test mode
   */
  stopTest() {
    this.testMode = false;
  }

  /**
   * Reset simulation state
   */
  reset() {
    this.particles = [];
    this.testMode = false;
    this.testParticlesReleased = 0;
    this.bound = 0;
    this.attempts = 0;

    for (let cell of this.cells) {
      cell.resetBindings();
    }
  }

  // --- Statistics ---

  /**
   * Get simulation statistics
   */
  getStats() {
    let totalReceptors = 0;
    let boundReceptors = 0;

    for (let cell of this.cells) {
      totalReceptors += cell.getTotalReceptors();
      boundReceptors += cell.getBoundCount();
    }

    const bindingPercentage = totalReceptors > 0 ? (boundReceptors / totalReceptors * 100) : 0;
    // Use node-based combinatorial probability model for theoretical scoring
    const theoreticalScore = scoreTissue(this.ligandPositions, this.tissue.receptors, 1);

    return {
      bound: this.bound,
      attempts: this.attempts,
      totalReceptors: totalReceptors,
      boundReceptors: boundReceptors,
      bindingPercentage: bindingPercentage,
      theoreticalScore: theoreticalScore,
      particleCount: this.particles.length,
      freeParticles: this.particles.filter(p => !p.bound).length,
      boundParticles: this.particles.filter(p => p.bound).length
    };
  }

  /**
   * Get test mode status
   */
  getTestStatus() {
    return {
      testMode: this.testMode,
      released: this.testParticlesReleased,
      total: this.testParticlesTotal
    };
  }
}

// Export for browser global
window.Simulation = Simulation;
