"""Master server for the Targeted Drug Delivery exhibit.

Runs on the Raspberry Pi. Coordinates:
  - I2C color sensors (nanoparticle scanning)
  - RFID reader (puzzle loading)
  - GPIO buttons (user input)
  - Socket.IO hub (client simulation computers)
  - Results display (local Chromium browser)

Usage:
    python master_server.py
    python master_server.py --no-gpio    # Skip GPIO init (for testing without Pi hardware)
    python master_server.py --no-sensors # Skip sensor init
    python master_server.py --no-rfid    # Skip RFID init
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

# Optional hardware services (initialized based on CLI flags)
sensor_service = None
rfid_service = None
gpio_input = None


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
    if sensor_service is None:
        logger.warning("Sensor service not available")
        return

    result = sensor_service.read_all()
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
    if rfid_service is None:
        logger.warning("RFID service not available")
        return

    puzzle_id, puzzle = rfid_service.scan_and_load()
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
    global sensor_service, rfid_service, gpio_input

    parser = argparse.ArgumentParser(description="TDD Exhibit Master Server")
    parser.add_argument("--no-gpio", action="store_true", help="Skip GPIO initialization")
    parser.add_argument("--no-sensors", action="store_true", help="Skip sensor initialization")
    parser.add_argument("--no-rfid", action="store_true", help="Skip RFID initialization")
    args = parser.parse_args()

    # Initialize hardware services
    if not args.no_sensors:
        try:
            from sensor_service import SensorService
            sensor_service = SensorService()
            sensor_service.initialize()
            logger.info("Sensor service ready")
        except Exception as e:
            logger.error("Sensor init failed (use --no-sensors to skip): %s", e)

    if not args.no_rfid:
        try:
            from rfid_service import RFIDService
            rfid_service = RFIDService()
            rfid_service.initialize()
            logger.info("RFID service ready")
        except Exception as e:
            logger.error("RFID init failed (use --no-rfid to skip): %s", e)

    if not args.no_gpio:
        try:
            from gpio_input import GPIOInput
            gpio_input = GPIOInput()
            gpio_input.initialize()
            gpio_input.on_scan(action_scan_nanoparticle)
            gpio_input.on_test(action_start_test)
            gpio_input.on_reset(action_reset)
            logger.info("GPIO input ready")
        except Exception as e:
            logger.error("GPIO init failed (use --no-gpio to skip): %s", e)

    logger.info("Starting master server on %s:%d", SERVER_HOST, SERVER_PORT)
    socketio.run(app, host=SERVER_HOST, port=SERVER_PORT)


if __name__ == "__main__":
    main()
