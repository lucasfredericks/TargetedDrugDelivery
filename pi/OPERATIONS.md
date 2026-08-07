Exhibit Operations
==================

Day-to-day running of the Targeted Drug Delivery exhibit: opening, closing,
what to check, and what to do when something looks wrong. For wiring, first
install, and configuration see SETUP.md.

Two audiences here. **Opening**, **Closing**, and **When something goes wrong**
are floor-staff procedures. **Weekly check**, **Reading the log**, and
**Deploying a change** assume a terminal on the Pi.


Opening
-------

1. Power on the Pi and the four simulation PCs in any order. Each PC waits for
   the Pi and proceeds on its own once the Pi answers.
2. Confirm all four screens show the simulation, not "Waiting for exhibit
   server...".
3. On the Pi's display, confirm the footer reads **Connected** and
   **Clients: 4**. The count is synced when the display page joins, so a number
   below 4 is real — that screen never registered. Reload it.
4. Run one test end to end with a puzzle card: colors register on the display,
   the bars fill, results appear.


Closing
-------

- Take the puzzle card out of the reader. Not critical — the server suppresses
  repeat readings — but it stops the sensors reading all night.
- Leave everything powered on. The simulations reload themselves at 4 AM, which
  is what keeps a multi-day run healthy.


When something goes wrong
-------------------------

| What you see | What it means | What to do |
|---|---|---|
| "All simulation clients lost; exhibit reset" | Every screen was unreachable for 20s or more | Note the time and check the log — a stall line just before it points at the Pi rather than the PCs |
| "Test timed out after Ns; exhibit reset" | A screen stopped reporting but stayed connected | Check that screen's browser console |
| Screen stuck on "Waiting for exhibit server..." | The Pi is unreachable | Self-heals when the Pi returns; otherwise check the service and the network cable |
| Screen blank, or "Out of Memory" | That browser tab died | Reload it (Ctrl+R). Report it — this should no longer happen |
| Footer shows fewer than 4 clients | That screen isn't registered | Reload the screen |
| Colors read wrong | Calibration or lighting | See "Sensors read wrong colors" in SETUP.md |

A single reset mid-session is disruptive but not damaging: the next card starts
a clean run. Note the time so it can be matched against the log later.


Weekly check
------------

Reboot the Pi. Cheap insurance while there is still an open question about
whether long uptimes degrade it — which the health log is there to answer.

Then look at the trend:

    journalctl -u tdd-exhibit --since "7 days ago" | grep "Health:" | tail -40

Two numbers matter:

- `rss=` — the server's memory. Steady is healthy. Climbing across days means a
  leak, and the exhibit will eventually stall and drop every client at once.
- `peak loop lag` — how far behind schedule the event loop ran in that minute.
  Normal is a few hundredths of a second. Sustained growth is the early warning
  for the same failure.

If both stay flat across a couple of weeks, uptime isn't the problem and the
weekly reboot can stop.


Reading the log
---------------

Live:

    journalctl -u tdd-exhibit -f

Everything interesting from the last hour:

    journalctl -u tdd-exhibit --since "1 hour ago" \
      | grep -E "stalled|Health:|lost|dropped|reconnected|timed out"

What the lines mean:

- `Health: peak loop lag ...` — once a minute, always. The baseline.
- `Event loop stalled Ns` — the server was unable to run for N seconds. Past
  roughly 60s, Socket.IO gives up on every client at once and the exhibit
  resets. The memory, fd, and thread counts on the same line say why.
- `Expected completer ... dropped mid-test; holding its slot` followed by
  `... reconnected as ...` — a screen dropped and came back inside the grace
  period, so the test continued. Visitors saw nothing. Frequent pairs mean the
  underlying disconnects are still happening, just no longer breaking runs.
- `Gave up on ...: no reconnect within 15s` — a screen really was gone.

### Keeping logs across a reboot

