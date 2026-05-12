// Cell.js - Cell entity with organic shape generation and receptor management

class Cell {
  constructor(cx, cy, baseRadius, seed, receptorConcentrations, isTumor = false, tissueColor = null) {
    this.cx = cx;
    this.cy = cy;
    this.seed = seed;
    this.isTumor = isTumor;
    this.tissueColor = tissueColor || TISSUE_COLORS.default;
    this.bendingSprings = [];
    this.receptors = [];    // Array of Receptor objects
    this.receptorNodes = []; // Array of {angle, x, y, pairId} - nodes between adjacent receptors
    this.bound = 0;         // Count of bound particles on this cell
    this.absorbedDrugs = 0; // Count of drug molecules absorbed into this cell

    // Cell death state
    this.dying = false;
    this.dead = false;
    this.deathTimer = 0;
    this.deathDuration = 180; // 3 seconds at 60fps
    this.deathSegments = [];  // Membrane line segments flying apart

    // Store receptor concentrations
    this.receptorConcentrations = receptorConcentrations || [0, 0, 0, 0, 0, 0];
    this.totalExpression = this.receptorConcentrations.reduce((sum, c) => sum + (c || 0), 0);

    // Calculate total receptors needed (each color gets its full allocation)
    const maxPerColor = PHYSICS_DEFAULTS.maxReceptorsPerColor;
    this.totalReceptorsNeeded = 0;
    for (let i = 0; i < 6; i++) {
      this.totalReceptorsNeeded += Math.round((this.receptorConcentrations[i] || 0) * maxPerColor);
    }

    // Scale size based on expression (0.6x to 1.2x)
    const { minSizeFactor, maxSizeFactor, maxExpression } = EXPRESSION_SCALING;
    const expressionRatio = Math.min(this.totalExpression / maxExpression, 1);
    this.sizeFactor = minSizeFactor + expressionRatio * (maxSizeFactor - minSizeFactor);
    this.radius = baseRadius * this.sizeFactor;

    // Shape points must accommodate all receptors needed
    // Use at least minShapePoints, but scale up if more receptors are needed
    const { minShapePoints } = EXPRESSION_SCALING;
    this.numShapePoints = Math.max(minShapePoints, this.totalReceptorsNeeded);

    // Generate shape — Perlin amplitude differs for tumor (lumpy) vs. normal (gently irregular)
    const noiseAmp = this.isTumor
      ? SOFT_BODY_DEFAULTS.tumorNoiseAmplitude
      : SOFT_BODY_DEFAULTS.normalNoiseAmplitude;
    this.shape = Cell.generateShape(cx, cy, this.radius, seed, this.numShapePoints, noiseAmp);

    // Nucleus geometry — deterministic offset from seed, slightly different proportions for tumor
    this.computeNucleusGeometry();

    // Auto-allocate receptors based on concentrations
    this.allocateReceptors();

    // Initialize soft body spring-mass system
    this.initSoftBody();
  }

  // Compute nucleus offset and radii from current radius and seed.  Called from the
  // constructor and from updateConcentrations() whenever the cell radius changes.
  computeNucleusGeometry() {
    const angle = (this.seed * 6.283) % (2 * Math.PI);
    const offset = this.radius * 0.12;
    this.nucleusOffsetX = Math.cos(angle) * offset;
    this.nucleusOffsetY = Math.sin(angle) * offset;
    this.nucleusRadiusX = this.radius * (this.isTumor ? 0.42 : 0.35);
    this.nucleusRadiusY = this.radius * (this.isTumor ? 0.36 : 0.32);
  }

  // Generate cell shape — Perlin variation with configurable noise amplitude.
  // Backward-compatible with boolean callers: true → 0.20, false → 0.
  static generateShape(cx, cy, baseRadius, seed, numPoints = 32, noiseAmplitude = 0.2) {
    const points = [];
    const amp = typeof noiseAmplitude === 'boolean'
      ? (noiseAmplitude ? 0.2 : 0)
      : noiseAmplitude;

    for (let i = 0; i < numPoints; i++) {
      const angle = (i / numPoints) * TWO_PI;
      let r = baseRadius;
      if (amp > 0) {
        const noiseVal = noise(Math.cos(angle) * 2 + seed, Math.sin(angle) * 2 + seed);
        r *= map(noiseVal, 0, 1, 1 - amp, 1 + amp);
      }
      points.push({
        x: cx + Math.cos(angle) * r,
        y: cy + Math.sin(angle) * r
      });
    }
    return points;
  }

