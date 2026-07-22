# Simulation PC Setup

Each simulation PC is one screen in the exhibit that renders one tissue. The PCs
run **no simulation code locally** — they are browsers pointed at the Raspberry
Pi, which serves the simulation and coordinates everything over Socket.IO.

**Why no local code:** the Pi is the single source of truth. When you change the
simulation in the repo, you `git pull` on the Pi and every screen picks it up on
its next reload. You never touch the individual PCs.

The only local file on each PC is `launcher.html` (below). It exists solely to
handle boot ordering and never changes when the simulation changes.

---

## How it fits together

```
  Sim PC 0 ─┐   browser (kiosk)
  Sim PC 1 ─┤        │  loads launcher.html (local) → redirects to ↓
  Sim PC 2 ─┤        │  http://<pi>:5000/sim/?server=<pi>:5000&tissue=<n>
  Sim PC 3 ─┘        ▼
                Raspberry Pi (master_server.py, port 5000)
                  • serves the simulation at /sim/
                  • Socket.IO: assignments, start/reset, stats, results
                  • serves the results display at / (Pi's own HDMI output)
```

- **Serving** and **coordination** both come from the Pi. Runtime disconnects
  (Pi reboot, CPU jank under load) are already handled: the Socket.IO client
  runs in a Web Worker and reconnects forever, re-registering on every
  reconnect. Nothing to configure for that.
- **Cold-boot ordering** is the one thing serving-from-the-Pi can't fix alone.
  If a PC's browser opens before the Pi's HTTP server is up, it lands on an
  error page and won't retry. `launcher.html` closes exactly that gap.

---

## The two required URL params

A working exhibit URL needs **both**:

| Param | Read by | Effect |
|-------|---------|--------|
| `server=<pi>:5000` | [network.js](../concept_development/simulation_prototype/src/network.js) | Puts the client in Socket.IO (exhibit) mode and points it at the Pi. **Without it the sim silently falls back to local BroadcastChannel dev mode and never connects.** |
| `tissue=<0-3>` | [main.js](../concept_development/simulation_prototype/src/main.js) | Assigns which single tissue this screen renders. Omit it and the screen renders all 4. |

The launcher builds this URL for you, so you only pass `pi` and `tissue` to the
launcher.

---

## Setup per PC

### 1. Copy the launcher

Copy `simulation_pc/launcher.html` to each PC, e.g.:

```
C:\exhibit\launcher.html
```

This is the **only** file that lives on the PC, and it's identical on all four
machines. You copy it once. It does not need re-copying when the simulation
changes — the simulation is served from the Pi.

### 2. Point the browser at it (kiosk)

Set each PC's browser to open the launcher in full-screen kiosk mode, passing
the Pi address and this screen's tissue index. Only the `tissue=` value differs
between machines:

| PC | Kiosk URL |
|----|-----------|
| Sim PC 0 | `file:///C:/exhibit/launcher.html?pi=192.168.1.1:5000&tissue=0` |
| Sim PC 1 | `file:///C:/exhibit/launcher.html?pi=192.168.1.1:5000&tissue=1` |
| Sim PC 2 | `file:///C:/exhibit/launcher.html?pi=192.168.1.1:5000&tissue=2` |
| Sim PC 3 | `file:///C:/exhibit/launcher.html?pi=192.168.1.1:5000&tissue=3` |

Replace `192.168.1.1` with the Pi's static IP (see [pi/SETUP.md](../pi/SETUP.md)
Step 8).

Chromium example (a Startup shortcut or Task Scheduler entry on boot):

```
chrome.exe --kiosk "file:///C:/exhibit/launcher.html?pi=192.168.1.1:5000&tissue=0"
```

The launcher shows a "Waiting for exhibit server…" screen, polls the Pi every
2 s, and redirects to the Pi-served simulation the moment the Pi answers. Boot
the PCs and the Pi in any order.

### 3. That's it

No nginx, no local web server, no copy of `simulation_prototype/` on the PC. When
the simulation changes, `git pull` on the Pi and reload the screens (or reboot
them).

---

## Auto-start Chromium in kiosk at boot

Pick **one** of these so each PC opens straight into its screen on power-up. In
both cases only the `tissue=` value changes between the four PCs.

