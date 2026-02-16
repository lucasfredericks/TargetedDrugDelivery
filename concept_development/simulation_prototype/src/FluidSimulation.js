// FluidSimulation.js - GPU-accelerated Navier-Stokes fluid simulation
// Uses WebGL 2 with p5.js for Eulerian fluid dynamics

console.log('FluidSimulation.js loading...');

class FluidSimulation {
  /**
   * Create a fluid simulation
   * @param {number} simWidth - Simulation grid width (recommend 1/5 of render width)
   * @param {number} simHeight - Simulation grid height
   * @param {number} renderWidth - Full render width (for coordinate mapping)
   * @param {number} renderHeight - Full render height
   */
  constructor(simWidth, simHeight, renderWidth, renderHeight) {
    this.simWidth = simWidth;
    this.simHeight = simHeight;
    this.renderWidth = renderWidth;
    this.renderHeight = renderHeight;

    // Simulation parameters
    this.dt = 1.0;                    // Time step (in grid units)
    this.dissipation = 0.998;         // Velocity dissipation (higher = turbulence persists longer)
    this.pressureIterations = 200;    // Jacobi iterations for pressure solve (need ~gridSize/2 for reasonable convergence)
    this.flowSpeed = 0.02;          // Base flow speed in grid cells per step
    this.vorticityStrength = 2.5     // Vorticity confinement strength (higher = stronger swirling)
    this.viscosity = 0.5;            // Viscous diffusion strength (lower = sharper vortices)
    this.diffusionIterations = 15;    // Jacobi iterations for viscous diffusion solve

    // State
    this.initialized = false;
    this.gl = null;
    this.programs = {};
    this.textures = {};
    this.framebuffers = {};

    // Cached velocity field for CPU queries
    this.cachedVelocity = null;
    this.cacheFrame = -1;
    this.cacheInterval = 5; // Update cache every N frames

    // Cached pressure field for debug visualization
    this.cachedPressure = null;
  }

  /**
   * Initialize WebGL resources
   * Creates a dedicated offscreen canvas for GPU fluid computation
   */
  initialize() {
    // Create a dedicated offscreen canvas for WebGL (p5's canvas uses 2D context)
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.simWidth;
    this.canvas.height = this.simHeight;
    this.canvas.style.display = 'none'; // Hidden - only used for computation
    document.body.appendChild(this.canvas);

    // Get WebGL2 context from our dedicated canvas
    this.gl = this.canvas.getContext('webgl2', {
      preserveDrawingBuffer: true,
      antialias: false
    });

    if (!this.gl) {
      console.error('WebGL 2 not available');
      return false;
    }

    const gl = this.gl;

    // Enable float textures (required for fluid sim)
    const ext = gl.getExtension('EXT_color_buffer_float');
    if (!ext) {
      console.error('EXT_color_buffer_float not available - trying OES_texture_float');
      // Try fallback for older browsers
      const extFloat = gl.getExtension('OES_texture_float');
      const extFloatLinear = gl.getExtension('OES_texture_float_linear');
      if (!extFloat) {
        console.error('Float textures not supported');
        return false;
      }
    }

    // Create shader programs
    this._createPrograms();

    // Create textures and framebuffers
    this._createBuffers();

    // Create fullscreen quad for rendering
    this._createQuad();

    this.initialized = true;
    console.log(`FluidSimulation initialized: ${this.simWidth}x${this.simHeight} (dedicated WebGL canvas)`);
    return true;
  }