  // Allocate Y-shaped receptors around the cell membrane
  allocateReceptors() {
    this.receptors = [];
    const maxPerColor = PHYSICS_DEFAULTS.maxReceptorsPerColor;

    // Calculate receptor count for each color (full allocation, no scaling)
    const receptorCounts = [];
    let totalReceptors = 0;
    for (let color = 0; color < 6; color++) {
      const count = Math.round((this.receptorConcentrations[color] || 0) * maxPerColor);
      receptorCounts.push(count);
      totalReceptors += count;
    }

    if (totalReceptors === 0 || !this.shape || this.shape.length === 0) {
      return;
    }

    // Create shuffled indices for random distribution around the membrane
    const availableSlots = this.shape.length;
    const indices = [];
    for (let i = 0; i < availableSlots; i++) {
      indices.push(i);
    }
    for (let i = indices.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = indices[i];
      indices[i] = indices[j];
      indices[j] = t;
    }

    // Allocate all receptors (each color gets its full count)
    let pointIdx = 0;
    for (let color = 0; color < 6; color++) {
      const count = receptorCounts[color];
      for (let k = 0; k < count; k++) {
        if (pointIdx >= indices.length) break;

        const shapeIdx = indices[pointIdx++];
        const point = this.shape[shapeIdx];
        const baseX = point.x;
        const baseY = point.y;

        // Calculate outward direction from cell center
        const dx = baseX - this.cx;
        const dy = baseY - this.cy;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const nx = dx / dist;
        const ny = dy / dist;

        // Receptor stems point outward
        const branchLen = Math.min(6, this.radius * 0.15);
        const stemLen = branchLen * 2;
        const tipX = baseX + nx * stemLen;
        const tipY = baseY + ny * stemLen;

        const receptor = new Receptor(baseX, baseY, tipX, tipY, color, nx, ny, branchLen);
        receptor.shapeIndex = shapeIdx; // Track which shape point this receptor is anchored to
        this.receptors.push(receptor);
      }
    }

    // Compute receptor nodes between adjacent receptors
    this.computeReceptorNodes();
  }

  // Initialize soft body spring-mass system from current shape points
  initSoftBody() {
    const sb = SOFT_BODY_DEFAULTS;
    this.softBodyEnabled = sb.enabled;

    if (!this.softBodyEnabled || !this.shape || this.shape.length === 0) {
      this.anchorX = this.cx;
      this.anchorY = this.cy;
      this.nodes = [];
      this.structuralSprings = [];
      return;
    }

    // Create mass nodes from shape points
    this.nodes = this.shape.map(pt => ({
      x: pt.x,
      y: pt.y,
      vx: 0,
      vy: 0,
      restOffsetX: 0,
      restOffsetY: 0,
      mass: 1.0
    }));

    // The organic shape's centroid differs from (cx, cy) because Perlin-noise radii vary.
    // Recompute cx/cy to the true centroid so that restOffsets and the anchor are consistent
    // with where the nodes actually are — prevents a jump-to-equilibrium on the first frame.
    let sumX = 0, sumY = 0;
    for (let node of this.nodes) { sumX += node.x; sumY += node.y; }
    this.cx = sumX / this.nodes.length;
    this.cy = sumY / this.nodes.length;

    for (let node of this.nodes) {
      node.restOffsetX = node.x - this.cx;
      node.restOffsetY = node.y - this.cy;
    }

    // Anchor at the true centroid — zero initial spring force
    this.anchorX = this.cx;
    this.anchorY = this.cy;

    // Rest area for volume preservation (signed, positive for CCW winding)
    let areaSum = 0;
    for (let i = 0; i < this.nodes.length; i++) {
      const j = (i + 1) % this.nodes.length;
      areaSum += this.nodes[i].x * this.nodes[j].y - this.nodes[j].x * this.nodes[i].y;
    }
    this.restArea = areaSum * 0.5;

    // Bending springs — rest angle taken from the actual initial geometry, so there is
    // zero initial bending force regardless of noise amplitude.  Tumor cells restore
    // toward a strongly lumpy silhouette; non-tumor cells toward a gently irregular one.
    const N = this.nodes.length;
    this.bendingSprings = [];
    for (let i = 0; i < N; i++) {
      const A = this.nodes[(i - 1 + N) % N];
      const B = this.nodes[i];
      const C = this.nodes[(i + 1) % N];
      const e1x = A.x - B.x, e1y = A.y - B.y;
      const e2x = C.x - B.x, e2y = C.y - B.y;
      const restAngle = Math.atan2(e1x * e2y - e1y * e2x, e1x * e2x + e1y * e2y);
      this.bendingSprings.push({ i, restAngle });
    }

    // Structural springs between adjacent nodes (membrane shape preservation)
    this.structuralSprings = [];
    for (let i = 0; i < this.nodes.length; i++) {
      const j = (i + 1) % this.nodes.length;
      const ni = this.nodes[i];
      const nj = this.nodes[j];
      const dx = nj.x - ni.x;
      const dy = nj.y - ni.y;
      this.structuralSprings.push({
        i: i,
        j: j,
        restLength: Math.sqrt(dx * dx + dy * dy),
        stiffness: sb.structuralStiffness,
        damping: sb.structuralDamping
      });
    }
  }

