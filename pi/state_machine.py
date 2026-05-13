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
    State.TESTING: {State.RESULTS, State.PUZZLE_LOADED},
    State.RESULTS: {State.IDLE, State.TESTING, State.PUZZLE_LOADED},
}


class ExhibitStateMachine:
    """Manages the exhibit workflow state and associated data."""

    def __init__(self):
        self.state = State.IDLE
        self.ligand_positions = None
        self.ligand_colors = None
        self.current_puzzle = None
        # Puzzle queued by a tag scan that arrived during TESTING.  Drained
        # into current_puzzle when the test ends (via restart_test or
        # complete_test) so chaotic tag-swap usage isn't silently dropped.
        self.pending_puzzle = None
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
        """Record a nanoparticle scan. Updates data in any state."""
        self.ligand_positions = ligand_positions
        self.ligand_colors = ligand_colors

        if self.state == State.IDLE:
            self.transition(State.NANOPARTICLE_SCANNED)
        return True

    def load_puzzle(self, puzzle):
        """Record a puzzle load. Valid after nanoparticle scan or after results.

        If called during TESTING, the puzzle is stored as pending and will be
        promoted to current_puzzle when the test ends.  Returns True only on
        immediate application.
        """
        if self.state in (State.NANOPARTICLE_SCANNED, State.PUZZLE_LOADED, State.RESULTS):
            self.current_puzzle = puzzle
            # Any pending puzzle is now stale — the latest scan supersedes it.
            self.pending_puzzle = None
            self.transition(State.PUZZLE_LOADED)
            return True
        if self.state == State.TESTING:
            # Tag swapped mid-test: queue the puzzle so the next exit from
            # TESTING (restart or natural complete) picks it up.
            self.pending_puzzle = puzzle
            logger.info("Puzzle queued (test in progress); will apply on exit")
        return False

    def start_test(self):
        """Begin testing. Valid only from PUZZLE_LOADED."""
        if self.state == State.PUZZLE_LOADED:
            self.test_results = None
            return self.transition(State.TESTING)
        return False

    def restart_test(self):
        """Transition TESTING → PUZZLE_LOADED so a fresh test can be started.

        Preserves current_puzzle and ligand_positions so the restart uses the
        same nanoparticle and tissue configuration without re-scanning, then
        drains any pending puzzle queued during the test.
        """
        if self.transition(State.PUZZLE_LOADED):
            self._apply_pending_puzzle()
            return True
        return False

    def complete_test(self, results):
        """Record test completion with final results."""
        if self.state == State.TESTING:
            self.test_results = results
            if self.transition(State.RESULTS):
                self._apply_pending_puzzle()
                return True
        return False

    def _apply_pending_puzzle(self):
        """Promote any queued puzzle to current_puzzle. Returns True if a swap occurred."""
        if self.pending_puzzle is not None:
            logger.info("Applying pending puzzle queued during test")
            self.current_puzzle = self.pending_puzzle
            self.pending_puzzle = None
            return True
        return False

    def reset(self):
        """Return to idle. Valid from any state."""
        old = self.state
        self.state = State.IDLE
        self.ligand_positions = None
        self.ligand_colors = None
        self.current_puzzle = None
        self.pending_puzzle = None
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
