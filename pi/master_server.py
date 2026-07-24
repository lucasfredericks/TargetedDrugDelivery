"""Master server for the Targeted Drug Delivery exhibit.

Coordinates hardware I/O, simulation clients, and the results display.
  - Color sensors: Pi I2C via TCA9548A multiplexer + 6x APDS-9960
  - RFID + button: Arduino Uno with Adafruit PN532 shield over USB serial

Usage:
    python master_server.py                        # Default
    python master_server.py --serial /dev/ttyACM0  # Arduino on specific port
    python master_server.py --no-hardware          # No hardware (display/network only)
"""

import argparse
import json as _json
import logging
import os
import queue
import sys
import threading
import time

from flask import Flask, render_template, jsonify, request, send_from_directory
from flask_socketio import SocketIO, emit

from config import SERVER_HOST, SERVER_PORT, DEFAULT_PARTICLE_COUNT, DEFAULT_TOXICITY
from state_machine import ExhibitStateMachine, State
from client_manager import ClientManager

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s"
)
logger = logging.getLogger(__name__)

# Flask + Socket.IO app
app = Flask(__name__)
app.config["SECRET_KEY"] = "tdd-exhibit"
# ping_timeout is generous because sim clients run a CPU-heavy p5.js draw loop
# that can block the browser main thread at peak particle load. With the default
# 20s timeout, that jank was read as a disconnect, dropping every client at once
# mid-test and tripping the "all clients lost" auto-reset. 60s tolerates the
# stall; the client still reconnects quickly if it truly drops.
socketio = SocketIO(
    app,
    cors_allowed_origins="*",
    async_mode="eventlet",
    ping_interval=25,
    ping_timeout=60,
)

# Core services
state_machine = ExhibitStateMachine()
client_manager = ClientManager()

# Hardware services (initialized in main)
sensor_service = None     # Pi I2C color sensors
arduino_rfid = None       # Arduino PN532 RFID + start button
_sensor_lock = threading.Lock()  # Prevents concurrent I2C reads from multiple threads
_action_queue = queue.Queue()    # OS threads enqueue; eventlet greenlet dispatches

# Button debounce: ignore repeat presses within this window.
_BUTTON_DEBOUNCE_SECS = 2.0
_last_test_action_time = 0.0


# --- HTTP Routes ---

@app.route("/")
def index():
    """Redirect to display page."""
    return render_template("display.html")


_SIM_DIR = os.path.join(os.path.dirname(__file__), "..", "concept_development", "simulation_prototype")

@app.route("/sim")
def sim_redirect():
    """Redirect /sim to /sim/ so relative paths in index.html resolve correctly."""
    from flask import redirect, request as req
    return redirect(req.url.replace("/sim", "/sim/", 1), code=301)

@app.route("/sim/")
def sim_index():
    """Serve the simulation prototype index page."""
    return send_from_directory(_SIM_DIR, "index.html")

@app.route("/sim/<path:filename>")
def sim_files(filename):
    """Serve simulation prototype static files."""
    return send_from_directory(_SIM_DIR, filename)


@app.route("/status")
def status():
    """Return current exhibit state as JSON (for debugging)."""
    return jsonify({
        **state_machine.get_status(),
        "clients": client_manager.count
    })


# --- Admin Routes ---

@app.route("/admin")
def admin():
    """Tag-to-puzzle mapping admin page."""
    return render_template("admin.html")


@app.route("/admin/api/puzzles")
def admin_list_puzzles():
    """List available puzzle JSON files."""
    import glob as _glob
    from config import PUZZLES_DIR
    files = sorted([
        os.path.basename(f)
        for f in _glob.glob(os.path.join(PUZZLES_DIR, "*.json"))
        if os.path.basename(f) != "index.json"
    ])
    return jsonify(files)


@app.route("/admin/api/tags", methods=["GET"])
def admin_get_tags():
    """Return current tag-to-puzzle mappings."""
    raw = _load_puzzle_index_raw()
    return jsonify({k: v for k, v in raw.items() if not k.startswith("_")})


