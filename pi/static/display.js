/**
 * Display client for the Targeted Drug Delivery exhibit.
 * Connects to the Pi master server via Socket.IO and shows results.
 */

const LIGAND_COLORS_HEX = {
    Red: "#e63946",
    Blue: "#457b9d",
    Green: "#2a9d8f",
    Purple: "#9b59b6",
    Orange: "#e67e22",
    Yellow: "#f1c40f",
    None: "#444"
};

const LIGAND_NAMES = ["Red", "Blue", "Green", "Purple", "Orange", "Yellow"];

// State
let currentLigands = null;
let currentPuzzle = null;
let currentResults = [];

// Socket.IO connection
const socket = io();

socket.on("connect", () => {
    document.getElementById("connection-status").textContent = "Connected";
    socket.emit("join_display");
});

socket.on("disconnect", () => {
    document.getElementById("connection-status").textContent = "Disconnected";
});

// --- Event Handlers ---

socket.on("state_sync", (data) => {
    updateStatus(data.state);
    if (data.ligandPositions) {
        currentLigands = data.ligandPositions;
        renderNanoparticle(data.ligandPositions, data.ligandColors);
    }
    if (data.puzzle) {
        currentPuzzle = data.puzzle;
        renderPuzzleInfo(data.puzzle);
    }
    if (data.results) {
        renderResults(data.results);
    }
});

socket.on("nanoparticle_scanned", (data) => {
    currentLigands = data.ligandPositions;
    renderNanoparticle(data.ligandPositions, data.colors);
    updateStatus("NANOPARTICLE_SCANNED");
});

socket.on("puzzle_loaded", (data) => {
    currentPuzzle = data.puzzle;
    renderPuzzleInfo(data.puzzle);
    updateStatus("PUZZLE_LOADED");
});

socket.on("test_started", () => {
    updateStatus("TESTING");
});

socket.on("results_update", (data) => {
    renderResults(data.allStats);
});

socket.on("test_complete", (data) => {
    renderResults(data.finalResults);
    updateStatus("RESULTS");
});

socket.on("state_reset", () => {
    currentLigands = null;
    currentPuzzle = null;
    currentResults = [];
    updateStatus("IDLE");
    clearDisplay();
});

socket.on("client_count", (data) => {
    document.getElementById("client-count").textContent = data.count;
});

socket.on("error", (data) => {
    showError(data.message);
});

// --- Rendering ---

function updateStatus(state) {
    const badge = document.getElementById("status-badge");
    badge.textContent = state.replace(/_/g, " ");
    badge.className = "status-badge status-" + state.toLowerCase();
}

function renderNanoparticle(positions, colorNames) {
    const canvas = document.getElementById("nanoparticle-canvas");
    const ctx = canvas.getContext("2d");
    const cx = canvas.width / 2;
    const cy = canvas.height / 2;
    const hexR = Math.min(canvas.width, canvas.height) * 0.23; // hex vertex radius
    const apothem = hexR * Math.cos(Math.PI / 6);              // center-to-face distance

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Draw 6 outward ligand triangles first (tip just inside hex face, base outward)
    for (let i = 0; i < 6; i++) {
        const mid = -Math.PI / 2 + (i + 0.5) * 2 * Math.PI / 6;
        const triH = hexR * 0.95;
        const halfBase = triH / Math.sqrt(3);
        const tipX = cx + Math.cos(mid) * (apothem - 2);
        const tipY = cy + Math.sin(mid) * (apothem - 2);
        const baseCX = cx + Math.cos(mid) * (apothem - 2 + triH);
        const baseCY = cy + Math.sin(mid) * (apothem - 2 + triH);
        const px = Math.cos(mid + Math.PI / 2);
        const py = Math.sin(mid + Math.PI / 2);

        const colorName = (colorNames && colorNames[i]) ? colorNames[i] : "None";

        ctx.beginPath();
        ctx.moveTo(tipX, tipY);
        ctx.lineTo(baseCX + px * halfBase, baseCY + py * halfBase);
        ctx.lineTo(baseCX - px * halfBase, baseCY - py * halfBase);
        ctx.closePath();
        ctx.fillStyle = LIGAND_COLORS_HEX[colorName];
        ctx.fill();
        ctx.strokeStyle = "rgba(0,0,0,0.25)";
        ctx.lineWidth = 1;
        ctx.stroke();
    }

    // Draw central hexagon on top — always yellow, covers triangle tips
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
        const angle = -Math.PI / 2 + i * 2 * Math.PI / 6;
        const x = cx + Math.cos(angle) * hexR;
        const y = cy + Math.sin(angle) * hexR;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fillStyle = "#f1c40f";
    ctx.fill();
    ctx.strokeStyle = "#888";
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Update ligand list
    const listEl = document.getElementById("ligand-list");
    listEl.innerHTML = "";
    for (let i = 0; i < 6; i++) {
        const name = colorNames ? colorNames[i] : (positions[i] >= 0 ? LIGAND_NAMES[positions[i]] : "Empty");
        const div = document.createElement("div");
        div.className = "ligand-slot";
        div.style.borderLeft = `3px solid ${LIGAND_COLORS_HEX[name] || "#444"}`;
        div.textContent = `${i + 1}: ${name}`;
        listEl.appendChild(div);
    }
}

