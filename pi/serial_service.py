"""Serial bridge to Arduino I/O board for the Targeted Drug Delivery exhibit.

Replaces sensor_service.py, rfid_service.py, and gpio_input.py with a single
service that communicates with the Arduino over USB serial using JSON lines.

The Arduino handles all hardware I/O (color sensors, RFID, buttons) and sends
results back as JSON. This service parses those results and exposes the same
interface that master_server.py expects.

Usage:
    service = SerialService("/dev/ttyUSB0")
    service.initialize()
    service.on_button("scan", my_callback)
    sensors = service.read_sensors()
    rfid = service.read_rfid()
"""

import json
import logging
import threading
import time

import serial

from config import (
    SERIAL_PORT, SERIAL_BAUD, SERIAL_TIMEOUT,
    LIGAND_COLORS, COLOR_NONE, COLOR_MAP_PATH
)

logger = logging.getLogger(__name__)


class SerialService:
    """Communicates with the Arduino I/O board over USB serial."""

    def __init__(self, port=None, baud=None):
        self.port = port or SERIAL_PORT
        self.baud = baud or SERIAL_BAUD
        self.ser = None
        self._button_callbacks = {}
        self._listener_thread = None
        self._running = False
        self._response_event = threading.Event()
        self._last_response = None
        self._lock = threading.Lock()

    def initialize(self):
        """Open serial connection and start background listener."""
        try:
            self.ser = serial.Serial(
                self.port, self.baud,
                timeout=SERIAL_TIMEOUT
            )
            # Wait for Arduino reset after serial open
            time.sleep(2)
            # Flush any startup messages
            while self.ser.in_waiting:
                line = self.ser.readline().decode("utf-8", errors="replace").strip()
                if line:
                    self._handle_line(line, log_only=True)

            self._running = True
            self._listener_thread = threading.Thread(
                target=self._listen, daemon=True
            )
            self._listener_thread.start()

            # Verify connection
            resp = self._send_command({"cmd": "ping"}, timeout=5)
            if resp and resp.get("type") == "pong":
                logger.info(
                    "Arduino connected on %s: %d sensors, calibrated=%s",
                    self.port, resp.get("sensors", 0), resp.get("calibrated")
                )
            else:
                logger.warning("Arduino did not respond to ping on %s", self.port)

        except Exception as e:
            logger.error("Failed to open serial port %s: %s", self.port, e)
            self.ser = None

    def _listen(self):
        """Background thread: read lines from serial and dispatch."""
        while self._running and self.ser and self.ser.is_open:
            try:
                if self.ser.in_waiting:
                    line = self.ser.readline().decode("utf-8", errors="replace").strip()
                    if line:
                        self._handle_line(line)
                else:
                    time.sleep(0.01)
            except Exception as e:
                if self._running:
                    logger.error("Serial read error: %s", e)
                    time.sleep(0.1)

    def _handle_line(self, line, log_only=False):
        """Parse a JSON line from the Arduino."""
        try:
            data = json.loads(line)
        except json.JSONDecodeError:
            logger.debug("Non-JSON from Arduino: %s", line)
            return

        msg_type = data.get("type", "")
        logger.debug("Arduino: %s", data)

        # Button events are always dispatched (unsolicited)
        if msg_type == "button" and not log_only:
            button = data.get("button")
            cb = self._button_callbacks.get(button)
            if cb:
                try:
                    cb()
                except Exception as e:
                    logger.error("Button callback error (%s): %s", button, e)
            return

        # All other messages are responses to commands
        self._last_response = data
        self._response_event.set()

    def _send_command(self, cmd_dict, timeout=10):
        """Send a JSON command and wait for the response."""
        if self.ser is None or not self.ser.is_open:
            logger.error("Serial port not open")
            return None

        with self._lock:
            self._response_event.clear()
            self._last_response = None

            line = json.dumps(cmd_dict) + "\n"
            self.ser.write(line.encode("utf-8"))
            self.ser.flush()

            if self._response_event.wait(timeout=timeout):
                return self._last_response
            else:
                logger.warning("Timeout waiting for response to: %s", cmd_dict.get("cmd"))
                return None

    # --- Public API: Sensors (matches sensor_service interface) ---

    def read_sensors(self):
        """Read all 6 color sensors. Returns dict matching SensorService.read_all()."""
        resp = self._send_command({"cmd": "read_sensors"})
        if resp and resp.get("type") == "sensors":
            return {
                "ligandPositions": resp.get("ligandPositions", [-1] * 6),
                "colors": resp.get("colors", ["None"] * 6),
                "raw": resp.get("raw", [None] * 6),
            }
        return {
            "ligandPositions": [-1] * 6,
            "colors": ["None"] * 6,
            "raw": [None] * 6,
        }

    def read_all(self):
        """Alias for read_sensors() — drop-in for SensorService.read_all()."""
        return self.read_sensors()

    # --- Public API: RFID (matches rfid_service interface) ---

    def read_rfid(self):
        """Poll RFID reader once. Returns (tag_id, text) or (None, None)."""
        resp = self._send_command({"cmd": "read_rfid"}, timeout=3)
        if resp and resp.get("type") == "rfid":
            tag_id = resp.get("tag_id")
            text = resp.get("text", "")
            return tag_id, text
        return None, None

    def scan_and_load(self):
        """Read RFID tag and return puzzle config. Matches RFIDService.scan_and_load()."""
        tag_id, _ = self.read_rfid()
        if tag_id is None:
            return None, None

        puzzle = self.lookup_puzzle(tag_id)
        return str(tag_id), puzzle

    def lookup_puzzle(self, tag_id):
        """Look up puzzle config by tag UID."""
        import os
        from config import PUZZLES_DIR, PUZZLES_INDEX_PATH

        if not os.path.exists(PUZZLES_INDEX_PATH):
            logger.warning("Puzzle index not found at %s", PUZZLES_INDEX_PATH)
            return None

        with open(PUZZLES_INDEX_PATH, "r") as f:
            index = json.load(f)

        uid_key = str(tag_id)
        if uid_key not in index:
            logger.warning("Unknown tag UID: %s", uid_key)
            return None

        puzzle_file = index[uid_key]
        puzzle_path = os.path.join(PUZZLES_DIR, puzzle_file)

        if not os.path.exists(puzzle_path):
            logger.error("Puzzle file not found: %s", puzzle_path)
            return None

        with open(puzzle_path, "r") as f:
            return json.load(f)

    # --- Public API: Buttons (matches gpio_input interface) ---

    def on_button(self, name, callback):
        """Register a callback for a button event."""
        self._button_callbacks[name] = callback

    def on_scan(self, callback):
        """Register callback for scan button. Matches GPIOInput.on_scan()."""
        self.on_button("scan", callback)

    def on_test(self, callback):
        """Register callback for test button. Matches GPIOInput.on_test()."""
        self.on_button("test", callback)

    def on_reset(self, callback):
        """Register callback for reset button. Matches GPIOInput.on_reset()."""
        self.on_button("reset", callback)

    # --- Public API: Calibration ---

    def calibrate_sample(self, channel):
        """Take calibration sample from one sensor. Returns raw RGBC+prox dict."""
        resp = self._send_command(
            {"cmd": "calibrate_sample", "channel": channel},
            timeout=15
        )
        if resp and resp.get("type") == "calibration_sample":
            return resp
        return None

    def calibrate_save(self, calibration_data):
        """Send calibration data to Arduino for EEPROM storage."""
        resp = self._send_command(
            {"cmd": "calibrate_save", "data": calibration_data},
            timeout=10
        )
        return resp and resp.get("type") == "calibration_saved"

    def calibrate_load(self):
        """Load calibration data from Arduino EEPROM."""
        resp = self._send_command({"cmd": "calibrate_load"}, timeout=5)
        if resp and resp.get("type") == "calibration" and resp.get("valid"):
            return resp
        return None

    # --- Cleanup ---

    def cleanup(self):
        """Stop listener and close serial port."""
        self._running = False
        if self.ser and self.ser.is_open:
            self.ser.close()
        logger.info("Serial service closed")
