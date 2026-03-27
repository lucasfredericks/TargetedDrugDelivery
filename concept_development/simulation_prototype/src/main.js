// main.js - Entry point for the simulation, coordinates multiple Simulation instances

// Global state
let simulations = [];
let puzzle = null;
let singleTissueMode = false;
let singleTissueIndex = null;
let scoreboardDiv = null;

// Global parameters (shared across all simulations)
let globalParams = {
  ligandPositions: [-1, -1, -1, -1, -1, -1],
  toxicity: 2,
  fidelity: 0.8
};

// Display areas for each simulation (set in setup)
let displayAreas = [];

// Fluid simulation toggle (set via URL param ?fluid=true)
let useFluidSim = false;

// Network client for Pi master server or BroadcastChannel fallback
let network = null;

function setup() {
  // Detect single-tissue mode via URL param
  const tissueParam = parseInt(getQueryParam('tissue'));
  singleTissueMode = !isNaN(tissueParam) && tissueParam >= 0 && tissueParam <= 3;
  singleTissueIndex = singleTissueMode ? tissueParam : null;

  // Detect fluid simulation mode via URL param ?fluid=true
  useFluidSim = getQueryParam('fluid') === 'true';

  // Calculate canvas size
  const canvasSize = calculateCanvasSize(singleTissueMode, LAYOUT_DEFAULTS);
  const canvas = createCanvas(canvasSize.width, canvasSize.height);
  canvas.parent(document.body);
  noStroke();

  // Get scoreboard element
  scoreboardDiv = document.getElementById('scoreboard');

  // Setup network (Socket.IO if ?server= param, else BroadcastChannel)
  setupNetwork();

  // Load puzzle and create simulations
  fetch('puzzle_example.json')
    .then(r => r.json())
    .then(p => {
      puzzle = p;
      globalParams.toxicity = p.toxicity || 2;

      // Populate ligand positions from puzzle if provided
      if (Array.isArray(p.ligandCounts)) {
        globalParams.ligandPositions = computePositionsFromLigandCounts(p.ligandCounts);
      }

      createSimulations();
      updateScoreboard();
    })
    .catch(() => {
      // Create with default puzzle if load fails
      puzzle = createDefaultPuzzle();
      createSimulations();
    });
}

function createDefaultPuzzle() {
  return {
    id: 'default',
    tissues: [
      { name: 'T1', receptors: [0, 0, 0, 0, 0, 0] },
      { name: 'T2', receptors: [0, 0, 0, 0, 0, 0] },
      { name: 'T3', receptors: [0, 0, 0, 0, 0, 0] },
      { name: 'T4', receptors: [0, 0, 0, 0, 0, 0] }
    ],
    ligandCounts: [0, 0, 0, 0, 0, 0],
    toxicity: 2
  };
}

function createSimulations() {
  simulations = [];
  displayAreas = [];

  if (singleTissueMode) {
    // Single fullscreen simulation
    const tissue = puzzle.tissues[singleTissueIndex];
    const sim = new Simulation({
      tissue: tissue,
      tissueIndex: singleTissueIndex,
      ligandPositions: globalParams.ligandPositions,
      toxicity: globalParams.toxicity,
      fidelity: globalParams.fidelity,
      deathThreshold: tissue.deathThreshold || 5,
      width: width,
      height: height,
      useFluidSim: useFluidSim,
      fluidSimScale: 5  // Run fluid at 1/5th resolution (doubled from 1/10th)
    });
    sim.initialize();
    simulations.push(sim);
    displayAreas.push({ x: 0, y: 0, w: width, h: height });
  } else {
    // 2x2 grid of simulations
    displayAreas = calculateDisplayAreas(windowWidth, windowHeight, LAYOUT_DEFAULTS);

    for (let i = 0; i < 4; i++) {
      const tissue = puzzle.tissues[i];
      const sim = new Simulation({
        tissue: tissue,
        tissueIndex: i,
        ligandPositions: globalParams.ligandPositions,
        toxicity: globalParams.toxicity,
        fidelity: globalParams.fidelity,
        deathThreshold: tissue.deathThreshold || 5,
        width: RENDER_RESOLUTION.width,
        height: RENDER_RESOLUTION.height,
        useFluidSim: useFluidSim,
        fluidSimScale: 5  // Run fluid at 1/5th resolution (doubled from 1/10th)
      });
      sim.initialize();
      simulations.push(sim);
    }
  }
}

// Frame timing profiler — logs average phase durations every 120 frames
const _frameTiming = { update: 0, render: 0, composite: 0, frameTotal: 0, lastFrameEnd: 0, frames: 0 };

