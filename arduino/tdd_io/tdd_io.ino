/*
 * Targeted Drug Delivery Exhibit — Arduino I/O Firmware
 *
 * Reads 6 APDS-9960 color sensors (via TCA9548A I2C multiplexer),
 * an MFRC522 RFID reader (via SPI), and 3 buttons. Communicates with
 * the exhibit server over USB serial using JSON lines at 115200 baud.
 *
 * Serial Protocol:
 *   Computer → Arduino (commands):
 *     {"cmd":"read_sensors"}
 *     {"cmd":"read_rfid"}
 *     {"cmd":"calibrate_start"}
 *     {"cmd":"calibrate_sample","channel":0}
 *     {"cmd":"calibrate_save","data":{...}}
 *     {"cmd":"calibrate_load"}
 *     {"cmd":"ping"}
 *
 *   Arduino → Computer (responses):
 *     {"type":"sensors","ligandPositions":[...],"colors":[...],"raw":[...]}
 *     {"type":"rfid","tag_id":"123456","text":""}
 *     {"type":"rfid","tag_id":null}
 *     {"type":"button","button":"scan"}
 *     {"type":"calibration_sample","channel":0,"r":1200,"g":300,"b":200,"c":4500,"prox":120}
 *     {"type":"calibration","data":{...}}
 *     {"type":"pong"}
 *     {"type":"error","message":"..."}
 *
 * Hardware:
 *   - TCA9548A I2C multiplexer at 0x70
 *   - 6x APDS-9960 color/proximity sensors on mux channels 0-5
 *   - MFRC522 RFID reader on SPI (SS=10, RST=9)
 *   - 3 buttons on pins 2, 3, 4 (pull-up, active low)
 *
 * Libraries required:
 *   - Adafruit_APDS9960 (via Library Manager)
 *   - MFRC522 (via Library Manager)
 *   - ArduinoJson (via Library Manager)
 */

#include <Wire.h>
#include <SPI.h>
#include <EEPROM.h>
#include <Adafruit_APDS9960.h>
#include <MFRC522.h>
#include <ArduinoJson.h>

// --- Pin Definitions ---
#define RFID_SS_PIN   10
#define RFID_RST_PIN  9
#define BTN_SCAN      2
#define BTN_TEST      3
#define BTN_RESET     4

// --- Constants ---
#define MUX_ADDR      0x70
#define NUM_SENSORS   6
#define NUM_COLORS    6
#define DEBOUNCE_MS   300

// Color names (must match server config)
const char* COLOR_NAMES[] = {"Red", "Blue", "Green", "Purple", "Orange", "Yellow"};
const char* BUTTON_NAMES[] = {"scan", "test", "reset"};
const uint8_t BUTTON_PINS[] = {BTN_SCAN, BTN_TEST, BTN_RESET};

// --- APDS-9960 Settings ---
#define COLOR_GAIN      APDS9960_AGAIN_4X
#define COLOR_INT_TIME  256  // max integration cycles

// --- EEPROM Layout ---
// Magic bytes to detect valid calibration
#define EEPROM_MAGIC      0xCA
#define EEPROM_VERSION    0x02
// EEPROM structure:
//   [0]    magic byte
//   [1]    version
//   [2..] calibration data (JSON-like binary, see CalibrationData)

// Per-sensor per-color calibration reference values
struct ColorRef {
  int16_t r;    // clear-normalized R (0-1000)
  int16_t g;    // clear-normalized G (0-1000)
  int16_t b;    // clear-normalized B (0-1000)
  int16_t sc;   // scaled clear (0-1000)
};

struct SensorCalibration {
  ColorRef colors[NUM_COLORS + 1];  // 6 colors + "None"
  int32_t clear_max;
  uint8_t proximity_threshold;
};

struct CalibrationData {
  SensorCalibration sensors[NUM_SENSORS];
  bool valid;
};

// --- Globals ---
Adafruit_APDS9960 apds[NUM_SENSORS];
bool sensor_ok[NUM_SENSORS];
MFRC522 rfid(RFID_SS_PIN, RFID_RST_PIN);
CalibrationData cal;
unsigned long last_btn_time[3] = {0, 0, 0};
String input_buffer = "";

// --- I2C Multiplexer ---
void mux_select(uint8_t channel) {
  if (channel >= 8) return;
  Wire.beginTransmission(MUX_ADDR);
  Wire.write(1 << channel);
  Wire.endTransmission();
}

void mux_disable() {
  Wire.beginTransmission(MUX_ADDR);
  Wire.write(0);
  Wire.endTransmission();
}

