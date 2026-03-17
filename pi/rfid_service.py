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

        Tries hardware SPI first. If the MFRC522 doesn't respond (version
        register reads 0x00 or 0xFF), falls back to software bit-bang SPI
        using the same GPIO pins.
        """
        self._load_puzzle_index()
        try:
            from mfrc522 import MFRC522, SimpleMFRC522
            self.reader = SimpleMFRC522()
            self.reader.reader = MFRC522(
                bus=RFID_SPI_BUS,
                device=RFID_SPI_DEVICE,
                pin_rst=RFID_RST_PIN
            )

            # Verify hardware SPI works by reading the version register
            mfrc = self.reader.reader
            read_reg = getattr(mfrc, 'read_mfrc522', None) or getattr(mfrc, 'Read_MFRC522', None)
            version = read_reg(0x37) if read_reg else 0
            if version not in (0x00, 0xFF):
                logger.info("RFID reader initialized via hardware SPI (version=0x%02X)", version)
                return

            # Hardware SPI failed — try software SPI
            logger.warning("Hardware SPI not working (version=0x%02X), trying software SPI", version)
            self._init_soft_spi()

        except Exception as e:
            logger.error("Failed to initialize RFID reader: %s", e)
            self.reader = None

    def _init_soft_spi(self):
        """Initialize MFRC522 using software bit-bang SPI."""
        try:
            from mfrc522 import MFRC522, SimpleMFRC522
            from soft_spi import SoftSPI

            soft = SoftSPI(cs=8, sck=11, mosi=10, miso=9, speed=50000)
            self.reader = SimpleMFRC522()
            self.reader.reader = MFRC522(pin_rst=RFID_RST_PIN)
            # Replace the hardware spidev with our software SPI
            self.reader.reader.spi = soft

            # Re-initialize the MFRC522 with software SPI
            init_fn = getattr(self.reader.reader, 'mfrc522_init', None) or \
                      getattr(self.reader.reader, 'MFRC522_Init', None)
            if init_fn:
                init_fn()

            read_reg = getattr(self.reader.reader, 'read_mfrc522', None) or \
                       getattr(self.reader.reader, 'Read_MFRC522', None)
            version = read_reg(0x37) if read_reg else 0
            logger.info("RFID reader initialized via software SPI (version=0x%02X)", version)
        except Exception as e:
            logger.error("Software SPI fallback failed: %s", e)
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
