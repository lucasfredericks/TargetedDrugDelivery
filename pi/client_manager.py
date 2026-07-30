"""Manages connected simulation client computers and tissue assignments."""

import logging
import time

logger = logging.getLogger(__name__)


class ClientManager:
    """Tracks connected simulation clients and assigns tissues dynamically.

    During a test the manager is *locked*: tissue assignments are frozen and
    only the clients that were active when the test started are tracked for
    completion.  Clients that connect or disconnect while locked do not
    trigger a reassignment, which prevents mid-test stats corruption.

    A locked client that drops does not forfeit its place immediately: its slot
    is held so the same screen can reclaim it when its Socket.IO client
    reconnects, which it does on its own.  Only expire_pending() gives up.
    """

    def __init__(self):
        # sid → client info dict
        self.clients = {}
        # Set of sids that must send test_complete for the test to finish.
        # Populated by lock(); cleared by unlock().
        self._expected_completers = set()
        self._locked = False
        # sid → slot held for an expected completer that dropped mid-test. The
        # sid stays in _expected_completers while held, so the exhibit doesn't
        # reset out from under a client that is about to reconnect.
        self._pending_reconnect = {}

    # ------------------------------------------------------------------
    # Test lifecycle
    # ------------------------------------------------------------------

    def lock(self):
        """Snapshot active clients as expected completers; freeze assignments.

        Reassign first so every currently-connected client holds a tissue.
        Assignment is otherwise only refreshed reactively when a client
        registers or unregisters while unlocked, so a client can be connected
        yet unassigned — e.g. it joined mid-test as an observer and stayed on
        across the test boundary (unlock does not reassign). Without this, a
        fresh test could lock with 0 expected completers despite clients being
        present, and the first test_complete would trip the "all clients lost"
        auto-reset. This runs at test start, when every connected client is a
        legitimate participant, so reassigning here is always correct.
        """
        self._reassign_tissues()
        self._locked = True
        self._pending_reconnect = {}
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
        self._pending_reconnect = {}

    def expire_pending(self, grace_seconds):
        """Give up on held slots whose grace period has run out.

        Returns the sids released.  An expiry can be what finally settles a
        test — the remaining clients may all be done, or none may be left — so
        callers should re-check completion when this returns anything.
        """
        if not self._pending_reconnect:
            return []

        now = time.monotonic()
        expired = [
            sid for sid, slot in self._pending_reconnect.items()
            if now - slot["since"] >= grace_seconds
        ]
        for sid in expired:
            del self._pending_reconnect[sid]
            self._expected_completers.discard(sid)
            logger.warning(
                "Gave up on %s: no reconnect within %ss (%d completer(s) left)",
                sid, grace_seconds, len(self._expected_completers),
            )
        return expired

    @property
    def expected_completer_count(self):
        return len(self._expected_completers)

    @property
    def pending_reconnect_count(self):
        return len(self._pending_reconnect)

    def is_expected_completer(self, sid):
        """True if this client was tracked for completion at test-start."""
        return sid in self._expected_completers

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
        elif not self._reclaim_slot(sid, info):
            # Mid-test observer: no tissue assignment, not tracked for completion.
            logger.info(
                "Client %s registered mid-test (observer only, total: %d)",
                sid, len(self.clients),
            )

    def _client_key(self, info):
        """Identity for a screen that survives a reconnect.

        Each exhibit PC is pinned to one tissue by its ?tissue=<n> URL param and
        reports it at registration, so the tissue index names the screen.
        Clients without one (dev grid mode) share a single key; with one such
        client that is exact, and with several they are interchangeable anyway.
        """
        idx = (info or {}).get("singleTissueIndex")
        return "grid" if idx is None else "tissue:%s" % idx

    def _reclaim_slot(self, sid, info):
        """Hand a reconnecting screen back the slot it held before it dropped.

        Returns True if a slot was reclaimed.
        """
        key = self._client_key(info)
        match = next(
            (old for old, slot in self._pending_reconnect.items() if slot["key"] == key),
            None,
        )
        if match is None:
            return False

        slot = self._pending_reconnect.pop(match)
        self._expected_completers.discard(match)
        self._expected_completers.add(sid)
        client = self.clients[sid]
        client["assigned_tissues"] = slot["assigned_tissues"]
        client["status"] = slot["status"]
        client["last_stats"] = slot["last_stats"]
        logger.info(
            "Client %s reconnected as %s after %.1fs; test continues (tissues %s)",
            match, sid, time.monotonic() - slot["since"], client["assigned_tissues"],
        )
        return True

    def unregister(self, sid):
        """Remove a disconnected client."""
        client = self.clients.pop(sid, None)
        if client is None:
            return
        if self._locked:
            if sid in self._expected_completers:
                if client["status"] == "complete":
                    # Already reported its results; nothing left to wait for.
                    self._expected_completers.discard(sid)
                else:
                    # Hold the slot instead of dropping it: the client reconnects
                    # by itself, and forfeiting here over a momentary blip is what
                    # used to reset the whole exhibit mid-test.  The sid stays in
                    # _expected_completers so no_completers_left() reads False
                    # until expire_pending() gives up on it.
                    self._pending_reconnect[sid] = {
                        "key": self._client_key(client["info"]),
                        "assigned_tissues": client["assigned_tissues"],
                        "status": client["status"],
                        "last_stats": client["last_stats"],
                        "since": time.monotonic(),
                    }
                    logger.warning(
                        "Expected completer %s dropped mid-test; holding its slot "
                        "for a reconnect", sid,
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

        Uses the snapshot taken at lock() time.  A client whose slot is being
        held for a reconnect is deliberately not complete — the test waits for
        it — but expire_pending() bounds that wait, so completion can't hang.
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
        # Keep the last stats from screens that are mid-reconnect, so their
        # tissue doesn't vanish from the display while we wait for them.
        for slot in self._pending_reconnect.values():
            if slot["last_stats"]:
                all_stats.extend(slot["last_stats"])
        all_stats.sort(key=lambda s: s.get("tissueIndex", 0))
        return all_stats

    def get_all_sids(self):
        """Return list of all connected client session IDs."""
        return list(self.clients.keys())

    @property
    def count(self):
        return len(self.clients)
