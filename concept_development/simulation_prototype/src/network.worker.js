/**
 * Web Worker that owns the Socket.IO connection to the Pi master server.
 *
 * Why a worker: the Engine.IO heartbeat is server-initiated (the Pi sends a
 * PING, the client must answer with a PONG on its JS event loop). When the
 * p5.js draw loop saturates the page's main thread, that PONG can be starved
 * for long enough that the server declares every sim client disconnected
 * mid-test — tripping the "all clients lost" auto-reset. Running the socket on
 * this dedicated thread keeps the heartbeat responsive regardless of how busy
 * the simulation is.
 *
 * Message protocol with network.js (main thread):
 *   IN  { type:"init", url, register }       → open connection; register on connect
 *   IN  { type:"stats", stats }              → emit stats_update
 *   IN  { type:"test_complete", finalStats } → emit test_complete
 *   OUT { type:"connect" | "disconnect" }
 *   OUT { type:"assignment"|"start_test"|"reset"|"ligand_update", data }
 *   OUT { type:"fatal", error }              → worker can't run; main falls back in-thread
 */

// Resolved relative to this worker's URL (src/network.worker.js → lib/…).
try {
  importScripts("../lib/socket.io.min.js");
} catch (e) {
  self.postMessage({ type: "fatal", error: "importScripts failed: " + e.message });
}

let socket = null;
let register = {};

self.onmessage = (ev) => {
  const msg = ev.data || {};
  switch (msg.type) {
    case "init":
      _connect(msg.url, msg.register);
      break;
    case "stats":
      if (socket && socket.connected) {
        socket.emit("stats_update", { stats: msg.stats });
      }
      break;
    case "test_complete":
      if (socket && socket.connected) {
        socket.emit("test_complete", { finalStats: msg.finalStats });
      }
      break;
  }
};

function _connect(url, reg) {
  register = reg || {};

  if (typeof io === "undefined") {
    self.postMessage({ type: "fatal", error: "socket.io client not loaded in worker" });
    return;
  }

  try {
    socket = io(url, {
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionAttempts: Infinity,
    });
  } catch (e) {
    self.postMessage({ type: "fatal", error: "io() failed: " + e.message });
    return;
  }

  socket.on("connect", () => {
    // Re-register on every (re)connect so a bounced socket re-announces itself.
    socket.emit("register_client", register);
    self.postMessage({ type: "connect" });
  });
  socket.on("disconnect", () => self.postMessage({ type: "disconnect" }));
  socket.on("assignment", (data) => self.postMessage({ type: "assignment", data }));
  socket.on("start_test", (data) => self.postMessage({ type: "start_test", data }));
  socket.on("reset", () => self.postMessage({ type: "reset" }));
  socket.on("ligand_update", (data) => self.postMessage({ type: "ligand_update", data }));
}