The log is only useful for diagnosing a hang if it survives the reboot that
clears the hang. Debian and Raspberry Pi OS often run journald in volatile mode,
where logs live in RAM and are lost on restart. Check:

    journalctl --disk-usage
    ls -d /var/log/journal        # missing means volatile

To make it persistent and bound its size:

    sudo mkdir -p /var/log/journal
    sudo systemd-tmpfiles --create --prefix /var/log/journal
    printf '[Journal]\nStorage=persistent\nSystemMaxUse=200M\n' \
      | sudo tee /etc/systemd/journald.conf.d/exhibit.conf
    sudo systemctl restart systemd-journald

The health monitor writes about 0.4 MB a day at the default 60s summary, so
200 MB holds well over a year and journald discards the oldest first. If that is
noisier than you want, raise HEALTH_SUMMARY_SECONDS in config.py — stall
warnings fire on the event, not the schedule, so they are unaffected.


Deploying a change
------------------

If the Pi runs with the read-only overlay enabled, a plain `git pull` lands in
the throwaway layer and is gone at the next reboot. Disable the overlay first —
see "Making changes when the root is read-only" below.

1. `git pull` on the Pi.
2. `sudo systemctl restart tdd-exhibit`.
3. If anything under `concept_development/simulation_prototype/` changed, reload
   the four screens. They are served from the Pi, so a reload is the whole
   deploy — nothing is installed on the PCs.
4. If you changed COLOR_GAIN or COLOR_INTEGRATION_TIME, re-run
   `color_calibration.py`. Those settings change the raw RGBC scale and
   color_map.json must be regenerated to match.

Check the service came back:

    systemctl status tdd-exhibit
    journalctl -u tdd-exhibit -n 30


Making changes when the root is read-only
-----------------------------------------

If you enable the read-only overlay filesystem — to keep an unplug from
corrupting the SD card — the real root is frozen and every write lands in a
throwaway layer that is discarded on the next reboot. Anything meant to last (a
code deploy, a re-run of calibration, a new tag mapping) has to be written with
the overlay turned off and then committed to git, so it survives both the reboot
and a future reimage.

This is rare by design. Tag remapping happens only when a card fails or a puzzle
board is swapped; deploys and recalibration are deliberate maintenance. The cost
of the off/on cycle buys a Pi that tolerates being switched off at the wall.

### The cycle

1. Turn the overlay off, then reboot so the root mounts writable:

       sudo raspi-config
       # Performance Options -> Overlay File System -> disable
       sudo reboot

2. Make the change:
   - Tag mapping: the admin dashboard at `http://<pi-ip>:5000/admin`, or edit
     `puzzles/index.json` by hand (see SETUP.md, "Register RFID Tags").
   - Code: `git pull` (see "Deploying a change").
   - Calibration: `color_calibration.py`, which rewrites `color_map.json`.

3. Commit anything that must outlive a reimage. The mappings and the calibration
   are device state, not part of the base image, so an uncommitted change is as
   good as lost:

       cd ~/TargetedDrugDelivery/pi
       git add puzzles/index.json color_map.json
       git commit -m "Remap tag ..."
       git push        # if this Pi has a remote configured

4. Turn the overlay back on. This is the step that restores the unplug
   hardening, so treat it as part of the job — a Pi left with the overlay off is
   silently unprotected until someone notices:

       sudo raspi-config
       # Performance Options -> Overlay File System -> enable
       sudo reboot

5. Confirm it is back on, then run one test with a card to confirm the exhibit
   still reads and scores:

       findmnt -no FSTYPE /        # "overlay" when the read-only overlay is active

### Notes

- `mount -o remount,rw /` does not help. It appears to succeed but only writes
  into the volatile overlay, so the change still vanishes on reboot. The overlay
  has to be disabled and the Pi rebooted for a write to reach the card.
- The server writes `index.json` atomically, so a power loss can never leave it
  half-written. That is separate from the overlay problem: a dashboard save with
  the overlay on is complete and valid, and still gone at the next reboot.
  Committing is what makes it stick.