function draw() {
  background(250);

  // Update and render each simulation
  for (let i = 0; i < simulations.length; i++) {
    const sim = simulations[i];
    const area = displayAreas[i];

    // Update simulation
    const t0 = performance.now();
    sim.update(frameCount);
    const t1 = performance.now();

    // Render to buffer
    sim.render();
    const t2 = performance.now();

    // Draw buffer to main canvas (downscaled for 2x2 grid)
    const buffer = sim.getBuffer();
    if (buffer) {
      image(buffer, area.x, area.y, area.w, area.h);
    }
    const t3 = performance.now();

    _frameTiming.update += (t1 - t0);
    _frameTiming.render += (t2 - t1);
    _frameTiming.composite += (t3 - t2);
    _frameTiming.frames++;

    // Draw labels (multi-tissue mode only)
    if (!singleTissueMode) {
      drawTissueLabel(sim, area);
    }
  }

  // Track frame-to-frame time (captures deferred GPU work + browser overhead)
  const frameEnd = performance.now();
  if (_frameTiming.lastFrameEnd > 0) {
    _frameTiming.frameTotal += (frameEnd - _frameTiming.lastFrameEnd);
  }
  _frameTiming.lastFrameEnd = frameEnd;

  // Log averages every 120 frames (~2 seconds)
  if (_frameTiming.frames >= 120) {
    const n = _frameTiming.frames;
    const measuredWork = (_frameTiming.update + _frameTiming.render + _frameTiming.composite) / n;
    const actualFrame = _frameTiming.frameTotal / n;
    console.log(
      `[perf] update: ${(_frameTiming.update / n).toFixed(2)}ms | ` +
      `render: ${(_frameTiming.render / n).toFixed(2)}ms | ` +
      `composite: ${(_frameTiming.composite / n).toFixed(2)}ms | ` +
      `measured: ${measuredWork.toFixed(2)}ms | ` +
      `actual frame: ${actualFrame.toFixed(2)}ms | ` +
      `gap: ${(actualFrame - measuredWork).toFixed(2)}ms`
    );
    _frameTiming.update = 0;
    _frameTiming.render = 0;
    _frameTiming.composite = 0;
    _frameTiming.frameTotal = 0;
    _frameTiming.frames = 0;
  }

  // Draw status bar at bottom
  drawStatusBar();

  // Draw single-tissue info panel
  if (singleTissueMode) {
    drawSingleTissueInfo();
  }
}

function drawTissueLabel(sim, area) {
  const stats = sim.getStats();

  fill(0);
  textSize(14);
  textAlign(LEFT, TOP);
  text(sim.tissue.name, area.x + 8, area.y - 22);

  textSize(12);
  text(
    `Binding Affinity: ${stats.theoreticalScore.toFixed(1)}% | Cell Death: ${stats.absorptionEfficiency.toFixed(1)}% (${stats.totalAbsorbedDrugs} absorbed)`,
    area.x + 8,
    area.y - 6
  );
}

function drawStatusBar() {
  // Aggregate particle counts across all simulations
  let totalParticles = 0;
  let boundParticles = 0;
  let freeParticles = 0;
  let testMode = false;
  let totalReleased = 0;
  let totalTarget = 0;

  for (let sim of simulations) {
    const stats = sim.getStats();
    const testStatus = sim.getTestStatus();
    totalParticles += stats.particleCount;
    boundParticles += stats.absorbingParticles + stats.absorbedParticles;
    freeParticles += stats.freeParticles;

    if (testStatus.testMode) {
      testMode = true;
      totalReleased += testStatus.released;
      totalTarget += testStatus.total;
    }
  }

  fill(60);
  noStroke();
  textSize(14);
  textAlign(CENTER, BOTTOM);

  const fluidLabel = useFluidSim ? ' [GPU Fluid]' : '';
  const showingVelocity = simulations[0]?.showVelocityField;
  const showingPressure = simulations[0]?.showPressureField;
  let vizLabel = '';
  if (showingVelocity && showingPressure) vizLabel = ' [Viz: V+P]';
  else if (showingVelocity) vizLabel = ' [Viz: V]';
  else if (showingPressure) vizLabel = ' [Viz: P]';

  const fpsLabel = ` | FPS: ${frameRate().toFixed(1)}`;

  if (testMode) {
    text(
      `TEST MODE${fluidLabel}${vizLabel}: ${totalReleased}/${totalTarget} released | Particles: ${totalParticles} (${freeParticles} flowing, ${boundParticles} bound)${fpsLabel}`,
      width / 2,
      height - 8
    );
  } else {
    const hint = useFluidSim ? ' Press V/P to toggle velocity/pressure field.' : '';
    text(`Ready${fluidLabel}${vizLabel}. Press Test button on dashboard to begin.${hint}${fpsLabel}`, width / 2, height - 8);
  }
}

