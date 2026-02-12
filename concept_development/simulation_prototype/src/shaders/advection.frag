// Advection shader - moves quantities through the velocity field
// Uses semi-Lagrangian advection (trace back and sample)
#version 300 es
precision highp float;

uniform sampler2D uVelocity;    // Velocity field to advect by
uniform sampler2D uQuantity;    // Quantity to advect (can be velocity itself)
uniform sampler2D uBoundaries;  // Obstacle mask (r > 0.5 = solid)
uniform vec2 uResolution;       // Grid resolution
uniform float uDt;              // Time step
uniform float uDissipation;     // Dissipation factor (1.0 = no dissipation)

in vec2 vUv;
out vec4 fragColor;

void main() {
  // Check if this cell is a boundary
  float boundary = texture(uBoundaries, vUv).r;
  if (boundary > 0.5) {
    fragColor = vec4(0.0); // Zero velocity inside obstacles
    return;
  }

  // Get velocity at current position
  vec2 velocity = texture(uVelocity, vUv).xy;

  // Trace back in time to find source position
  vec2 texelSize = 1.0 / uResolution;
  vec2 sourcePos = vUv - velocity * texelSize * uDt;

  // Sample the quantity at the source position
  vec4 result = texture(uQuantity, sourcePos) * uDissipation;

  fragColor = result;
}