@app.route("/admin/api/tags", methods=["POST"])
def admin_save_tag():
    """Add or update a tag mapping. Body: {"uid": "...", "puzzle": "filename.json"}"""
    data = request.get_json()
    uid = (data.get("uid") or "").strip()
    puzzle = (data.get("puzzle") or "").strip()
    if not uid or not puzzle:
        return jsonify({"error": "uid and puzzle required"}), 400
    raw = _load_puzzle_index_raw()
    mappings = {k: v for k, v in raw.items() if not k.startswith("_")}
    mappings[uid] = puzzle
    _save_puzzle_index(mappings)
    if arduino_rfid:
        arduino_rfid.reload_puzzle_index()
    return jsonify({"ok": True})


@app.route("/admin/api/tags/<path:uid>", methods=["DELETE"])
def admin_delete_tag(uid):
    """Remove a tag mapping by UID."""
    raw = _load_puzzle_index_raw()
    mappings = {k: v for k, v in raw.items() if not k.startswith("_")}
    if uid not in mappings:
        return jsonify({"error": "not found"}), 404
    del mappings[uid]
    _save_puzzle_index(mappings)
    if arduino_rfid:
        arduino_rfid.reload_puzzle_index()
    return jsonify({"ok": True})


def _load_puzzle_index_raw():
    from config import PUZZLES_INDEX_PATH
    if not os.path.exists(PUZZLES_INDEX_PATH):
        return {}
    with open(PUZZLES_INDEX_PATH) as f:
        return _json.load(f)


def _save_puzzle_index(mappings):
    from config import PUZZLES_INDEX_PATH
    with open(PUZZLES_INDEX_PATH, "w") as f:
        _json.dump(mappings, f, indent=2)


# --- Socket.IO: Simulation Client Events ---

@socketio.on("connect")
def handle_connect():
    logger.info("Client connected: %s", _sid())


@socketio.on("disconnect")
def handle_disconnect():
    sid = _sid()
    was_expected = client_manager.is_expected_completer(sid)
    client_manager.unregister(sid)
    logger.info("Client disconnected: %s", sid)
    _emit_to_display("client_count", {"count": client_manager.count})
    # If an expected completer dropped, check whether the test can finish or must reset.
    if state_machine.state == State.TESTING and was_expected:
        _check_test_done()


@socketio.on("register_client")
def handle_register(data):
    """Simulation client registers and receives its tissue assignment."""
    from flask_socketio import join_room
    sid = _sid()
    join_room("sim_clients")
    client_manager.register(sid, data)
    assignment = client_manager.get_assignment(sid)
    emit("assignment", {"tissueIndices": assignment})

    # Push current puzzle/ligand state so the client displays the right config
    # immediately rather than waiting for the next sensor poll cycle.
    # Works for both idle and mid-test arrivals: mid-test clients have no
    # tissue assignment so they show idle cells with the correct receptors.
    if state_machine.ligand_positions is not None or state_machine.current_puzzle is not None:
        emit("ligand_update", {
            "ligandPositions": state_machine.ligand_positions,
            "puzzle": state_machine.current_puzzle,
        })

    _emit_to_display("client_count", {"count": client_manager.count})
    logger.info("Client %s assigned tissues: %s", sid, assignment)


@socketio.on("stats_update")
def handle_stats_update(data):
    """Receive periodic stats from a simulation client."""
    sid = _sid()
    stats = data.get("stats", [])
    client_manager.update_stats(sid, stats)

    # Aggregate and forward to display
    all_stats = client_manager.get_aggregated_stats()
    _emit_to_display("results_update", {"allStats": all_stats})


@socketio.on("test_complete")
def handle_test_complete(data):
    """A simulation client has finished its test."""
    if state_machine.state != State.TESTING:
        return  # Stale completion after a reset or timeout — ignore.
    sid = _sid()
    final_stats = data.get("finalStats", [])
    client_manager.update_stats(sid, final_stats)
    client_manager.mark_complete(sid)
    _check_test_done()


# --- Socket.IO: Display Events ---

