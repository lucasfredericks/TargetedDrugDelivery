Simulation prototype

Quick start — Local development

- Open `index.html` in a browser (double-click) to run the prototype.
- Open `dashboard.html` in a separate tab to control ligands and run tests.
- The page uses p5.js and Socket.IO from CDN; no build step required.
- Communication between dashboard and simulation uses BroadcastChannel (same browser only).

URL parameters:

- `?tissue=N` — Full-screen single tissue (N = 0–3: Tumor, Heart, Liver, Lung)
- `?fluid=true` — Enable GPU-accelerated fluid simulation (requires WebGL 2)

Quick start — Exhibit mode (Raspberry Pi)

In exhibit mode, a Raspberry Pi acts as the master controller with physical inputs
(color sensors, RFID, buttons), and 1–4 client computers run the simulation.

Pi setup:

```bash
cd pi/
pip install -r requirements.txt
python master_server.py
```

Use `--no-gpio`, `--no-sensors`, or `--no-rfid` flags to skip hardware that isn't
connected (useful for testing on a non-Pi machine):

```bash
python master_server.py --no-gpio --no-sensors --no-rfid
```

Client setup:

Open the simulation in a browser pointed at the Pi server:

```
index.html?server=192.168.1.1:5000
```

The client will connect via Socket.IO, register with the master, and receive tissue
assignments automatically. Multiple clients split the 4 tissues evenly.

Pi display:

The Pi serves a results dashboard at `http://<pi-ip>:5000/` — open this in Chromium
on the Pi's HDMI display to show scores, nanoparticle preview, and test progress.

Hardware

- 6x Adafruit APDS-9960 color sensors (I2C) via TCA9548A multiplexer — read ligand colors
- MFRC522 RFID reader (SPI) — load puzzle configurations from tagged boards
- 3 GPIO buttons — Scan Nanoparticle, Start Test, Reset

Run `python pi/color_calibration.py` to calibrate sensor RGB values for your physical
ligand pieces. Run `python pi/test_sensors.py` to verify sensor wiring.

What's included

- `index.html` — Simulation canvas entrypoint
- `dashboard.html` — Control panel with ligand editor (local dev)
- `src/` — Modular simulation (Simulation, Cell, Particle, Receptor, BindingLogic, FluidSimulation, etc.)
- `src/network.js` — Socket.IO / BroadcastChannel abstraction
- `src/main.js` — Entry point coordinating simulations and network
- `puzzle_example.json` — Example puzzle (4 tissues × 6 receptor concentrations)
- `pi/` — Raspberry Pi master server, sensor services, display, and puzzle configs
