"""RFID reader service for loading puzzle configurations.

Reads MFRC522 RFID tags via SPI and looks up puzzle configs from local JSON files.
"""

import json
import os
import logging

from config import PUZZLES_DIR, PUZZLES_INDEX_PATH

logger = logging.getLogger(__name__)

# MFRC522 import is deferred to avoid errors on non-Pi systems
_MFRC522 = None


def _get_reader():
    """Lazy-load MFRC522 reader (only works on Pi with SPI enabled)."""
    global _MFRC522
    if _MFRC522 is None:
        from mfrc522 import SimpleMFRC522
        _MFRC522 = SimpleMFRC522()
    return _MFRC522


class RFIDService:
    """Reads RFID tags and resolves puzzle configurations."""

    def __init__(self):
        self.puzzle_index = {}
        self.reader = None

    def initialize(self):
        """Load puzzle index and prepare RFID reader."""
        self._load_puzzle_index()
        try:
            self.reader = _get_reader()
            logger.info("RFID reader initialized")
        except Exception as e:
            logger.error("Failed to initialize RFID reader: %s", e)
            self.reader = None

    def _load_puzzle_index(self):
        """Load the tag ID → puzzle file mapping."""
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

    def lookup_puzzle(self, tag_text):
        """Look up a puzzle config by tag text (puzzle ID string).

        Returns the puzzle dict or None if not found.
        """
        if tag_text not in self.puzzle_index:
            logger.warning("Unknown puzzle ID: '%s'", tag_text)
            return None

        puzzle_file = self.puzzle_index[tag_text]
        puzzle_path = os.path.join(PUZZLES_DIR, puzzle_file)

        if not os.path.exists(puzzle_path):
            logger.error("Puzzle file not found: %s", puzzle_path)
            return None

        with open(puzzle_path, "r") as f:
            puzzle = json.load(f)

        logger.info("Loaded puzzle '%s' from %s", tag_text, puzzle_file)
        return puzzle

    def scan_and_load(self):
        """Read a tag and return the associated puzzle config.

        Returns (puzzle_id, puzzle_dict) or (None, None).
        """
        tag_id, tag_text = self.read_tag()
        if tag_text is None or tag_text == "":
            return None, None

        puzzle = self.lookup_puzzle(tag_text)
        return tag_text, puzzle