@socketio.on("join_display")
def handle_join_display():
    """Display page registers to receive exhibit updates."""
    from flask_socketio import join_room
    join_room("display")
    # Send current state
    emit("state_sync", state_machine.get_status())
    # The client count is otherwise only pushed when it changes, and those emits
    # go to the display room — so any sim client that registered before this page
    # joined was missed and the footer would sit at the template's 0 until the
    # next connect or disconnect. On a cold boot the sim PCs usually win that
    # race, which is exactly when the count reads 0 with four screens running.
    emit("client_count", {"count": client_manager.count})
    logger.info("Display joined")


# --- Socket.IO: Admin Events ---

@socketio.on("join_admin")
def handle_join_admin():
    """Admin page registers to receive live tag scan events."""
    from flask_socketio import join_room
    join_room("admin")
    current = arduino_rfid.current_tag_uid if arduino_rfid else None
    emit("admin_state", {"current_tag": current})
    logger.info("Admin client joined")


# --- Button Actions (called from GPIO or Socket.IO) ---

def action_scan_nanoparticle():
    """Read color sensors and update nanoparticle state.

    Uses tpool.execute so the blocking I2C read + lock acquisition happens
    in a real OS thread, keeping the eventlet event loop responsive.
    """
    svc = sensor_service
    if svc is None:
        logger.warning("Sensor service not available")
        return

    from eventlet import tpool
    result = tpool.execute(_do_sensor_read, svc)
    positions = result["ligandPositions"]
    colors = result["colors"]

    state_machine.scan_nanoparticle(positions, colors)
    _emit_to_display("nanoparticle_scanned", {
        "ligandPositions": positions,
        "colors": colors,
        "raw": result["raw"]
    })
    # Push ligand positions to sim clients so they can update affinity preview
    if state_machine.state != State.TESTING:
        _broadcast_ligand_update(positions, state_machine.current_puzzle)
    logger.info("Nanoparticle scanned: %s", colors)


def action_scan_rfid(uid=None):
    """Read RFID tag and load puzzle config.

    If *uid* is provided it is used directly for the puzzle lookup,
    avoiding a race where current_tag_uid may have been cleared by
    a tag_removed event processed while a background task was pending.
    """
    svc = arduino_rfid
    if svc is None:
        logger.warning("RFID service not available")
        return

    if uid:
        puzzle = svc.lookup_puzzle(uid)
        puzzle_id = uid
    else:
        puzzle_id, puzzle = svc.scan_and_load()

    if puzzle is None:
        _emit_to_display("error", {"message": f"Unknown puzzle tag: {puzzle_id}"})
        return

    # Ensure state machine is ready — tag detection implies nanoparticle is
    # present even if the sensor poll hasn't run yet.
    if state_machine.state == State.IDLE:
        from config import NUM_SENSORS, COLOR_NONE
        state_machine.scan_nanoparticle(
            state_machine.ligand_positions or [COLOR_NONE] * NUM_SENSORS,
            state_machine.ligand_colors or ["None"] * NUM_SENSORS,
        )

    # load_puzzle transitions to PUZZLE_LOADED (→ observer emits "puzzle_loaded"
    # to the display).  It returns False when scanned mid-TESTING — in that case
    # nothing is loaded and nothing is emitted, so the display can't show a
    # puzzle that isn't actually active.
    if not state_machine.load_puzzle(puzzle):
        logger.info("Tag %s ignored in state %s", puzzle_id, state_machine.state.name)
        return

    # Push puzzle tissue config to sim clients so affinity preview updates immediately.
    _broadcast_ligand_update(state_machine.ligand_positions, puzzle)
    logger.info("Puzzle loaded: %s", puzzle_id)


def action_start_test():
    """Lock the client set and enter TESTING (which broadcasts start_test)."""
    if client_manager.count == 0:
        logger.warning("No simulation clients connected")
        _emit_to_display("error", {"message": "No simulation clients connected"})
        return

    # Snapshot expected completers BEFORE the transition: the on_change observer
    # emits start_test the instant we enter TESTING, so the lock must be in place
    # before any client can report back.
    client_manager.reset_all()
    client_manager.lock()
    if not state_machine.start_test():  # → observer emits start_test + test_started
        client_manager.unlock()
        logger.warning("Cannot start test in state: %s", state_machine.state.name)
        return

    logger.info(
        "Test started with %d client(s) (%d expected completer(s))",
        client_manager.count, client_manager.expected_completer_count,
    )