  /**
   * Upload cell boundaries as obstacle texture
   * @param {Array} cells - Array of cell objects with cx, cy, radius properties
   * @param {Object} options - Optional settings
   * @param {number} options.wallThickness - Thickness of top/bottom walls in sim pixels (default: 4)
   */
  uploadBoundaries(cells, options = {}) {
    if (!this.initialized) return;

    const width = this.simWidth;
    const height = this.simHeight;
    const data = new Uint8Array(width * height * 4);

    // Wall thickness for top and bottom boundaries (in simulation pixels)
    const wallThickness = options.wallThickness !== undefined ? options.wallThickness : 4;

    // Scale factors from render to sim coordinates
    const scaleX = width / this.renderWidth;
    const scaleY = height / this.renderHeight;

    // Rasterize cells as circular obstacles
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        // Convert to render coordinates
        const rx = (x + 0.5) / scaleX;
        const ry = (y + 0.5) / scaleY;

        let isObstacle = false;

        // Top and bottom wall boundaries (creates channel flow)
        if (y < wallThickness || y >= height - wallThickness) {
          isObstacle = true;
        }

        // Check against each cell (only if not already a wall)
        if (!isObstacle) {
          for (let cell of cells) {
            const dx = rx - cell.cx;
            const dy = ry - cell.cy;
            const dist = Math.sqrt(dx * dx + dy * dy);

            // Use slightly smaller radius to allow flow near edges
            if (dist < cell.radius * 0.9) {
              isObstacle = true;
              break;
            }
          }
        }

        const idx = (y * width + x) * 4;
        data[idx] = isObstacle ? 255 : 0;     // R - obstacle flag
        data[idx + 1] = 0;
        data[idx + 2] = 0;
        data[idx + 3] = 255;
      }
    }

    // Upload to boundary texture
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.textures.boundaries);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);

    console.log(`Uploaded ${cells.length} cell boundaries + top/bottom walls (${wallThickness}px)`);
  }

  /**
   * Step the fluid simulation forward
   * @param {number} frameCount - Current frame number
   */
  step(frameCount) {
    if (!this.initialized) return;

    // Update simulation time
    if (!this._simTime) this._simTime = 0;
    this._simTime += this.dt * 0.25; // Faster time evolution for more dynamic turbulence

    // Debug: log first step
    if (!this._firstStepLogged) {
      console.log(`FluidSimulation: ${this.simWidth}x${this.simHeight}, flowSpeed=${this.flowSpeed}, pressureIter=${this.pressureIterations}`);
      this._firstStepLogged = true;
    }

    const gl = this.gl;

    // Store current viewport to restore later
    const viewport = gl.getParameter(gl.VIEWPORT);

    // Set viewport to simulation resolution
    gl.viewport(0, 0, this.simWidth, this.simHeight);

    // 1. Add external forces (inflow from left)
    this._addForces();

    // 2. Advect velocity field
    this._advect(this.textures.velocityA, this.textures.velocityA, this.framebuffers.velocityB);
    this._swapVelocity();

    // 3. Viscous diffusion (shearing forces) - creates boundary layers near obstacles
    if (this.viscosity > 0) {
      for (let i = 0; i < this.diffusionIterations; i++) {
        this._diffusionIteration();
        this._swapVelocity();
      }
    }

    // 4. Enforce boundary conditions BEFORE divergence (ensures correct BC for pressure solve)
    this._enforceBoundaries();
    this._swapVelocity();

    // 5. Compute divergence
    this._computeDivergence();

    // 6. Solve pressure (multiple Jacobi iterations)
    this._clearTexture(this.textures.pressureA);
    for (let i = 0; i < this.pressureIterations; i++) {
      this._pressureIteration();
      this._swapPressure();
    }

    // 7. Subtract pressure gradient (projection step)
    this._subtractGradient();
    this._swapVelocity();

    // 8. Enforce boundary conditions again (clean up after projection)
    this._enforceBoundaries();
    this._swapVelocity();

    // 9. Vorticity confinement (re-inject energy into vortices)
    this._computeVorticity();
    this._applyVorticityForce();
    this._swapVelocity();

    // Restore viewport
    gl.viewport(viewport[0], viewport[1], viewport[2], viewport[3]);

    // Update CPU cache periodically (also on first frame)
    if (this.cacheFrame < 0 || frameCount - this.cacheFrame >= this.cacheInterval) {
      this._updateCache();
      this.cacheFrame = frameCount;
    }
  }

  /**
   * Get velocity at a position in render coordinates
   * @param {number} x - X position in render coordinates
   * @param {number} y - Y position in render coordinates
   * @returns {{vx: number, vy: number}} Velocity vector
   */
  getVelocityAt(x, y) {
    if (!this.cachedVelocity) {
      return { vx: this.flowSpeed, vy: 0 }; // Default flow if no cache
    }

    // Convert to simulation coordinates
    const sx = (x / this.renderWidth) * this.simWidth;
    const sy = (y / this.renderHeight) * this.simHeight;

    // Bilinear interpolation
    const x0 = Math.floor(sx);
    const y0 = Math.floor(sy);
    const x1 = Math.min(x0 + 1, this.simWidth - 1);
    const y1 = Math.min(y0 + 1, this.simHeight - 1);
    const fx = sx - x0;
    const fy = sy - y0;

    // Sample four corners
    const v00 = this._sampleCache(x0, y0);
    const v10 = this._sampleCache(x1, y0);
    const v01 = this._sampleCache(x0, y1);
    const v11 = this._sampleCache(x1, y1);

    // Bilinear interpolation
    const vx = (v00.vx * (1 - fx) + v10.vx * fx) * (1 - fy) +
               (v01.vx * (1 - fx) + v11.vx * fx) * fy;
    const vy = (v00.vy * (1 - fx) + v10.vy * fx) * (1 - fy) +
               (v01.vy * (1 - fx) + v11.vy * fx) * fy;

    // Scale back to render units
    const scaleX = this.renderWidth / this.simWidth;
    const scaleY = this.renderHeight / this.simHeight;

    return { vx: vx * scaleX * 0.1, vy: vy * scaleY * 0.1 };
  }

  /**
   * Check if a position is inside an obstacle
   * @param {number} x - X position in render coordinates
   * @param {number} y - Y position in render coordinates
   * @returns {boolean} True if inside obstacle
   */
  isObstacle(x, y) {
    // This could sample the boundary texture, but for now use the cells directly
    return false; // Handled by existing cell collision
  }

  /**
   * Render velocity field visualization to a p5.Graphics buffer
   * @param {p5.Graphics} g - Graphics buffer to render to
   * @param {Object} options - Visualization options
   * @param {boolean} options.showColors - Show color-coded velocity magnitude/direction
   * @param {boolean} options.showArrows - Show arrow glyphs
   * @param {number} options.arrowSpacing - Spacing between arrows in render pixels
   * @param {number} options.arrowScale - Scale factor for arrow length
   * @param {number} options.opacity - Overall opacity (0-255)
   */
  renderVelocityField(g, options = {}) {
    if (!this.cachedVelocity || !this.initialized) {
      return;
    }

    const showColors = options.showColors !== false;
    const showArrows = options.showArrows !== false;
    const arrowSpacing = options.arrowSpacing || 40;
    const arrowScale = options.arrowScale || 15;
    const opacity = options.opacity || 180;

    const w = g.width;
    const h = g.height;

    g.push();

    // Color-coded velocity field (rendered as rectangles for performance)
    if (showColors) {
      g.noStroke();
      const cellW = w / this.simWidth;
      const cellH = h / this.simHeight;

      for (let sy = 0; sy < this.simHeight; sy++) {
        for (let sx = 0; sx < this.simWidth; sx++) {
          const idx = (sy * this.simWidth + sx) * 4;
          const vx = this.cachedVelocity[idx];
          const vy = this.cachedVelocity[idx + 1];

          // Skip near-zero velocities
          const mag = Math.sqrt(vx * vx + vy * vy);
          if (mag < 0.01) continue;

          // Map velocity to color
          // Direction -> Hue (0=right=red, 90=up=green, 180=left=cyan, 270=down=blue)
          const angle = Math.atan2(vy, vx);
          const hue = ((angle + Math.PI) / (2 * Math.PI)) * 360;

          // Magnitude -> Saturation and Brightness
          const normMag = Math.min(mag / (this.flowSpeed * 2), 1);
          const sat = 60 + normMag * 40;
          const bri = 50 + normMag * 50;

          g.colorMode(g.HSB, 360, 100, 100, 255);
          g.fill(hue, sat, bri, opacity * 0.5);

          const rx = sx * cellW;
          const ry = sy * cellH;
          g.rect(rx, ry, cellW + 1, cellH + 1);
        }
      }
      g.colorMode(g.RGB, 255);
    }

    // Arrow glyphs - length indicates velocity magnitude
    if (showArrows) {
      g.stroke(40, 40, 60, opacity);
      g.strokeWeight(1.5);

      const numArrowsX = Math.floor(w / arrowSpacing);
      const numArrowsY = Math.floor(h / arrowSpacing);

      for (let ay = 0; ay <= numArrowsY; ay++) {
        for (let ax = 0; ax <= numArrowsX; ax++) {
          const rx = ax * arrowSpacing + arrowSpacing / 2;
          const ry = ay * arrowSpacing + arrowSpacing / 2;

          // Get velocity at this render position
          const vel = this.getVelocityAt(rx, ry);

          // Compute magnitude
          const mag = Math.sqrt(vel.vx * vel.vx + vel.vy * vel.vy);
          if (mag < 0.02) continue;

          // Arrow length proportional to velocity magnitude (not normalized)
          // Scale factor converts velocity units to pixels
          const lengthScale = arrowScale * 8;  // Amplify for visibility
          const arrowLen = Math.min(mag * lengthScale, arrowSpacing * 0.9);

          // Direction from velocity components
          const endX = rx + (vel.vx / mag) * arrowLen;
          const endY = ry + (vel.vy / mag) * arrowLen;

          // Draw arrow line
          g.line(rx, ry, endX, endY);

          // Draw arrowhead (size proportional to arrow length)
          const headLen = Math.max(3, Math.min(arrowLen * 0.25, 8));
          const headAngle = Math.atan2(vel.vy, vel.vx);
          const ha1 = headAngle + Math.PI * 0.8;
          const ha2 = headAngle - Math.PI * 0.8;

          g.line(endX, endY, endX + Math.cos(ha1) * headLen, endY + Math.sin(ha1) * headLen);
          g.line(endX, endY, endX + Math.cos(ha2) * headLen, endY + Math.sin(ha2) * headLen);
        }
      }
    }

    g.pop();
  }

  /**
   * Get the maximum velocity magnitude in the current field
   * @returns {number} Maximum velocity magnitude
   */
  getMaxVelocity() {
    if (!this.cachedVelocity) return 0;

    let maxMag = 0;
    for (let i = 0; i < this.cachedVelocity.length; i += 4) {
      const vx = this.cachedVelocity[i];
      const vy = this.cachedVelocity[i + 1];
      const mag = Math.sqrt(vx * vx + vy * vy);
      if (mag > maxMag) maxMag = mag;
    }
    return maxMag;
  }

  /**
   * Render pressure field visualization to a p5.Graphics buffer
   * High pressure = red, low pressure = blue, zero = white
   * @param {p5.Graphics} g - Graphics buffer to render to
   * @param {Object} options - Visualization options
   * @param {number} options.opacity - Overall opacity (0-255)
   * @param {number} options.scale - Pressure scale multiplier (auto-calculated if not provided)
   */
  renderPressureField(g, options = {}) {
    if (!this.cachedPressure || !this.initialized) {
      return;
    }

    const opacity = options.opacity || 180;
    const w = g.width;
    const h = g.height;

    // Find pressure range for normalization
    let minP = Infinity;
    let maxP = -Infinity;
    for (let i = 0; i < this.cachedPressure.length; i += 4) {
      const p = this.cachedPressure[i];
      if (p < minP) minP = p;
      if (p > maxP) maxP = p;
    }

    // Use symmetric range around zero for better visualization
    const absMax = Math.max(Math.abs(minP), Math.abs(maxP), 0.001);
    const scale = options.scale || absMax;

    g.push();
    g.noStroke();

    const cellW = w / this.simWidth;
    const cellH = h / this.simHeight;

    for (let sy = 0; sy < this.simHeight; sy++) {
      for (let sx = 0; sx < this.simWidth; sx++) {
        const idx = (sy * this.simWidth + sx) * 4;
        const pressure = this.cachedPressure[idx];

        // Normalize to -1 to 1 range
        const normP = Math.max(-1, Math.min(1, pressure / scale));

        // Color mapping: red = high pressure, blue = low pressure, white = zero
        let r, gr, b;
        if (normP > 0) {
          // High pressure: white to red
          r = 255;
          gr = Math.floor(255 * (1 - normP));
          b = Math.floor(255 * (1 - normP));
        } else {
          // Low pressure: white to blue
          r = Math.floor(255 * (1 + normP));
          gr = Math.floor(255 * (1 + normP));
          b = 255;
        }

        g.fill(r, gr, b, opacity);

        const rx = sx * cellW;
        const ry = sy * cellH;
        g.rect(rx, ry, cellW + 1, cellH + 1);
      }
    }

    // Draw legend
    g.fill(0);
    g.textSize(12);
    g.textAlign(g.LEFT, g.TOP);
    g.text(`Pressure: ${minP.toFixed(3)} to ${maxP.toFixed(3)}`, 10, 10);

    g.pop();
  }

  // ==================== Private Methods ====================

  _sampleCache(x, y) {
    const idx = (y * this.simWidth + x) * 4;
    return {
      vx: this.cachedVelocity[idx],
      vy: this.cachedVelocity[idx + 1]
    };
  }

  _updateCache() {
    const gl = this.gl;
    const width = this.simWidth;
    const height = this.simHeight;

    if (!this.cachedVelocity) {
      this.cachedVelocity = new Float32Array(width * height * 4);
    }
    if (!this.cachedPressure) {
      this.cachedPressure = new Float32Array(width * height * 4);
    }

    // Read velocity texture to CPU
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffers.velocityA);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.FLOAT, this.cachedVelocity);

    // Read pressure texture to CPU
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffers.pressureA);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.FLOAT, this.cachedPressure);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  _createPrograms() {
    // Use shader sources from FluidShaders module
    const shaders = window.FluidShaders;
    if (!shaders) {
      console.error('FluidShaders not loaded - ensure FluidShaders.js is included before FluidSimulation.js');
      return;
    }

    const vertSrc = shaders.vertex;

    // Create shader programs
    this.programs.advection = this._createProgram(vertSrc, shaders.advection);
    this.programs.divergence = this._createProgram(vertSrc, shaders.divergence);
    this.programs.pressure = this._createProgram(vertSrc, shaders.pressure);
    this.programs.gradient = this._createProgram(vertSrc, shaders.gradient);
    this.programs.addForce = this._createProgram(vertSrc, shaders.addForce);
    this.programs.vorticity = this._createProgram(vertSrc, shaders.vorticity);
    this.programs.vorticityForce = this._createProgram(vertSrc, shaders.vorticityForce);
    this.programs.boundaryEnforce = this._createProgram(vertSrc, shaders.boundaryEnforce);
    this.programs.diffusion = this._createProgram(vertSrc, shaders.diffusion);
  }

  _createProgram(vertSrc, fragSrc) {
    const gl = this.gl;

    const vert = gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(vert, vertSrc);
    gl.compileShader(vert);
    if (!gl.getShaderParameter(vert, gl.COMPILE_STATUS)) {
      console.error('Vertex shader error:', gl.getShaderInfoLog(vert));
      return null;
    }

    const frag = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(frag, fragSrc);
    gl.compileShader(frag);
    if (!gl.getShaderParameter(frag, gl.COMPILE_STATUS)) {
      console.error('Fragment shader error:', gl.getShaderInfoLog(frag));
      console.error('Fragment shader source:', fragSrc.substring(0, 200));
      return null;
    }

    const program = gl.createProgram();
    gl.attachShader(program, vert);
    gl.attachShader(program, frag);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.error('Program link error:', gl.getProgramInfoLog(program));
      return null;
    }

    return program;
  }

  _createBuffers() {
    const gl = this.gl;
    const width = this.simWidth;
    const height = this.simHeight;

    // Create float textures for velocity (ping-pong pair)
    this.textures.velocityA = this._createFloatTexture(width, height);
    this.textures.velocityB = this._createFloatTexture(width, height);

    // Pressure (ping-pong pair)
    this.textures.pressureA = this._createFloatTexture(width, height);
    this.textures.pressureB = this._createFloatTexture(width, height);

    // Divergence (single)
    this.textures.divergence = this._createFloatTexture(width, height);

    // Vorticity (for vorticity confinement)
    this.textures.vorticity = this._createFloatTexture(width, height);

    // Boundaries (RGBA8 is fine for this) - initialize to zeros (no obstacles)
    this.textures.boundaries = this._createTexture(width, height, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE);
    // Initialize boundaries to all zeros (no obstacles)
    const emptyBoundaries = new Uint8Array(width * height * 4);
    gl.bindTexture(gl.TEXTURE_2D, this.textures.boundaries);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, emptyBoundaries);

    // Create framebuffers
    this.framebuffers.velocityA = this._createFramebuffer(this.textures.velocityA);
    this.framebuffers.velocityB = this._createFramebuffer(this.textures.velocityB);
    this.framebuffers.pressureA = this._createFramebuffer(this.textures.pressureA);
    this.framebuffers.pressureB = this._createFramebuffer(this.textures.pressureB);
    this.framebuffers.divergence = this._createFramebuffer(this.textures.divergence);
    this.framebuffers.vorticity = this._createFramebuffer(this.textures.vorticity);
  }

  _createFloatTexture(width, height) {
    return this._createTexture(width, height, this.gl.RGBA32F, this.gl.RGBA, this.gl.FLOAT);
  }

  _createTexture(width, height, internalFormat, format, type) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, width, height, 0, format, type, null);
    // Use NEAREST filtering for float textures (LINEAR may not be supported)
    const filter = (type === gl.FLOAT) ? gl.NEAREST : gl.LINEAR;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  _createFramebuffer(texture) {
    const gl = this.gl;
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);

    // Check framebuffer completeness
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      console.error('Framebuffer incomplete:', status);
    }

    return fb;
  }

  _createQuad() {
    const gl = this.gl;
    const vertices = new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]);
    this.quadBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);

    this.quadVAO = gl.createVertexArray();
    gl.bindVertexArray(this.quadVAO);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
  }

  _clearTexture(texture) {
    const gl = this.gl;
    const fb = this._createFramebuffer(texture);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.deleteFramebuffer(fb);
  }

  _addForces() {
    const gl = this.gl;
    const prog = this.programs.addForce;
    if (!prog) return;

    gl.useProgram(prog);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffers.velocityB);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.textures.velocityA);
    gl.uniform1i(gl.getUniformLocation(prog, 'uVelocity'), 0);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.textures.boundaries);
    gl.uniform1i(gl.getUniformLocation(prog, 'uBoundaries'), 1);

    gl.uniform2f(gl.getUniformLocation(prog, 'uResolution'), this.simWidth, this.simHeight);
    gl.uniform1f(gl.getUniformLocation(prog, 'uFlowSpeed'), this.flowSpeed);
    gl.uniform1f(gl.getUniformLocation(prog, 'uInflowWidth'), 0.05);
    gl.uniform1f(gl.getUniformLocation(prog, 'uTime'), this._simTime || 0);

    this._drawQuad();
    this._swapVelocity();
  }

  _advect(velocityTex, quantityTex, targetFB) {
    const gl = this.gl;
    const prog = this.programs.advection;
    if (!prog) return;

    gl.useProgram(prog);
    gl.bindFramebuffer(gl.FRAMEBUFFER, targetFB);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, velocityTex);
    gl.uniform1i(gl.getUniformLocation(prog, 'uVelocity'), 0);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, quantityTex);
    gl.uniform1i(gl.getUniformLocation(prog, 'uQuantity'), 1);

    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.textures.boundaries);
    gl.uniform1i(gl.getUniformLocation(prog, 'uBoundaries'), 2);

    gl.uniform2f(gl.getUniformLocation(prog, 'uResolution'), this.simWidth, this.simHeight);
    gl.uniform1f(gl.getUniformLocation(prog, 'uDt'), this.dt);
    gl.uniform1f(gl.getUniformLocation(prog, 'uDissipation'), this.dissipation);

    this._drawQuad();
  }

  _diffusionIteration() {
    const gl = this.gl;
    const prog = this.programs.diffusion;
    if (!prog) return;

    gl.useProgram(prog);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffers.velocityB);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.textures.velocityA);
    gl.uniform1i(gl.getUniformLocation(prog, 'uVelocity'), 0);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.textures.boundaries);
    gl.uniform1i(gl.getUniformLocation(prog, 'uBoundaries'), 1);

    gl.uniform2f(gl.getUniformLocation(prog, 'uResolution'), this.simWidth, this.simHeight);
    gl.uniform1f(gl.getUniformLocation(prog, 'uViscosity'), this.viscosity);
    gl.uniform1f(gl.getUniformLocation(prog, 'uDt'), this.dt);

    this._drawQuad();
  }

  _computeDivergence() {
    const gl = this.gl;
    const prog = this.programs.divergence;

    gl.useProgram(prog);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffers.divergence);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.textures.velocityA);
    gl.uniform1i(gl.getUniformLocation(prog, 'uVelocity'), 0);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.textures.boundaries);
    gl.uniform1i(gl.getUniformLocation(prog, 'uBoundaries'), 1);

    gl.uniform2f(gl.getUniformLocation(prog, 'uResolution'), this.simWidth, this.simHeight);

    this._drawQuad();
  }

  _pressureIteration() {
    const gl = this.gl;
    const prog = this.programs.pressure;

    gl.useProgram(prog);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffers.pressureB);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.textures.pressureA);
    gl.uniform1i(gl.getUniformLocation(prog, 'uPressure'), 0);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.textures.divergence);
    gl.uniform1i(gl.getUniformLocation(prog, 'uDivergence'), 1);

    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.textures.boundaries);
    gl.uniform1i(gl.getUniformLocation(prog, 'uBoundaries'), 2);

    gl.uniform2f(gl.getUniformLocation(prog, 'uResolution'), this.simWidth, this.simHeight);

    this._drawQuad();
  }

  _subtractGradient() {
    const gl = this.gl;
    const prog = this.programs.gradient;
    if (!prog) return;

    gl.useProgram(prog);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffers.velocityB);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.textures.velocityA);
    gl.uniform1i(gl.getUniformLocation(prog, 'uVelocity'), 0);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.textures.pressureA);
    gl.uniform1i(gl.getUniformLocation(prog, 'uPressure'), 1);

    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.textures.boundaries);
    gl.uniform1i(gl.getUniformLocation(prog, 'uBoundaries'), 2);

    gl.uniform2f(gl.getUniformLocation(prog, 'uResolution'), this.simWidth, this.simHeight);

    this._drawQuad();
  }

  _computeVorticity() {
    const gl = this.gl;
    const prog = this.programs.vorticity;

    if (!prog) return;

    gl.useProgram(prog);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffers.vorticity);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.textures.velocityA);
    gl.uniform1i(gl.getUniformLocation(prog, 'uVelocity'), 0);

    gl.uniform2f(gl.getUniformLocation(prog, 'uResolution'), this.simWidth, this.simHeight);

    this._drawQuad();
  }

  _applyVorticityForce() {
    const gl = this.gl;
    const prog = this.programs.vorticityForce;

    if (!prog) return;

    gl.useProgram(prog);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffers.velocityB);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.textures.velocityA);
    gl.uniform1i(gl.getUniformLocation(prog, 'uVelocity'), 0);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.textures.vorticity);
    gl.uniform1i(gl.getUniformLocation(prog, 'uVorticity'), 1);

    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.textures.boundaries);
    gl.uniform1i(gl.getUniformLocation(prog, 'uBoundaries'), 2);

    gl.uniform2f(gl.getUniformLocation(prog, 'uResolution'), this.simWidth, this.simHeight);
    gl.uniform1f(gl.getUniformLocation(prog, 'uVorticityStrength'), this.vorticityStrength);
    gl.uniform1f(gl.getUniformLocation(prog, 'uDt'), this.dt);

    this._drawQuad();
  }

  _enforceBoundaries() {
    const gl = this.gl;
    const prog = this.programs.boundaryEnforce;

    if (!prog) return;

    gl.useProgram(prog);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffers.velocityB);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.textures.velocityA);
    gl.uniform1i(gl.getUniformLocation(prog, 'uVelocity'), 0);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.textures.boundaries);
    gl.uniform1i(gl.getUniformLocation(prog, 'uBoundaries'), 1);

    gl.uniform2f(gl.getUniformLocation(prog, 'uResolution'), this.simWidth, this.simHeight);

    this._drawQuad();
  }

  _swapVelocity() {
    [this.textures.velocityA, this.textures.velocityB] = [this.textures.velocityB, this.textures.velocityA];
    [this.framebuffers.velocityA, this.framebuffers.velocityB] = [this.framebuffers.velocityB, this.framebuffers.velocityA];
  }

  _swapPressure() {
    [this.textures.pressureA, this.textures.pressureB] = [this.textures.pressureB, this.textures.pressureA];
    [this.framebuffers.pressureA, this.framebuffers.pressureB] = [this.framebuffers.pressureB, this.framebuffers.pressureA];
  }

  _drawQuad() {
    const gl = this.gl;
    gl.bindVertexArray(this.quadVAO);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
  }

  // Shader sources are now in FluidShaders.js
}

// Export for browser global
window.FluidSimulation = FluidSimulation;
console.log('FluidSimulation.js loaded, class defined:', typeof FluidSimulation);