  // Update soft body physics each frame
  updateSoftBody(physicsParams, frameCount, fluidSim) {
    if (!this.softBodyEnabled || this.nodes.length === 0) return;

    const sb = SOFT_BODY_DEFAULTS;

    // Slow per-cell breath multiplier — drives gentle pulsation of shape-restoring targets
    // and (for tumor cells) volume preservation.  Phase is offset by seed so cells don't
    // pulse in unison; period is ~5s at 60fps.
    const breathPhase = (2 * Math.PI * frameCount / sb.breathPeriodFrames)
                      + (this.seed % 1) * 2 * Math.PI;
    const breathMul = 1 + sb.breathAmplitude * Math.sin(breathPhase);

    // 1. Apply external forces to nodes (small — just for subtle jiggle)
    for (let i = 0; i < this.nodes.length; i++) {
      const node = this.nodes[i];

      // Brownian jitter only (keeps cells alive-looking without drift)
      node.vx += (Math.random() - 0.5) * sb.brownianStrength;
      node.vy += (Math.random() - 0.5) * sb.brownianStrength;
    }

    // 2. Apply structural spring forces (adjacent membrane nodes)
    for (let spring of this.structuralSprings) {
      const ni = this.nodes[spring.i];
      const nj = this.nodes[spring.j];
      const dx = nj.x - ni.x;
      const dy = nj.y - ni.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 0.001;
      const displacement = dist - spring.restLength;

      const fx = (dx / dist) * displacement * spring.stiffness;
      const fy = (dy / dist) * displacement * spring.stiffness;

      const dvx = nj.vx - ni.vx;
      const dvy = nj.vy - ni.vy;
      const dampFx = dvx * spring.damping;
      const dampFy = dvy * spring.damping;

      ni.vx += (fx + dampFx) / ni.mass;
      ni.vy += (fy + dampFy) / ni.mass;
      nj.vx -= (fx + dampFx) / nj.mass;
      nj.vy -= (fy + dampFy) / nj.mass;
    }

    // 3. Shape-restoring springs — pull each node toward its rest position relative to the
    // current centroid.  Cartesian (not radial) so each node has a unique angular target;
    // this makes topology-wrong states (figure-8, double-loop) energetically unstable and
    // ensures the cell always recovers to the correct shape.  Rest offsets are scaled by
    // breathMul so the whole cell gently expands and contracts.
    for (let i = 0; i < this.nodes.length; i++) {
      const node = this.nodes[i];
      const dx = node.x - (this.cx + node.restOffsetX * breathMul);
      const dy = node.y - (this.cy + node.restOffsetY * breathMul);
      node.vx -= dx * sb.pressureStiffness;
      node.vy -= dy * sb.pressureStiffness;
      node.vx -= node.vx * sb.pressureDamping;
      node.vy -= node.vy * sb.pressureDamping;
    }

    // 3.5. Bending springs — resist angle changes at each membrane joint.
    // Force derived from the analytical gradient of the joint angle w.r.t. node positions.
    // Tumor cells restore to their Perlin shape; all others restore to a circle.
    const bendK = sb.bendingStiffness;
    if (bendK > 0) {
      const N = this.nodes.length;
      for (const spring of this.bendingSprings) {
        const idx = spring.i;
        const A = this.nodes[(idx - 1 + N) % N];
        const B = this.nodes[idx];
        const C = this.nodes[(idx + 1) % N];

        const e1x = A.x - B.x, e1y = A.y - B.y;
        const e2x = C.x - B.x, e2y = C.y - B.y;
        const denom = (e1x*e1x + e1y*e1y) * (e2x*e2x + e2y*e2y);
        if (denom < 1e-6) continue;

        const cross = e1x*e2y - e1y*e2x;
        const dot_  = e1x*e2x + e1y*e2y;
        let dAngle = Math.atan2(cross, dot_) - spring.restAngle;
        if (dAngle >  Math.PI) dAngle -= 2 * Math.PI;
        if (dAngle < -Math.PI) dAngle += 2 * Math.PI;

        const scale = -bendK * dAngle / denom;

        // Gradient numerators: ∂(angle)/∂pos × denom
        const gAx =  dot_ * e2y - cross * e2x;
        const gAy = -dot_ * e2x - cross * e2y;
        const gCx = -dot_ * e1y - cross * e1x;
        const gCy =  dot_ * e1x - cross * e1y;

        A.vx += scale * gAx;  A.vy += scale * gAy;
        C.vx += scale * gCx;  C.vy += scale * gCy;
        B.vx -= scale * (gAx + gCx);
        B.vy -= scale * (gAy + gCy);
      }
    }

    // 3.8. Volume preservation — maintain polygon area to prevent C-shape / pancake collapse.
    // Tumor cells need this because their irregular Perlin shape can collapse on bending
    // springs alone.  Non-tumor cells (which are nearly circular) are sufficiently held
    // by structural + bending + shape-restoring springs and look over-inflated when this
    // is also active, so the block is gated to tumor cells only.  The breath multiplier
    // scales target area as r² (since area scales as r²) for visible breathing.
    if (this.isTumor && Math.abs(this.restArea) > 1e-6) {
      const Nv = this.nodes.length;
      let area = 0;
      for (let i = 0; i < Nv; i++) {
        const j = (i + 1) % Nv;
        area += this.nodes[i].x * this.nodes[j].y - this.nodes[j].x * this.nodes[i].y;
      }
      area *= 0.5;
      const breathTarget = this.restArea * breathMul * breathMul;
      const pressure = sb.volumeStiffness * (breathTarget - area) / Math.abs(this.restArea);
      for (let i = 0; i < Nv; i++) {
        const j = (i + 1) % Nv;
        const edgeDx = this.nodes[j].x - this.nodes[i].x;
        const edgeDy = this.nodes[j].y - this.nodes[i].y;
        const fnx = -edgeDy * 0.5 * pressure;
        const fny =  edgeDx * 0.5 * pressure;
        this.nodes[i].vx += fnx;  this.nodes[i].vy += fny;
        this.nodes[j].vx += fnx;  this.nodes[j].vy += fny;
      }
    }

    // 4. Integrate positions and apply damping
    for (let i = 0; i < this.nodes.length; i++) {
      const node = this.nodes[i];
      node.vx *= sb.nodeDamping;
      node.vy *= sb.nodeDamping;
      node.x += node.vx;
      node.y += node.vy;

      // Update corresponding shape point
      this.shape[i].x = node.x;
      this.shape[i].y = node.y;
    }

    // 5. Compute centroid from nodes
    let sumX = 0, sumY = 0;
    for (let node of this.nodes) {
      sumX += node.x;
      sumY += node.y;
    }
    this.cx = sumX / this.nodes.length;
    this.cy = sumY / this.nodes.length;

    // 5.5. Hard constraints — position corrections applied after integration.
    //
    // (a) Edge length cap: if an edge exceeds maxEdgeStretch × restLength, shorten it
    //     back directly and zero the separating velocity so it doesn't re-stretch next frame.
    //
    // (b) Winding guard: for CCW winding, cross(A−B, C−B) must be < 0 at every node.
    //     A positive value means the node has folded to the wrong side of its neighbours.
    //     Snap it halfway back to its Cartesian rest position and kill its velocity so the
    //     fold doesn't propagate.
    {
      const Nc = this.nodes.length;

      // (a) Edge length cap
      for (const spring of this.structuralSprings) {
        const ni = this.nodes[spring.i];
        const nj = this.nodes[spring.j];
        const dx = nj.x - ni.x, dy = nj.y - ni.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 0.001;
        const maxLen = spring.restLength * sb.maxEdgeStretch;
        if (dist > maxLen) {
          const corr = (dist - maxLen) / dist * 0.5;
          ni.x += dx * corr;  ni.y += dy * corr;
          nj.x -= dx * corr;  nj.y -= dy * corr;
          this.shape[spring.i].x = ni.x;  this.shape[spring.i].y = ni.y;
          this.shape[spring.j].x = nj.x;  this.shape[spring.j].y = nj.y;
          // Remove separating velocity component to prevent immediate re-stretch
          const nx = dx / dist, ny = dy / dist;
          const relVel = (nj.vx - ni.vx) * nx + (nj.vy - ni.vy) * ny;
          if (relVel > 0) {
            ni.vx += 0.5 * relVel * nx;  ni.vy += 0.5 * relVel * ny;
            nj.vx -= 0.5 * relVel * nx;  nj.vy -= 0.5 * relVel * ny;
          }
        }
      }

      // (b) Winding guard
      for (let i = 0; i < Nc; i++) {
        const A = this.nodes[(i - 1 + Nc) % Nc];
        const B = this.nodes[i];
        const C = this.nodes[(i + 1) % Nc];
        const cross = (A.x - B.x) * (C.y - B.y) - (A.y - B.y) * (C.x - B.x);
        if (cross > 0) {
          const tx = this.cx + B.restOffsetX;
          const ty = this.cy + B.restOffsetY;
          B.x += (tx - B.x) * 0.5;
          B.y += (ty - B.y) * 0.5;
          B.vx *= 0.1;
          B.vy *= 0.1;
          this.shape[i].x = B.x;
          this.shape[i].y = B.y;
        }
      }
    }

    // 6. Angular velocity damping — bleed off rigid-body spin so tangential impacts
    // don't send the cell into a continuous rotation.
    // ω = Σ(r × v) / Σ|r|²  (2D scalar angular velocity)
    {
      let angNum = 0, angDen = 0;
      for (const node of this.nodes) {
        const rx = node.x - this.cx;
        const ry = node.y - this.cy;
        angNum += rx * node.vy - ry * node.vx;
        angDen += rx * rx + ry * ry;
      }
      if (angDen > 0) {
        const omega = angNum / angDen;
        const drain = omega * sb.angularDamping;
        for (const node of this.nodes) {
          const rx = node.x - this.cx;
          const ry = node.y - this.cy;
          node.vx += drain * ry;
          node.vy -= drain * rx;
        }
      }
    }

    // 7. Anchor spring — pull cell center back toward spawn point (prevents drift)
    // Dead zone: no force within anchorSlack radius; spring engages only on excess displacement
    const anchorDx = this.cx - this.anchorX;
    const anchorDy = this.cy - this.anchorY;
    const anchorDist = Math.sqrt(anchorDx * anchorDx + anchorDy * anchorDy);
    const slack = sb.anchorSlack ?? 0;
    if (anchorDist > slack) {
      const excess = anchorDist - slack;
      const nx = anchorDx / anchorDist;
      const ny = anchorDy / anchorDist;
      const pullX = nx * excess * sb.anchorStiffness;
      const pullY = ny * excess * sb.anchorStiffness;
      for (let node of this.nodes) {
        node.vx -= pullX;
        node.vy -= pullY;
      }
    }

    // 7. Update receptor positions to follow their anchored shape points
    this.updateReceptorPositions();
  }

