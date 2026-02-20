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

  // Setup BroadcastChannel listener
  setupBroadcastChannel();

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

function draw() {
  background(250);

  // Update and render each simulation
  for (let i = 0; i < simulations.length; i++) {
    const sim = simulations[i];
    const area = displayAreas[i];

    // Update simulation
    sim.update(frameCount);

    // Render to buffer
    sim.render();

    // Draw buffer to main canvas (downscaled for 2x2 grid)
    const buffer = sim.getBuffer();
    if (buffer) {
      image(buffer, area.x, area.y, area.w, area.h);
    }

    // Draw labels (multi-tissue mode only)
    if (!singleTissueMode) {
      drawTissueLabel(sim, area);
    }
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

  if (testMode) {
    text(
      `TEST MODE${fluidLabel}${vizLabel}: ${totalReleased}/${totalTarget} released | Particles: ${totalParticles} (${freeParticles} flowing, ${boundParticles} bound)`,
      width / 2,
      height - 8
    );
  } else {
    const hint = useFluidSim ? ' Press V/P to toggle velocity/pressure field.' : '';
    text(`Ready${fluidLabel}${vizLabel}. Press Test button on dashboard to begin.${hint}`, width / 2, height - 8);
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

// Global channel reference for broadcasting stats
let broadcastChannel = null;

function setupBroadcastChannel() {
  try {
    broadcastChannel = new BroadcastChannel('tdd-channel');
    console.log('Simulation: BroadcastChannel created');

    broadcastChannel.onmessage = (ev) => {
      const msg = ev.data || {};
      console.log('Simulation received message:', msg.type, msg.command || '');

      if (msg.type === 'test') {
        // Start test mode on all simulations
        console.log('Starting test mode with', msg.totalParticles, 'particles');
        for (let sim of simulations) {
          sim.startTest(msg.totalParticles || 1000, 600);
        }
        updateScoreboard();
        broadcastStats();
      } else if (msg.type === 'params') {
        // Apply puzzle update first if provided (updates tissue receptors)
        // but skip ligandCounts from puzzle - we'll use msg.ligandPositions instead
        if (msg.puzzle) {
          applyPuzzleWithoutLigands(msg.puzzle);
        }

        // Update global parameters from dashboard (takes precedence over puzzle)
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
        // Propagate to all simulations
        for (let sim of simulations) {
          sim.setLigandPositions(globalParams.ligandPositions);
          sim.setToxicity(globalParams.toxicity);
          if (typeof globalParams.turbulenceX === 'number') {
            sim.physicsParams.turbulenceX = globalParams.turbulenceX;
          }
          if (typeof globalParams.turbulenceY === 'number') {
            sim.physicsParams.turbulenceY = globalParams.turbulenceY;
          }
          // Apply per-tissue death threshold from puzzle
          const tissue = puzzle?.tissues?.[sim.tissueIndex];
          if (tissue) {
            sim.setDeathThreshold(tissue.deathThreshold || 5);
          }
        }

        // Handle commands
        if (msg.command === 'reset' || msg.command === 'restart') {
          for (let sim of simulations) {
            sim.reset();
          }
        }

        updateScoreboard();
        broadcastStats();
      }
    };
  } catch (e) {
    console.warn('BroadcastChannel not available');
  }
}

// Broadcast stats to dashboard for bar graph
function broadcastStats() {
  if (!broadcastChannel) return;

  const stats = simulations.map(sim => {
    const s = sim.getStats();
    return {
      name: sim.tissue.name,
      theoreticalScore: s.theoreticalScore,
      absorptionEfficiency: s.absorptionEfficiency,
      totalAbsorbedDrugs: s.totalAbsorbedDrugs,
      attempts: s.attempts
    };
  });

  broadcastChannel.postMessage({
    type: 'stats',
    stats: stats
  });
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

// Periodically refresh scoreboard and broadcast stats to dashboard
setInterval(() => {
  updateScoreboard();
  broadcastStats();
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
