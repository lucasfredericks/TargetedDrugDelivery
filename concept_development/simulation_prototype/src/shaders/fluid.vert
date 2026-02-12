// Vertex shader for fullscreen quad (shared by all fluid passes)
#version 300 es

in vec2 aPosition;
out vec2 vUv;

void main() {
  // Map from p5's coordinate space to clip space
  vec2 pos = aPosition * 2.0 - 1.0;
  gl_Position = vec4(pos, 0.0, 1.0);
  vUv = aPosition;
}