  // Reposition receptors to follow deformed membrane.  Free receptors sway as damped
  // springs around their rest tip position; bound/latched/refractory ones snap rigidly
  // so the latched triangle visual stays anchored to the ligand.
  updateReceptorPositions() {
    const r = window.RECEPTOR_DEFAULTS;
    const swayOn = r.swayEnabled !== false;

    for (let receptor of this.receptors) {
      if (receptor.shapeIndex === undefined) continue;

      const pt = this.shape[receptor.shapeIndex];
      const dx = pt.x - this.cx;
      const dy = pt.y - this.cy;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const restNx = dx / dist;
      const restNy = dy / dist;

      receptor.baseX = pt.x;
      receptor.baseY = pt.y;

      const stemLen = receptor.branchLen * 2;
      const restTipX = pt.x + restNx * stemLen;
      const restTipY = pt.y + restNy * stemLen;

      const lockSway = !swayOn || receptor.bound || receptor.latched || receptor.refractory;

      if (lockSway) {
        receptor.tipX = restTipX;
        receptor.tipY = restTipY;
        receptor.tipVx = 0;
        receptor.tipVy = 0;
        receptor.nx = restNx;
        receptor.ny = restNy;
        continue;
      }

      // Spring: restoring force toward rest tip + Brownian jitter + velocity damping
      let sx = receptor.tipX - restTipX;
      let sy = receptor.tipY - restTipY;
      receptor.tipVx += -sx * r.swayStiffness + (Math.random() - 0.5) * r.swayBrownian;
      receptor.tipVy += -sy * r.swayStiffness + (Math.random() - 0.5) * r.swayBrownian;
      receptor.tipVx *= r.swayDamping;
      receptor.tipVy *= r.swayDamping;
      receptor.tipX += receptor.tipVx;
      receptor.tipY += receptor.tipVy;

      // Clamp displacement so the stem can't visibly stretch under noise spikes
      sx = receptor.tipX - restTipX;
      sy = receptor.tipY - restTipY;
      const offset = Math.sqrt(sx * sx + sy * sy);
      if (offset > r.swayMaxOffset) {
        const scale = r.swayMaxOffset / offset;
        receptor.tipX = restTipX + sx * scale;
        receptor.tipY = restTipY + sy * scale;
      }

      // Recompute display normal from base→tip so the U arms pivot with the stem
      const ndx = receptor.tipX - pt.x;
      const ndy = receptor.tipY - pt.y;
      const ndist = Math.sqrt(ndx * ndx + ndy * ndy) || 1;
      receptor.nx = ndx / ndist;
      receptor.ny = ndy / ndist;
    }
  }

