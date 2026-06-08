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
      turbulenceX: PHYSICS_DEFAULTS.turbulenceX,
      turbulenceY: PHYSICS_DEFAULTS.turbulenceY,
      cellsPerTissue: PHYSICS_DEFAULTS.cellsPerTissue,
      particleSpriteSize: PHYSICS_DEFAULTS.particleSpriteSize
    };

    // Internal state
    this.particles = [];
    this.debris = [];  // Free-floating ligand debris from absorbed particles
    this.tracers = []; // Lightweight flow-visualization particles
    this.tracerCount = 3000; // Target number of tracer particles
    this.cells = [];
    this._cellSignature = null; // Receptor/tissue fingerprint of the current cells
    this.buffer = null;
    this.particleSprite = null;
    this.spriteCache = new Map();  // key: ligandPositions.join(','), value: p5.Graphics
    this.initialized = false;

    // GPU fluid simulation (optional)
    this.fluidSim = null;
    this.useFluidSim = config.useFluidSim !== undefined ? config.useFluidSim : false;
    this.fluidSimScale = config.fluidSimScale || 5; // Sim runs at 1/N of render resolution
    this.showVelocityField = true; // Toggle with 'V' key
    this.showPressureField = false; // Toggle with 'P' key

    // Test mode state
    this.testMode = false;
    this.testParticlesTotal = 0;
    this.testParticlesReleased = 0;
    this.testStartFrame = 0;
    this.testDuration = PHYSICS_DEFAULTS.testDuration;

    // Cell death threshold (drugs absorbed before a cell dies)
    this.deathThreshold = config.deathThreshold !== undefined ? config.deathThreshold : 5;

    // Statistics
    this.bound = 0;
    this.attempts = 0;
    this.totalAbsorbed = 0;    // Running count — survives cell death/removal
    this.triggeredDeaths = 0;  // Cells that crossed the death threshold
    this.initialCellCount = 0; // Cell count at test start, used as denominator
    this.theoreticalScore = 0; // Snapshotted at test start; stable for the duration of the test
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

    // Initialize GPU fluid simulation if enabled
    console.log('Fluid sim check:', {
      useFluidSim: this.useFluidSim,
      fluidSimDefined: typeof FluidSimulation !== 'undefined'
    });

    if (this.useFluidSim && typeof FluidSimulation !== 'undefined') {
      const simW = Math.floor(this.width / this.fluidSimScale);
      const simH = Math.floor(this.height / this.fluidSimScale);
      console.log(`Creating FluidSimulation: ${simW}x${simH} for ${this.width}x${this.height} render`);

      this.fluidSim = new FluidSimulation(simW, simH, this.width, this.height);
      // Note: FluidSimulation uses its own flowSpeed in grid units (default 0.0002)
      // Do NOT override with physicsParams.flowSpeed which is in render pixels

      if (this.fluidSim.initialize()) {
        // Upload cell boundaries to GPU
        this.fluidSim.uploadBoundaries(this.cells);
        console.log('GPU fluid simulation enabled');
      } else {
        console.warn('GPU fluid simulation failed to initialize, falling back to Perlin noise');
        this.fluidSim = null;
      }
    } else if (this.useFluidSim) {
      console.error('FluidSimulation class not found - check script loading order');
    }

    // Spawn initial tracer particles spread across the canvas
    this.initTracers();

    this.initialized = true;
  }

  /**
   * Initialize tracer particles spread across the canvas
   */
  initTracers() {
    this.tracers = [];
    if (typeof TracerParticle === 'undefined') return;

    for (let i = 0; i < this.tracerCount; i++) {
      this.tracers.push(TracerParticle.spawnRandom(
        this.width, this.height, this.physicsParams.flowSpeed
      ));
    }
  }

  /**
   * Generate cells for this tissue
   */
  generateCells() {
    this.cells = [];
    // Store base radius range for later use when updating concentrations
    this.minCellRadius = Math.min(this.width, this.height) * 0.08;
    this.maxCellRadius = Math.min(this.width, this.height) * 0.12;

    // Minimum padding — kept small since cell death removes blocked cells over time
    const nanoparticleDiameter = this.physicsParams.particleSpriteSize;
    this.minCellPadding = nanoparticleDiameter * 1.0;

    const maxAttempts = 400;

    // Calculate max possible radius (for margin calculation)
    // This accounts for expression scaling: maxCellRadius * maxSizeFactor
    const maxPossibleRadius = this.maxCellRadius * (EXPRESSION_SCALING?.maxSizeFactor || 1.2);

    // Calculate number of cells to fill screen space
    const targetCoverage = 2.0; // Dense packing; cell death opens up new paths over time
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
    const cellCount = Math.max(5, Math.min(80, targetCellCount));

    // Resolve tissue color once per simulation — all cells in this tissue share it
    const tissueKey = (this.tissue.name || '').toLowerCase();
    const tissueColor = TISSUE_COLORS[tissueKey] || TISSUE_COLORS.default;

    for (let i = 0; i < cellCount; i++) {
      let placed = false;
      let attemptCount = 0;

      while (!placed && attemptCount < maxAttempts) {
        // Horizontal margin (left/right) - full margin for inflow/outflow
        const marginX = maxPossibleRadius + this.minCellPadding;
        // Vertical margin (top/bottom) - keep 1.5× sprite clearance so nanoparticles
        // can flow above and below cells rather than piling up at the walls
        const marginY = maxPossibleRadius + nanoparticleDiameter * 1.5;

        const cx = Math.random() * (this.width - 2 * marginX) + marginX;
        const cy = Math.random() * (this.height - 2 * marginY) + marginY;
        // Base radius before expression scaling
        const baseRadius = Math.random() * (this.maxCellRadius - this.minCellRadius) + this.minCellRadius;
        const seed = Math.random() * 1000;

        // Create cell with receptor concentrations (constructor calculates actual radius)
        const isTumor = this.tissue.name.toLowerCase().includes('tumor');
        const cell = new Cell(cx, cy, baseRadius, seed, this.tissue.receptors, isTumor, tissueColor);
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

    // Update fluid simulation boundaries if active
    if (this.fluidSim && this.fluidSim.initialized) {
      this.fluidSim.uploadBoundaries(this.cells);
    }

    // Rebuild spatial hash grid for collision detection
    this.buildCellGrid();
  }

  /**
   * Regenerate particle sprite based on current ligand configuration
   */
  regenerateSprite() {
    this.spriteCache.clear();
    this.particleSprite = generateParticleSprite(
      this.physicsParams.particleSpriteSize,
      this.ligandPositions,
      this.toxicity
    );
  }

  _randomizeLigandPositions(canonical) {
    const arr = canonical.slice();
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  _getSpriteForArrangement(ligandPositions) {
    const key = ligandPositions.join(',');
    if (!this.spriteCache.has(key)) {
      this.spriteCache.set(
        key,
        generateParticleSprite(this.physicsParams.particleSpriteSize, ligandPositions, this.toxicity)
      );
    }
    return this.spriteCache.get(key);
  }

  // --- Spatial hash grid for O(1) cell lookup ---

  /**
   * Build a flat spatial hash grid mapping grid-cell buckets to overlapping cells.
   * Each cell object is inserted into every bucket its bounding circle overlaps.
   * Grid cell size of 200px means particles check a 3x3 neighborhood (~4-6 candidates
   * max) instead of scanning all 15-30 cells in the simulation.
   * Call after generateCells() and whenever the cells array changes.
   */
  buildCellGrid() {
    this.gridCellSize = 200; // px — larger than max cell radius (~156px) with margin
    this.gridW = Math.ceil(this.width / this.gridCellSize);
    this.gridH = Math.ceil(this.height / this.gridCellSize);
    this.cellGrid = new Array(this.gridW * this.gridH).fill(null);

    for (const cell of this.cells) {
      const minGX = Math.max(0, Math.floor((cell.cx - cell.radius) / this.gridCellSize));
      const maxGX = Math.min(this.gridW - 1, Math.floor((cell.cx + cell.radius) / this.gridCellSize));
      const minGY = Math.max(0, Math.floor((cell.cy - cell.radius) / this.gridCellSize));
      const maxGY = Math.min(this.gridH - 1, Math.floor((cell.cy + cell.radius) / this.gridCellSize));

      for (let gy = minGY; gy <= maxGY; gy++) {
        for (let gx = minGX; gx <= maxGX; gx++) {
          const idx = gy * this.gridW + gx;
          if (!this.cellGrid[idx]) this.cellGrid[idx] = [];
          this.cellGrid[idx].push(cell);
        }
      }
    }
  }

  /**
   * Return candidate cells near (x, y) by querying a 3x3 neighborhood of grid buckets.
   * Reduces particle-cell collision checks from O(allCells) to O(~4-6 cells).
   *
   * @param {number} x - World x coordinate
   * @param {number} y - World y coordinate
   * @param {boolean} liveOnly - If true, exclude dying/dead cells (default: true)
   * @returns {Cell[]} Candidate cells that may be within collision range
   */
  getCandidateCells(x, y, liveOnly = true) {
    if (!this.cellGrid) {
      // Fallback before grid is built (should not happen in normal flow)
      return liveOnly ? this.cells.filter(c => !c.dying && !c.dead) : this.cells.slice();
    }

    const result = [];
    const gx0 = Math.floor(x / this.gridCellSize);
    const gy0 = Math.floor(y / this.gridCellSize);

    for (let dgy = -1; dgy <= 1; dgy++) {
      for (let dgx = -1; dgx <= 1; dgx++) {
        const ngx = gx0 + dgx;
        const ngy = gy0 + dgy;
        if (ngx < 0 || ngx >= this.gridW || ngy < 0 || ngy >= this.gridH) continue;
        const bucket = this.cellGrid[ngy * this.gridW + ngx];
        if (!bucket) continue;
        for (const cell of bucket) {
          if (liveOnly && (cell.dying || cell.dead)) continue;
          if (!result.includes(cell)) result.push(cell);
        }
      }
    }

    return result;
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

    // Step GPU fluid simulation (runs independently, updates velocity cache periodically)
    if (this.fluidSim && this.fluidSim.initialized) {
      this.fluidSim.step(frameCount);
    }

    // Update tracer particles
    this.updateTracers(frameCount);

    // Update cell refractory timers, soft body dynamics, and death animation
    for (let cell of this.cells) {
      cell.update(this.physicsParams, frameCount, this.fluidSim);
    }

    // Cell-cell neighbor repulsion — soft contact forces produce tissue-like flattening
    // where neighbours touch.  Forces are weighted by each node's facing direction so the
    // membrane deforms locally at the contact point rather than translating as a rigid body.
    {
      const repK = SOFT_BODY_DEFAULTS.neighborRepulsionStrength;
      const repMargin = SOFT_BODY_DEFAULTS.neighborRepulsionMargin;
      const liveCells = this.cells.filter(c => !c.dying && !c.dead);
      for (let a = 0; a < liveCells.length; a++) {
        const ca = liveCells[a];
        for (let b = a + 1; b < liveCells.length; b++) {
          const cb = liveCells[b];
          const dx = cb.cx - ca.cx;
          const dy = cb.cy - ca.cy;
          const dist = Math.sqrt(dx * dx + dy * dy) || 0.001;
          const minDist = ca.radius + cb.radius + repMargin;
          if (dist >= minDist) continue;

          const overlap = minDist - dist;
          const nx = dx / dist;
          const ny = dy / dist;
          const forceMag = overlap * repK;

          // Push only ca's nodes facing cb (positive dot with +n)
          for (const node of ca.nodes) {
            const facing = ((node.x - ca.cx) * nx + (node.y - ca.cy) * ny) / ca.radius;
            if (facing > 0) {
              node.vx -= nx * forceMag * facing;
              node.vy -= ny * forceMag * facing;
            }
          }
          // Push only cb's nodes facing ca (positive dot with -n)
          for (const node of cb.nodes) {
            const facing = -((node.x - cb.cx) * nx + (node.y - cb.cy) * ny) / cb.radius;
            if (facing > 0) {
              node.vx += nx * forceMag * facing;
              node.vy += ny * forceMag * facing;
            }
          }
        }
      }
    }

    // Remove cells whose death animation has fully completed
    const prevCellCount = this.cells.length;
    this.cells = this.cells.filter(c => !c.isFullyDead());
    if (this.cells.length !== prevCellCount) this.buildCellGrid();

    // Update particle physics
    this.updateParticles(frameCount);

    // Update absorbing/absorbed particles
    this.updateAbsorbingParticles(frameCount);

    // Update debris
    this.updateDebris(frameCount);
  }

  /**
   * Handle particle spawning in test mode
   */
  updateTestModeSpawning(frameCount) {
    const elapsedFrames = frameCount - this.testStartFrame;

    if (this.testParticlesReleased < this.testParticlesTotal) {
      if (elapsedFrames < this.testDuration) {
        // Use sine-based curve for smooth start and end
        const progress = elapsedFrames / this.testDuration;
        const targetReleased = Math.floor(this.testParticlesTotal * (1 - Math.cos(progress * Math.PI)) / 2);
        const particlesToSpawn = Math.max(0, targetReleased - this.testParticlesReleased);

        for (let i = 0; i < particlesToSpawn; i++) {
          const particle = Particle.spawn(this.width, this.height, this.physicsParams.flowSpeed);
          particle.ligandPositions = this._randomizeLigandPositions(this.ligandPositions);
          particle.sprite = this._getSpriteForArrangement(particle.ligandPositions);
          this.particles.push(particle);
          this.testParticlesReleased++;
        }
      } else {
        // Duration ended — release any remaining particles
        const remaining = this.testParticlesTotal - this.testParticlesReleased;
        for (let i = 0; i < remaining; i++) {
          const particle = Particle.spawn(this.width, this.height, this.physicsParams.flowSpeed);
          particle.ligandPositions = this._randomizeLigandPositions(this.ligandPositions);
          particle.sprite = this._getSpriteForArrangement(particle.ligandPositions);
          this.particles.push(particle);
          this.testParticlesReleased++;
        }
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

    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];

      if (p.bound || p.fading) continue;

      // Update particle physics (pass fluidSim for GPU-based advection if available)
      p.update(this.physicsParams, this.width, this.height, frameCount, this.fluidSim);

      // Remove out-of-bounds particles
      if (p.isOutOfBounds(this.width, this.height)) {
        this.particles.splice(i, 1);
        continue;
      }

      // Check collision with live cells only — spatial hash returns only nearby candidates
      const nearestCell = findNearestCollidingCell(p, this.getCandidateCells(p.x, p.y), spriteRadius);

      if (nearestCell) {
        this.attempts++;

        // Attempt node-based binding (probabilistic: 85% for 2+ matches, 20% for 1 match)
        const result = attemptNodeBinding(
          p,
          nearestCell,
          p.ligandPositions,
          spriteSize
        );

        if (result.success) {
          // Mark receptors as bound/latched (visual update) and collect them
          const boundReceptors = [];
          for (let j = 0; j < result.matchedCellNodes.length; j++) {
            const cellNode = result.matchedCellNodes[j];
            const particleNode = result.matchedParticleNodes[j];
            cellNode.bound = true;
            cellNode.receptor1.bound = true;
            cellNode.receptor1.latched = true;
            cellNode.receptor1.latchedLigandColor = particleNode.color1;
            boundReceptors.push(cellNode.receptor1);
            cellNode.receptor2.bound = true;
            cellNode.receptor2.latched = true;
            cellNode.receptor2.latchedLigandColor = particleNode.color2;
            boundReceptors.push(cellNode.receptor2);
          }

          // Spawn debris from the ligands before absorption
          const newDebris = Debris.spawnFromParticle(p, p.ligandPositions, spriteSize);
          this.debris.push(...newDebris);

          // Start drug absorption toward cell center
          p.startAbsorption(nearestCell, boundReceptors);
          this.bound++;
          nearestCell.bound += result.matchCount;
        } else {
          // Deflect around cell and apply impulse to membrane
          const impactX = p.x;
          const impactY = p.y;
          const impactFx = p.vx * 0.3;
          const impactFy = p.vy * 0.3;
          p.deflectAroundCell(nearestCell, spriteRadius, this.physicsParams.flowSpeed);
          nearestCell.applyImpulse(impactX, impactY, impactFx, impactFy);
        }
      }
    }
  }

  /**
   * Update particles that are absorbing, absorbed, or fading out
   */
  updateAbsorbingParticles(frameCount) {
    for (let p of this.particles) {
      if (p.absorbing || p.absorbed) {
        const wasAbsorbing = p.absorbing;
        p.updateAbsorption(this.physicsParams, frameCount);
        // Detect the frame a particle crosses the membrane and count it
        if (wasAbsorbing && p.absorbed) {
          this.totalAbsorbed++;
        }
      } else if (p.fading) {
        p.updateFading(this.physicsParams, frameCount);
      }
    }

    // Check death threshold: trigger cell death when absorbed drug count is reached
    for (let cell of this.cells) {
      if (!cell.dying && !cell.dead && cell.absorbedDrugs >= this.deathThreshold) {
        cell.triggerDeath();
        this.triggeredDeaths++;
        // Release all absorbed/absorbing particles in that cell to fade out
        for (let p of this.particles) {
          if ((p.absorbed || p.absorbing) && p.targetCell === cell) {
            p.startFading();
          }
        }
      }
    }

    // Remove particles whose fade animation has completed
    this.particles = this.particles.filter(p => !p.isFadeExpired());
  }

  /**
   * Update free-floating debris (ligand pieces)
   */
  updateDebris(frameCount) {
    for (let i = this.debris.length - 1; i >= 0; i--) {
      const d = this.debris[i];
      d.update(this.physicsParams, this.width, this.height, frameCount, this.fluidSim, this.getCandidateCells(d.x, d.y, false));

      if (d.isOutOfBounds(this.width, this.height) || d.isExpired()) {
        this.debris.splice(i, 1);
      }
    }
  }

  /**
   * Update tracer particles (advection, recycling)
   */
  updateTracers(frameCount) {
    if (typeof TracerParticle === 'undefined') return;

    // Update existing tracers
    for (let i = this.tracers.length - 1; i >= 0; i--) {
      const t = this.tracers[i];
      t.update(this.physicsParams, this.width, this.height, frameCount, this.fluidSim);

      // Recycle expired or out-of-bounds tracers
      if (t.isExpired() || t.isOutOfBounds(this.width, this.height)) {
        // Out-of-bounds particles exited the canvas — re-enter from the left.
        // Expired particles died naturally mid-canvas — respawn randomly so
        // tracers stay distributed across the full width, not just the left side.
        if (t.isOutOfBounds(this.width, this.height)) {
          this.tracers[i] = TracerParticle.spawnLeft(
            this.width, this.height, this.physicsParams.flowSpeed
          );
        } else {
          this.tracers[i] = TracerParticle.spawnRandom(
            this.width, this.height, this.physicsParams.flowSpeed
          );
        }
      }
    }

    // Top up if below target count
    while (this.tracers.length < this.tracerCount) {
      this.tracers.push(TracerParticle.spawnRandom(
        this.width, this.height, this.physicsParams.flowSpeed
      ));
    }
  }

  /**
   * Render simulation to internal buffer
   */
  render() {
    if (!this.buffer) return;

    this.buffer.background(250);
    this.buffer.push();

    // Background — gradient backdrop + caustic shimmer (falls back to flat fill if disabled)
    this.renderBackdrop(this.buffer);

    // Render fluid pressure field visualization if enabled (P key toggle)
    if (this.showPressureField && this.fluidSim && this.fluidSim.initialized) {
      this.fluidSim.renderPressureField(this.buffer, {
        opacity: 160
      });
    }

    // Render fluid velocity field visualization if enabled (V key toggle)
    if (this.showVelocityField && this.fluidSim && this.fluidSim.initialized) {
      this.fluidSim.renderVelocityField(this.buffer, {
        showColors: !this.showPressureField, // Don't show velocity colors if pressure is shown
        showArrows: true,
        arrowSpacing: 50,
        arrowScale: 20,
        opacity: 160
      });
    }

    // Render tracer particles (behind cells for depth)
    const rt0 = performance.now();
    this.renderTracers();
    const rt1 = performance.now();

    // Render cells
    for (let cell of this.cells) {
      cell.render(this.buffer);
      cell.renderBindingOverlay(this.buffer, this.testMode);
    }
    const rt2 = performance.now();

    // Render debris (behind particles)
    this.renderDebris();
    const rt3 = performance.now();

    // Render particles
    this.renderParticles();
    const rt4 = performance.now();

    this.buffer.pop();

    // Accumulate render sub-phase timings
    if (!this._renderTiming) this._renderTiming = { tracers: 0, cells: 0, debris: 0, particles: 0, frames: 0 };
    this._renderTiming.tracers += (rt1 - rt0);
    this._renderTiming.cells += (rt2 - rt1);
    this._renderTiming.debris += (rt3 - rt2);
    this._renderTiming.particles += (rt4 - rt3);
    this._renderTiming.frames++;
    if (this._renderTiming.frames >= 120) {
      const n = this._renderTiming.frames;
      console.log(
        `[render breakdown] tracers: ${(this._renderTiming.tracers / n).toFixed(2)}ms | ` +
        `cells: ${(this._renderTiming.cells / n).toFixed(2)}ms | ` +
        `debris: ${(this._renderTiming.debris / n).toFixed(2)}ms | ` +
        `particles: ${(this._renderTiming.particles / n).toFixed(2)}ms | ` +
        `tracer count: ${this.tracers.length} | particle count: ${this.particles.length}`
      );
      this._renderTiming = { tracers: 0, cells: 0, debris: 0, particles: 0, frames: 0 };
    }
  }

  /**
   * Render all particles to buffer
   */
  renderParticles() {
    for (let p of this.particles) {
      p.render(this.buffer, p.sprite, this.physicsParams.particleSpriteSize, this.toxicity);
    }
  }

  /**
   * Render free-floating debris to buffer
   */
  renderDebris() {
    for (let d of this.debris) {
      d.render(this.buffer, this.physicsParams.particleSpriteSize);
    }
  }

  /**
   * Draw the fluidic background: vertical gradient + animated caustic shimmer overlay,
   * both clipped to the rounded-rect backdrop.  Falls back to the original flat lavender
   * fill if BACKGROUND_DEFAULTS.enabled is false.
   */
  renderBackdrop(g) {
    const bg = window.BACKGROUND_DEFAULTS;
    if (!bg || !bg.enabled) {
      g.fill(240, 240, 255);
      g.rect(0, 0, this.width, this.height, 6);
      return;
    }

    const ctx = g.drawingContext;
    const w = this.width;
    const h = this.height;
    const r = bg.cornerRadius;

    // Build rounded-rect path and clip
    ctx.save();
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') {
      ctx.roundRect(0, 0, w, h, r);
    } else {
      // Manual fallback for older browsers
      ctx.moveTo(r, 0);
      ctx.lineTo(w - r, 0); ctx.quadraticCurveTo(w, 0, w, r);
      ctx.lineTo(w, h - r); ctx.quadraticCurveTo(w, h, w - r, h);
      ctx.lineTo(r, h);     ctx.quadraticCurveTo(0, h, 0, h - r);
      ctx.lineTo(0, r);     ctx.quadraticCurveTo(0, 0, r, 0);
    }
    ctx.closePath();
    ctx.clip();

    // Vertical gradient backdrop
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    const t = bg.gradientTop, m = bg.gradientMid, b = bg.gradientBot;
    grad.addColorStop(0,   `rgb(${t[0]},${t[1]},${t[2]})`);
    grad.addColorStop(0.5, `rgb(${m[0]},${m[1]},${m[2]})`);
    grad.addColorStop(1,   `rgb(${b[0]},${b[1]},${b[2]})`);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);

    // Caustic shimmer overlay
    if (bg.shimmerEnabled) {
      if (!this.shimmerCanvas) this.initShimmer(bg);
      const throttle = Math.max(1, bg.shimmerThrottle | 0);
      if ((frameCount % throttle) === 0) this.updateShimmer(bg, frameCount);

      const prevSmoothing = ctx.imageSmoothingEnabled;
      const prevQuality = ctx.imageSmoothingQuality;
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(this.shimmerCanvas, 0, 0, w, h);
      ctx.imageSmoothingEnabled = prevSmoothing;
      ctx.imageSmoothingQuality = prevQuality;
    }

    ctx.restore();
  }

  /**
   * Create the low-res offscreen canvas used as the caustic noise source.  Called lazily
   * on the first backdrop render so we don't add work to the Simulation constructor.
   */
  initShimmer(bg) {
    this.shimmerCanvas = document.createElement('canvas');
    this.shimmerCanvas.width = bg.shimmerResX;
    this.shimmerCanvas.height = bg.shimmerResY;
    this.shimmerCtx = this.shimmerCanvas.getContext('2d');
    this.shimmerImage = this.shimmerCtx.createImageData(bg.shimmerResX, bg.shimmerResY);
  }

  /**
   * Repaint the shimmer noise field for this frame.  Samples 3D Perlin noise on the
   * low-res grid, applies a contrast curve to sparsen the peaks, and writes the result
   * into the shimmer ImageData as a white-tinted alpha-modulated layer.
   */
  updateShimmer(bg, frameCount) {
    const data = this.shimmerImage.data;
    const w = this.shimmerCanvas.width;
    const h = this.shimmerCanvas.height;
    const scale = bg.shimmerScale;
    const t = frameCount * bg.shimmerSpeed;
    const contrast = bg.shimmerContrast;
    const tint = bg.shimmerTint;
    const peakAlpha = bg.shimmerStrength * 255;
    let i = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const n = noise(x * scale, y * scale, t);
        const v = Math.pow(n, contrast);
        data[i++] = tint[0];
        data[i++] = tint[1];
        data[i++] = tint[2];
        data[i++] = v * peakAlpha;
      }
    }
    this.shimmerCtx.putImageData(this.shimmerImage, 0, 0);
  }

  /**
   * Render tracer particles to buffer using batched Canvas 2D paths.
   * Groups trail segments and dots by quantized alpha, then draws each group
   * as a single path — reducing ~54,000 individual draw calls to ~16 batched paths.
   */
  renderTracers() {
    if (typeof TracerParticle === 'undefined' || this.tracers.length === 0) return;

    const ctx = this.buffer.drawingContext;
    const BUCKETS = 8;
    const BUCKET_SCALE = BUCKETS / 256;

    // Reuse persistent bucket arrays to avoid GC pressure
    if (!this._trailBuckets) {
      this._trailBuckets = new Array(BUCKETS);
      this._dotBuckets = new Array(BUCKETS);
      for (let b = 0; b < BUCKETS; b++) {
        this._trailBuckets[b] = [];
        this._dotBuckets[b] = [];
      }
    }
    for (let b = 0; b < BUCKETS; b++) {
      this._trailBuckets[b].length = 0;
      this._dotBuckets[b].length = 0;
    }

    // Classify all tracer segments and dots into alpha buckets
    for (let ti = 0; ti < this.tracers.length; ti++) {
      const t = this.tracers[ti];
      const fadeIn = Math.min(1, t.age / 10);
      const remaining = t.lifetime - t.age;
      const fadeOut = Math.min(1, remaining / 30);
      const baseAlpha = fadeIn * fadeOut;
      if (baseAlpha <= 0) continue;

      // Trail line segments
      if (t.trail.length > 1) {
        for (let i = 1; i < t.trail.length; i++) {
          const a = (i / t.trail.length) * baseAlpha * 80;
          const b = Math.min(BUCKETS - 1, (a * BUCKET_SCALE) | 0);
          this._trailBuckets[b].push(
            t.trail[i - 1].x, t.trail[i - 1].y,
            t.trail[i].x, t.trail[i].y
          );
        }
        // Segment from last trail point to current position
        const a = baseAlpha * 100;
        const b = Math.min(BUCKETS - 1, (a * BUCKET_SCALE) | 0);
        const last = t.trail[t.trail.length - 1];
        this._trailBuckets[b].push(last.x, last.y, t.x, t.y);
      }

      // Dot
      const dotAlpha = baseAlpha * 140;
      const db = Math.min(BUCKETS - 1, (dotAlpha * BUCKET_SCALE) | 0);
      this._dotBuckets[db].push(t.x, t.y);
    }

    // Draw line segments — one batched path per alpha bucket
    ctx.lineWidth = 1;
    for (let b = 0; b < BUCKETS; b++) {
      const segs = this._trailBuckets[b];
      if (segs.length === 0) continue;
      const alpha = (b + 0.5) / BUCKETS;
      ctx.strokeStyle = `rgba(200,210,230,${alpha})`;
      ctx.beginPath();
      for (let j = 0; j < segs.length; j += 4) {
        ctx.moveTo(segs[j], segs[j + 1]);
        ctx.lineTo(segs[j + 2], segs[j + 3]);
      }
      ctx.stroke();
    }

    // Draw dots — one batched fill per alpha bucket
    for (let b = 0; b < BUCKETS; b++) {
      const dots = this._dotBuckets[b];
      if (dots.length === 0) continue;
      const alpha = (b + 0.5) / BUCKETS;
      ctx.fillStyle = `rgba(210,220,240,${alpha})`;
      ctx.beginPath();
      for (let j = 0; j < dots.length; j += 2) {
        ctx.moveTo(dots[j] + 1, dots[j + 1]);
        ctx.arc(dots[j], dots[j + 1], 1, 0, Math.PI * 2);
      }
      ctx.fill();
    }

    this.buffer.noStroke();
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
    this.theoreticalScore = this.computeTheoreticalScore();
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
   * Update cell death threshold
   */
  setDeathThreshold(threshold) {
    this.deathThreshold = threshold;
    this.theoreticalScore = this.computeTheoreticalScore();
  }

  /**
   * Build a value-based fingerprint of the inputs that affect cell layout.
   * Uses the receptor *values* (joined), not the array reference, so an
   * in-place mutation of tissue.receptors (e.g. a dashboard slider) is still
   * detected — that reference-equality blind spot is why the old skip-guard
   * left cells stale when only one slider was non-zero.
   */
  _tissueSignature(tissue) {
    const receptors = (tissue.receptors || []).map(r => r || 0).join(',');
    return `${tissue.name || ''}|${receptors}`;
  }

  /**
   * Update tissue configuration. Regenerates cells only when the tissue's
   * receptor profile actually changes (a new puzzle/RFID). The Pi re-emits
   * ligand_update on every sensor sweep while a tag is present, so blindly
   * regenerating here made every cell rebuild continuously. Cells are still
   * rebuilt fresh on test start and reset, which call generateCells directly.
   */
  setTissue(tissue) {
    this.tissue = tissue;
    const sig = this._tissueSignature(tissue);
    if (sig !== this._cellSignature || this.cells.length === 0) {
      this._cellSignature = sig;
      this.generateCells();
    }
    this.theoreticalScore = this.computeTheoreticalScore();
  }

  /**
   * Compute theoretical score analytically from receptor concentrations and ligand positions.
   * Represents the binding affinity of the drug for this tissue — the probability that a
   * random adjacent receptor pair on the cell membrane matches any active ligand pair.
   *
   * matchRate = Σ (r[c1]/totalConc) × (r[c2]/totalConc)  for each active ligand pair (c1, c2)
   * theoreticalScore = matchRate × 100
   *
   * This ranges 0–100% where 100% means every receptor pair on the tissue is compatible
   * with the drug. It is stable: depends only on tissue receptors and ligand positions,
   * not on cell layout, deathThreshold, or particle count.
   */
  computeTheoreticalScore() {
    const receptors = this.tissue.receptors;

    const totalConc = receptors.reduce((sum, r) => sum + (r || 0), 0);
    if (totalConc < 0.01) return 0;

    // Sum match probabilities over all active ligand ordered pairs
    let matchRate = 0;
    for (let i = 0; i < 6; i++) {
      const c1 = this.ligandPositions[(i + 5) % 6];
      const c2 = this.ligandPositions[i];
      if (typeof c1 === 'number' && c1 >= 0 && c1 < 6 &&
          typeof c2 === 'number' && c2 >= 0 && c2 < 6) {
        matchRate += ((receptors[c1] || 0) / totalConc) * ((receptors[c2] || 0) / totalConc);
      }
    }

    return Math.min(100, matchRate * 100);
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

    // Clear particles, debris, and tracers, then regenerate cells fresh
    this.particles = [];
    this.debris = [];
    this.initTracers();
    this.bound = 0;
    this.attempts = 0;
    this.totalAbsorbed = 0;
    this.triggeredDeaths = 0;
    this.generateCells();
    this.initialCellCount = this.cells.length;
    this.theoreticalScore = this.computeTheoreticalScore();
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
    this.debris = [];
    this.initTracers();
    this.testMode = false;
    this.testParticlesReleased = 0;
    this.bound = 0;
    this.attempts = 0;
    this.totalAbsorbed = 0;
    this.triggeredDeaths = 0;
    this.generateCells();
    this.initialCellCount = this.cells.length;
    this.theoreticalScore = this.computeTheoreticalScore();
  }

  // --- Statistics ---

  /**
   * Get simulation statistics
   */
  getStats() {
    const totalAbsorbedDrugs = this.totalAbsorbed;

    // Score = cells that crossed the death threshold / initial cell count, capped at 100%
    const absorptionEfficiency = this.initialCellCount > 0
      ? Math.min(100, (this.triggeredDeaths / this.initialCellCount) * 100)
      : 0;

    // Theoretical score is snapshotted at test start (or when ligands change outside a test)
    // so it stays stable while cells die during the run.
    const theoreticalScore = this.theoreticalScore;

    return {
      bound: this.bound,
      attempts: this.attempts,
      bindingEvents: totalAbsorbedDrugs,  // drugs that fully crossed the membrane
      triggeredDeaths: this.triggeredDeaths,
      totalAbsorbedDrugs: totalAbsorbedDrugs,
      absorptionEfficiency: absorptionEfficiency,
      theoreticalScore: theoreticalScore,
      particleCount: this.particles.length,
      freeParticles: this.particles.filter(p => !p.bound).length,
      absorbingParticles: this.particles.filter(p => p.absorbing).length,
      absorbedParticles: this.particles.filter(p => p.absorbed).length
    };
  }

  /**
   * Get test mode status
   */
  getTestStatus() {
    const freeFlowing = this.particles.filter(
      p => !p.bound && !p.absorbing && !p.absorbed && !p.fading
    ).length;
    return {
      testMode: this.testMode,
      released: this.testParticlesReleased,
      total: this.testParticlesTotal,
      freeFlowing
    };
  }
}

// Export for browser global
window.Simulation = Simulation;
