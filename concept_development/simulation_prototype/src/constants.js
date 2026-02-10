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

// Export for browser global
window.COLORS = COLORS;
window.COLOR_NAMES = COLOR_NAMES;
window.TOXICITY_COLORS = TOXICITY_COLORS;
window.PHYSICS_DEFAULTS = PHYSICS_DEFAULTS;
window.EXPRESSION_SCALING = EXPRESSION_SCALING;
window.RENDER_RESOLUTION = RENDER_RESOLUTION;
window.LAYOUT_DEFAULTS = LAYOUT_DEFAULTS;
