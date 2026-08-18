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

The color calibration and the tag pairings are not touched by any of this. They
live in gitignored files — see "Installation state" below — so a pull cannot
overwrite them and you never have to recalibrate after a deploy.


Trying a branch on the Pi
-------------------------

Because the calibration and pairings are gitignored, switching branches is safe:
git has no tracked copy of either file on any branch, so it has nothing to
restore over them.

    cd ~/TargetedDrugDelivery
    git fetch origin
    git checkout beta          # or: git checkout main, to go back
    sudo systemctl restart tdd-exhibit

Reload the four screens if anything under `concept_development/` changed. Run
`python pi/installation_config.py status` afterwards if you want the
confirmation in writing — it reports whether both files are still present and
still ignored.

The overlay rule still applies: check out the branch with the overlay disabled,
or the checkout itself is discarded at the next reboot.

### Branches that predate this change

Only branches that carry the gitignore change are safe to hop between. On an
older branch these two files are still tracked, and git will overwrite the live
ones with the placeholders from that branch — silently, with no warning and no
prompt, because as far as git is concerned it is just checking out a tracked
file. Switching back does not undo it.

Before checking out a branch you are unsure about:

    python pi/installation_config.py save --push    # so there is a snapshot
    git checkout <branch>
    python pi/installation_config.py status         # says if the files are tracked here

If status reports `NO -- still tracked!`, the calibration and pairings on disk
came from that branch, not from this installation. Get yours back with:

    python pi/installation_config.py restore

The cheap habit that makes all of this moot: run `save` before any checkout.


Installation state
------------------

Two files belong to this specific installation rather than to the code:

    pi/color_map.json        color calibration, written by color_calibration.py
    pi/puzzles/index.json    RFID tag pairings, written by the /admin dashboard

Both are gitignored. They used to be tracked, which meant a branch switch or an
awkward pull could quietly replace a real calibration with the placeholder in
git, and recalibrating was the only way back. Now no code branch contains them
at all, so nothing git does can touch them.

That also means git is no longer backing them up, and an SD reimage would take
them with it. `installation_config.py` is the backup. It snapshots both files
onto an orphan branch, `installation-state`, checked out in a worktree beside
the repo. That branch is never merged into a code branch — it cannot cause a
conflict — but it does push to origin, so the snapshot survives a reimage and
can be read from any other clone.

Snapshots are per-hostname, so more than one device can share the branch.

    cd ~/TargetedDrugDelivery/pi

    python installation_config.py status          # what is live, is it snapshotted
    python installation_config.py save --push     # after calibrating or pairing
    python installation_config.py restore         # after a reimage or fresh clone
    python installation_config.py list            # snapshots from all devices

`save` refuses to snapshot a file that still looks like a placeholder, so it
will not overwrite good state with junk; `--force` overrides. `restore` leaves
the file it replaced beside the original as `.bak-<timestamp>`.

**Run `save` after every calibration and every tag pairing.** Nothing does it
for you, and until you do, the change exists only on that SD card.

If either file is missing, the service still starts. Tag lookups just fail until
you pair tags, and color matching falls back to `color_map.json.example` with a
loud warning in the log:

    USING EXAMPLE COLOR CALIBRATION — color_map.json not found ...

That is a fresh clone or a failed restore talking, not a sensor fault.

### Migrating a Pi that predates this

A Pi set up before this change has both files tracked with local edits, so the
first pull will conflict. Take a copy before you pull:

    cd ~/TargetedDrugDelivery
    mkdir -p ~/tdd-state-backup
    cp pi/color_map.json pi/puzzles/index.json ~/tdd-state-backup/

    git checkout -- pi/color_map.json pi/puzzles/index.json   # let the pull run clean
    git pull

    cp ~/tdd-state-backup/color_map.json pi/
    cp ~/tdd-state-backup/index.json pi/puzzles/

    python pi/installation_config.py status       # expect: calibrated, paired, ignored
    python pi/installation_config.py save --push

Do this with the overlay disabled. Once `save` has run, `~/tdd-state-backup` is
redundant and can be deleted.


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

The four simulation PCs use the same reboot-to-restore model via Deep Freeze, and
the same discipline applies to them: thaw, make the change, verify a clean boot,
re-freeze. See [../simulation_pc/SETUP.md](../simulation_pc/SETUP.md), "Deep Freeze
(reboot-to-restore)." Because the sim PCs hold no state of their own, a change
there is usually a browser update or a `tissue=`/Pi-address edit — never anything
that needs committing.

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

3. Snapshot anything that must outlive a reimage. The mappings and the
   calibration are device state, not part of the base image, and they are
   gitignored — so an unsnapshotted change is as good as lost:

       cd ~/TargetedDrugDelivery/pi
       python installation_config.py save --push -m "Remap tag ..."

   Do not try to `git add` these files on a code branch; git is ignoring them
   on purpose. See "Installation state" above.

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
  Snapshotting it with `installation_config.py save` is what makes it stick.