function drawSingleTissueInfo() {
  if (!puzzle || simulations.length === 0) return;

  const sim = simulations[0];
  const stats = sim.getStats();
  const tissue = sim.tissue;

  // Draw info panel at bottom
  fill(255, 255, 255, 230);
  stroke(60);
  strokeWeight(2);
  const boxW = 600;
  const boxH = 60;
  const boxX = width / 2 - boxW / 2;
  const boxY = height - boxH - 40;
  rect(boxX, boxY, boxW, boxH, 4);
  noStroke();

  fill(0);
  textSize(18);
  textAlign(CENTER, TOP);
  text(tissue.name, width / 2, boxY + 8);

  textSize(14);
  text(
    `Theory: ${stats.theoreticalScore.toFixed(1)}% | Efficiency: ${stats.absorptionEfficiency.toFixed(1)}% (${stats.totalAbsorbedDrugs} absorbed)`,
    width / 2,
    boxY + 32
  );
}

// Network setup: Socket.IO for exhibit mode (?server=host:port), BroadcastChannel for local dev
function setupNetwork() {
  network = new NetworkClient();
  network.initialize();

  // Handle test start (from Pi master or dashboard)
  network.onStartTest((data) => {
    console.log('Starting test mode, ligandPositions:', data?.ligandPositions,
                'puzzle:', data?.puzzle?.id || data?.puzzle?.name);

    // In exhibit mode, apply received config before starting
    if (network.isExhibitMode && data) {
      if (data.puzzle) {
        applyPuzzle(data.puzzle);
      }
      if (Array.isArray(data.ligandPositions)) {
        globalParams.ligandPositions = data.ligandPositions.slice(0, 6);
        for (let sim of simulations) {
          sim.setLigandPositions(globalParams.ligandPositions);
        }
        console.log('Applied ligandPositions:', globalParams.ligandPositions);
      }
      if (typeof data.toxicity === 'number') {
        globalParams.toxicity = data.toxicity;
        for (let sim of simulations) {
          sim.setToxicity(globalParams.toxicity);
        }
      }
    }

    for (let sim of simulations) {
      sim.startTest(data?.totalParticles || 1000, 600);
    }
    updateScoreboard();
    sendStats();
  });

  // Handle params update (BroadcastChannel / dashboard mode only)
  network.onParams((msg) => {
    console.log('Simulation received params:', msg.command || '');

    if (msg.puzzle) {
      applyPuzzleWithoutLigands(msg.puzzle);
    }

    if (Array.isArray(msg.ligandPositions)) {
      globalParams.ligandPositions = msg.ligandPositions.slice(0, 6);
    }
    if (typeof msg.toxicity === 'number') {
      globalParams.toxicity = msg.toxicity;
    }
    if (typeof msg.turbulenceX === 'number') {
      globalParams.turbulenceX = msg.turbulenceX;
    }
    if (typeof msg.turbulenceY === 'number') {
      globalParams.turbulenceY = msg.turbulenceY;
    }

    for (let sim of simulations) {
      sim.setLigandPositions(globalParams.ligandPositions);
      sim.setToxicity(globalParams.toxicity);
      if (typeof globalParams.turbulenceX === 'number') {
        sim.physicsParams.turbulenceX = globalParams.turbulenceX;
      }
      if (typeof globalParams.turbulenceY === 'number') {
        sim.physicsParams.turbulenceY = globalParams.turbulenceY;
      }
      const tissue = puzzle?.tissues?.[sim.tissueIndex];
      if (tissue) {
        sim.setDeathThreshold(tissue.deathThreshold || 5);
      }
    }

    if (msg.command === 'reset' || msg.command === 'restart') {
      for (let sim of simulations) {
        sim.reset();
      }
    }

    updateScoreboard();
    sendStats();
  });

  // Handle reset from Pi master
  network.onReset(() => {
    for (let sim of simulations) {
      sim.reset();
    }
    updateScoreboard();
  });

  // Handle ligand/puzzle preview update from Pi master (outside of test)
  network.onLigandUpdate((data) => {
    // Don't change sim state mid-test; just update affinity preview
    if (simulations.some(sim => sim.getTestStatus().testMode)) return;
    if (data.ligandPositions) {
      globalParams.ligandPositions = data.ligandPositions;
      for (let sim of simulations) {
        sim.setLigandPositions(data.ligandPositions);
      }
    }
    if (data.puzzle) {
      applyPuzzleWithoutLigands(data.puzzle);
    }
    sendStats();
  });
}

