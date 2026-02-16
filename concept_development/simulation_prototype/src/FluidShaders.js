// FluidShaders.js - GLSL shader sources for GPU fluid simulation
// Extracted from FluidSimulation.js for modularity

const FluidShaders = {
  // Shared vertex shader for fullscreen quad
  vertex: `#version 300 es
in vec2 aPosition;
out vec2 vUv;
void main() {
  gl_Position = vec4(aPosition * 2.0 - 1.0, 0.0, 1.0);
  vUv = aPosition;
}`,

  // Semi-Lagrangian advection shader
  advection: `#version 300 es
precision highp float;

uniform sampler2D uVelocity;
uniform sampler2D uQuantity;
uniform sampler2D uBoundaries;
uniform vec2 uResolution;
uniform float uDt;
uniform float uDissipation;

in vec2 vUv;
out vec4 fragColor;

void main() {
  // Check if this cell is an obstacle
  float boundary = texture(uBoundaries, vUv).r;
  if (boundary > 0.5) {
    fragColor = vec4(0.0);
    return;
  }

  vec2 texelSize = 1.0 / uResolution;

  // Get velocity at this point
  vec2 velocity = texture(uVelocity, vUv).xy;

  // Semi-Lagrangian advection: trace backwards to find source
  vec2 sourceUV = vUv - velocity * texelSize * uDt;

  // Clamp to valid range
  sourceUV = clamp(sourceUV, vec2(0.001), vec2(0.999));

  // Check if source is inside an obstacle - if so, use current position instead
  // This prevents velocity from being "pulled through" obstacles
  float sourceBoundary = texture(uBoundaries, sourceUV).r;
  if (sourceBoundary > 0.5) {
    // Source is inside obstacle - try to find valid nearby source
    // Step back along the path until we exit the obstacle
    vec2 dir = normalize(velocity);
    vec2 testUV = sourceUV;
    for (int i = 0; i < 8; i++) {
      testUV += dir * texelSize * 0.5;
      testUV = clamp(testUV, vec2(0.001), vec2(0.999));
      if (texture(uBoundaries, testUV).r < 0.5) {
        sourceUV = testUV;
        break;
      }
    }
    // If still in obstacle, just use current position
    if (texture(uBoundaries, sourceUV).r > 0.5) {
      sourceUV = vUv;
    }
  }

  // Sample the quantity at the source location
  vec2 result = texture(uQuantity, sourceUV).xy;

  // Apply dissipation
  result *= uDissipation;

  fragColor = vec4(result, 0.0, 1.0);
}`,

  // Divergence computation shader
  divergence: `#version 300 es
precision highp float;

uniform sampler2D uVelocity;
uniform sampler2D uBoundaries;
uniform vec2 uResolution;

in vec2 vUv;
out vec4 fragColor;

void main() {
  vec2 texelSize = 1.0 / uResolution;

  vec2 vL = texture(uVelocity, vUv - vec2(texelSize.x, 0.0)).xy;
  vec2 vR = texture(uVelocity, vUv + vec2(texelSize.x, 0.0)).xy;
  vec2 vB = texture(uVelocity, vUv - vec2(0.0, texelSize.y)).xy;
  vec2 vT = texture(uVelocity, vUv + vec2(0.0, texelSize.y)).xy;

  float bL = texture(uBoundaries, vUv - vec2(texelSize.x, 0.0)).r;
  float bR = texture(uBoundaries, vUv + vec2(texelSize.x, 0.0)).r;
  float bB = texture(uBoundaries, vUv - vec2(0.0, texelSize.y)).r;
  float bT = texture(uBoundaries, vUv + vec2(0.0, texelSize.y)).r;

  if (bL > 0.5) vL = vec2(0.0);
  if (bR > 0.5) vR = vec2(0.0);
  if (bB > 0.5) vB = vec2(0.0);
  if (bT > 0.5) vT = vec2(0.0);

  float divergence = 0.5 * ((vR.x - vL.x) + (vT.y - vB.y));
  fragColor = vec4(divergence, 0.0, 0.0, 1.0);
}`,

  // Jacobi pressure solver shader
  pressure: `#version 300 es
precision highp float;

uniform sampler2D uPressure;
uniform sampler2D uDivergence;
uniform sampler2D uBoundaries;
uniform vec2 uResolution;

in vec2 vUv;
out vec4 fragColor;

void main() {
  vec2 texelSize = 1.0 / uResolution;

  float boundary = texture(uBoundaries, vUv).r;
  if (boundary > 0.5) {
    fragColor = vec4(0.0);
    return;
  }

  float pL = texture(uPressure, vUv - vec2(texelSize.x, 0.0)).r;
  float pR = texture(uPressure, vUv + vec2(texelSize.x, 0.0)).r;
  float pB = texture(uPressure, vUv - vec2(0.0, texelSize.y)).r;
  float pT = texture(uPressure, vUv + vec2(0.0, texelSize.y)).r;

  float bL = texture(uBoundaries, vUv - vec2(texelSize.x, 0.0)).r;
  float bR = texture(uBoundaries, vUv + vec2(texelSize.x, 0.0)).r;
  float bB = texture(uBoundaries, vUv - vec2(0.0, texelSize.y)).r;
  float bT = texture(uBoundaries, vUv + vec2(0.0, texelSize.y)).r;

  float pC = texture(uPressure, vUv).r;
  if (bL > 0.5) pL = pC;
  if (bR > 0.5) pR = pC;
  if (bB > 0.5) pB = pC;
  if (bT > 0.5) pT = pC;

  float divergence = texture(uDivergence, vUv).r;
  float pressure = (pL + pR + pB + pT - divergence) * 0.25;

  fragColor = vec4(pressure, 0.0, 0.0, 1.0);
}`,

  // Pressure gradient subtraction shader (projection step)
  gradient: `#version 300 es
precision highp float;

uniform sampler2D uVelocity;
uniform sampler2D uPressure;
uniform sampler2D uBoundaries;
uniform vec2 uResolution;

in vec2 vUv;
out vec4 fragColor;

void main() {
  // Check if this cell is an obstacle
  float boundary = texture(uBoundaries, vUv).r;
  if (boundary > 0.5) {
    fragColor = vec4(0.0);
    return;
  }

  vec2 texelSize = 1.0 / uResolution;

  // Sample pressure at neighboring cells
  float pL = texture(uPressure, vUv - vec2(texelSize.x, 0.0)).r;
  float pR = texture(uPressure, vUv + vec2(texelSize.x, 0.0)).r;
  float pB = texture(uPressure, vUv - vec2(0.0, texelSize.y)).r;
  float pT = texture(uPressure, vUv + vec2(0.0, texelSize.y)).r;

  // Handle boundary conditions for pressure
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

  // Subtract gradient from velocity to make it divergence-free
  vec2 velocity = texture(uVelocity, vUv).xy;
  velocity -= gradient;

  fragColor = vec4(velocity, 0.0, 1.0);
}`,

  // External forces and turbulence injection shader
  addForce: `#version 300 es
precision highp float;

uniform sampler2D uVelocity;
uniform sampler2D uBoundaries;
uniform vec2 uResolution;
uniform float uFlowSpeed;
uniform float uInflowWidth;
uniform float uTime;

in vec2 vUv;
out vec4 fragColor;

// Simple pseudo-random hash
float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

// Value noise
float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f); // Smoothstep

  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));

  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

// Fractal Brownian Motion for richer turbulence
float fbm(vec2 p) {
  float value = 0.0;
  float amplitude = 0.5;
  for (int i = 0; i < 4; i++) {
    value += amplitude * noise(p);
    p *= 2.0;
    amplitude *= 0.5;
  }
  return value;
}

void main() {
  float boundary = texture(uBoundaries, vUv).r;
  if (boundary > 0.5) {
    fragColor = vec4(0.0);
    return;
  }

  vec2 texelSize = 1.0 / uResolution;
  vec2 velocity = texture(uVelocity, vUv).xy;

  // Add inflow from left edge with vertical variation
  if (vUv.x < uInflowWidth) {
    float ramp = smoothstep(0.0, uInflowWidth, vUv.x);
    float inflow = uFlowSpeed * (1.0 - ramp);

    // Add sinusoidal vertical variation to inflow
    float verticalWave = sin(vUv.y * 12.0 + uTime * 2.0) * 0.3;
    float verticalNoise = (noise(vec2(vUv.y * 8.0, uTime * 0.5)) - 0.5) * 0.4;

    velocity.x += inflow;
    velocity.y += inflow * (verticalWave + verticalNoise);

    if (vUv.x < 0.02) {
      velocity.x = max(velocity.x, uFlowSpeed);
    }
  }

  // Detect wake regions behind obstacles and add vortex shedding
  // Sample boundary texture in upstream direction (to the left)
  float wakeStrength = 0.0;
  float wakeSign = 0.0;
  float wakeDistance = 0.0;

  // Check multiple distances upstream for obstacles (extended range for large cells)
  for (float dist = 1.0; dist <= 25.0; dist += 1.0) {
    vec2 upstreamUV = vUv - vec2(texelSize.x * dist, 0.0);
    if (upstreamUV.x >= 0.0) {
      float upstreamBoundary = texture(uBoundaries, upstreamUV).r;
      if (upstreamBoundary > 0.5) {
        // We're in the wake of an obstacle
        wakeDistance = dist;
        float falloff = 1.0 - (dist / 30.0);
        wakeStrength = max(wakeStrength, falloff * 0.8);

        // Determine which side of the obstacle we're on
        // Sample above and below the upstream point
        float boundAbove = texture(uBoundaries, upstreamUV + vec2(0.0, texelSize.y * 3.0)).r;
        float boundBelow = texture(uBoundaries, upstreamUV - vec2(0.0, texelSize.y * 3.0)).r;

        if (boundAbove < 0.5 && boundBelow > 0.5) {
          wakeSign = 1.0;  // We're above the obstacle
        } else if (boundBelow < 0.5 && boundAbove > 0.5) {
          wakeSign = -1.0; // We're below the obstacle
        } else {
          // Alternating vortex shedding based on position and time (von Karman street)
          wakeSign = sign(sin(vUv.y * 40.0 + uTime * 5.0 - dist * 0.3));
        }
        break;
      }
    }
  }

  // Also detect obstacles in diagonal directions (for better wake coverage)
  for (float dist = 1.0; dist <= 15.0; dist += 2.0) {
    vec2 upstreamUVTop = vUv - vec2(texelSize.x * dist, -texelSize.y * dist * 0.5);
    vec2 upstreamUVBot = vUv - vec2(texelSize.x * dist, texelSize.y * dist * 0.5);

    if (upstreamUVTop.x >= 0.0) {
      float boundTop = texture(uBoundaries, upstreamUVTop).r;
      float boundBot = texture(uBoundaries, upstreamUVBot).r;

      if (boundTop > 0.5) {
        float falloff = 1.0 - (dist / 20.0);
        wakeStrength = max(wakeStrength, falloff * 0.6);
        if (wakeSign == 0.0) wakeSign = -1.0;
      }
      if (boundBot > 0.5) {
        float falloff = 1.0 - (dist / 20.0);
        wakeStrength = max(wakeStrength, falloff * 0.6);
        if (wakeSign == 0.0) wakeSign = 1.0;
      }
    }
  }

  // Add vortex shedding in wake regions
  if (wakeStrength > 0.0) {
    // Strouhal-based vortex shedding frequency (more physically accurate)
    float strouhalFreq = 0.2 * uFlowSpeed; // Strouhal number ~ 0.2 for cylinders

    // Alternating vertical velocity to create von Karman vortex street
    float vortexPhase = vUv.x * 20.0 - uTime * strouhalFreq * 6.0;
    float vortex = sin(vortexPhase) * wakeStrength * uFlowSpeed * 1.8;

    // Add secondary frequency for more complex patterns
    vortex += sin(vortexPhase * 1.7 + 0.5) * wakeStrength * uFlowSpeed * 0.7;

    // Add tertiary frequency for even richer patterns
    vortex += sin(vortexPhase * 0.6 + 2.0) * wakeStrength * uFlowSpeed * 0.5;

    // Add noise for natural variation
    float wakeNoise = fbm(vec2(vUv.x * 8.0 + uTime * 0.4, vUv.y * 8.0)) - 0.5;
    vortex += wakeNoise * wakeStrength * uFlowSpeed * 1.2;

    velocity.y += vortex * wakeSign;

    // Also add some horizontal velocity variation in wake (causes meandering)
    float horizVariation = sin(vortexPhase * 0.5 + 1.0) * wakeStrength * uFlowSpeed * 0.5;
    velocity.x += horizVariation;

    // Reduce base horizontal velocity in wake (drag effect - particles linger longer)
    velocity.x *= (1.0 - wakeStrength * 0.35);
  }

  // Enhanced background turbulence using curl noise (divergence-free)
  // This is injected EVERY FRAME to sustain turbulence against numerical dissipation
  float turbScale = 3.0;  // Lower = larger swirls that span more area
  float turbStrength = uFlowSpeed * 0.5;  // Stronger injection for more meandering

  // Multi-scale curl noise for richer turbulence
  float n1 = fbm(vec2(vUv.x * turbScale, vUv.y * turbScale + uTime * 0.3));
  float n2 = fbm(vec2(vUv.x * turbScale + 0.1, vUv.y * turbScale + uTime * 0.3));
  float n3 = fbm(vec2(vUv.x * turbScale, vUv.y * turbScale + 0.1 + uTime * 0.3));

  // Curl of noise field (divergence-free by construction)
  vec2 curl = vec2(n3 - n1, n1 - n2) * turbStrength;
  velocity += curl;

  // Add medium-scale turbulence for variety
  float medScale = 6.0;
  float medN1 = fbm(vec2(vUv.x * medScale + uTime * 0.4, vUv.y * medScale));
  float medN2 = fbm(vec2(vUv.x * medScale + 0.08, vUv.y * medScale + uTime * 0.4));
  float medN3 = fbm(vec2(vUv.x * medScale, vUv.y * medScale + 0.08 + uTime * 0.4));
  vec2 medCurl = vec2(medN3 - medN1, medN1 - medN2) * turbStrength * 0.7;
  velocity += medCurl;

  // Add finer-scale turbulence for detail
  float fineScale = 12.0;
  float fineN1 = noise(vec2(vUv.x * fineScale + uTime * 0.6, vUv.y * fineScale));
  float fineN2 = noise(vec2(vUv.x * fineScale + 0.05, vUv.y * fineScale + uTime * 0.6));
  float fineN3 = noise(vec2(vUv.x * fineScale, vUv.y * fineScale + 0.05 + uTime * 0.6));
  vec2 fineCurl = vec2(fineN3 - fineN1, fineN1 - fineN2) * turbStrength * 0.5;
  velocity += fineCurl;

  // Add micro-scale turbulence for texture
  float microScale = 20.0;
  float microN1 = noise(vec2(vUv.x * microScale + uTime * 0.8, vUv.y * microScale));
  float microN2 = noise(vec2(vUv.x * microScale + 0.03, vUv.y * microScale + uTime * 0.8));
  vec2 microCurl = vec2(microN2 - microN1, microN1 - microN2) * turbStrength * 0.3;
  velocity += microCurl;

  // Add random perturbations near obstacles (boundary layer effects)
  float nearBoundary = 0.0;
  for (float dx = -2.0; dx <= 2.0; dx += 1.0) {
    for (float dy = -2.0; dy <= 2.0; dy += 1.0) {
      vec2 sampleUV = vUv + vec2(texelSize.x * dx, texelSize.y * dy);
      nearBoundary = max(nearBoundary, texture(uBoundaries, sampleUV).r);
    }
  }
  if (nearBoundary > 0.5) {
    float edgeNoise = (noise(vec2(vUv.x * 20.0 + uTime, vUv.y * 20.0)) - 0.5) * 2.0;
    velocity.y += edgeNoise * uFlowSpeed * 0.3;
  }

  // Open boundary on right
  if (vUv.x > 0.92) {
    float ramp = smoothstep(0.92, 1.0, vUv.x);
    velocity.y *= (1.0 - ramp * 0.5);
    velocity.x = mix(velocity.x, max(velocity.x, uFlowSpeed * 0.5), ramp);
  }

  fragColor = vec4(velocity, 0.0, 1.0);
}`,

  // Vorticity computation shader
  vorticity: `#version 300 es
precision highp float;

uniform sampler2D uVelocity;
uniform vec2 uResolution;

in vec2 vUv;
out vec4 fragColor;

void main() {
  vec2 texelSize = 1.0 / uResolution;

  // Sample velocity at neighboring cells
  vec2 vL = texture(uVelocity, vUv - vec2(texelSize.x, 0.0)).xy;
  vec2 vR = texture(uVelocity, vUv + vec2(texelSize.x, 0.0)).xy;
  vec2 vB = texture(uVelocity, vUv - vec2(0.0, texelSize.y)).xy;
  vec2 vT = texture(uVelocity, vUv + vec2(0.0, texelSize.y)).xy;

  // Compute curl (vorticity) in 2D: dv/dx - du/dy
  float vorticity = (vR.y - vL.y) - (vT.x - vB.x);
  vorticity *= 0.5;

  fragColor = vec4(vorticity, 0.0, 0.0, 1.0);
}`,

  // Vorticity confinement force shader
  vorticityForce: `#version 300 es
precision highp float;

uniform sampler2D uVelocity;
uniform sampler2D uVorticity;
uniform sampler2D uBoundaries;
uniform vec2 uResolution;
uniform float uVorticityStrength;
uniform float uDt;

in vec2 vUv;
out vec4 fragColor;

void main() {
  float boundary = texture(uBoundaries, vUv).r;
  if (boundary > 0.5) {
    fragColor = vec4(0.0);
    return;
  }

  vec2 texelSize = 1.0 / uResolution;

  // Sample vorticity at neighboring cells
  float vL = texture(uVorticity, vUv - vec2(texelSize.x, 0.0)).r;
  float vR = texture(uVorticity, vUv + vec2(texelSize.x, 0.0)).r;
  float vB = texture(uVorticity, vUv - vec2(0.0, texelSize.y)).r;
  float vT = texture(uVorticity, vUv + vec2(0.0, texelSize.y)).r;
  float vC = texture(uVorticity, vUv).r;

  // Compute gradient of vorticity magnitude
  vec2 gradVort = vec2(abs(vR) - abs(vL), abs(vT) - abs(vB)) * 0.5;

  // Normalize gradient (avoid division by zero)
  float len = length(gradVort);
  if (len > 1e-5) {
    gradVort /= len;
  } else {
    gradVort = vec2(0.0);
  }

  // Compute vorticity confinement force
  // Force is perpendicular to gradient, scaled by vorticity
  // In 2D: F = epsilon * (N x omega) where N is normalized gradient
  // N x omega in 2D gives: (N.y * omega, -N.x * omega)
  vec2 force = vec2(gradVort.y, -gradVort.x) * vC * uVorticityStrength;

  // Get current velocity and add force
  vec2 velocity = texture(uVelocity, vUv).xy;
  velocity += force * uDt;

  fragColor = vec4(velocity, 0.0, 1.0);
}`,

  // Boundary enforcement shader (no-penetration condition)
  boundaryEnforce: `#version 300 es
precision highp float;

uniform sampler2D uVelocity;
uniform sampler2D uBoundaries;
uniform vec2 uResolution;

in vec2 vUv;
out vec4 fragColor;

void main() {
  vec2 texelSize = 1.0 / uResolution;

  // Check if this cell is an obstacle
  float boundary = texture(uBoundaries, vUv).r;
  if (boundary > 0.5) {
    // Inside obstacle: zero velocity
    fragColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }

  vec2 velocity = texture(uVelocity, vUv).xy;

  // Check neighboring cells for boundaries
  float bL = texture(uBoundaries, vUv - vec2(texelSize.x, 0.0)).r;
  float bR = texture(uBoundaries, vUv + vec2(texelSize.x, 0.0)).r;
  float bB = texture(uBoundaries, vUv - vec2(0.0, texelSize.y)).r;
  float bT = texture(uBoundaries, vUv + vec2(0.0, texelSize.y)).r;

  // If adjacent to a boundary, enforce no-penetration (zero normal velocity)
  // This prevents flow INTO the obstacle

  // If boundary is to the left and we're flowing left, stop horizontal flow
  if (bL > 0.5 && velocity.x < 0.0) {
    velocity.x = 0.0;
  }
  // If boundary is to the right and we're flowing right, stop horizontal flow
  if (bR > 0.5 && velocity.x > 0.0) {
    velocity.x = 0.0;
  }
  // If boundary is below and we're flowing down, stop vertical flow
  if (bB > 0.5 && velocity.y < 0.0) {
    velocity.y = 0.0;
  }
  // If boundary is above and we're flowing up, stop vertical flow
  if (bT > 0.5 && velocity.y > 0.0) {
    velocity.y = 0.0;
  }

  // Note: Diagonal boundary handling removed - the cardinal direction checks above
  // are sufficient. The previous 0.5 velocity multiplier for diagonal obstacles
  // was too aggressive and suppressed flow deflection around cell corners.

  fragColor = vec4(velocity, 0.0, 1.0);
}`,

  // Viscous diffusion shader (implicit Jacobi solver)
  diffusion: `#version 300 es
precision highp float;

uniform sampler2D uVelocity;
uniform sampler2D uBoundaries;
uniform vec2 uResolution;
uniform float uViscosity;
uniform float uDt;

in vec2 vUv;
out vec4 fragColor;

void main() {
  // Check if this cell is an obstacle
  float boundary = texture(uBoundaries, vUv).r;
  if (boundary > 0.5) {
    fragColor = vec4(0.0);
    return;
  }

  vec2 texelSize = 1.0 / uResolution;

  // Sample velocity at current and neighboring cells
  vec2 vC = texture(uVelocity, vUv).xy;
  vec2 vL = texture(uVelocity, vUv - vec2(texelSize.x, 0.0)).xy;
  vec2 vR = texture(uVelocity, vUv + vec2(texelSize.x, 0.0)).xy;
  vec2 vB = texture(uVelocity, vUv - vec2(0.0, texelSize.y)).xy;
  vec2 vT = texture(uVelocity, vUv + vec2(0.0, texelSize.y)).xy;

  // Check for boundary neighbors - use no-slip (zero velocity) at boundaries
  float bL = texture(uBoundaries, vUv - vec2(texelSize.x, 0.0)).r;
  float bR = texture(uBoundaries, vUv + vec2(texelSize.x, 0.0)).r;
  float bB = texture(uBoundaries, vUv - vec2(0.0, texelSize.y)).r;
  float bT = texture(uBoundaries, vUv + vec2(0.0, texelSize.y)).r;

  // No-slip boundary condition: velocity at solid boundaries is zero
  // This creates shear layers at the boundary interface
  if (bL > 0.5) vL = vec2(0.0);
  if (bR > 0.5) vR = vec2(0.0);
  if (bB > 0.5) vB = vec2(0.0);
  if (bT > 0.5) vT = vec2(0.0);

  // Jacobi iteration for implicit diffusion solve
  // Solving: (I - viscosity * dt * Laplacian) * v_new = v_old
  // Rearranged: v_new = (v_old + alpha * (vL + vR + vB + vT)) / (1 + 4*alpha)
  // where alpha = viscosity * dt
  float alpha = uViscosity * uDt;
  vec2 result = (vC + alpha * (vL + vR + vB + vT)) / (1.0 + 4.0 * alpha);

  fragColor = vec4(result, 0.0, 1.0);
}`
};

// Export for browser global
window.FluidShaders = FluidShaders;
console.log('FluidShaders.js loaded');
