# Targeted Drug Delivery — Documentation

An interactive museum exhibit about targeted drug delivery. A visitor builds a
nanoparticle by placing colored ligands on a physical token, scans it and a puzzle
card at a Raspberry Pi station, and watches four simulation screens race drug
particles against four tissues to see how well the design targets the tumor.

The Raspberry Pi is the brain: it reads the hardware, serves the simulation, and
coordinates the screens over Socket.IO. The four simulation PCs are stateless
kiosks that each render one tissue. The Pi's own HDMI output shows the results
display.

## Find what you need

| I want to… | Read |
|---|---|
| Understand what the exhibit is and how the parts fit | this page |
| Give the Pi git access (deploy key) | [pi/SETUP.md](../pi/SETUP.md) → "Step 0: Git Access" |
| Wire and install the Pi master (sensors, Arduino, software) | [pi/SETUP.md](../pi/SETUP.md), steps 0–5 |
| Configure it (network, color calibration, puzzles & RFID tags) | [pi/SETUP.md](../pi/SETUP.md), steps 6–8 |
| Set up a simulation PC kiosk (browser, Skia Graphite, Deep Freeze) | [simulation_pc/SETUP.md](../simulation_pc/SETUP.md) |
| Open, close, and run the exhibit day to day | [pi/OPERATIONS.md](../pi/OPERATIONS.md) |
| Fix something that's misbehaving | [pi/OPERATIONS.md](../pi/OPERATIONS.md) → "When something goes wrong" |
| Deploy a code change to a running exhibit | [pi/OPERATIONS.md](../pi/OPERATIONS.md) → "Deploying a change" |
| Try a branch on the Pi without losing calibration | [pi/OPERATIONS.md](../pi/OPERATIONS.md) → "Trying a branch on the Pi" |
| Back up or restore calibration and tag pairings | [pi/OPERATIONS.md](../pi/OPERATIONS.md) → "Installation state" |
| Work on the simulation code itself | [concept_development/simulation_prototype/README.md](../concept_development/simulation_prototype/README.md) |

## Reading order (first-time install)

1. This overview.
2. [pi/SETUP.md](../pi/SETUP.md) — build and configure the Pi master, end to end.
3. [simulation_pc/SETUP.md](../simulation_pc/SETUP.md) — set up the four kiosk PCs.
4. [pi/OPERATIONS.md](../pi/OPERATIONS.md) — how to run it once it's built.

## System at a glance

```
  Sim PC 0–3  ──►  browser kiosks, one tissue each
      │             load the simulation from the Pi, talk Socket.IO
      ▼
  Raspberry Pi  (master_server.py, port 5000)
      • color sensors (I2C) + RFID/start button (Arduino over USB serial)
      • serves the simulation at  /sim/
      • coordinates assignments, start/reset, stats, results
      • results display on the Pi's own HDMI output at  /
```

## About this manual

These documents are on their way to becoming a single operations manual. For now
they live next to the code they describe, and this page is the entry point and the
canonical reading order. One rule keeps them from scattering again: **each topic
has exactly one home** (see the table above). When you add documentation, extend
the doc that already owns the topic and link to it from elsewhere — don't restate
it in a second place, or the two copies drift.