def action_restart_test():
    """Start or restart the test, handling mid-test button presses.

    Valid from TESTING, PUZZLE_LOADED, or RESULTS states.

    - TESTING: emits reset to sim clients, steps state back to PUZZLE_LOADED
      (preserving current puzzle + nanoparticle config), then starts a new test.
    - PUZZLE_LOADED: starts normally.
    - RESULTS: transitions back to PUZZLE_LOADED, then starts a new test.
    - Other states: logs a warning; no action taken.

    A 2-second debounce prevents an accidental double-press from launching
    two sequential tests.
    """
    global _last_test_action_time
    now = time.monotonic()
    if now - _last_test_action_time < _BUTTON_DEBOUNCE_SECS:
        logger.debug(
            "Button debounced (%.2fs < %.1fs threshold)",
            now - _last_test_action_time, _BUTTON_DEBOUNCE_SECS,
        )
        return
    _last_test_action_time = now

    if state_machine.state == State.TESTING:
        logger.info("Button pressed mid-test; restarting with current parameters")
        # Drop the lock so action_start_test re-snapshots completers. Stepping
        # back to PUZZLE_LOADED fires the observer, which emits "reset" to the
        # sim clients (clearing the previous run) before the new start_test.
        client_manager.unlock()
        state_machine.restart_test()
        action_start_test()

    elif state_machine.state == State.PUZZLE_LOADED:
        action_start_test()

    elif state_machine.state == State.RESULTS:
        # Repeat run with the same puzzle/nanoparticle without re-scanning.
        if state_machine.restart_test():
            action_start_test()

    else:
        logger.warning(
            "Button pressed in state %s — no puzzle/nanoparticle configured yet; ignoring",
            state_machine.state.name,
        )


def action_reset():
    """Reset exhibit to idle state."""
    client_manager.reset_all()
    client_manager.unlock()  # Re-enable tissue reassignment for the next test.
    state_machine.reset()    # → observer emits "reset" (sim) + "state_reset" (display)
    logger.info("Exhibit reset to IDLE")


# --- Socket.IO triggers for actions (allow display/debug to trigger via websocket) ---

@socketio.on("action_scan")
def handle_action_scan(_data=None):
    action_scan_nanoparticle()


@socketio.on("action_rfid")
def handle_action_rfid(_data=None):
    action_scan_rfid()


@socketio.on("action_test")
def handle_action_test(_data=None):
    action_restart_test()


@socketio.on("action_reset")
def handle_action_reset(_data=None):
    action_reset()


# --- Helpers ---

def _sid():
    from flask import request
    return request.sid


def _emit_to_display(event, data):
    """Send an event to all display clients."""
    socketio.emit(event, data, room="display")


# Signature of the last ligand_update broadcast to sim_clients, used to suppress
# identical repeats (see _broadcast_ligand_update).
_last_ligand_signature = None


def _broadcast_ligand_update(positions, puzzle):
    """Send ligand_update to all sim clients, skipping unchanged payloads.

    The sensor loop polls several times a second but the reading is almost
    always the same one it sent last time, and a sim client treats every
    ligand_update as a real change: it rebuilds its nanoparticle sprites and
    recomputes affinity.  Broadcasting only actual changes keeps that work
    proportional to what visitors do rather than to uptime.

    Suppression is safe for clients that arrive or reload later: handle_register
    pushes the current ligand/puzzle state directly to each client as it
    registers, so nobody depends on the periodic repeats to catch up.

    Returns True if the event was sent.
    """
    global _last_ligand_signature
    payload = {"ligandPositions": positions, "puzzle": puzzle}
    # Compare a serialized snapshot: the caller may hand us objects that are
    # later mutated in place, which a stored reference would not notice.
    signature = _json.dumps(payload, sort_keys=True, default=str)
    if signature == _last_ligand_signature:
        return False
    socketio.emit("ligand_update", payload, room="sim_clients")
    _last_ligand_signature = signature
    return True