// --- Sensor Initialization ---
void init_sensors() {
  for (uint8_t ch = 0; ch < NUM_SENSORS; ch++) {
    mux_select(ch);
    delay(10);
    sensor_ok[ch] = apds[ch].begin();
    if (sensor_ok[ch]) {
      apds[ch].setADCGain(COLOR_GAIN);
      apds[ch].setADCIntegTime(COLOR_INT_TIME);
      apds[ch].enableColor(true);
      apds[ch].enableProximity(true);
    }
  }
  mux_disable();
}

// --- Color Classification ---
void normalize_by_clear(uint16_t r, uint16_t g, uint16_t b, uint16_t c,
                        int16_t &nr, int16_t &ng, int16_t &nb) {
  if (c == 0) {
    nr = ng = nb = 0;
    return;
  }
  nr = (int16_t)(1000L * r / c);
  ng = (int16_t)(1000L * g / c);
  nb = (int16_t)(1000L * b / c);
}

int16_t scale_clear(uint16_t c, uint8_t channel) {
  int32_t max_c = cal.sensors[channel].clear_max;
  if (max_c == 0) return 0;
  return (int16_t)(1000L * c / max_c);
}

// Returns color index (0-5) or -1 for None
int8_t classify_color(uint16_t r, uint16_t g, uint16_t b, uint16_t c,
                       uint8_t prox, uint8_t channel) {
  if (!cal.valid) return -1;

  // Proximity shortcut for empty
  uint8_t thresh = cal.sensors[channel].proximity_threshold;
  if (thresh > 0 && prox < thresh / 2) {
    return -1;
  }

  int16_t nr, ng, nb;
  normalize_by_clear(r, g, b, c, nr, ng, nb);
  int16_t sc = scale_clear(c, channel);

  int32_t best_dist = 0x7FFFFFFF;
  int8_t best_idx = -1;

  // Check all colors + None (index NUM_COLORS = None)
  for (uint8_t i = 0; i <= NUM_COLORS; i++) {
    ColorRef &ref = cal.sensors[channel].colors[i];
    int32_t dr = (int32_t)(nr - ref.r);
    int32_t dg = (int32_t)(ng - ref.g);
    int32_t db = (int32_t)(nb - ref.b);
    int32_t ds = (int32_t)(sc - ref.sc);
    int32_t dist = dr*dr + dg*dg + db*db + ds*ds;
    if (dist < best_dist) {
      best_dist = dist;
      best_idx = (i < NUM_COLORS) ? (int8_t)i : -1;
    }
  }

  return best_idx;
}

// --- EEPROM Calibration ---
void save_calibration() {
  EEPROM.write(0, EEPROM_MAGIC);
  EEPROM.write(1, EEPROM_VERSION);
  uint8_t *data = (uint8_t*)&cal;
  for (uint16_t i = 0; i < sizeof(CalibrationData); i++) {
    EEPROM.write(2 + i, data[i]);
  }
}

void load_calibration() {
  if (EEPROM.read(0) != EEPROM_MAGIC || EEPROM.read(1) != EEPROM_VERSION) {
    cal.valid = false;
    return;
  }
  uint8_t *data = (uint8_t*)&cal;
  for (uint16_t i = 0; i < sizeof(CalibrationData); i++) {
    data[i] = EEPROM.read(2 + i);
  }
}

// --- Sensor Reading ---
bool read_sensor(uint8_t channel, uint16_t &r, uint16_t &g, uint16_t &b,
                 uint16_t &c, uint8_t &prox) {
  if (!sensor_ok[channel]) return false;
  mux_select(channel);
  delay(5);

  // Wait for color data ready
  if (!apds[channel].colorDataReady()) {
    delay(50);
    if (!apds[channel].colorDataReady()) {
      mux_disable();
      return false;
    }
  }

  apds[channel].getColorData(&r, &g, &b, &c);
  prox = apds[channel].readProximity();
  mux_disable();
  return true;
}

// --- Command: Read All Sensors ---
void cmd_read_sensors() {
  JsonDocument doc;
  doc["type"] = "sensors";

  JsonArray positions = doc["ligandPositions"].to<JsonArray>();
  JsonArray colors = doc["colors"].to<JsonArray>();
  JsonArray raw = doc["raw"].to<JsonArray>();

  for (uint8_t ch = 0; ch < NUM_SENSORS; ch++) {
    uint16_t r, g, b, c;
    uint8_t prox;

    if (read_sensor(ch, r, g, b, c, prox)) {
      int8_t idx = classify_color(r, g, b, c, prox, ch);
      positions.add(idx);
      if (idx >= 0 && idx < NUM_COLORS) {
        colors.add(COLOR_NAMES[idx]);
      } else {
        colors.add("None");
      }
      JsonObject rawObj = raw.add<JsonObject>();
      rawObj["r"] = r;
      rawObj["g"] = g;
      rawObj["b"] = b;
      rawObj["c"] = c;
      rawObj["prox"] = prox;
    } else {
      positions.add(-1);
      colors.add("None");
      raw.add(nullptr);
    }
  }

  serializeJson(doc, Serial);
  Serial.println();
}

