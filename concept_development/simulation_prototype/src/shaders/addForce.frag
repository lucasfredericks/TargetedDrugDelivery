// Add external force - applies constant flow from left edge
#version 300 es
precision highp float;

uniform sampler2D uVelocity;
uniform sampler2D uBoundaries;
uniform vec2 uResolution;
uniform float uFlowSpeed;       // Base flow speed (in grid cells per step)
uniform float uInflowWidth;     // Width of inflow region (0-1)

in vec2 vUv;
out vec4 fragColor;

void main() {
  // Check if current cell is boundary
  float boundary = texture(uBoundaries, vUv).r;
  if (boundary > 0.5) {
    fragColor = vec4(0.0);
    return;
  }

  vec2 velocity = texture(uVelocity, vUv).xy;

  // Add inflow from left edge
  if (vUv.x < uInflowWidth) {
    // Smooth ramp from edge
    float ramp = smoothstep(0.0, uInflowWidth, vUv.x);
    float inflow = uFlowSpeed * (1.0 - ramp);
    velocity.x += inflow;

    // Also enforce minimum flow at the very edge
    if (vUv.x < 0.02) {
      velocity.x = max(velocity.x, uFlowSpeed);
    }
  }

  // Open boundary on right - gradually relax to outflow
  if (vUv.x > 0.95) {
    float ramp = smoothstep(0.95, 1.0, vUv.x);
    velocity.y *= (1.0 - ramp * 0.5); // Reduce vertical component
  }

  fragColor = vec4(velocity, 0.0, 1.0);
}
