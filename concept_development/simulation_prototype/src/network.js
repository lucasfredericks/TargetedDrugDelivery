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
    this.socket = null; // in-thread Socket.IO (fallback path only)
    this.worker = null; // Web Worker owning the Socket.IO connection (primary path)
    this.broadcastChannel = null;
    this.serverUrl = null;
    this.assignedTissues = null; // Tissue indices assigned by master

    // Worker-path state
    this._workerReady = false; // true once the worker reports a live connection
    this._fellBack = false;    // true once we've given up on the worker

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

    // Prefer running the Socket.IO connection in a Web Worker so the heartbeat
    // survives a saturated main thread (see network.worker.js). Fall back to an
    // in-thread connection if the environment can't spawn the worker.
    if (typeof Worker !== "undefined") {
      try {
        this._initSocketIOWorker(url);
        return;
      } catch (e) {
        console.warn("Network: could not start socket worker; using in-thread socket", e);
        this.worker = null;
      }
    }
    this._initSocketIOInline(url);
  }

  /** Primary path: the socket lives on a dedicated worker thread. */
  _initSocketIOWorker(url) {
    const worker = new Worker("src/network.worker.js");
    this.worker = worker;
    this._workerReady = false;
    this._fellBack = false;

    const fallback = (why) => {
      if (this._fellBack) return;
      this._fellBack = true;
      console.warn("Network: socket worker unavailable; using in-thread socket:", why);
      try { worker.terminate(); } catch (e) { /* ignore */ }
      this.worker = null;
      this._initSocketIOInline(url);
    };

    // A worker error before we ever connected means the worker path is broken,
    // so fall back. After a successful connect we keep the worker; its own
    // Socket.IO client handles reconnects.
    worker.onerror = (e) => {
      if (!this._workerReady) fallback(e.message || "worker error");
    };

    worker.onmessage = (ev) => {
      const msg = ev.data || {};
      switch (msg.type) {
        case "fatal":
          fallback(msg.error || "worker fatal");
          break;
        case "connect":
          this._workerReady = true;
          console.log("Network: connected to master server (worker)");
          break;
        case "disconnect":
          console.log("Network: disconnected from master server (worker)");
          break;
        case "assignment":
          this.assignedTissues = msg.data && msg.data.tissueIndices;
          console.log("Network: assigned tissues", this.assignedTissues);
          if (this._onAssignment) this._onAssignment(this.assignedTissues);
          break;
        case "start_test":
          console.log("Network: start_test received", msg.data);
          if (this._onStartTest) this._onStartTest(msg.data);
          break;
        case "reset":
          console.log("Network: reset received");
          if (this._onReset) this._onReset();
          break;
        case "ligand_update":
          if (this._onLigandUpdate) this._onLigandUpdate(msg.data);
          break;
      }
    };

    worker.postMessage({
      type: "init",
      url: url,
      register: {
        userAgent: navigator.userAgent,
        singleTissueMode: singleTissueMode,
        singleTissueIndex: singleTissueIndex,
      },
    });
    console.log("Network: connecting to master server via worker at", url);
  }

  /** Fallback path: the socket runs in-thread (original behavior). */
  _initSocketIOInline(url) {
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

    this.socket.on("ligand_update", (data) => {
      if (this._onLigandUpdate) this._onLigandUpdate(data);
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

  /** Called when master sends ligand/puzzle preview update (outside of test). */
  onLigandUpdate(callback) {
    this._onLigandUpdate = callback;
  }

  // --- Outbound messages ---

  /** Send periodic stats to master or dashboard. */
  sendStats(stats) {
    if (this.mode === "socketio") {
      if (this.worker) {
        this.worker.postMessage({ type: "stats", stats: stats });
      } else if (this.socket?.connected) {
        this.socket.emit("stats_update", { stats: stats });
      }
    } else if (this.mode === "broadcast" && this.broadcastChannel) {
      this.broadcastChannel.postMessage({ type: "stats", stats: stats });
    }
  }

  /** Notify master that this client's test is complete. */
  sendTestComplete(finalStats) {
    if (this.mode === "socketio") {
      if (this.worker) {
        this.worker.postMessage({ type: "test_complete", finalStats: finalStats });
      } else if (this.socket?.connected) {
        this.socket.emit("test_complete", { finalStats: finalStats });
      }
    }
    // No equivalent in BroadcastChannel mode
  }

  /** Check if operating in exhibit (Socket.IO) mode. */
  get isExhibitMode() {
    return this.mode === "socketio";
  }
}