// --- Command: Read RFID ---
void cmd_read_rfid() {
  JsonDocument doc;
  doc["type"] = "rfid";

  if (rfid.PICC_IsNewCardPresent() && rfid.PICC_ReadCardSerial()) {
    // Build UID string
    String uid = "";
    for (byte i = 0; i < rfid.uid.size; i++) {
      if (i > 0) uid += ":";
      if (rfid.uid.uidByte[i] < 0x10) uid += "0";
      uid += String(rfid.uid.uidByte[i], HEX);
    }
    uid.toUpperCase();

    // Also compute numeric UID for backwards compat with SimpleMFRC522
    unsigned long numericUid = 0;
    for (byte i = 0; i < rfid.uid.size && i < 4; i++) {
      numericUid = (numericUid << 8) | rfid.uid.uidByte[i];
    }

    doc["tag_id"] = String(numericUid);
    doc["tag_hex"] = uid;

    // Try reading text from block 1 (sector 0)
    doc["text"] = "";

    rfid.PICC_HaltA();
    rfid.PCD_StopCrypto1();
  } else {
    doc["tag_id"] = (const char*)nullptr;
  }

  serializeJson(doc, Serial);
  Serial.println();
}

// --- Command: Calibration Sample ---
void cmd_calibrate_sample(uint8_t channel) {
  // Take 10 samples and average
  int32_t sum_r = 0, sum_g = 0, sum_b = 0, sum_c = 0;
  int32_t sum_prox = 0;
  uint8_t count = 0;

  for (uint8_t i = 0; i < 10; i++) {
    uint16_t r, g, b, c;
    uint8_t prox;
    if (read_sensor(channel, r, g, b, c, prox)) {
      sum_r += r;
      sum_g += g;
      sum_b += b;
      sum_c += c;
      sum_prox += prox;
      count++;
    }
    delay(100);
  }

  JsonDocument doc;
  doc["type"] = "calibration_sample";
  doc["channel"] = channel;

  if (count > 0) {
    doc["r"] = sum_r / count;
    doc["g"] = sum_g / count;
    doc["b"] = sum_b / count;
    doc["c"] = sum_c / count;
    doc["prox"] = sum_prox / count;
    doc["samples"] = count;
  } else {
    doc["error"] = "no readings";
  }

  serializeJson(doc, Serial);
  Serial.println();
}

// --- Command: Save Calibration ---
void cmd_calibrate_save(JsonDocument &input) {
  JsonObject data = input["data"];

  // Parse calibration data from server
  for (uint8_t ch = 0; ch < NUM_SENSORS; ch++) {
    String ch_str = String(ch);
    if (!data["sensors"].containsKey(ch_str)) continue;

    JsonObject sensor_data = data["sensors"][ch_str];
    cal.sensors[ch].clear_max = data["clear_max"][ch_str] | 1;

    if (data["proximity_thresholds"].containsKey(ch_str)) {
      cal.sensors[ch].proximity_threshold = data["proximity_thresholds"][ch_str];
    }

    // Parse each color
    for (uint8_t i = 0; i < NUM_COLORS; i++) {
      if (sensor_data.containsKey(COLOR_NAMES[i])) {
        JsonObject cv = sensor_data[COLOR_NAMES[i]];
        cal.sensors[ch].colors[i].r = cv["r"];
        cal.sensors[ch].colors[i].g = cv["g"];
        cal.sensors[ch].colors[i].b = cv["b"];
        cal.sensors[ch].colors[i].sc = cv["sc"];
      }
    }

    // Parse "None"
    if (sensor_data.containsKey("None")) {
      JsonObject cv = sensor_data["None"];
      cal.sensors[ch].colors[NUM_COLORS].r = cv["r"];
      cal.sensors[ch].colors[NUM_COLORS].g = cv["g"];
      cal.sensors[ch].colors[NUM_COLORS].b = cv["b"];
      cal.sensors[ch].colors[NUM_COLORS].sc = cv["sc"];
    }
  }

  cal.valid = true;
  save_calibration();

  JsonDocument doc;
  doc["type"] = "calibration_saved";
  doc["size"] = sizeof(CalibrationData);
  serializeJson(doc, Serial);
  Serial.println();
}

