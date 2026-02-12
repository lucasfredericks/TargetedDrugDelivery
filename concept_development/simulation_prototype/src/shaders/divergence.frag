// Divergence shader - computes how much velocity is "spreading out"
// Negative divergence = fluid accumulating, positive = fluid dispersing
#version 300 es
precision highp float;

uniform sampler2D uVelocity;
uniform sampler2D uBoundaries;
uniform vec2 uResolution;

in vec2 vUv;
out vec4 fragColor;

void main() {
  vec2 texelSize = 1.0 / uResolution;

  // Sample neighboring velocities
  vec2 vL = texture(uVelocity, vUv - vec2(texelSize.x, 0.0)).xy;
  vec2 vR = texture(uVelocity, vUv + vec2(texelSize.x, 0.0)).xy;
  vec2 vB = texture(uVelocity, vUv - vec2(0.0, texelSize.y)).xy;
  vec2 vT = texture(uVelocity, vUv + vec2(0.0, texelSize.y)).xy;

  // Check for boundary neighbors - use zero velocity at boundaries
  float bL = texture(uBoundaries, vUv - vec2(texelSize.x, 0.0)).r;
  float bR = texture(uBoundaries, vUv + vec2(texelSize.x, 0.0)).r;
  float bB = texture(uBoundaries, vUv - vec2(0.0, texelSize.y)).r;
  float bT = texture(uBoundaries, vUv + vec2(0.0, texelSize.y)).r;

  // Zero out velocity at boundaries (no-slip condition)
  if (bL > 0.5) vL = vec2(0.0);
  if (bR > 0.5) vR = vec2(0.0);
  if (bB > 0.5) vB = vec2(0.0);
  if (bT > 0.5) vT = vec2(0.0);

  // Central difference divergence: div(v) = dVx/dx + dVy/dy
  float divergence = 0.5 * ((vR.x - vL.x) + (vT.y - vB.y));

  fragColor = vec4(divergence, 0.0, 0.0, 1.0);
}