// Send stats to Pi master or dashboard
function sendStats() {
  if (!network) return;

  const stats = simulations.map(sim => {
    const s = sim.getStats();
    const testStatus = sim.getTestStatus();
    return {
      tissueIndex: sim.tissueIndex,
      name: sim.tissue.name,
      theoreticalScore: s.theoreticalScore,
      absorptionEfficiency: s.absorptionEfficiency,
      totalAbsorbedDrugs: s.totalAbsorbedDrugs,
      bindingEvents: s.bindingEvents,
      progress: testStatus.testMode
        ? Math.min(1, (testStatus.released - testStatus.freeFlowing) / Math.max(1, testStatus.total))
        : 0
    };
  });

  network.sendStats(stats);

  // Check if all simulations are complete: all particles released and
  // either all particles resolved or 10 seconds elapsed since last release
  const allDone = simulations.every(sim => {
    const ts = sim.getTestStatus();
    if (!ts.testMode || ts.released < ts.total) return false;
    // All particles gone — done
    if (sim.particles.length === 0) return true;
    // Timeout: 600 frames (~10s at 60fps) after last release for stuck particles
    const framesSinceRelease = frameCount - sim.testStartFrame - sim.testDuration;
    return framesSinceRelease > 600;
  });
  if (allDone && simulations.some(sim => sim.getTestStatus().released > 0)) {
    network.sendTestComplete(stats);
  }
}

function applyPuzzle(p) {
  puzzle = p;

  // Update each simulation with its tissue config
  for (let i = 0; i < simulations.length; i++) {
    const sim = simulations[i];
    const tissueIndex = sim.tissueIndex;
    const tissue = p.tissues[tissueIndex];

    if (tissue) {
      sim.setTissue(tissue);
    }
  }

  // Update global params from puzzle
  if (Array.isArray(p.ligandCounts)) {
    globalParams.ligandPositions = computePositionsFromLigandCounts(p.ligandCounts);
    for (let sim of simulations) {
      sim.setLigandPositions(globalParams.ligandPositions);
    }
  }
  if (typeof p.toxicity === 'number') {
    globalParams.toxicity = p.toxicity;
    for (let sim of simulations) {
      sim.setToxicity(globalParams.toxicity);
    }
  }
}

// Apply puzzle tissue/receptor config without overwriting ligand positions
// Used when dashboard sends params - dashboard ligandPositions take precedence
function applyPuzzleWithoutLigands(p) {
  puzzle = p;

  // Update each simulation with its tissue config
  for (let i = 0; i < simulations.length; i++) {
    const sim = simulations[i];
    const tissueIndex = sim.tissueIndex;
    const tissue = p.tissues[tissueIndex];

    if (tissue) {
      sim.setTissue(tissue);
    }
  }

  // Note: We intentionally skip updating ligandPositions here
  // The dashboard's ligandPositions will be applied separately
}

function updateScoreboard() {
  if (!scoreboardDiv || !puzzle) return;

  let html = '';

  for (let i = 0; i < simulations.length; i++) {
    const sim = simulations[i];
    const stats = sim.getStats();
    const tissue = sim.tissue;

    html += `<div class="tissue"><strong>${tissue.name}</strong><br>Theory: ${stats.theoreticalScore.toFixed(1)}%<br>Efficiency: ${stats.absorptionEfficiency.toFixed(1)}% (${stats.totalAbsorbedDrugs} absorbed)</div>`;
  }

  scoreboardDiv.innerHTML = html;
}

// Periodically refresh scoreboard and send stats
setInterval(() => {
  updateScoreboard();
  sendStats();
}, 800);

// Expose global functions for compatibility with dashboard.html if opened together
window.loadPuzzle = function() {
  fetch('puzzle_example.json')
    .then(r => r.json())
    .then(p => {
      applyPuzzle(p);
      updateScoreboard();
    });
};

window.resetSim = function() {
  for (let sim of simulations) {
    sim.reset();
  }
  updateScoreboard();
};

// Keyboard controls
function keyPressed() {
  // 'V' key toggles velocity field visualization
  if (key === 'v' || key === 'V') {
    for (let sim of simulations) {
      sim.showVelocityField = !sim.showVelocityField;
    }
    const state = simulations[0]?.showVelocityField ? 'ON' : 'OFF';
    console.log(`Velocity field visualization: ${state}`);
  }

  // 'P' key toggles pressure field visualization
  if (key === 'p' || key === 'P') {
    for (let sim of simulations) {
      sim.showPressureField = !sim.showPressureField;
    }
    const state = simulations[0]?.showPressureField ? 'ON' : 'OFF';
    console.log(`Pressure field visualization: ${state}`);
  }
}
