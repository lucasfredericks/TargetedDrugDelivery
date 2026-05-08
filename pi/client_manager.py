"""Manages connected simulation client computers and tissue assignments."""

import logging

logger = logging.getLogger(__name__)


class ClientManager:
    """Tracks connected simulation clients and assigns tissues dynamically.

    During a test the manager is *locked*: tissue assignments are frozen and
    only the clients that were active when the test started are tracked for
    completion.  Clients that connect or disconnect while locked do not
    trigger a reassignment, which prevents mid-test stats corruption.
    """

    def __init__(self):
        # sid → client info dict
        self.clients = {}
        # Set of sids that must send test_complete for the test to finish.
        # Populated by lock(); cleared by unlock().
        self._expected_completers = set()
        self._locked = False

    # ------------------------------------------------------------------
    # Test lifecycle
    # ------------------------------------------------------------------

    def lock(self):
        """Snapshot active clients as expected completers; freeze assignments."""
        self._locked = True
        self._expected_completers = {
            sid for sid, c in self.clients.items() if c["assigned_tissues"]
        }
        logger.info(
            "Test locked with %d expected completer(s): %s",
            len(self._expected_completers),
            self._expected_completers,
        )

    def unlock(self):
        """Unfreeze assignments so new clients are incorporated normally."""
        self._locked = False
        self._expected_completers = set()

    @property
    def expected_completer_count(self):
        return len(self._expected_completers)

    # ------------------------------------------------------------------
    # Connection management
    # ------------------------------------------------------------------

    def register(self, sid, info=None):
        """Register a new client connection."""
        self.clients[sid] = {
            "sid": sid,
            "info": info or {},
            "assigned_tissues": [],
            "status": "connected",
            "last_stats": None,
        }
        if not self._locked:
            self._reassign_tissues()
        else:
            # Mid-test observer: no tissue assignment, not tracked for completion.
            logger.info(
                "Client %s registered mid-test (observer only, total: %d)",
                sid, len(self.clients),
            )

    def unregister(self, sid):
        """Remove a disconnected client."""
        if sid not in self.clients:
            return
        del self.clients[sid]
        if self._locked:
            # Remove from completion tracking so the test can still finish.
            if sid in self._expected_completers:
                self._expected_completers.discard(sid)
                logger.warning(
                    "Expected completer %s disconnected mid-test (%d remaining)",
                    sid, len(self._expected_completers),
                )
        else:
            self._reassign_tissues()
        logger.info("Client unregistered: %s (total: %d)", sid, len(self.clients))

    def _reassign_tissues(self):
        """Distribute 4 tissues evenly across connected clients."""
        sids = list(self.clients.keys())
        n = len(sids)
        if n == 0:
            return
        tissues = [0, 1, 2, 3]
        for i, sid in enumerate(sids):
            assigned = [t for t in tissues if t % n == i]
            self.clients[sid]["assigned_tissues"] = assigned
            logger.info("Client %s assigned tissues: %s", sid, assigned)

    # ------------------------------------------------------------------
    # Test tracking
    # ------------------------------------------------------------------

    def get_assignment(self, sid):
        """Get tissue indices assigned to a client."""
        client = self.clients.get(sid)
        return client["assigned_tissues"] if client else []

    def update_stats(self, sid, stats):
        """Store the latest stats from a client."""
        if sid in self.clients:
            self.clients[sid]["last_stats"] = stats

    def mark_complete(self, sid):
        """Mark a client as having completed its test."""
        if sid in self.clients:
            self.clients[sid]["status"] = "complete"

    def all_complete(self):
        """Return True when every expected completer has sent test_complete.

        Uses the snapshot taken at lock() time, so mid-test disconnects
        (which call unregister → _expected_completers.discard) don't block
        completion indefinitely.
        """
        if not self._expected_completers:
            return False
        return all(
            self.clients.get(sid, {}).get("status") == "complete"
            for sid in self._expected_completers
        )

    def no_completers_left(self):
        """True when all expected completers have disconnected without finishing."""
        return self._locked and len(self._expected_completers) == 0

    def reset_all(self):
        """Reset all clients to connected status for a new test."""
        for client in self.clients.values():
            client["status"] = "connected"
            client["last_stats"] = None

    # ------------------------------------------------------------------
    # Stats
    # ------------------------------------------------------------------

    def get_aggregated_stats(self):
        """Collect latest stats from all clients into a single list."""
        all_stats = []
        for client in self.clients.values():
            if client["last_stats"]:
                all_stats.extend(client["last_stats"])
        all_stats.sort(key=lambda s: s.get("tissueIndex", 0))
        return all_stats

    def get_all_sids(self):
        """Return list of all connected client session IDs."""
        return list(self.clients.keys())

    @property
    def count(self):
        return len(self.clients)