def _on_state_change(old, new):
    """Map each state *entry* to its client/display notifications — the one place.

    Registered as the state machine's on_change listener, so every call to a
    state_machine.* method automatically emits the right events and the two can't
    drift apart.  Continuous data streams (sensor `ligand_update`,
    `results_update`) are intentionally NOT here — they aren't state transitions
    and stay at their call sites.

    Runs inside transition(), i.e. on the eventlet event loop, so socketio.emit
    here reliably reaches remote clients.
    """
    if new == State.IDLE:
        socketio.emit("reset", {}, room="sim_clients")
        _emit_to_display("state_reset", {})

    elif new == State.PUZZLE_LOADED:
        # A restart steps TESTING → PUZZLE_LOADED; clear the clients' prior run first.
        if old == State.TESTING:
            socketio.emit("reset", {}, room="sim_clients")
        _emit_to_display("puzzle_loaded", {"puzzle": state_machine.current_puzzle})

    elif new == State.TESTING:
        puzzle = state_machine.current_puzzle
        toxicity = puzzle.get("toxicity", DEFAULT_TOXICITY) if puzzle else DEFAULT_TOXICITY
        # Room-based emit is reliable from the event loop; carries the full config
        # so a client has everything it needs to run without a follow-up round trip.
        socketio.emit("start_test", {
            "ligandPositions": state_machine.ligand_positions,
            "toxicity": toxicity,
            "puzzle": puzzle,
            "totalParticles": DEFAULT_PARTICLE_COUNT,
        }, room="sim_clients")
        _emit_to_display("test_started", {
            "ligandPositions": state_machine.ligand_positions,
            "puzzle": puzzle,
        })

    elif new == State.RESULTS:
        _emit_to_display("test_complete", {"finalResults": state_machine.test_results})


state_machine.on_change(_on_state_change)


def _check_test_done():
    """Evaluate test completion after any client status change.

    Called when a client sends test_complete or disconnects mid-test.
    - If all expected completers are done → complete the test normally.
    - If no expected completers remain (all disconnected) → auto-reset so
      the exhibit doesn't hang indefinitely.
    """
    if state_machine.state != State.TESTING:
        return
    if client_manager.all_complete():
        all_results = client_manager.get_aggregated_stats()
        state_machine.complete_test(all_results)  # → observer emits test_complete
        logger.info("Test complete. Final results collected.")
    elif client_manager.no_completers_left():
        logger.warning("All expected completers disconnected; auto-resetting exhibit")
        _emit_to_display("error", {"message": "All simulation clients lost; exhibit reset"})
        action_reset()


# --- Background Tasks ---

def _action_dispatch_loop():
    """Eventlet greenlet that dispatches actions queued by OS threads.

    Arduino callbacks run in a plain OS thread where socketio.emit is
    unreliable for reaching remote clients.  Routing actions through this
    greenlet ensures all emits happen inside the eventlet event loop.
    """
    while True:
        socketio.sleep(0.05)
        while not _action_queue.empty():
            try:
                action = _action_queue.get_nowait()
                action()
                socketio.sleep(0)  # Yield between actions so other greenlets stay responsive.
            except queue.Empty:
                break
            except Exception as e:
                logger.error("Action dispatch error: %s", e)


def _test_watchdog_loop():
    """Eventlet greenlet: guard the test lifecycle.

    Two jobs, both on a 5s tick:
      - release slots held for clients that dropped mid-test and never came
        back, then re-check completion (an expiry can complete or reset a test);
      - auto-reset if a test exceeds TEST_TIMEOUT_SECONDS, covering stalled sim
        clients or a network failure that keeps test_complete from arriving.
    """
    from config import TEST_TIMEOUT_SECONDS, RECONNECT_GRACE_SECONDS
    test_started_at = None

    while True:
        socketio.sleep(5)

        if client_manager.expire_pending(RECONNECT_GRACE_SECONDS):
            _check_test_done()

        if state_machine.state == State.TESTING:
            if test_started_at is None:
                test_started_at = time.monotonic()
            elapsed = time.monotonic() - test_started_at
            if elapsed > TEST_TIMEOUT_SECONDS:
                logger.warning(
                    "Test watchdog: %.0fs elapsed (limit %ds); auto-resetting",
                    elapsed, TEST_TIMEOUT_SECONDS,
                )
                _emit_to_display("error", {
                    "message": f"Test timed out after {int(elapsed)}s; exhibit reset"
                })
                action_reset()
                test_started_at = None
        else:
            test_started_at = None


