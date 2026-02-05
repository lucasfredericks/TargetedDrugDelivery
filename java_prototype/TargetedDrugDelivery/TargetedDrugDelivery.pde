import geomerative.*;
color[] receptorColors;


Nanoparticle nanoparticle;
boolean showScores = true;
PVector testButtonPos = new PVector(600, 500);
PVector rerollButtonPos = new PVector (300, 500);
PVector buttonSize = new PVector(150, 40);

ArrayList<Organ> organs;
HashMap<Organ, Float> bindingScores = new HashMap<Organ, Float>();


color[] hexDrugColors = {
  color(0, 200, 0), // Green
  color(255, 255, 0), // Yellow
  color(255, 0, 0)     // Red
};

void setup() {
  size(900, 600);

  receptorColors = new color[] {
    color(255, 0, 0), // Red
    color(0, 200, 0), // Green
    color(0, 0, 255), // Blue
    color(128, 0, 128), // Purple
    color(255, 165, 0), // Orange
    color(255, 255, 0)    // Yellow
  };


  RG.init(this);
  RG.ignoreStyles(true);
  RG.setPolygonizer(RG.ADAPTATIVE);


  nanoparticle = new Nanoparticle("TDD_nanoparticle.svg", receptorColors);

  organs = new ArrayList<Organ>();
  organs.add(new Organ("Heart", new float[]{0.3, 0.6, 0, 0, 0.1, 0.4}, 50, 100, receptorColors));
  organs.add(new Organ("Liver", new float[]{0.2, 0, 0.8, 0, 0.3, 0.5}, 50, 180, receptorColors));
  organs.add(new Organ("Brain", new float[]{0.2, 0, 0.8, 0, 0.3, 0.5}, 50, 260, receptorColors));
  organs.add(new Tumor("Tumor", new float[]{0, 0, 0, 0, 0, 0}, 50, 320, receptorColors));
}

void draw() {
  background(255);

  for (Organ o : organs) o.display(o.x, o.y);

  nanoparticle.display();

  if (showScores) {
    fill(0);
    textSize(16);
    textAlign(LEFT);
    int yPos = height - 100;
    for (Organ o : organs) {
      float score = bindingScores.containsKey(o) ? bindingScores.get(o) : 0;
      text(o.name + " toxicity: " + nf(score, 1, 3), 50, yPos);
      yPos += 25;
    }
  }

  // Draw test molecule button
  fill(200);
  stroke(0);
  rect(testButtonPos.x, testButtonPos.y, buttonSize.x, buttonSize.y, 5);
  fill(0);
  textAlign(CENTER, CENTER);
  textSize(18);
  text("Test Molecule", testButtonPos.x + buttonSize.x / 2, testButtonPos.y + buttonSize.y / 2);

  // Draw reroll molecule button
  fill(200);
  stroke(0);
  rect(rerollButtonPos.x, rerollButtonPos.y, buttonSize.x, buttonSize.y, 5);
  fill(0);
  textAlign(CENTER, CENTER);
  textSize(18);
  text("New Puzzle", rerollButtonPos.x + buttonSize.x / 2, rerollButtonPos.y + buttonSize.y / 2);


}

void mousePressed() {
  if (mouseX > testButtonPos.x && mouseX < testButtonPos.x + buttonSize.x &&
    mouseY > testButtonPos.y && mouseY < testButtonPos.y + buttonSize.y) {
    showScores = true;
    bindingScores.clear();
    for (Organ o : organs) {
      float score = nanoparticle.bindingScore(o);
      bindingScores.put(o, score);
    }
  } else if (mouseX > rerollButtonPos.x && mouseX < rerollButtonPos.x + buttonSize.x &&
    mouseY > rerollButtonPos.y && mouseY < rerollButtonPos.y + buttonSize.y) {
      for (Organ o : organs){
       o.reroll();  
      }
  } else {
    nanoparticle.handleClick(mouseX, mouseY);
  }
}
