"""Arduino RFID + button service over USB serial.

Reads JSON lines from the Arduino (tdd_rfid firmware) to handle:
  - PN532 NFC/RFID tag detection and removal
  - Start button press

Runs a background thread to read the serial port and dispatch
callbacks registered by the master server.
"""

import json
import os
import threading
import logging
import glob

import serial

from config import PUZZLES_DIR, PUZZLES_INDEX_PATH, SERIAL_BAUD, SERIAL_TIMEOUT

logger = logging.getLogger(__name__)


class ArduinoRFIDService:
    """Manages RFID and button events from Arduino over USB serial."""

    def __init__(self, port=None):
        self.port = port
        self.ser = None
        self.puzzle_index = {}
        self.current_tag_uid = None
        self._callbacks = {
            "start": None,
            "tag": None,
            "tag_removed": None,
        }
        self._thread = None
        self._running = False

    def initialize(self):
        """Open serial connection and start listener thread."""
        self._load_puzzle_index()

        if self.port is None:
            self.port = self._detect_port()
        if self.port is None:
            logger.error("No Arduino detected")
            return

        try:
            self.ser = serial.Serial(
                self.port,
                baudrate=SERIAL_BAUD,
                timeout=SERIAL_TIMEOUT
            )
            logger.info("Arduino serial opened on %s", self.port)

            # Wait for Arduino ready message
            self._wait_for_ready()

            # Start background reader
            self._running = True
            self._thread = threading.Thread(target=self._reader_loop, daemon=True)
            self._thread.start()

        except Exception as e:
            logger.error("Failed to open serial %s: %s", self.port, e)
            self.ser = None

    def _detect_port(self):
        """Auto-detect Arduino serial port."""
        candidates = (
            glob.glob("/dev/ttyACM*") +
            glob.glob("/dev/ttyUSB*")
        )
        if candidates:
            logger.info("Auto-detected Arduino on %s", candidates[0])
            return candidates[0]
        return None

    def _wait_for_ready(self, timeout=5):
        """Wait for the Arduino 'ready' message."""
        import time
        start = time.time()
        while time.time() - start < timeout:
            try:
                line = self.ser.readline().decode("utf-8", errors="replace").strip()
                if not line:
                    continue
                msg = json.loads(line)
                if msg.get("type") == "ready":
                    logger.info("Arduino ready: %s", msg)
                    return True
                elif msg.get("type") == "error":
                    logger.error("Arduino error: %s", msg.get("msg"))
                    return False
            except (json.JSONDecodeError, UnicodeDecodeError):
                continue
        logger.warning("Arduino ready timeout after %ds", timeout)
        return False

    def _reader_loop(self):
        """Background thread: read serial lines and dispatch events."""
        while self._running:
            try:
                if self.ser is None or not self.ser.is_open:
                    break
                raw = self.ser.readline()
                if not raw:
                    continue
                line = raw.decode("utf-8", errors="replace").strip()
                if not line:
                    continue
                msg = json.loads(line)
                self._dispatch(msg)
            except json.JSONDecodeError:
                logger.debug("Non-JSON from Arduino: %s", line if 'line' in dir() else raw)
            except serial.SerialException as e:
                logger.error("Serial read error: %s", e)
                break
            except Exception as e:
                logger.error("Reader loop error: %s", e)

    def _dispatch(self, msg):
        """Handle a parsed JSON message from the Arduino."""
        msg_type = msg.get("type")

        if msg_type == "tag":
            uid = msg.get("uid", "")
            self.current_tag_uid = uid
            logger.info("RFID tag detected: %s", uid)
            cb = self._callbacks.get("tag")
            if cb:
                try:
                    cb(uid)
                except Exception as e:
                    logger.error("Tag callback error: %s", e)

        elif msg_type == "tag_removed":
            self.current_tag_uid = None
            logger.info("RFID tag removed")
            cb = self._callbacks.get("tag_removed")
            if cb:
                try:
                    cb()
                except Exception as e:
                    logger.error("Tag removed callback error: %s", e)

        elif msg_type == "button":
            btn_id = msg.get("id", "")
            logger.info("Button pressed: %s", btn_id)
            cb = self._callbacks.get(btn_id)
            if cb:
                try:
                    cb()
                except Exception as e:
                    logger.error("Button callback error: %s", e)

        elif msg_type == "error":
            logger.error("Arduino error: %s", msg.get("msg"))

    # --- Callback registration ---

    def on_start(self, callback):
        """Register callback for start button press."""
        self._callbacks["start"] = callback

    def on_tag(self, callback):
        """Register callback for tag detected. Callback receives (uid)."""
        self._callbacks["tag"] = callback

    def on_tag_removed(self, callback):
        """Register callback for tag removed."""
        self._callbacks["tag_removed"] = callback

    # --- Puzzle lookup (same interface as RFIDService) ---

    def reload_puzzle_index(self):
        """Reload tag UID → puzzle mapping from disk (call after index.json is updated)."""
        self._load_puzzle_index()

    def _load_puzzle_index(self):
        """Load tag UID → puzzle file mapping."""
        if not os.path.exists(PUZZLES_INDEX_PATH):
            logger.warning("Puzzle index not found at %s", PUZZLES_INDEX_PATH)
            self.puzzle_index = {}
            return
        with open(PUZZLES_INDEX_PATH, "r") as f:
            self.puzzle_index = json.load(f)
        logger.info("Loaded puzzle index with %d entries", len(self.puzzle_index))

    def lookup_puzzle(self, uid):
        """Look up puzzle config by tag UID string.

        Tries exact match first, then without colons, then case-insensitive.
        """
        # Exact match
        if uid in self.puzzle_index:
            return self._load_puzzle_file(self.puzzle_index[uid])

        # Without colons
        uid_compact = uid.replace(":", "")
        if uid_compact in self.puzzle_index:
            return self._load_puzzle_file(self.puzzle_index[uid_compact])

        # Case-insensitive
        uid_lower = uid.lower().replace(":", "")
        for key, val in self.puzzle_index.items():
            if key.lower().replace(":", "") == uid_lower:
                return self._load_puzzle_file(val)

        logger.warning("Unknown tag UID: %s", uid)
        return None

    def _load_puzzle_file(self, filename):
        """Load a puzzle JSON file."""
        path = os.path.join(PUZZLES_DIR, filename)
        if not os.path.exists(path):
            logger.error("Puzzle file not found: %s", path)
            return None
        with open(path, "r") as f:
            return json.load(f)

    def scan_and_load(self):
        """Return (uid, puzzle) for the currently present tag, or (None, None)."""
        if self.current_tag_uid is None:
            return None, None
        puzzle = self.lookup_puzzle(self.current_tag_uid)
        return self.current_tag_uid, puzzle

    # --- Serial commands to Arduino ---

    def request_status(self):
        """Ask Arduino for current status."""
        if self.ser and self.ser.is_open:
            self.ser.write(b'{"cmd":"status"}\n')

    # --- Cleanup ---

    def cleanup(self):
        """Stop reader thread and close serial."""
        self._running = False
        if self.ser and self.ser.is_open:
            self.ser.close()
        if self._thread:
            self._thread.join(timeout=2)
