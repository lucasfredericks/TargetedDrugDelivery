"""RFID reader service for loading puzzle configurations.

Reads MFRC522 RFID tags via SPI and looks up puzzle configs by tag UID.
No data needs to be written to the tags — the factory UID is used as the key
into a local JSON mapping (puzzles/index.json).

Uses the Sunfounder MFRC522 module connected to the Sparkfun Qwiic pHAT SPI pins.

Requires the Pi 5-compatible MFRC522 fork (uses gpiozero instead of RPi.GPIO):
    pip install git+https://github.com/Dennis-89/MFRC522-python-SimpleMFRC522.git

Wiring (Qwiic pHAT → MFRC522):
    MOSI → MOSI
    MISO → MISO
    SCK  → SCK
    CS   → SDA (chip select, labeled SDA on the MFRC522 module)
    D6   → RST
    3.3V → 3.3V
    GND  → GND
"""

import json
import os
import logging

from config import (
    PUZZLES_DIR, PUZZLES_INDEX_PATH,
    RFID_RST_PIN, RFID_SPI_BUS, RFID_SPI_DEVICE
)

logger = logging.getLogger(__name__)


class RFIDService:
    """Reads RFID tags and resolves puzzle configurations."""

    def __init__(self):
        self.puzzle_index = {}
        self.reader = None

    def initialize(self):
        """Load puzzle index and prepare RFID reader.

        Creates SimpleMFRC522, then replaces its internal MFRC522 instance
        with one configured for our custom RST pin (SimpleMFRC522's
        constructor doesn't expose pin_rst).
        """
        self._load_puzzle_index()
        try:
            from mfrc522 import MFRC522, SimpleMFRC522
            self.reader = SimpleMFRC522()
            # Replace the default MFRC522 with one using our RST pin
            self.reader.reader = MFRC522(
                bus=RFID_SPI_BUS,
                device=RFID_SPI_DEVICE,
                pin_rst=RFID_RST_PIN
            )
            logger.info("RFID reader initialized (RST=GPIO%d, SPI%d.%d)",
                        RFID_RST_PIN, RFID_SPI_BUS, RFID_SPI_DEVICE)
        except Exception as e:
            logger.error("Failed to initialize RFID reader: %s", e)
            self.reader = None

    def _load_puzzle_index(self):
        """Load the tag UID → puzzle file mapping.

        The index maps string UIDs to puzzle filenames, e.g.:
            { "123456789": "puzzle-example-01.json" }
        """
        if not os.path.exists(PUZZLES_INDEX_PATH):
            logger.warning("Puzzle index not found at %s", PUZZLES_INDEX_PATH)
            self.puzzle_index = {}
            return

        with open(PUZZLES_INDEX_PATH, "r") as f:
            self.puzzle_index = json.load(f)
        logger.info("Loaded puzzle index with %d entries", len(self.puzzle_index))

    def read_tag(self):
        """Block until an RFID tag is read. Returns (tag_id, tag_text) or (None, None)."""
        if self.reader is None:
            logger.error("RFID reader not initialized")
            return None, None

        try:
            tag_id, text = self.reader.read()
            text = text.strip() if text else ""
            logger.info("RFID tag read: id=%s text='%s'", tag_id, text)
            return tag_id, text
        except Exception as e:
            logger.error("RFID read error: %s", e)
            return None, None

    def read_tag_no_block(self):
        """Non-blocking tag read. Returns (tag_id, tag_text) or (None, None)."""
        if self.reader is None:
            return None, None

        try:
            tag_id, text = self.reader.read_no_block()
            if tag_id is not None:
                text = text.strip() if text else ""
                logger.info("RFID tag detected: id=%s text='%s'", tag_id, text)
            return tag_id, text
        except Exception:
            return None, None

    def lookup_puzzle(self, tag_id):
        """Look up a puzzle config by tag UID.

        Returns the puzzle dict or None if not found.
        """
        uid_key = str(tag_id)
        if uid_key not in self.puzzle_index:
            logger.warning("Unknown tag UID: %s", uid_key)
            return None

        puzzle_file = self.puzzle_index[uid_key]
        puzzle_path = os.path.join(PUZZLES_DIR, puzzle_file)

        if not os.path.exists(puzzle_path):
            logger.error("Puzzle file not found: %s", puzzle_path)
            return None

        with open(puzzle_path, "r") as f:
            puzzle = json.load(f)

        logger.info("Loaded puzzle for UID %s from %s", uid_key, puzzle_file)
        return puzzle

    def scan_and_load(self):
        """Read a tag and return the associated puzzle config.

        Returns (puzzle_id, puzzle_dict) or (None, None).
        """
        tag_id, _ = self.read_tag()
        if tag_id is None:
            return None, None

        puzzle = self.lookup_puzzle(tag_id)
        return str(tag_id), puzzle