def _health_snapshot():
    """One-line resource summary. Best effort — never raises, never blocks."""
    parts = []
    try:
        with open("/proc/self/status") as f:
            for line in f:
                if line.startswith("VmRSS:"):
                    parts.append("rss=" + "".join(line.split()[1:]))
                    break
    except OSError:
        pass
    try:
        parts.append("fds=%d" % len(os.listdir("/proc/self/fd")))
    except OSError:
        pass
    parts.append("threads=%d" % threading.active_count())
    parts.append("clients=%d" % client_manager.count)
    if client_manager.pending_reconnect_count:
        parts.append("awaiting_reconnect=%d" % client_manager.pending_reconnect_count)
    parts.append("state=%s" % state_machine.state.name)
    return " ".join(parts)


def _health_loop():
    """Eventlet greenlet: report event-loop stalls and resource trends.

    Each tick measures how much longer the sleep actually took than it asked
    for.  That overshoot is the event loop's lag, and it is the quantity that
    matters here: while the loop is stalled the server answers no Socket.IO
    heartbeats, so a stall approaching ping_timeout drops every sim client at
    once and the exhibit resets with "All simulation clients lost".  Logging the
    lag with the memory/fd/thread numbers from the moment it ended is what
    separates a memory or I/O problem from a network one after the fact —
    without having to reproduce the fault on demand.
    """
    from config import (
        HEALTH_TICK_SECONDS, HEALTH_LAG_WARN_SECONDS, HEALTH_SUMMARY_SECONDS,
    )

    last = time.monotonic()
    window_start = last
    peak_lag = 0.0

    while True:
        socketio.sleep(HEALTH_TICK_SECONDS)
        now = time.monotonic()
        lag = (now - last) - HEALTH_TICK_SECONDS
        last = now
        peak_lag = max(peak_lag, lag)

        if lag >= HEALTH_LAG_WARN_SECONDS:
            logger.warning("Event loop stalled %.1fs | %s", lag, _health_snapshot())

        if now - window_start >= HEALTH_SUMMARY_SECONDS:
            logger.info(
                "Health: peak loop lag %.2fs over %ds | %s",
                peak_lag, int(now - window_start), _health_snapshot(),
            )
            peak_lag = 0.0
            window_start = now


def _do_sensor_read(svc):
    """Read all sensors under the lock. Runs in a real OS thread via tpool."""
    with _sensor_lock:
        return svc.read_all()


def _sensor_poll_loop():
    """Eventlet greenlet: schedule sensor reads every second and push to display.

    Uses eventlet.tpool.execute so the blocking I2C reads happen in a real OS
    thread while this greenlet yields cooperatively — keeping socketio.emit
    in the greenlet context where it works reliably.
    """
    from eventlet import tpool
    from config import NUM_SENSORS, COLOR_NONE, SENSOR_POLL_INTERVAL_SECONDS
    empty_positions = [COLOR_NONE] * NUM_SENSORS
    empty_colors = ["None"] * NUM_SENSORS
    while True:
        socketio.sleep(SENSOR_POLL_INTERVAL_SECONDS)
        svc = sensor_service
        if svc is None:
            break
        # No tag present → all slots empty, skip I2C reads
        tag_present = (arduino_rfid is not None
                       and arduino_rfid.current_tag_uid is not None)
        if not tag_present:
            _emit_to_display("nanoparticle_scanned", {
                "ligandPositions": empty_positions,
                "colors": empty_colors,
                "tagPresent": False,
            })
            continue
        try:
            result = tpool.execute(_do_sensor_read, svc)
            positions = result["ligandPositions"]
            colors = result["colors"]
            # Keep state machine in sync so start_test sends current colors
            state_machine.scan_nanoparticle(positions, colors)
            _emit_to_display("nanoparticle_scanned", {
                "ligandPositions": positions,
                "colors": colors,
                "tagPresent": True,
            })
            if state_machine.state != State.TESTING:
                _broadcast_ligand_update(positions, state_machine.current_puzzle)
        except Exception as e:
            logger.error("Sensor poll error: %s", e)