  // Apply an impulse force at a point on the membrane (e.g., particle impact)
  applyImpulse(x, y, fx, fy) {
    if (!this.softBodyEnabled || this.nodes.length === 0) return;

    // Find nearest node to impact point
    let nearestIdx = 0;
    let nearestDist = Infinity;
    for (let i = 0; i < this.nodes.length; i++) {
      const dx = this.nodes[i].x - x;
      const dy = this.nodes[i].y - y;
      const d = dx * dx + dy * dy;
      if (d < nearestDist) {
        nearestDist = d;
        nearestIdx = i;
      }
    }

    const scale = SOFT_BODY_DEFAULTS.impactForceScale;

    // Apply force to nearest node and its neighbors (spread impact)
    const n = this.nodes.length;
    this.nodes[nearestIdx].vx += fx * scale;
    this.nodes[nearestIdx].vy += fy * scale;

    // Neighbors get half the force
    const prev = (nearestIdx - 1 + n) % n;
    const next = (nearestIdx + 1) % n;
    this.nodes[prev].vx += fx * scale * 0.5;
    this.nodes[prev].vy += fy * scale * 0.5;
    this.nodes[next].vx += fx * scale * 0.5;
    this.nodes[next].vy += fy * scale * 0.5;
  }

  /**
   * Compute nodes between physically adjacent receptors on the membrane.
   * Nodes are created at the midpoint between adjacent receptor tips.
   * Each node has a "pair identity" (colorA, colorB) where order matters.
   * Receptors are sorted by angle around the cell center.
   */
  computeReceptorNodes() {
    this.receptorNodes = [];

    if (this.receptors.length < 2) return;

    // Sort receptors by angle around cell center
    const sortedReceptors = this.receptors.slice().map(r => {
      const angle = Math.atan2(r.tipY - this.cy, r.tipX - this.cx);
      return { receptor: r, angle: angle };
    }).sort((a, b) => a.angle - b.angle);

    // Create nodes between each pair of adjacent receptors (wrapping around)
    for (let i = 0; i < sortedReceptors.length; i++) {
      const curr = sortedReceptors[i];
      const next = sortedReceptors[(i + 1) % sortedReceptors.length];

      const r1 = curr.receptor;
      const r2 = next.receptor;

      // Node position is midpoint between the two receptor tips
      const nodeX = (r1.tipX + r2.tipX) / 2;
      const nodeY = (r1.tipY + r2.tipY) / 2;

      // Node angle (for matching with particle nodes)
      const nodeAngle = Math.atan2(nodeY - this.cy, nodeX - this.cx);

      // Pair identity: ordered pair of colors (going clockwise/counterclockwise)
      // The order is (current receptor color, next receptor color) in angular order
      const pairId = Cell.makePairId(r1.color, r2.color);

      this.receptorNodes.push({
        x: nodeX,
        y: nodeY,
        angle: nodeAngle,
        color1: r1.color,
        color2: r2.color,
        pairId: pairId,
        bound: false,
        receptor1: r1,
        receptor2: r2
      });
    }
  }