### Prerequisite: disable Chrome's crash-restore bubble

After an unclean shutdown Chrome shows a "restore pages?" bar that steals kiosk
focus. Launch a **dedicated profile** and mark it clean-exit so the bar never
appears. The commands below use `--user-data-dir=C:\exhibit\chrome-profile` for
that; create the folder once (`mkdir C:\exhibit\chrome-profile`).

Adjust the Chrome path if needed:
`C:\Program Files\Google\Chrome\Application\chrome.exe`.

### Option A: Startup-folder shortcut (simplest)

1. Press `Win+R`, type `shell:startup`, Enter. This opens the current user's
   Startup folder (contents launch at login).
2. Right-click → **New → Shortcut**. For the location, paste (one line, PC 0
   shown — change `tissue=0` per machine):

   ```
   "C:\Program Files\Google\Chrome\Application\chrome.exe" --kiosk --user-data-dir=C:\exhibit\chrome-profile --no-first-run --disable-session-crashed-bubble --disable-infobars "file:///C:/exhibit/launcher.html?pi=192.168.1.1:5000&tissue=0"
   ```

3. Name it `TDD Sim` and finish. Set the PC to log in automatically (see below)
   so it reaches the desktop without someone typing a password.

Fast to set up; runs only after that user logs in.

### Option B: Task Scheduler (more robust)

Survives across users and lets you add a startup delay if the machine is slow to
bring up networking. Run in an **admin** PowerShell (change `tissue=0` per PC):

```powershell
$chrome = "C:\Program Files\Google\Chrome\Application\chrome.exe"
$args = '--kiosk --user-data-dir=C:\exhibit\chrome-profile --no-first-run ' +
        '--disable-session-crashed-bubble --disable-infobars ' +
        '"file:///C:/exhibit/launcher.html?pi=192.168.1.1:5000&tissue=0"'

$action  = New-ScheduledTaskAction -Execute $chrome -Argument $args
$trigger = New-ScheduledTaskTrigger -AtLogOn
$trigger.Delay = "PT10S"   # optional: wait 10s after logon for the network
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask -TaskName "TDD Sim" -Action $action -Trigger $trigger `
    -Settings $settings -RunLevel Limited -User $env:USERNAME
```

The launcher already handles the Pi not being ready, so the `Delay`/network wait
is only about the PC itself finishing boot — it isn't required for correctness.

### Auto-login and exiting kiosk

- **Auto-login** (so boot reaches the desktop unattended): run `netplwiz`, uncheck
  "Users must enter a user name and password to use this computer", and enter the
  account's credentials once.
- **Exit kiosk** for maintenance: `Alt+F4`, or `Ctrl+W`. To keep staff from
  wandering off, you can also lock the machine to this one task with Windows
  **Assigned Access** (Settings → Accounts → Family & other users → Set up a
  kiosk), pointing it at the same Chrome command.

---

## Optional launcher params

| Param | Default | Notes |
|-------|---------|-------|
| `pi` | `192.168.1.1:5000` | Pi `host:port`. |
| `tissue` | (omitted) | `0`–`3`. Omit to render all four tissues on one screen. |
| `fluid` | (off) | `fluid=true` enables the fluid-sim background; passed through to the sim URL. |
| `poll` | `2000` | Poll interval in ms while waiting for the Pi. |

---

## Notes & troubleshooting

- **Screen stuck on "Waiting for exhibit server…":** the Pi isn't reachable.
  Ping the Pi from the PC; confirm `master_server.py` is running and the
  `pi=` host:port is correct. The launcher keeps retrying, so it will proceed on
  its own once the Pi comes up.
- **Sim loads but never connects / shows dev behavior:** the URL lost its
  `?server=` param. Check the launcher's `pi=` value — the launcher is what adds
  `?server=`.
- **A screen renders all 4 tissues instead of one:** its `tissue=` param is
  missing or out of range (must be `0`–`3`).
- **More than 4 tissues:** the exhibit assumes a 4-tissue puzzle layout. Extend
  the tissue indices and add screens accordingly.
- **Display:** the results display is not a sim PC — it runs on the Pi's own HDMI
  output at `http://localhost:5000/` (see [pi/SETUP.md](../pi/SETUP.md) Step 11).
