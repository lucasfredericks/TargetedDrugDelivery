// dashboard.js - sends params to simulation tabs via BroadcastChannel
(function(){
  const channel = (typeof BroadcastChannel !== 'undefined') ? new BroadcastChannel('tdd-channel') : null;
  if (channel) {
    console.log('Dashboard: BroadcastChannel created successfully');
  } else {
    console.error('Dashboard: BroadcastChannel not supported by browser!');
  }

  // DOM elements
  const preview = document.getElementById('npPreview');
  const ctx = preview.getContext('2d');
  const ligandRow = document.getElementById('ligandRow');
  const puzzleView = document.getElementById('puzzleView');
  const particleCountEl = document.getElementById('particleCount');
  const particleCountLabel = document.getElementById('particleCountLabel');
  const turbulenceXEl = document.getElementById('turbulenceX');
  const turbulenceXLabel = document.getElementById('turbulenceXLabel');
  const turbulenceYEl = document.getElementById('turbulenceY');
  const turbulenceYLabel = document.getElementById('turbulenceYLabel');
  const deathThresholdEl = document.getElementById('deathThreshold');
  const deathThresholdLabel = document.getElementById('deathThresholdLabel');
  const loadBtn = document.getElementById('loadPuzzle');
  const resetBtn = document.getElementById('resetSim');
  const testBtn = document.getElementById('testBtn');
  const randomizeLigandsBtn = document.getElementById('randomizeLigands');
  const affinityContent = document.getElementById('affinityContent');
  const killRateContent = document.getElementById('killRateContent');

  // Six color options
  const colors = ['#e41a1c','#377eb8','#4daf4a','#984ea3','#ff7f00','#ffff33'];
  const colorNames = ['Red','Blue','Green','Purple','Orange','Yellow'];
  const ligandSlots = [ -1, -1, -1, -1, -1, -1 ];
  let toxicity = 2; // default
  let particleCount = 1000;
  let turbulenceX = 0.1;
  let turbulenceY = 0.3;
  let deathThreshold = 5;

  // Store latest stats from simulation for bar graph
  let latestStats = [];

  // Debounced sendParams for auto-sending on slider changes
  let sendParamsTimeout = null;
  function debouncedSendParams(delay = 300) {
    if (sendParamsTimeout) clearTimeout(sendParamsTimeout);
    sendParamsTimeout = setTimeout(() => sendParams(), delay);
  }

  // Listen for stats updates from simulation
  if (channel) {
    channel.onmessage = (ev) => {
      const msg = ev.data || {};
      if (msg.type === 'stats') {
        // Merge incoming stats with existing stats by tissue name
        // This keeps all 4 tissues visible even when only 1 simulation is running
        const incomingStats = msg.stats || [];
        for (let incoming of incomingStats) {
          const existingIdx = latestStats.findIndex(s => s.name === incoming.name);
          if (existingIdx >= 0) {
            latestStats[existingIdx].absorptionEfficiency = incoming.absorptionEfficiency;
            latestStats[existingIdx].totalAbsorbedDrugs = incoming.totalAbsorbedDrugs;
            latestStats[existingIdx].attempts = incoming.attempts;
            latestStats[existingIdx].theoreticalScore = incoming.theoreticalScore;
          }
        }
        updateBarGraph();
      }
    };
  }

  function makeSelectors(){
    ligandRow.innerHTML = '';
    for (let i=0;i<6;i++){
      const sel = document.createElement('select');
      sel.dataset.index = i;
      for (let j=0;j<6;j++){ const o = document.createElement('option'); o.value = j; o.text = colorNames[j]; sel.appendChild(o); }
      const empty = document.createElement('option'); empty.value = -1; empty.text = 'None'; sel.appendChild(empty);
      sel.value = -1;
      sel.onchange = ()=>{
        ligandSlots[i] = parseInt(sel.value);
        drawPreview();
        updateTheoreticalScores();
        debouncedSendParams();
      };
      ligandRow.appendChild(sel);
    }
  }

  function drawPreview(){
    ctx.clearRect(0,0,preview.width, preview.height);
    const w = preview.width, h = preview.height;
    const cx = w*0.45, cy = h*0.55; const hexR = Math.min(w,h)*0.18;
    // draw ligands as equilateral triangles
    const apothem = hexR * Math.cos(Math.PI/6);
    const arrangement = ligandSlots.slice(0,6);
    for (let i=0;i<6;i++){
      const mid = -Math.PI/2 + (i+0.5)*2*Math.PI/6;
      const triH = hexR*0.95; const triS=(2*triH)/Math.sqrt(3); const halfBase = triS/2;
      const tipDist = apothem - 2; const baseCenterDist = tipDist + triH;
      const tipX = cx + Math.cos(mid)*tipDist; const tipY = cy + Math.sin(mid)*tipDist;
      const baseCenterX = cx + Math.cos(mid)*baseCenterDist; const baseCenterY = cy + Math.sin(mid)*baseCenterDist;
      const px = Math.cos(mid+Math.PI/2); const py = Math.sin(mid+Math.PI/2);
      const baseAx = baseCenterX + px*halfBase; const baseAy = baseCenterY + py*halfBase;
      const baseBx = baseCenterX - px*halfBase; const baseBy = baseCenterY - py*halfBase;
      const ci = arrangement[i]; ctx.beginPath(); ctx.moveTo(tipX, tipY); ctx.lineTo(baseAx, baseAy); ctx.lineTo(baseBx, baseBy); ctx.closePath();
      ctx.fillStyle = (ci===-1)?'#e6e6e6':colors[(ci%6+6)%6]; ctx.fill(); ctx.strokeStyle='rgba(0,0,0,0.12)'; ctx.stroke();
    }
    // central hex
    ctx.beginPath(); for (let i=0;i<6;i++){ const a = -Math.PI/2 + i*2*Math.PI/6; const x = cx + Math.cos(a)*hexR; const y = cy + Math.sin(a)*hexR; if (i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);} ctx.closePath();
    const toxColor = toxicity===3? '#b30000' : (toxicity===2? '#ffd11a' : '#8fd14f'); ctx.fillStyle = toxColor; ctx.fill(); ctx.strokeStyle='#222'; ctx.stroke();
  }

  // Update theoretical scores in bar graph based on current ligands and puzzle
  // Uses adjacency-aware combinatorial probability scoring
  function updateTheoreticalScores() {
    if (!window.currentPuzzle || !window.currentPuzzle.tissues) return;

    // Pass ligandSlots directly (positions, not counts) for adjacency-aware scoring
    const ligandPositions = ligandSlots.slice(0, 6);

    // Update latestStats with theoretical scores (keep actual if exists)
    latestStats = window.currentPuzzle.tissues.map((tissue, i) => {
      const existing = latestStats[i] || {};
      const theoryScore = typeof scoreTissue === 'function'
        ? scoreTissue(ligandPositions, tissue.receptors)
        : 0;
      return {
        name: tissue.name,
        theoreticalScore: theoryScore,
        absorptionEfficiency: existing.absorptionEfficiency || 0,
        totalAbsorbedDrugs: existing.totalAbsorbedDrugs || 0,
        attempts: existing.attempts || 0
      };
    });

    updateBarGraph();
  }

  // Render binding affinity and cell kill rate as separate graphs
  function updateBarGraph() {
    if (!latestStats || latestStats.length === 0) {
      affinityContent.innerHTML = '<div style="color:#888;font-size:12px">Configure tissues and ligands</div>';
      killRateContent.innerHTML = '<div style="color:#888;font-size:12px">Run a test to see results</div>';
      return;
    }

    // Binding Affinity — always rendered from theoretical scores
    let affinityHtml = '';
    for (let stat of latestStats) {
      const pct = Math.min(100, Math.max(0, stat.theoreticalScore || 0));
      affinityHtml += `
        <div class="tissue-bar-row">
          <div class="tissue-bar-label">${stat.name}</div>
          <div class="tissue-bar-container">
            <div class="bar-wrapper">
              <div class="bar-bg">
                <div class="bar-fill bar-theory" style="width:${pct}%"></div>
              </div>
              <div class="bar-value">${pct.toFixed(1)}%</div>
            </div>
          </div>
        </div>
      `;
    }
    affinityContent.innerHTML = affinityHtml;

    // Cell Kill Rate — only shown after a test has produced actual data
    const hasActualData = latestStats.some(s => (s.absorptionEfficiency || 0) > 0 || (s.totalAbsorbedDrugs || 0) > 0);
    if (!hasActualData) {
      killRateContent.innerHTML = '<div style="color:#888;font-size:12px">Run a test to see results</div>';
      return;
    }

    let killHtml = '';
    for (let stat of latestStats) {
      const pct = Math.min(100, Math.max(0, stat.absorptionEfficiency || 0));
      const absorbed = stat.totalAbsorbedDrugs || 0;
      const subtitle = absorbed > 0 ? `${absorbed} absorbed` : '';
      killHtml += `
        <div class="tissue-bar-row">
          <div class="tissue-bar-label">${stat.name}</div>
          <div class="tissue-bar-container">
            <div class="bar-wrapper">
              <div class="bar-bg">
                <div class="bar-fill bar-actual" style="width:${pct}%"></div>
              </div>
              <div class="bar-value">${pct.toFixed(1)}%</div>
            </div>
            ${subtitle ? `<div style="font-size:10px;color:#888;margin-top:2px">${subtitle}</div>` : ''}
          </div>
        </div>
      `;
    }
    killRateContent.innerHTML = killHtml;
  }

  function sendParams(command){
    if (!channel) {
      console.error('Dashboard: BroadcastChannel not available!');
      return;
    }
    const msg = {
      type: 'params',
      ligandPositions: ligandSlots.slice(0,6),
      toxicity: toxicity,
      turbulenceX: turbulenceX,
      turbulenceY: turbulenceY,
      deathThreshold: deathThreshold,
      command: command || null,
      puzzle: window.currentPuzzle || null
    };
    console.log('Dashboard sending params:', command || 'update', 'puzzle:', !!msg.puzzle);
    channel.postMessage(msg);
  }

  // create a default empty puzzle structure (4 tissues, 6 zeroed receptors)
  function defaultPuzzle(){
    const tissues = [];
    for (let i=0;i<4;i++) tissues.push({ name: 'T'+(i+1), receptors: [0,0,0,0,0,0] });
    return { id: 'default', tissues: tissues, ligandCounts: [0,0,0,0,0,0], toxicity: toxicity };
  }

  function updatePuzzleView(){
    if (!window.currentPuzzle) { puzzleView.textContent = 'No puzzle loaded'; return; }
    puzzleView.textContent = JSON.stringify(window.currentPuzzle, null, 2);
  }

  // Render tissue controls: for each tissue, show six sliders (0.0 - 1.0)
  const tissueControlsDiv = document.getElementById('tissueControls');
  function renderTissueControls(p){
    // Only set window.currentPuzzle if a puzzle is explicitly provided
    // Don't auto-initialize with defaultPuzzle() to avoid overwriting simulation's puzzle
    const puzzleObj = p || window.currentPuzzle || defaultPuzzle();
    if (p) {
      window.currentPuzzle = puzzleObj;
    }
    tissueControlsDiv.innerHTML = '';
    puzzleObj.tissues.forEach((t)=>{
      const wrapper = document.createElement('div'); wrapper.style.border='1px solid #ddd'; wrapper.style.padding='6px'; wrapper.style.marginBottom='6px';

      // Title row with tissue name and randomize button
      const titleRow = document.createElement('div'); titleRow.style.display='flex'; titleRow.style.justifyContent='space-between'; titleRow.style.alignItems='center'; titleRow.style.marginBottom='4px';
      const titleText = document.createElement('strong'); titleText.textContent = t.name;
      const randomizeBtn = document.createElement('button'); randomizeBtn.textContent = 'Randomize'; randomizeBtn.style.fontSize='11px'; randomizeBtn.style.padding='2px 8px';
      titleRow.appendChild(titleText);
      titleRow.appendChild(randomizeBtn);
      wrapper.appendChild(titleRow);

      const row = document.createElement('div'); row.style.display='flex'; row.style.gap='8px'; row.style.flexWrap='wrap';

      // Store references to inputs and labels for randomization
      const controls = [];

      for (let ri=0; ri<6; ri++){
        const ctrl = document.createElement('div'); ctrl.style.minWidth='140px';
        const label = document.createElement('label'); label.style.display='block'; label.style.fontSize='12px'; label.style.marginBottom='2px';
        // label receptor sliders by color to match ligand color indices
        label.textContent = `${colorNames[ri]} receptor: ` + (t.receptors[ri]||0).toFixed(2);
        const input = document.createElement('input'); input.type = 'range'; input.min = 0; input.max = 1; input.step = 0.01; input.value = (t.receptors[ri]||0);
        input.style.width = '120px';
        input.oninput = (e)=>{
          const v = parseFloat(e.target.value);
          t.receptors[ri] = v;
          // update label and preview; auto-send after debounce
          label.textContent = `${colorNames[ri]} receptor: ` + v.toFixed(2);
          updatePuzzleView();
          updateTheoreticalScores();
          debouncedSendParams();
        };
        ctrl.appendChild(label); ctrl.appendChild(input); row.appendChild(ctrl);
        controls.push({ input, label, receptorIndex: ri });
      }

      // Randomize button handler
      randomizeBtn.onclick = ()=>{
        controls.forEach(c => {
          const randomValue = Math.random();
          t.receptors[c.receptorIndex] = randomValue;
          c.input.value = randomValue;
          c.label.textContent = `${colorNames[c.receptorIndex]} receptor: ` + randomValue.toFixed(2);
        });
        updatePuzzleView();
        updateTheoreticalScores();
        sendParams(); // Send immediately on button click
      };

      wrapper.appendChild(row); tissueControlsDiv.appendChild(wrapper);
    });
    updatePuzzleView();
    updateTheoreticalScores();
  }

  // Particle count slider
  particleCountEl.oninput = () => {
    particleCount = parseInt(particleCountEl.value);
    particleCountLabel.textContent = particleCount;
  };

  // Turbulence X slider
  turbulenceXEl.oninput = () => {
    turbulenceX = parseFloat(turbulenceXEl.value);
    turbulenceXLabel.textContent = turbulenceX.toFixed(2);
    debouncedSendParams();
  };

  // Turbulence Y slider
  turbulenceYEl.oninput = () => {
    turbulenceY = parseFloat(turbulenceYEl.value);
    turbulenceYLabel.textContent = turbulenceY.toFixed(2);
    debouncedSendParams();
  };

  // Cell death threshold slider
  deathThresholdEl.oninput = () => {
    deathThreshold = parseInt(deathThresholdEl.value);
    deathThresholdLabel.textContent = deathThreshold;
    debouncedSendParams();
  };

  loadBtn.onclick = ()=>{
    fetch('puzzle_example.json').then(r=>r.json()).then(p=>{
      window.currentPuzzle = p; puzzleView.textContent = JSON.stringify(p, null, 2);
      // default populate ligandSlots from counts if provided
      if (Array.isArray(p.ligandCounts)){
        // fill slots in color order
        let pos = [];
        for (let c=0;c<6;c++){ let count = Math.max(0, Math.floor(p.ligandCounts[c]||0)); for (let k=0;k<count && pos.length<6;k++) pos.push(c); }
        while(pos.length<6) pos.push(-1);
        for (let i=0;i<6;i++){ ligandSlots[i]=pos[i]; ligandRow.children[i].value = String(pos[i]); }
        drawPreview();
      }
      // render controls for the loaded puzzle and send params
      renderTissueControls(p);
      sendParams();
    });
  };

  resetBtn.onclick = ()=>{
    for (let i=0;i<6;i++){
      ligandSlots[i] = -1;
      ligandRow.children[i].value = -1;
    }
    drawPreview();
    // Reset actual scores in bar graph
    latestStats = latestStats.map(s => ({...s, absorptionEfficiency: 0, totalAbsorbedDrugs: 0, attempts: 0}));
    updateBarGraph();
    sendParams('reset');
  };

  // Test button: send current params with restart command, then start test
  testBtn.onclick = ()=> {
    if (!channel) {
      console.error('Dashboard: Cannot send test - BroadcastChannel not available!');
      return;
    }
    console.log('Dashboard: Test button clicked');
    // Send current parameters to simulation with restart command
    sendParams('restart');
    // Then send test command with particle count
    setTimeout(() => {
      console.log('Dashboard: Sending test message for', particleCount, 'particles per tissue');
      channel.postMessage({
        type: 'test',
        totalParticles: particleCount
      });
    }, 100); // Small delay to ensure params are received first
  };

  // Randomize ligands button
  randomizeLigandsBtn.onclick = ()=> {
    // Randomly assign ligands to each of the 6 slots
    for (let i = 0; i < 6; i++) {
      // Random choice: either a color (0-5) or empty (-1)
      // Weight toward having ligands (70% chance of ligand vs 30% empty)
      const randomValue = Math.random() < 0.7 ? Math.floor(Math.random() * 6) : -1;
      ligandSlots[i] = randomValue;
      ligandRow.children[i].value = String(randomValue);
    }
    drawPreview();
    updateTheoreticalScores();
    sendParams(); // Send immediately on button click
  };

  // Initial setup
  makeSelectors();
  drawPreview();

  // Auto-load the puzzle on startup so dashboard has the same state as simulation
  fetch('puzzle_example.json').then(r=>r.json()).then(p=>{
    window.currentPuzzle = p;
    // Populate ligand slots from counts if provided
    if (Array.isArray(p.ligandCounts)){
      let pos = [];
      for (let c=0;c<6;c++){
        let count = Math.max(0, Math.floor(p.ligandCounts[c]||0));
        for (let k=0;k<count && pos.length<6;k++) pos.push(c);
      }
      while(pos.length<6) pos.push(-1);
      for (let i=0;i<6;i++){
        ligandSlots[i]=pos[i];
        ligandRow.children[i].value = String(pos[i]);
      }
      drawPreview();
    }
    renderTissueControls(p);
  }).catch(()=>{
    // If puzzle load fails, render with default
    renderTissueControls();
  });
})();