  /**
   * Create a unique pair ID from two colors. Order matters!
   * Returns a string like "2-5" for colors 2 and 5.
   */
  static makePairId(color1, color2) {
    return `${color1}-${color2}`;
  }

  // Update per-frame state (soft body, refractory timers, node availability, death animation)
  update(physicsParams, frameCount, fluidSim) {
    // Animate dying segments; skip receptor logic once death starts
    if (this.dying) {
      this.deathTimer++;
      const noiseScale = physicsParams.turbulenceScale;
      const noiseStr = physicsParams.turbulenceStrength * 0.15;
      for (let seg of this.deathSegments) {
        const mx = (seg.ax + seg.bx) * 0.5;
        const my = (seg.ay + seg.by) * 0.5;
        const nx = noise(mx * noiseScale + frameCount * 0.003 * physicsParams.turbulenceX, my * noiseScale);
        const ny = noise(mx * noiseScale + 100, my * noiseScale + frameCount * 0.003 * physicsParams.turbulenceY);
        seg.vx += (nx - 0.5) * 2 * noiseStr;
        seg.vy += (ny - 0.5) * 2 * noiseStr;
        seg.vx *= 0.97;
        seg.vy *= 0.97;
        seg.ax += seg.vx;
        seg.ay += seg.vy;
        seg.bx += seg.vx;
        seg.by += seg.vy;
      }
      // Nucleus segments stay in place during the burst delay, then fly apart with
      // the same turbulence + damping treatment as the membrane.
      if (this.nucleusSegments && this.deathTimer >= this.nucleusBurstDelay) {
        for (let seg of this.nucleusSegments) {
          const mx = (seg.ax + seg.bx) * 0.5;
          const my = (seg.ay + seg.by) * 0.5;
          const nx = noise(mx * noiseScale + frameCount * 0.003 * physicsParams.turbulenceX, my * noiseScale);
          const ny = noise(mx * noiseScale + 100, my * noiseScale + frameCount * 0.003 * physicsParams.turbulenceY);
          seg.vx += (nx - 0.5) * 2 * noiseStr;
          seg.vy += (ny - 0.5) * 2 * noiseStr;
          seg.vx *= 0.97;
          seg.vy *= 0.97;
          seg.ax += seg.vx;
          seg.ay += seg.vy;
          seg.bx += seg.vx;
          seg.by += seg.vy;
        }
      }
      if (this.deathTimer >= this.deathDuration) {
        this.dead = true;
      }
      return;
    }

    // Update soft body spring-mass dynamics
    this.updateSoftBody(physicsParams, frameCount, fluidSim);

    for (let receptor of this.receptors) {
      receptor.updateRefractory();
    }

    // Reconcile receptor node bound states:
    // A node becomes available again when neither of its receptors is bound, latched, or refractory
    for (let node of this.receptorNodes) {
      if (node.bound) {
        const r1free = !node.receptor1.bound && !node.receptor1.latched && !node.receptor1.refractory;
        const r2free = !node.receptor2.bound && !node.receptor2.latched && !node.receptor2.refractory;
        if (r1free && r2free) {
          node.bound = false;
        }
      }
    }
  }

