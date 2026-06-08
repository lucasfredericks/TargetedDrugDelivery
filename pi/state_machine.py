"""Exhibit workflow state machine.

Happy path:
    IDLE → NANOPARTICLE_SCANNED → PUZZLE_LOADED → TESTING → RESULTS

Plus two cross-cutting edges available everywhere:
    * any state → IDLE          (reset: watchdog, lost clients, manual)
    * TESTING/RESULTS → PUZZLE_LOADED  (re-run with the same nanoparticle)

`TRANSITIONS` is the single source of truth: every state change goes through
`transition()`, which rejects edges not listed here.  Side effects (Socket.IO
emits) are NOT performed here — callers register an `on_change` listener and
react to (old, new) so the "what does each state notify" logic lives in one
place (see master_server._on_state_change).

Threading: this object is mutated only from the master server's single
eventlet event loop (Arduino OS-thread callbacks are marshalled onto it via
an action queue), so methods here assume cooperative, non-reentrant access
and take no locks.
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


# Valid state transitions. Every state additionally allows → IDLE (reset),
# folded in below so it doesn't have to be repeated on each line.
TRANSITIONS = {
    State.IDLE: {State.NANOPARTICLE_SCANNED},
    State.NANOPARTICLE_SCANNED: {State.PUZZLE_LOADED},
    State.PUZZLE_LOADED: {State.TESTING, State.PUZZLE_LOADED},  # self-loop: re-scan a new tag
    State.TESTING: {State.RESULTS, State.PUZZLE_LOADED},        # → PUZZLE_LOADED: restart
    State.RESULTS: {State.PUZZLE_LOADED},                       # → PUZZLE_LOADED: re-run
}
for _src in TRANSITIONS:
    TRANSITIONS[_src].add(State.IDLE)


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
        """Record a nanoparticle scan. Updates data in any state."""
        self.ligand_positions = ligand_positions
        self.ligand_colors = ligand_colors

        if self.state == State.IDLE:
            self.transition(State.NANOPARTICLE_SCANNED)
        return True

    def load_puzzle(self, puzzle):
        """Record a puzzle load. Valid after nanoparticle scan or after results."""
        if self.state in (State.NANOPARTICLE_SCANNED, State.PUZZLE_LOADED, State.RESULTS):
            self.current_puzzle = puzzle
            self.transition(State.PUZZLE_LOADED)
            return True
        return False

    def start_test(self):
        """Begin testing. Valid only from PUZZLE_LOADED."""
        if self.state == State.PUZZLE_LOADED:
            self.test_results = None
            return self.transition(State.TESTING)
        return False

    def restart_test(self):
        """Step back to PUZZLE_LOADED to re-run a test. Valid from TESTING or RESULTS.

        Preserves current_puzzle and ligand_positions so the re-run uses the
        same nanoparticle and tissue configuration without re-scanning.
        """
        return self.transition(State.PUZZLE_LOADED)

    def complete_test(self, results):
        """Record test completion with final results."""
        if self.state == State.TESTING:
            self.test_results = results
            return self.transition(State.RESULTS)
        return False

    def reset(self):
        """Return to idle from any state, clearing all session data."""
        self.ligand_positions = None
        self.ligand_colors = None
        self.current_puzzle = None
        self.test_results = None
        self.transition(State.IDLE)

    def get_status(self):
        """Return current state and data as a serializable dict."""
        return {
            "state": self.state.name,
            "ligandPositions": self.ligand_positions,
            "ligandColors": self.ligand_colors,
            "puzzle": self.current_puzzle,
            "results": self.test_results
        }
