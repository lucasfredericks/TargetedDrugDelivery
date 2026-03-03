/**
 * Network abstraction for Socket.IO communication with the Pi master server.
 *
 * When a ?server=<host:port> URL parameter is present, connects to the Pi
 * master server via Socket.IO for exhibit mode. Otherwise, falls back to
 * BroadcastChannel for local dashboard development.
 *
 * Usage (in main.js):
 *   const network = new NetworkClient();
 *   network.initialize();
 *   // network.onStartTest(callback), network.onReset(callback), etc.
 *   // network.sendStats(stats), network.sendTestComplete(finalStats)
 */

// eslint-disable-next-line no-unused-vars
class NetworkClient {
  constructor() {
    this.mode = null; // "socketio" or "broadcast"
    this.socket = null;
    this.broadcastChannel = null;
    this.serverUrl = null;
    this.assignedTissues = null; // Tissue indices assigned by master

    // Callbacks
    this._onStartTest = null;
    this._onParams = null;
    this._onReset = null;
    this._onAssignment = null;
  }

  initialize() {
    this.serverUrl = getQueryParam("server");

    if (this.serverUrl && typeof io !== "undefined") {
      this._initSocketIO();
    } else {
      this._initBroadcastChannel();
    }
  }

  // --- Socket.IO mode ---

  _initSocketIO() {
    this.mode = "socketio";
    const url = this.serverUrl.startsWith("http")
      ? this.serverUrl
      : `http://${this.serverUrl}`;

    console.log("Network: connecting to master server at", url);
    this.socket = io(url, {
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionAttempts: Infinity,
    });

    this.socket.on("connect", () => {
      console.log("Network: connected to master server");
      this.socket.emit("register_client", {
        userAgent: navigator.userAgent,
        singleTissueMode: singleTissueMode,
        singleTissueIndex: singleTissueIndex,
      });
    });

    this.socket.on("disconnect", () => {
      console.log("Network: disconnected from master server");
    });

    this.socket.on("assignment", (data) => {
      this.assignedTissues = data.tissueIndices;
      console.log("Network: assigned tissues", this.assignedTissues);
      if (this._onAssignment) this._onAssignment(data.tissueIndices);
    });

    this.socket.on("start_test", (data) => {
      console.log("Network: start_test received", data);
      if (this._onStartTest) this._onStartTest(data);
    });

    this.socket.on("reset", () => {
      console.log("Network: reset received");
      if (this._onReset) this._onReset();
    });
  }

  // --- BroadcastChannel mode (local development fallback) ---

  _initBroadcastChannel() {
    this.mode = "broadcast";
    try {
      this.broadcastChannel = new BroadcastChannel("tdd-channel");
      console.log("Network: BroadcastChannel mode");

      this.broadcastChannel.onmessage = (ev) => {
        const msg = ev.data || {};
        if (msg.type === "test" && this._onStartTest) {
          this._onStartTest({
            totalParticles: msg.totalParticles || 1000,
            ligandPositions: null, // Use current positions in broadcast mode
            puzzle: null,
          });
        } else if (msg.type === "params" && this._onParams) {
          this._onParams(msg);
        }
      };
    } catch (e) {
      console.warn("Network: BroadcastChannel not available");
    }
  }

  // --- Event registration ---

  /** Called when master sends start_test. data: { ligandPositions, toxicity, puzzle, totalParticles, assignment } */
  onStartTest(callback) {
    this._onStartTest = callback;
  }

  /** Called when dashboard sends params (BroadcastChannel mode only). */
  onParams(callback) {
    this._onParams = callback;
  }

  /** Called when master sends reset. */
  onReset(callback) {
    this._onReset = callback;
  }

  /** Called when master assigns tissues to this client. */
  onAssignment(callback) {
    this._onAssignment = callback;
  }

  // --- Outbound messages ---

  /** Send periodic stats to master or dashboard. */
  sendStats(stats) {
    if (this.mode === "socketio" && this.socket?.connected) {
      this.socket.emit("stats_update", { stats: stats });
    } else if (this.mode === "broadcast" && this.broadcastChannel) {
      this.broadcastChannel.postMessage({ type: "stats", stats: stats });
    }
  }

  /** Notify master that this client's test is complete. */
  sendTestComplete(finalStats) {
    if (this.mode === "socketio" && this.socket?.connected) {
      this.socket.emit("test_complete", { finalStats: finalStats });
    }
    // No equivalent in BroadcastChannel mode
  }

  /** Check if operating in exhibit (Socket.IO) mode. */
  get isExhibitMode() {
    return this.mode === "socketio";
  }
}