  // Trigger cell death: break membrane into flying segments, and pre-compute the
  // nucleus burst segments — they hold their starting positions until nucleusBurstDelay
  // frames have elapsed, then fly apart with the same radial+scatter physics.
  triggerDeath() {
    this.dying = true;
    this.deathTimer = 0;
    this.deathSegments = [];
    this.nucleusSegments = [];
    this.nucleusBurstDelay = 25; // ~0.4s at 60fps — membrane gets a head start
    for (let i = 0; i < this.shape.length; i++) {
      const a = this.shape[i];
      const b = this.shape[(i + 1) % this.shape.length];
      // Outward radial kick from cell center
      const mx = (a.x + b.x) * 0.5;
      const my = (a.y + b.y) * 0.5;
      const radDx = mx - this.cx;
      const radDy = my - this.cy;
      const radLen = Math.sqrt(radDx * radDx + radDy * radDy) || 1;
      const radialSpeed = (Math.random() * 1.5 + 0.5);
      // Random scatter added to radial kick
      const scatterAngle = Math.random() * Math.PI * 2;
      const scatterSpeed = Math.random() * 0.8;
      this.deathSegments.push({
        ax: a.x, ay: a.y,
        bx: b.x, by: b.y,
        vx: (radDx / radLen) * radialSpeed + Math.cos(scatterAngle) * scatterSpeed,
        vy: (radDy / radLen) * radialSpeed + Math.sin(scatterAngle) * scatterSpeed
      });
    }

    // Nucleus burst segments — slice the nucleus ellipse into perimeter chords with
    // outward radial velocity from the nucleus center.  Slightly faster than membrane
    // for a "denser core releasing" feel.
    const nucNumPts = 14;
    const nucCx = this.cx + this.nucleusOffsetX;
    const nucCy = this.cy + this.nucleusOffsetY;
    for (let i = 0; i < nucNumPts; i++) {
      const a1 = (i / nucNumPts) * Math.PI * 2;
      const a2 = ((i + 1) / nucNumPts) * Math.PI * 2;
      const ax = nucCx + Math.cos(a1) * this.nucleusRadiusX;
      const ay = nucCy + Math.sin(a1) * this.nucleusRadiusY;
      const bx = nucCx + Math.cos(a2) * this.nucleusRadiusX;
      const by = nucCy + Math.sin(a2) * this.nucleusRadiusY;
      const mx = (ax + bx) * 0.5;
      const my = (ay + by) * 0.5;
      const radDx = mx - nucCx;
      const radDy = my - nucCy;
      const radLen = Math.sqrt(radDx * radDx + radDy * radDy) || 1;
      const radialSpeed = Math.random() * 1.8 + 0.6;
      const scatterAngle = Math.random() * Math.PI * 2;
      const scatterSpeed = Math.random() * 0.7;
      this.nucleusSegments.push({
        ax: ax, ay: ay,
        bx: bx, by: by,
        vx: (radDx / radLen) * radialSpeed + Math.cos(scatterAngle) * scatterSpeed,
        vy: (radDy / radLen) * radialSpeed + Math.sin(scatterAngle) * scatterSpeed
      });
    }
  }

  // Returns true once the fade animation has fully completed
  isFullyDead() {
    return this.dead;
  }

  // Render cell membrane and receptors to a graphics context
  render(g) {
    if (this.dying) {
      this.renderDying(g);
      return;
    }
    if (this.dead) return;

    // Draw cell membrane outline with tissue-specific fill and stroke
    const f = this.tissueColor.fill;
    const s = this.tissueColor.stroke;
    g.fill(f[0], f[1], f[2], f[3]);
    g.stroke(s[0], s[1], s[2], s[3]);
    g.strokeWeight(2);
    g.beginShape();
    for (let pt of this.shape) {
      g.vertex(pt.x, pt.y);
    }
    g.endShape(CLOSE);
    g.noStroke();

    // Draw nucleus — slightly off-center filled ellipse that follows the cell centroid
    const nx = this.cx + this.nucleusOffsetX;
    const ny = this.cy + this.nucleusOffsetY;
    if (this.isTumor) g.fill(180, 130, 145, 140);
    else              g.fill(170, 180, 210, 110);
    g.ellipse(nx, ny, this.nucleusRadiusX * 2, this.nucleusRadiusY * 2);

    // Draw Y-shaped receptors
    for (let receptor of this.receptors) {
      receptor.render(g);
    }
  }

  // Render membrane segments flying apart with fade
  renderDying(g) {
    const progress = this.deathTimer / this.deathDuration;
    const alpha = Math.round(255 * (1 - progress));

    // Membrane segments use the tissue stroke color so dying cells stay visually consistent
    const s = this.tissueColor.stroke;
    g.stroke(s[0], s[1], s[2], alpha);
    g.strokeWeight(2);
    g.noFill();
    for (let seg of this.deathSegments) {
      g.line(seg.ax, seg.ay, seg.bx, seg.by);
    }

    // Nucleus: solid filled ellipse during the burst delay, then flying line segments
    // that fade over the remainder of the death animation.
    const burstDelay = this.nucleusBurstDelay || 0;
    if (this.deathTimer < burstDelay) {
      // Pre-burst: nucleus stays intact, slight pre-burst dim
      const nucBaseAlpha = this.isTumor ? 140 : 110;
      const preBurstFade = 1 - (this.deathTimer / Math.max(1, burstDelay)) * 0.25;
      const nucAlpha = Math.round(nucBaseAlpha * preBurstFade);
      g.noStroke();
      if (this.isTumor) g.fill(180, 130, 145, nucAlpha);
      else              g.fill(170, 180, 210, nucAlpha);
      const nx = this.cx + this.nucleusOffsetX;
      const ny = this.cy + this.nucleusOffsetY;
      g.ellipse(nx, ny, this.nucleusRadiusX * 2, this.nucleusRadiusY * 2);
    } else if (this.nucleusSegments) {
      // Post-burst: line segments fade from full alpha to zero over the remaining frames
      const burstFramesElapsed = this.deathTimer - burstDelay;
      const burstFramesTotal = Math.max(1, this.deathDuration - burstDelay);
      const burstProgress = Math.min(1, burstFramesElapsed / burstFramesTotal);
      const nucBurstAlpha = Math.round(220 * (1 - burstProgress));
      if (nucBurstAlpha > 0) {
        if (this.isTumor) g.stroke(180, 130, 145, nucBurstAlpha);
        else              g.stroke(170, 180, 210, nucBurstAlpha);
        g.strokeWeight(1.5);
        g.noFill();
        for (let seg of this.nucleusSegments) {
          g.line(seg.ax, seg.ay, seg.bx, seg.by);
        }
      }
    }

    g.noStroke();
  }

