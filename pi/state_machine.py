"""Exhibit workflow state machine.

States:
    IDLE → NANOPARTICLE_SCANNED → PUZZLE_LOADED → TESTING → RESULTS → IDLE
"""

import logging
from enum import Enum, auto

logger = logging.getLogger(__name__)


class State(Enum):
    IDLE = auto()
    NANOPARTICLE_SCANNED = auto()
    PUZZLE_LOADED = auto()
    TESTING = auto()
    RESULTS = auto()


# Valid state transitions
TRANSITIONS = {
    State.IDLE: {State.NANOPARTICLE_SCANNED},
    State.NANOPARTICLE_SCANNED: {State.PUZZLE_LOADED, State.NANOPARTICLE_SCANNED},
    State.PUZZLE_LOADED: {State.TESTING, State.NANOPARTICLE_SCANNED, State.PUZZLE_LOADED},
    State.TESTING: {State.RESULTS},
    State.RESULTS: {State.IDLE},
}


class ExhibitStateMachine:
    """Manages the exhibit workflow state and associated data."""

    def __init__(self):
        self.state = State.IDLE
        self.ligand_positions = None
        self.ligand_colors = None
        self.current_puzzle = None
        self.test_results = None
        self._listeners = []

    def on_change(self, callback):
        """Register a callback for state changes. Called with (old_state, new_state)."""
        self._listeners.append(callback)

    def _notify(self, old_state):
        for cb in self._listeners:
            try:
                cb(old_state, self.state)
            except Exception as e:
                logger.error("State change listener error: %s", e)

    def transition(self, new_state):
        """Attempt a state transition. Returns True if successful."""
        if new_state not in TRANSITIONS.get(self.state, set()):
            logger.warning("Invalid transition: %s → %s", self.state.name, new_state.name)
            return False

        old = self.state
        self.state = new_state
        logger.info("State: %s → %s", old.name, new_state.name)
        self._notify(old)
        return True

    def scan_nanoparticle(self, ligand_positions, ligand_colors):
        """Record a nanoparticle scan. Valid from IDLE or re-scan states."""
        if self.state in (State.IDLE, State.NANOPARTICLE_SCANNED, State.PUZZLE_LOADED):
            self.ligand_positions = ligand_positions
            self.ligand_colors = ligand_colors

            if self.state == State.IDLE:
                self.transition(State.NANOPARTICLE_SCANNED)
            # Re-scan in other states keeps current state but updates data
            return True
        return False

    def load_puzzle(self, puzzle):
        """Record a puzzle load. Valid after nanoparticle scan."""
        if self.state in (State.NANOPARTICLE_SCANNED, State.PUZZLE_LOADED):
            self.current_puzzle = puzzle
            self.transition(State.PUZZLE_LOADED)
            return True
        return False

    def start_test(self):
        """Begin testing. Valid only when both nanoparticle and puzzle are loaded."""
        if self.state == State.PUZZLE_LOADED:
            self.test_results = None
            return self.transition(State.TESTING)
        return False

    def complete_test(self, results):
        """Record test completion with final results."""
        if self.state == State.TESTING:
            self.test_results = results
            return self.transition(State.RESULTS)
        return False

    def reset(self):
        """Return to idle. Valid from any state."""
        old = self.state
        self.state = State.IDLE
        self.ligand_positions = None
        self.ligand_colors = None
        self.current_puzzle = None
        self.test_results = None
        logger.info("State: %s → IDLE (reset)", old.name)
        self._notify(old)

    def get_status(self):
        """Return current state and data as a serializable dict."""
        return {
            "state": self.state.name,
            "ligandPositions": self.ligand_positions,
            "ligandColors": self.ligand_colors,
            "puzzle": self.current_puzzle,
            "results": self.test_results
        }
