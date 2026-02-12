// Gradient subtraction - subtract pressure gradient from velocity
// Makes the velocity field divergence-free (incompressible)
#version 300 es
precision highp float;

uniform sampler2D uVelocity;
uniform sampler2D uPressure;
uniform sampler2D uBoundaries;
uniform vec2 uResolution;

in vec2 vUv;
out vec4 fragColor;

void main() {
  // Check if current cell is boundary
  float boundary = texture(uBoundaries, vUv).r;
  if (boundary > 0.5) {
    fragColor = vec4(0.0);
    return;
  }

  vec2 texelSize = 1.0 / uResolution;

  // Sample neighboring pressures
  float pL = texture(uPressure, vUv - vec2(texelSize.x, 0.0)).r;
  float pR = texture(uPressure, vUv + vec2(texelSize.x, 0.0)).r;
  float pB = texture(uPressure, vUv - vec2(0.0, texelSize.y)).r;
  float pT = texture(uPressure, vUv + vec2(0.0, texelSize.y)).r;

  // Check for boundary neighbors
  float bL = texture(uBoundaries, vUv - vec2(texelSize.x, 0.0)).r;
  float bR = texture(uBoundaries, vUv + vec2(texelSize.x, 0.0)).r;
  float bB = texture(uBoundaries, vUv - vec2(0.0, texelSize.y)).r;
  float bT = texture(uBoundaries, vUv + vec2(0.0, texelSize.y)).r;

  float pC = texture(uPressure, vUv).r;
  if (bL > 0.5) pL = pC;
  if (bR > 0.5) pR = pC;
  if (bB > 0.5) pB = pC;
  if (bT > 0.5) pT = pC;

  // Compute pressure gradient
  vec2 gradient = vec2(pR - pL, pT - pB) * 0.5;

  // Get current velocity
  vec2 velocity = texture(uVelocity, vUv).xy;

  // Subtract gradient to make divergence-free
  velocity -= gradient;

  fragColor = vec4(velocity, 0.0, 1.0);
}
