"""Manages connected simulation client computers and tissue assignments."""

import logging

logger = logging.getLogger(__name__)


class ClientManager:
    """Tracks connected simulation clients and assigns tissues dynamically."""

    def __init__(self):
        # sid → client info dict
        self.clients = {}

    def register(self, sid, info=None):
        """Register a new client connection."""
        self.clients[sid] = {
            "sid": sid,
            "info": info or {},
            "assigned_tissues": [],
            "status": "connected",
            "last_stats": None
        }
        logger.info("Client registered: %s (total: %d)", sid, len(self.clients))
        self._reassign_tissues()

    def unregister(self, sid):
        """Remove a disconnected client."""
        if sid in self.clients:
            del self.clients[sid]
            logger.info("Client unregistered: %s (total: %d)", sid, len(self.clients))
            self._reassign_tissues()

    def _reassign_tissues(self):
        """Distribute 4 tissues evenly across connected clients."""
        sids = list(self.clients.keys())
        n = len(sids)
        if n == 0:
            return

        tissues = [0, 1, 2, 3]

        for i, sid in enumerate(sids):
            # Distribute tissues round-robin
            assigned = [t for t in tissues if t % n == i]
            self.clients[sid]["assigned_tissues"] = assigned
            logger.info("Client %s assigned tissues: %s", sid, assigned)

    def get_assignment(self, sid):
        """Get tissue indices assigned to a client."""
        client = self.clients.get(sid)
        if client:
            return client["assigned_tissues"]
        return []

    def update_stats(self, sid, stats):
        """Store the latest stats from a client."""
        if sid in self.clients:
            self.clients[sid]["last_stats"] = stats

    def mark_complete(self, sid):
        """Mark a client as having completed its test."""
        if sid in self.clients:
            self.clients[sid]["status"] = "complete"

    def all_complete(self):
        """Check if all clients have completed their tests."""
        if not self.clients:
            return False
        return all(c["status"] == "complete" for c in self.clients.values())

    def reset_all(self):
        """Reset all clients to connected status for a new test."""
        for client in self.clients.values():
            client["status"] = "connected"
            client["last_stats"] = None

    def get_aggregated_stats(self):
        """Collect latest stats from all clients into a single list."""
        all_stats = []
        for client in self.clients.values():
            if client["last_stats"]:
                all_stats.extend(client["last_stats"])
        # Sort by tissue index for consistent ordering
        all_stats.sort(key=lambda s: s.get("tissueIndex", 0))
        return all_stats

    def get_all_sids(self):
        """Return list of all connected client session IDs."""
        return list(self.clients.keys())

    @property
    def count(self):
        return len(self.clients)
