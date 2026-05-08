# Simulation PC Setup

## Current Setup (Pi-served)

Each simulation PC loads the webpage directly from the Raspberry Pi:

```
http://<pi-ip>:5000/sim/?tissue=<0-3>
```

This is simple but means the PC shows an error if the Pi hasn't finished booting when the browser opens. Socket.IO reconnection (`reconnectionAttempts: Infinity`) is already in place, so once the Pi is up the connection recovers automatically — the only gap is the initial page load.

---

## Future Setup: Local nginx + Pi for Socket.IO only

Serving simulation files locally means the page loads instantly at boot regardless of Pi state. The Socket.IO connection retries silently in the background until the Pi is ready, and the simulation sits in idle state until it receives an `assignment` from the master server.

### 1. Copy simulation files to each PC

Copy the `concept_development/simulation_prototype/` folder to each PC:

```
C:\exhibit\sim\
```

This only needs to be repeated when the simulation's HTML/JS/assets change. The Pi-hosted copy can remain as a fallback for the display PC and admin page.

### 2. Install nginx for Windows

Download from https://nginx.org/en/download.html (stable release `.zip`).

Extract to `C:\nginx\`.

Replace the contents of `C:\nginx\conf\nginx.conf` with:

```nginx
worker_processes 1;

events {
    worker_connections 1024;
}

http {
    include       mime.types;
    default_type  application/octet-stream;
    sendfile      on;

    server {
        listen 8080;
        server_name localhost;

        root C:/exhibit/sim;
        index index.html;

        location / {
            try_files $uri $uri/ =404;
        }
    }
}
```

### 3. Install nginx as a Windows service

Use [NSSM (Non-Sucking Service Manager)](https://nssm.cc/) to run nginx as a service that starts automatically on boot.

```
nssm install nginx C:\nginx\nginx.exe
nssm set nginx AppDirectory C:\nginx
nssm start nginx
```

Verify it's running: open `http://localhost:8080/` in a browser.

### 4. Configure browser startup URL

Each PC's browser should open to:

| PC | URL |
|----|-----|
| Sim PC 0 | `http://localhost:8080/?server=<pi-ip>:5000&tissue=0` |
| Sim PC 1 | `http://localhost:8080/?server=<pi-ip>:5000&tissue=1` |
| Sim PC 2 | `http://localhost:8080/?server=<pi-ip>:5000&tissue=2` |
| Sim PC 3 | `http://localhost:8080/?server=<pi-ip>:5000&tissue=3` |

Replace `<pi-ip>` with the Pi's static IP address.

The `?server=` parameter is what tells `network.js` to use Socket.IO mode and where to connect. Without it, the simulation falls back to BroadcastChannel (local dev mode).

### 5. Display

The display runs on the Pi itself (`display.html` served by Flask, shown on the Pi's HDMI output). No separate PC needed — the Pi serves and displays it locally at:

```
http://localhost:5000/
```

### Notes

- The `tissue=` index (0–3) assigns which tissue each PC simulates. Matches the 4-tissue puzzle layout.
- If the puzzle ever supports more than 4 tissues, update assignments accordingly.
- Updates to simulation logic (`src/*.js`) require copying new files to each PC. Updates to Pi coordination logic (`master_server.py`, `state_machine.py`, etc.) do not.
