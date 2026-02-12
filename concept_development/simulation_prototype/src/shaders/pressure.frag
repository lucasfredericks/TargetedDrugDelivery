// Pressure solver - Jacobi iteration to solve Poisson equation
// Iteratively finds pressure field that makes velocity divergence-free
#version 300 es
precision highp float;

uniform sampler2D uPressure;    // Previous pressure iteration
uniform sampler2D uDivergence;  // Divergence field
uniform sampler2D uBoundaries;  // Obstacle mask
uniform vec2 uResolution;

in vec2 vUv;
out vec4 fragColor;

void main() {
  vec2 texelSize = 1.0 / uResolution;

  // Check if current cell is boundary
  float boundary = texture(uBoundaries, vUv).r;
  if (boundary > 0.5) {
    fragColor = vec4(0.0);
    return;
  }

  // Sample neighboring pressures
  float pL = texture(uPressure, vUv - vec2(texelSize.x, 0.0)).r;
  float pR = texture(uPressure, vUv + vec2(texelSize.x, 0.0)).r;
  float pB = texture(uPressure, vUv - vec2(0.0, texelSize.y)).r;
  float pT = texture(uPressure, vUv + vec2(0.0, texelSize.y)).r;

  // Check for boundary neighbors - use Neumann boundary (dp/dn = 0)
  float bL = texture(uBoundaries, vUv - vec2(texelSize.x, 0.0)).r;
  float bR = texture(uBoundaries, vUv + vec2(texelSize.x, 0.0)).r;
  float bB = texture(uBoundaries, vUv - vec2(0.0, texelSize.y)).r;
  float bT = texture(uBoundaries, vUv + vec2(0.0, texelSize.y)).r;

  float pC = texture(uPressure, vUv).r;
  if (bL > 0.5) pL = pC;
  if (bR > 0.5) pR = pC;
  if (bB > 0.5) pB = pC;
  if (bT > 0.5) pT = pC;

  // Get divergence at this cell
  float divergence = texture(uDivergence, vUv).r;

  // Jacobi iteration: p = (sum of neighbors - divergence) / 4
  float pressure = (pL + pR + pB + pT - divergence) * 0.25;

  fragColor = vec4(pressure, 0.0, 0.0, 1.0);
}