function renderPuzzleInfo(puzzle) {
    const el = document.getElementById("puzzle-info");
    if (!puzzle || !puzzle.tissues) {
        el.innerHTML = '<div class="waiting-message" style="height:auto;font-size:1em;">No puzzle loaded</div>';
        return;
    }

    let html = '<div class="tissue-list">';
    for (const tissue of puzzle.tissues) {
        const topReceptors = tissue.receptors
            .map((v, i) => ({ name: LIGAND_NAMES[i], val: v }))
            .filter(r => r.val > 0.1)
            .sort((a, b) => b.val - a.val)
            .slice(0, 3)
            .map(r => `${r.name} ${(r.val * 100).toFixed(0)}%`)
            .join(", ");

        html += `<div class="tissue-item">
            <span class="tissue-name">${tissue.name}</span>
            <span>${topReceptors}</span>
        </div>`;
    }
    html += "</div>";
    el.innerHTML = html;
}

function renderResults(stats) {
    if (!stats || stats.length === 0) return;

    currentResults = stats;
    const area = document.getElementById("results-area");

    area.innerHTML = "";
    for (const stat of stats) {
        const affinity = stat.theoreticalScore || 0;
        const killRate = stat.absorptionEfficiency || 0;
        const progress = stat.progress || 0;

        const card = document.createElement("div");
        card.className = "result-card";
        card.innerHTML = `
            <h3>Tissue ${stat.tissueIndex !== undefined ? stat.tissueIndex + 1 : ""}</h3>
            <div class="tissue-name-label">${stat.name || "Unknown"}</div>
            <div class="bar-container">
                <div class="bar-group">
                    <div class="bar-label">
                        <span>Binding Affinity</span>
                        <span>${affinity.toFixed(1)}%</span>
                    </div>
                    <div class="bar-track">
                        <div class="bar-fill affinity" style="width:${Math.min(100, affinity)}%"></div>
                    </div>
                </div>
                <div class="bar-group">
                    <div class="bar-label">
                        <span>Cell Kill Rate</span>
                        <span>${killRate.toFixed(1)}%</span>
                    </div>
                    <div class="bar-track">
                        <div class="bar-fill killrate" style="width:${Math.min(100, killRate)}%"></div>
                    </div>
                </div>
            </div>
            ${progress < 1 ? `<div style="color:#666;font-size:0.8em;margin-top:8px;">Progress: ${(progress * 100).toFixed(0)}%</div>` : ""}
        `;
        area.appendChild(card);
    }
}

function clearDisplay() {
    const canvas = document.getElementById("nanoparticle-canvas");
    canvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height);
    document.getElementById("ligand-list").innerHTML = "";
    document.getElementById("puzzle-info").innerHTML =
        '<div class="waiting-message" style="height:auto;font-size:1em;">Scan RFID tag to load puzzle</div>';
    document.getElementById("results-area").innerHTML =
        '<div class="waiting-message" style="grid-column:1/-1;">Scan nanoparticle and puzzle to begin</div>';
}

function showError(message) {
    const toast = document.createElement("div");
    toast.className = "error-toast";
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 5000);
}