  // Render absorbed drug count overlay (for test mode)
  renderBindingOverlay(g, showOverlay) {
    return; // Text disabled for kiosk display

    const count = this.absorbedDrugs;

    const boxW = 36;
    const boxH = 24;
    g.fill(255, 255, 255, 220);
    g.stroke(0, 0, 0, 200);
    g.strokeWeight(1.5);
    g.rectMode(CENTER);
    g.rect(this.cx, this.cy, boxW, boxH, 4);
    g.noStroke();

    g.fill(0, 0, 0, 255);
    g.textSize(14);
    g.textAlign(CENTER, CENTER);
    g.textStyle(BOLD);
    g.text(`${count}`, this.cx, this.cy);
    g.textStyle(NORMAL);
    g.rectMode(CORNER);
  }

  // Get count of bound receptors
  getBoundCount() {
    return this.receptors.filter(r => r.bound).length;
  }

  // Get total receptor count
  getTotalReceptors() {
    return this.receptors.length;
  }

  // Get count of bound receptor nodes
  getBoundNodeCount() {
    return this.receptorNodes.filter(n => n.bound).length;
  }

  // Get total receptor node count
  getTotalNodes() {
    return this.receptorNodes.length;
  }

  // Reset all receptor bound states
  resetBindings() {
    this.bound = 0;
    this.absorbedDrugs = 0;
    for (let receptor of this.receptors) {
      receptor.bound = false;
      receptor.latched = false;
      receptor.latchedLigandColor = -1;
      receptor.latchedLigandX = 0;
      receptor.latchedLigandY = 0;
      receptor.refractory = false;
      receptor.refractoryTimer = 0;
      receptor.refractoryColor = -1;
    }
    // Reset receptor node bound states
    for (let node of this.receptorNodes) {
      node.bound = false;
    }
  }

  // Clear receptors (for regeneration when tissue config changes)
  clearReceptors() {
    this.receptors = [];
    this.bound = 0;
  }

  // Update receptor concentrations and regenerate cell (size, shape, receptors)
  updateConcentrations(receptorConcentrations, baseRadius) {
    this.receptorConcentrations = receptorConcentrations || [0, 0, 0, 0, 0, 0];
    this.totalExpression = this.receptorConcentrations.reduce((sum, c) => sum + (c || 0), 0);

    // Calculate total receptors needed (each color gets its full allocation)
    const maxPerColor = PHYSICS_DEFAULTS.maxReceptorsPerColor;
    this.totalReceptorsNeeded = 0;
    for (let i = 0; i < 6; i++) {
      this.totalReceptorsNeeded += Math.round((this.receptorConcentrations[i] || 0) * maxPerColor);
    }

    // Recalculate size factor
    const { minSizeFactor, maxSizeFactor, maxExpression } = EXPRESSION_SCALING;
    const expressionRatio = Math.min(this.totalExpression / maxExpression, 1);
    this.sizeFactor = minSizeFactor + expressionRatio * (maxSizeFactor - minSizeFactor);
    this.radius = baseRadius * this.sizeFactor;

    // Shape points must accommodate all receptors needed
    const { minShapePoints } = EXPRESSION_SCALING;
    this.numShapePoints = Math.max(minShapePoints, this.totalReceptorsNeeded);

    // Regenerate shape and receptors with the appropriate noise amplitude
    const noiseAmp = this.isTumor
      ? SOFT_BODY_DEFAULTS.tumorNoiseAmplitude
      : SOFT_BODY_DEFAULTS.normalNoiseAmplitude;
    this.shape = Cell.generateShape(this.cx, this.cy, this.radius, this.seed, this.numShapePoints, noiseAmp);

    // Recompute nucleus geometry for the new radius
    this.computeNucleusGeometry();

    this.allocateReceptors();

    // Reinitialize soft body for new shape
    this.initSoftBody();
  }
}

// Export for browser global
window.Cell = Cell;
