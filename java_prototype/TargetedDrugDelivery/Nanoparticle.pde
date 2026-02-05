class Nanoparticle {
  RShape grp;
  int[] config = new int[6];  // Triangle ligands
  int hexDrugIndex = 0;

  PGraphics pg;
  int w = 400, h = 400;
  int offsetX = 450, offsetY = 50;
  color[] receptorColors;

  Nanoparticle(String svgPath, color[] receptorColors) {
    grp = RG.loadShape(svgPath);
    grp.centerIn(g, 100, 1, 1);
    for (int i = 0; i < config.length; i++) config[i] = 0;
    pg = createGraphics(w, h);
    this.receptorColors = receptorColors; 
  }

  void display() {
    pg.beginDraw();
    pg.background(240);
    pg.translate(w / 2, h / 2);
    pg.strokeWeight(1);
    pg.stroke(0);

    RPoint mouseP = getMousePointInPG(mouseX, mouseY);

    for (int i = 0; i < grp.countChildren(); i++) {
      RShape shape = grp.children[i];
      color fillColor;

      if (i == 0) {
        fillColor = hexDrugColors[hexDrugIndex];
      } else if (i - 1 < config.length) {
        fillColor = receptorColors[config[i - 1]];
      } else {
        continue;
      }

      pg.noStroke();
      pg.fill(fillColor);
      shape.draw(pg);

      if (shape.contains(mouseP)) {
        pg.stroke(0);
        pg.strokeWeight(3);
        pg.noFill();
        shape.draw(pg);
      }
    }

    pg.endDraw();
    image(pg, offsetX, offsetY);
  }

  void handleClick(float mx, float my) {
    RPoint clickPoint = getMousePointInPG(mx, my);

    for (int i = 0; i < grp.countChildren(); i++) {
      RShape shape = grp.children[i];
      if (shape.contains(clickPoint)) {
        if (i == 0) {
          hexDrugIndex = (hexDrugIndex + 1) % hexDrugColors.length;
        } else if (i - 1 >= 0 && i - 1 < config.length) {
          config[i - 1] = (config[i - 1] + 1) % receptorColors.length;
        }
        break;
      }
    }
  }

  float bindingScore(Organ organ) {
  float rawScore = 0;

  // Count how many ligands of each type
  int[] ligandCounts = new int[receptorColors.length];

  for (int i = 0; i < config.length; i++) {
    int ligand = config[i];
    if (ligand >= 0 && ligand < ligandCounts.length) {
      ligandCounts[ligand]++;
    }
  }

  // Sum weighted matches
  for (int i = 0; i < ligandCounts.length && i < organ.receptorConcentrations.length; i++) {
    rawScore += ligandCounts[i] * organ.receptorConcentrations[i];
  }

  float maxPossibleScore = config.length;  // all ligands perfectly matched
  float normalizedScore = rawScore / maxPossibleScore;

  return normalizedScore * (hexDrugIndex + 1);
}



  RPoint getMousePointInPG(float mx, float my) {
    float relX = mx - offsetX;
    float relY = my - offsetY;
    float x = relX - w / 2;
    float y = relY - h / 2;
    return new RPoint(x, y);
  }
}
