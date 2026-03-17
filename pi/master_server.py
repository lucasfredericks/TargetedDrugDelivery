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
import logging
import sys

from flask import Flask, render_template, jsonify
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
socketio = SocketIO(app, cors_allowed_origins="*", async_mode="eventlet")

# Core services
state_machine = ExhibitStateMachine()
client_manager = ClientManager()

# Hardware services (initialized in main)
sensor_service = None     # Pi I2C color sensors
arduino_rfid = None       # Arduino PN532 RFID + start button


# --- HTTP Routes ---

@app.route("/")
def index():
    """Redirect to display page."""
    return render_template("display.html")


@app.route("/status")
def status():
    """Return current exhibit state as JSON (for debugging)."""
    return jsonify({
        **state_machine.get_status(),
        "clients": client_manager.count
    })


# --- Socket.IO: Simulation Client Events ---

@socketio.on("connect")
def handle_connect():
    logger.info("Client connected: %s", _sid())


@socketio.on("disconnect")
def handle_disconnect():
    sid = _sid()
    client_manager.unregister(sid)
    logger.info("Client disconnected: %s", sid)
    # Notify display of client count change
    _emit_to_display("client_count", {"count": client_manager.count})


@socketio.on("register_client")
def handle_register(data):
    """Simulation client registers and receives its tissue assignment."""
    sid = _sid()
    client_manager.register(sid, data)
    assignment = client_manager.get_assignment(sid)
    emit("assignment", {"tissueIndices": assignment})
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
    sid = _sid()
    final_stats = data.get("finalStats", [])
    client_manager.update_stats(sid, final_stats)
    client_manager.mark_complete(sid)

    if client_manager.all_complete():
        all_results = client_manager.get_aggregated_stats()
        state_machine.complete_test(all_results)
        _emit_to_display("test_complete", {"finalResults": all_results})
        logger.info("All clients complete. Final results collected.")


# --- Socket.IO: Display Events ---

@socketio.on("join_display")
def handle_join_display():
    """Display page registers to receive exhibit updates."""
    from flask_socketio import join_room
    join_room("display")
    # Send current state
    emit("state_sync", state_machine.get_status())
    logger.info("Display joined")


# --- Button Actions (called from GPIO or Socket.IO) ---

def action_scan_nanoparticle():
    """Read color sensors and update nanoparticle state."""
    svc = sensor_service
    if svc is None:
        logger.warning("Sensor service not available")
        return

    result = svc.read_all()
    positions = result["ligandPositions"]
    colors = result["colors"]

    state_machine.scan_nanoparticle(positions, colors)
    _emit_to_display("nanoparticle_scanned", {
        "ligandPositions": positions,
        "colors": colors,
        "raw": result["raw"]
    })
    logger.info("Nanoparticle scanned: %s", colors)


def action_scan_rfid():
    """Read RFID tag and load puzzle config."""
    svc = arduino_rfid
    if svc is None:
        logger.warning("RFID service not available")
        return

    puzzle_id, puzzle = svc.scan_and_load()
    if puzzle is None:
        _emit_to_display("error", {"message": f"Unknown puzzle tag: {puzzle_id}"})
        return

    state_machine.load_puzzle(puzzle)
    _emit_to_display("puzzle_loaded", {"puzzleId": puzzle_id, "puzzle": puzzle})
    logger.info("Puzzle loaded: %s", puzzle_id)


def action_start_test():
    """Send test command to all connected simulation clients."""
    if not state_machine.start_test():
        logger.warning("Cannot start test in state: %s", state_machine.state.name)
        return

    if client_manager.count == 0:
        logger.warning("No simulation clients connected")
        state_machine.reset()
        _emit_to_display("error", {"message": "No simulation clients connected"})
        return

    client_manager.reset_all()

    # Send test config to each client with its tissue assignment
    puzzle = state_machine.current_puzzle
    toxicity = puzzle.get("toxicity", DEFAULT_TOXICITY) if puzzle else DEFAULT_TOXICITY

    for sid in client_manager.get_all_sids():
        assignment = client_manager.get_assignment(sid)
        socketio.emit("start_test", {
            "ligandPositions": state_machine.ligand_positions,
            "toxicity": toxicity,
            "puzzle": puzzle,
            "totalParticles": DEFAULT_PARTICLE_COUNT,
            "assignment": {"tissueIndices": assignment}
        }, to=sid)

    _emit_to_display("test_started", {
        "ligandPositions": state_machine.ligand_positions,
        "puzzle": puzzle
    })
    logger.info("Test started with %d clients", client_manager.count)


def action_reset():
    """Reset exhibit to idle state."""
    state_machine.reset()
    client_manager.reset_all()

    # Tell clients to reset
    socketio.emit("reset", {}, broadcast=True)
    _emit_to_display("state_reset", {})
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
    action_start_test()


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

    if args.no_hardware:
        logger.info("Running without hardware (display/network only)")

    else:
        # Color sensors via Pi I2C
        if not args.no_sensors:
            try:
                from sensor_service import SensorService
                sensor_service = SensorService()
                sensor_service.initialize()
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
                # Tag detected → load puzzle
                arduino_rfid.on_tag(lambda uid: action_scan_rfid())
                # Start button → scan sensors then start test
                arduino_rfid.on_start(action_start_test)
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