// --- Command: Load Calibration ---
void cmd_calibrate_load() {
  JsonDocument doc;
  doc["type"] = "calibration";

  if (!cal.valid) {
    doc["valid"] = false;
    serializeJson(doc, Serial);
    Serial.println();
    return;
  }

  doc["valid"] = true;
  JsonObject sensors = doc["sensors"].to<JsonObject>();
  JsonObject clear_max = doc["clear_max"].to<JsonObject>();
  JsonObject prox_thresh = doc["proximity_thresholds"].to<JsonObject>();

  for (uint8_t ch = 0; ch < NUM_SENSORS; ch++) {
    String ch_str = String(ch);
    JsonObject sensor_obj = sensors[ch_str].to<JsonObject>();

    clear_max[ch_str] = cal.sensors[ch].clear_max;
    prox_thresh[ch_str] = cal.sensors[ch].proximity_threshold;

    for (uint8_t i = 0; i < NUM_COLORS; i++) {
      JsonObject cv = sensor_obj[COLOR_NAMES[i]].to<JsonObject>();
      cv["r"] = cal.sensors[ch].colors[i].r;
      cv["g"] = cal.sensors[ch].colors[i].g;
      cv["b"] = cal.sensors[ch].colors[i].b;
      cv["sc"] = cal.sensors[ch].colors[i].sc;
    }

    // None
    JsonObject cv = sensor_obj["None"].to<JsonObject>();
    cv["r"] = cal.sensors[ch].colors[NUM_COLORS].r;
    cv["g"] = cal.sensors[ch].colors[NUM_COLORS].g;
    cv["b"] = cal.sensors[ch].colors[NUM_COLORS].b;
    cv["sc"] = cal.sensors[ch].colors[NUM_COLORS].sc;
  }

  serializeJson(doc, Serial);
  Serial.println();
}

// --- Process Serial Command ---
void process_command(const String &line) {
  JsonDocument doc;
  DeserializationError err = deserializeJson(doc, line);

  if (err) {
    JsonDocument errDoc;
    errDoc["type"] = "error";
    errDoc["message"] = String("JSON parse error: ") + err.c_str();
    serializeJson(errDoc, Serial);
    Serial.println();
    return;
  }

  const char* cmd = doc["cmd"];
  if (!cmd) return;

  if (strcmp(cmd, "read_sensors") == 0) {
    cmd_read_sensors();
  } else if (strcmp(cmd, "read_rfid") == 0) {
    cmd_read_rfid();
  } else if (strcmp(cmd, "calibrate_sample") == 0) {
    uint8_t ch = doc["channel"] | 0;
    cmd_calibrate_sample(ch);
  } else if (strcmp(cmd, "calibrate_save") == 0) {
    cmd_calibrate_save(doc);
  } else if (strcmp(cmd, "calibrate_load") == 0) {
    cmd_calibrate_load();
  } else if (strcmp(cmd, "ping") == 0) {
    JsonDocument pong;
    pong["type"] = "pong";
    pong["sensors"] = NUM_SENSORS;
    pong["calibrated"] = cal.valid;
    serializeJson(pong, Serial);
    Serial.println();
  } else {
    JsonDocument errDoc;
    errDoc["type"] = "error";
    errDoc["message"] = String("Unknown command: ") + cmd;
    serializeJson(errDoc, Serial);
    Serial.println();
  }
}

// --- Button Handling ---
void check_buttons() {
  unsigned long now = millis();
  for (uint8_t i = 0; i < 3; i++) {
    if (digitalRead(BUTTON_PINS[i]) == LOW && (now - last_btn_time[i]) > DEBOUNCE_MS) {
      last_btn_time[i] = now;

      JsonDocument doc;
      doc["type"] = "button";
      doc["button"] = BUTTON_NAMES[i];
      serializeJson(doc, Serial);
      Serial.println();
    }
  }
}

// --- Setup ---
void setup() {
  Serial.begin(115200);
  while (!Serial) delay(10);

  // Buttons with internal pull-up
  for (uint8_t i = 0; i < 3; i++) {
    pinMode(BUTTON_PINS[i], INPUT_PULLUP);
  }

  // I2C
  Wire.begin();
  Wire.setClock(400000);  // 400kHz fast mode

  // SPI + RFID
  SPI.begin();
  rfid.PCD_Init();
  delay(50);

  // Sensors
  init_sensors();

  // Load calibration from EEPROM
  load_calibration();

  // Ready signal
  JsonDocument doc;
  doc["type"] = "ready";
  uint8_t sensor_count = 0;
  for (uint8_t i = 0; i < NUM_SENSORS; i++) {
    if (sensor_ok[i]) sensor_count++;
  }
  doc["sensors"] = sensor_count;
  doc["rfid"] = rfid.PCD_PerformSelfTest();
  rfid.PCD_Init();  // re-init after self test
  doc["calibrated"] = cal.valid;
  doc["eeprom_size"] = (int)sizeof(CalibrationData) + 2;
  serializeJson(doc, Serial);
  Serial.println();
}

// --- Main Loop ---
void loop() {
  // Check for serial commands
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\n') {
      input_buffer.trim();
      if (input_buffer.length() > 0) {
        process_command(input_buffer);
      }
      input_buffer = "";
    } else {
      input_buffer += c;
    }
  }

  // Check buttons (push events unprompted)
  check_buttons();
}