# --- Main ---

def main():
    global sensor_service, arduino_rfid

    parser = argparse.ArgumentParser(description="TDD Exhibit Master Server")
    parser.add_argument("--serial", nargs="?", const="auto",
                        help="Arduino serial port (default: auto-detect)")
    parser.add_argument("--no-hardware", action="store_true",
                        help="Skip all hardware initialization")
    parser.add_argument("--no-sensors", action="store_true",
                        help="Skip color sensor initialization")
    parser.add_argument("--no-rfid", action="store_true",
                        help="Skip RFID/Arduino initialization")
    args = parser.parse_args()

    # Start the action dispatcher greenlet — routes Arduino OS-thread
    # callbacks into the eventlet loop where socketio.emit works reliably.
    socketio.start_background_task(_action_dispatch_loop)

    # Watchdog: expire held reconnect slots; auto-reset overrunning tests.
    socketio.start_background_task(_test_watchdog_loop)

    # Health monitor: event-loop lag + resource trends over long uptimes.
    socketio.start_background_task(_health_loop)

    if args.no_hardware:
        logger.info("Running without hardware (display/network only)")

    else:
        # Color sensors via Pi I2C
        if not args.no_sensors:
            try:
                from sensor_service import SensorService
                sensor_service = SensorService()
                sensor_service.initialize()
                socketio.start_background_task(_sensor_poll_loop)
                logger.info("Color sensor service ready")
            except Exception as e:
                logger.error("Sensor init failed: %s", e)

        # RFID + button via Arduino serial
        if not args.no_rfid:
            from arduino_rfid_service import ArduinoRFIDService
            from config import SERIAL_PORT

            port = SERIAL_PORT if args.serial in (None, "auto") else args.serial
            if args.serial == "auto" or args.serial is None:
                port = _detect_arduino() or SERIAL_PORT

            arduino_rfid = ArduinoRFIDService(port=port)
            arduino_rfid.initialize()

            if arduino_rfid.ser is None:
                logger.error("Arduino not connected. Use --no-rfid to skip.")
                arduino_rfid = None
            else:
                # Callbacks fire in the Arduino reader thread (plain OS
                # thread).  socketio.emit from OS threads is unreliable for
                # remote clients, so we enqueue actions for the eventlet
                # dispatcher greenlet.
                def _on_tag(uid):
                    _action_queue.put(lambda u=uid: (
                        socketio.emit("admin_tag", {"uid": u}, room="admin"),
                        action_scan_rfid(u),
                    ))
                arduino_rfid.on_tag(_on_tag)
                # Tag removed → notify admin
                arduino_rfid.on_tag_removed(
                    lambda: _action_queue.put(
                        lambda: socketio.emit("admin_tag_removed", {}, room="admin")
                    )
                )
                # Start button → start or restart test
                arduino_rfid.on_start(
                    lambda: _action_queue.put(action_restart_test)
                )
                logger.info("Arduino RFID/button ready")

    logger.info("Starting master server on %s:%d", SERVER_HOST, SERVER_PORT)
    socketio.run(app, host=SERVER_HOST, port=SERVER_PORT)


def _detect_arduino():
    """Try to auto-detect Arduino serial port."""
    import glob
    candidates = (
        glob.glob("/dev/ttyACM*") +
        glob.glob("/dev/ttyUSB*") +
        glob.glob("COM*")
    )
    if candidates:
        logger.info("Auto-detected serial port: %s", candidates[0])
        return candidates[0]
    return None


if __name__ == "__main__":
    main()
