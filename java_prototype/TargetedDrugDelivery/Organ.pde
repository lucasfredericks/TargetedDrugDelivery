class Organ {
  String name;
  float[] receptorConcentrations; // length 6
  float x, y;
  color[] receptorColors; 

  Organ(String name, float[] concentrations, float x, float y, color[] receptorColors) {
    this.name = name;
    if (concentrations.length != 6) {
      throw new IllegalArgumentException("Organ must have 6 receptor values.");
    }
    this.receptorConcentrations = new float[6];
    for (int i = 0; i < 6; i++) {
      this.receptorConcentrations[i] = constrain(concentrations[i], 0, 1);
    }
    this.x = x;
    this.y = y;
    this.receptorColors = receptorColors;
  }
  
  float[] generateRandomReceptors() {
    float[] r = new float[6];
    for (int i = 0; i < 6; i++) {
      r[i] = random(0.0, 1.0);
    }
    return r;
  }
  
  void reroll(){
     this.receptorConcentrations = generateRandomReceptors();  
  }

  void display(float px, float py) {
    float radiusMax = 30;
    fill(0);
    textAlign(LEFT);
    textSize(14);
    text(name, px + 70, py + 10);

    for (int i = 0; i < 6; i++) {
      float cx = px + (i) * 45;
      float cy = py + 30;
      float conc = receptorConcentrations[i];
      float r = 8 + conc * radiusMax;

      fill(receptorColors[i]);
      stroke(0);
      ellipse(cx, cy, r, r);

      // Triangle marker inside the receptor
      fill(255);
      noStroke();
      float triSize = 6;
      triangle(cx, cy - triSize, cx - triSize * 0.8, cy + triSize * 0.6, cx + triSize * 0.8, cy + triSize * 0.6);
    }
  }
}

class Tumor extends Organ {
  Tumor(String name, float[] concentrations, float x, float y, color [] receptorColors) {
    super(name, concentrations, x, y, receptorColors);
    this.receptorConcentrations = generateRandomReceptors(); 
  }
}
