// NanoparticleSprite.js - Nanoparticle sprite generation

// Generate a nanoparticle sprite based on ligand positions and toxicity
function generateParticleSprite(size, ligandPositions, toxicity) {
  if (typeof createGraphics !== 'function') return null;

  const g = createGraphics(size, size);
  g.pixelDensity(1);
  g.clear();
  g.push();
  g.translate(size / 2, size / 2);

  // Compute a safe hex radius so triangles fit inside the sprite bounds
  const pad = 2;
  const maxR = size / 2 - pad;
  const cos30 = Math.cos(Math.PI / 6);
  const denom = cos30 + 0.95;
  let hexR = Math.min(size * 0.35, Math.max(4, (maxR + 1) / denom));
  const apothem = hexR * cos30;

  const arrangement = ligandPositions.slice(0, 6);

  // Draw equilateral triangles (ligands)
  for (let i = 0; i < 6; i++) {
    const mid = -Math.PI / 2 + (i + 0.5) * TWO_PI / 6;
    const triH = hexR * 0.7;  // Triangle height (reduced to ensure fit)
    const triS = (2 * triH) / Math.sqrt(3);  // Side length for equilateral
    const halfBase = triS / 2;
    const tipDist = apothem - 1;
    const baseCenterDist = tipDist + triH;

    const tipX = Math.cos(mid) * tipDist;
    const tipY = Math.sin(mid) * tipDist;
    const baseCenterX = Math.cos(mid) * baseCenterDist;
    const baseCenterY = Math.sin(mid) * baseCenterDist;
    const px = Math.cos(mid + Math.PI / 2);
    const py = Math.sin(mid + Math.PI / 2);
    const baseAx = baseCenterX + px * halfBase;
    const baseAy = baseCenterY + py * halfBase;
    const baseBx = baseCenterX - px * halfBase;
    const baseBy = baseCenterY - py * halfBase;

    const colorIdx = arrangement[i];
    g.noStroke();
    if (colorIdx === -1) {
      g.fill('#e6e6e6');
    } else {
      g.fill(colorForIndex(colorIdx));
    }
    g.triangle(tipX, tipY, baseAx, baseAy, baseBx, baseBy);
  }

  // Draw central hexagon with toxicity color
  g.fill(TOXICITY_COLORS[toxicity] || TOXICITY_COLORS[2]);
  g.stroke('#222');
  g.strokeWeight(0.6);
  g.beginShape();
  for (let i = 0; i < 6; i++) {
    const a = -Math.PI / 2 + i * TWO_PI / 6;
    const vx = Math.cos(a) * hexR;
    const vy = Math.sin(a) * hexR;
    g.vertex(vx, vy);
  }
  g.endShape(CLOSE);
  g.noStroke();
  g.pop();

  return g;
}

// Draw nanoparticle preview to a canvas context (for dashboard)
function drawNanoparticlePreviewToContext(ctx, w, h, ligandPositions, toxicity) {
  ctx.clearRect(0, 0, w, h);

  const cx = w * 0.45;
  const cy = h * 0.55;
  const hexR = Math.min(w, h) * 0.18;
  const apothem = hexR * Math.cos(Math.PI / 6);

  // Draw central hexagon
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = -Math.PI / 2 + i * 2 * Math.PI / 6;
    const x = cx + Math.cos(a) * hexR;
    const y = cy + Math.sin(a) * hexR;
    if (i === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  }
  ctx.closePath();
  ctx.fillStyle = TOXICITY_COLORS[toxicity] || TOXICITY_COLORS[2];
  ctx.fill();
  ctx.strokeStyle = '#222';
  ctx.lineWidth = 1;
  ctx.stroke();

  // Draw ligand triangles
  const arrangement = ligandPositions.slice(0, 6);
  for (let i = 0; i < 6; i++) {
    const mid = -Math.PI / 2 + (i + 0.5) * 2 * Math.PI / 6;
    const triH = hexR * 0.95;
    const triS = (2 * triH) / Math.sqrt(3);
    const halfBase = triS / 2;
    const tipDist = apothem - 2;
    const baseCenterDist = tipDist + triH;

    const tipX = cx + Math.cos(mid) * tipDist;
    const tipY = cy + Math.sin(mid) * tipDist;
    const baseCenterX = cx + Math.cos(mid) * baseCenterDist;
    const baseCenterY = cy + Math.sin(mid) * baseCenterDist;
    const px = Math.cos(mid + Math.PI / 2);
    const py = Math.sin(mid + Math.PI / 2);
    const baseAx = baseCenterX + px * halfBase;
    const baseAy = baseCenterY + py * halfBase;
    const baseBx = baseCenterX - px * halfBase;
    const baseBy = baseCenterY - py * halfBase;

    const colorIdx = arrangement[i];
    ctx.fillStyle = colorIdx === -1 ? '#e6e6e6' : COLORS[colorIdx % 6];
    ctx.beginPath();
    ctx.moveTo(tipX, tipY);
    ctx.lineTo(baseAx, baseAy);
    ctx.lineTo(baseBx, baseBy);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.12)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}

// Export for browser global
window.generateParticleSprite = generateParticleSprite;
window.drawNanoparticlePreviewToContext = drawNanoparticlePreviewToContext;
