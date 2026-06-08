# Sim PC Setup

One-time configuration for each Windows simulation PC. After this, all
code updates flow through `git pull` on the Pi alone — the sim PCs are
never touched again.

## What this directory contains

- **splash.html** — a local "waiting for server" page. Polls the Pi every
  second and redirects to the sim once it answers. Means the PCs can be
  powered on before the Pi without hitting an `ERR_CONNECTION_REFUSED`
  dead end.

## Install on each sim PC

1. **Copy `splash.html`** to `C:\tdd\splash.html` (or anywhere stable).
   You can email it to yourself, copy via USB, or download the raw file
   from GitHub. It does not need to be kept in sync with the repo —
   updates are rare.

2. **Create a Chrome shortcut** on the desktop with this target:

   ```
   "C:\Program Files\Google\Chrome\Application\chrome.exe" --kiosk --noerrdialogs --disable-pinch --overscroll-history-navigation=0 --enable-features=AutoReloadOnNetworkError "file:///C:/tdd/splash.html?server=<PI-IP>:5000&tissue=<N>"
   ```

   Replace:
   - `<PI-IP>` — the Pi's LAN address (e.g. `192.168.1.50`)
   - `<N>` — this PC's tissue index: `0`, `1`, `2`, or `3` (one per PC;
     see [pi/client_manager.py](../pi/client_manager.py) for assignment
     logic if you run fewer than 4 PCs)

   Optional extra params: `&fluid=true` to enable the WebGL fluid sim.

3. **Auto-launch on boot.** Put a copy of the shortcut in
   `shell:startup` (paste that into Run / Win+R). Windows will launch
   Chrome → splash → sim every time the PC powers on.

4. **Disable Windows Update reboots, sleep, and screensaver** —
   standard kiosk hygiene. Settings → System → Power & sleep → Never
   for both. Settings → Personalization → Lock screen → Screen saver
   settings → None.

## How it behaves

- **Pi off when PC boots:** splash shows "Waiting for master server..."
  and polls forever. Redirects to the sim as soon as the Pi answers.
- **Pi reboots mid-session:** the sim's Socket.IO client retries
  internally. If it stays disconnected longer than 60 s, the sim
  navigates back to the splash, which then re-detects the Pi.
- **Network blip < 60 s:** handled silently by Socket.IO reconnect; no
  reload.

The 60 s threshold lives in `DISCONNECT_RELOAD_MS` in
[../concept_development/simulation_prototype/src/network.js](../concept_development/simulation_prototype/src/network.js).

## Testing

From any sim PC, in order:

1. Stop `master_server.py` on the Pi.
2. Launch the Chrome shortcut. Expect: "Waiting for master server..."
3. Start `master_server.py`. Expect: redirect to the sim within ~1 s.
4. Mid-test, kill the Pi process. Expect: after 60 s, page returns to
   the splash; when you restart the Pi, it redirects back to the sim.

## Exiting kiosk mode

`Alt+F4` closes Chrome. `Ctrl+W` closes the tab (which in kiosk mode
also closes the window). If a child has discovered `F11`, the shortcut
puts it back on the next reboot.

## Remote power control (optional)

The Pi can wake and shut down the sim PCs over the LAN, so staff can
turn the whole exhibit on/off from one place (or from the `/admin`
page). One-time setup per sim PC:

### Wake-on-LAN

1. **BIOS:** enable "Wake on LAN" / "Power on by PCI-E" / "ErP" disabled
   (varies by vendor). The PC must keep the NIC powered when off.
2. **Windows:** Device Manager → your Ethernet adapter → Properties →
   *Power Management*: check "Allow this device to wake the computer".
   Then *Advanced* tab: set "Wake on Magic Packet" = Enabled.
3. **Find the MAC address:** in PowerShell on the sim PC,
   `Get-NetAdapter | Format-List Name, MacAddress`. Note the wired
   adapter's MAC.

### OpenSSH Server (for remote shutdown)

1. Settings → Apps → Optional features → "Add an optional feature" →
   install **OpenSSH Server**.
2. Start and auto-start the service (PowerShell as admin):
   ```powershell
   Start-Service sshd
   Set-Service -Name sshd -StartupType Automatic
   ```
3. **Trust the Pi's key.** On the Pi:
   ```bash
   cat ~/.ssh/id_ed25519.pub   # generate first with ssh-keygen if missing
   ```
   On the sim PC (PowerShell as admin), append that line to
   `C:\ProgramData\ssh\administrators_authorized_keys` (if the SSH user
   is an admin) or `%USERPROFILE%\.ssh\authorized_keys` (non-admin).
   The administrators file needs strict ACLs — Microsoft's docs cover
   the exact `icacls` invocation.
4. Verify from the Pi: `ssh <user>@<simpc-ip> hostname` returns without
   prompting for a password.

### Configure the Pi

On the Pi, one-time:

```bash
cd pi
cp sim_pcs.example.json sim_pcs.json
nano sim_pcs.json   # fill in real MACs, IPs, and SSH usernames
python control_sims.py list    # sanity check
python control_sims.py on      # wake all
python control_sims.py off     # shut down all
```

Once that works from the CLI, the `Wake All` / `Shut Down All` buttons
on the `/admin` page are wired to the same code.
