# Simulation Prototype (developer reference)

The browser simulation itself: a p5.js sketch that renders the tissues, cells,
particles, and binding, plus the networking layer that connects it to the Pi in
exhibit mode. This document is for working on that code.

**Installing or running the exhibit is documented elsewhere** — start at the
[documentation index](../../docs/README.md):

- Pi master (hardware, install, configuration): [../../pi/SETUP.md](../../pi/SETUP.md)
- Simulation PC kiosks: [../../simulation_pc/SETUP.md](../../simulation_pc/SETUP.md)
- Running the exhibit day to day: [../../pi/OPERATIONS.md](../../pi/OPERATIONS.md)

## Local development

- Open `index.html` in a browser to run the prototype standalone.
- Open `dashboard.html` in a second tab to control ligands and run tests.
- p5.js and Socket.IO are bundled in `lib/` — no build step and no network needed.
- The dashboard drives the simulation over `BroadcastChannel` (same browser only).
  Pointing the simulation at a Pi instead switches it to Socket.IO — see
  [src/network.js](src/network.js).

### URL parameters

- `?server=<host:port>` — exhibit mode: connect to the Pi master over Socket.IO.
  Without it, the simulation runs in local BroadcastChannel dev mode and never
  reaches a Pi.
- `?tissue=N` — render a single tissue full-screen (N = 0–3: Tumor, Heart, Liver,
  Lung). Omit it to render all four in a 2×2 grid.
- `?fluid=true` — enable the GPU fluid-sim background (requires WebGL 2).

## Architecture

- [src/main.js](src/main.js) — entry point; creates the four `Simulation`
  instances and wires them to the network.
- [src/network.js](src/network.js) + [src/network.worker.js](src/network.worker.js)
  — Socket.IO (exhibit) / BroadcastChannel (dev) abstraction behind one
  `NetworkClient` interface. The socket runs in a Web Worker so the Engine.IO
  heartbeat is answered even when the draw loop saturates the main thread.
- [src/Simulation.js](src/Simulation.js) — one tissue: owns its cells, particles,
  physics, and rendering to an offscreen buffer.
- `src/Cell.js`, `src/Particle.js`, `src/Receptor.js`, `src/BindingLogic.js` — the
  model: cells with receptors, drug particles, and the binding rules between them.
- `src/FluidSimulation.js`, `src/FluidShaders.js` — the optional fluid background.
- `puzzle_example.json` — an example puzzle (4 tissues × 6 receptor concentrations).

In exhibit mode the Pi is the single source of truth: it serves these files and
coordinates every client, so a code change is deployed by pulling it on the Pi,
not by touching the PCs. See [../../pi/OPERATIONS.md](../../pi/OPERATIONS.md),
"Deploying a change."
