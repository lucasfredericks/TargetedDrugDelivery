// constants.js - Shared constants for the simulation

// Color palette for ligands and receptors (6 colors)
const COLORS = ['#e41a1c', '#377eb8', '#4daf4a', '#984ea3', '#ff7f00', '#ffff33'];
const COLOR_NAMES = ['Red', 'Blue', 'Green', 'Purple', 'Orange', 'Yellow'];

// Toxicity colors
const TOXICITY_COLORS = {
  1: '#8fd14f',  // Green - low toxicity
  2: '#ffd11a',  // Yellow - medium toxicity
  3: '#b30000'   // Red - high toxicity
};

// Physics defaults
const PHYSICS_DEFAULTS = {
  flowSpeed: 1.5,           // Base flow velocity from left to right
  turbulenceScale: 0.005,   // Scale for noise-based turbulence
  turbulenceStrength: 0.15, // Strength of turbulent forces
  turbulenceX: 0.1,         // X-axis turbulence multiplier (0-1)
  turbulenceY: 0.3,         // Y-axis turbulence multiplier (0-1)
  cellsPerTissue: 15,       // Number of cells per tissue area
  particleSpriteSize: 32,   // Size of particle sprite in pixels
  maxReceptorsPerColor: 20, // Maximum receptors per color per cell (reduced for visibility)
  testDuration: 600,        // Frames over which to release test particles (~10s at 60fps)
  defaultTestParticles: 1000 // Default number of particles in test mode
};

// Expression-based cell scaling (for independent receptor concentrations)
const EXPRESSION_SCALING = {
  minSizeFactor: 0.6,      // Size multiplier at expression 0
  maxSizeFactor: 1.2,      // Size multiplier at expression 6
  maxExpression: 6,        // Maximum total expression (6 colors × 1.0 each)
  baseShapePoints: 32,     // Base resolution for cell outline
  minShapePoints: 20,      // Minimum points (small cells)
  maxShapePoints: 48       // Maximum points (large cells)
};

// Render resolution for full-quality buffers
const RENDER_RESOLUTION = {
  width: 1920,
  height: 1080
};

// Layout defaults for multi-tissue view
const LAYOUT_DEFAULTS = {
  canvasMargin: 12,
  areaGap: 50,
  maxAreaWidth: 520
};

// Soft body spring-mass defaults for cell membranes
const SOFT_BODY_DEFAULTS = {
  structuralStiffness: 0.8,   // Spring constant between adjacent membrane nodes
  structuralDamping: 0.1,     // Damping on structural springs
  pressureStiffness: 0.08,    // Cartesian spring pulling each node toward its rest offset from centroid
  pressureDamping: 0.03,      // Damping on pressure springs
  nodeDamping: 0.96,          // Per-frame velocity damping on nodes
  fluidForceScale: 0.02,      // How strongly fluid velocity pushes membrane nodes
  brownianStrength: 0.02,     // Random jitter force on nodes (biological micro-motion)
  impactForceScale: .5,      // Force multiplier when a nanoparticle hits the membrane
  anchorStiffness: 0.1,       // How strongly the cell center is tethered to its spawn point (0-1)
  anchorSlack: 20,            // Dead-zone radius (px): cell drifts freely before spring engages
  bendingStiffness: 8,        // Resistance to angle changes at each membrane joint
  angularDamping: 0.8,        // Fraction of rigid-body angular velocity removed per frame (0=none, 1=full)
  volumeStiffness: 0.06,      // Pressure force proportional to area deficit (prevents C-shape collapse)
  maxEdgeStretch: 0.95,        // Hard upper limit on edge length as a multiple of rest length
  tumorNoiseAmplitude: 0.5,  // Perlin noise amplitude for tumor cell shape (±20%)
  normalNoiseAmplitude: 0.08, // Perlin noise amplitude for non-tumor cell shape (±8%)
  breathPeriodFrames: 300,    // Period of slow membrane breathing (~5s at 60fps)
  breathAmplitude: 0.02,      // Fractional radius/area swing during breath cycle (±2%)
  neighborRepulsionStrength: 0.08, // Per-pixel-overlap force for cell-cell contact flattening
  neighborRepulsionMargin: 30,     // px buffer beyond r1+r2 where soft contact engages
  enabled: true
};

// Per-tissue color palette: fill (membrane interior) and stroke (outline / death segments)
const TISSUE_COLORS = {
  tumor:   { fill: [240, 200, 200, 180], stroke: [140,  80,  90, 140] },
  heart:   { fill: [230, 200, 210, 180], stroke: [130,  80,  95, 140] },
  liver:   { fill: [210, 200, 170, 180], stroke: [110, 100,  70, 140] },
  lung:    { fill: [210, 225, 240, 180], stroke: [ 90, 110, 130, 140] },
  default: { fill: [220, 230, 240, 180], stroke: [100, 100, 120, 120] }
};

// Export for browser global
window.COLORS = COLORS;
window.COLOR_NAMES = COLOR_NAMES;
window.TOXICITY_COLORS = TOXICITY_COLORS;
window.PHYSICS_DEFAULTS = PHYSICS_DEFAULTS;
window.EXPRESSION_SCALING = EXPRESSION_SCALING;
window.RENDER_RESOLUTION = RENDER_RESOLUTION;
window.LAYOUT_DEFAULTS = LAYOUT_DEFAULTS;
window.SOFT_BODY_DEFAULTS = SOFT_BODY_DEFAULTS;
window.TISSUE_COLORS = TISSUE_COLORS;
