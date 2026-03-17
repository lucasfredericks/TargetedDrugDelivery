/*
 * TDD RFID + Button Controller
 *
 * Arduino firmware for the Targeted Drug Delivery exhibit.
 * Manages PN532 NFC/RFID reader and a start button, communicating
 * with the Pi master server over USB serial (JSON lines).
 *
 * Hardware:
 *   - Adafruit PN532 NFC/RFID Shield (SPI mode)
 *   - Start button on digital pin 8 (pulled high, active low)
 *   - Arduino Uno with shield stacked on top
 *
 * PN532 Shield SEL jumper settings (check silkscreen on your board):
 *   - I2C mode:  SEL0 = open,   SEL1 = open
 *   - SPI mode:  SEL0 = closed, SEL1 = closed
 *
 * PN532 Shield SPI bridge connections:
 *   - IRQ  → D2
 *   - RST  → D3
 *   - SCK  → D4
 *   - MISO → D5
 *   - SS   → D6
 *   - MOSI → D7
 *
 * Serial protocol (115200 baud, JSON lines):
 *   Arduino → Pi:
 *     {"type":"ready"}                          — startup complete
 *     {"type":"tag","uid":"AA:BB:CC:DD"}         — tag detected
 *     {"type":"tag_removed"}                     — tag removed from reader
 *     {"type":"button","id":"start"}             — start button pressed
 *   Pi → Arduino:
 *     {"cmd":"status"}                           — request current state
 *     {"cmd":"led","state":"on"|"off"}           — control shield LED (pin 13 not usable with shield)
 *
 * Dependencies (install via Arduino Library Manager):
 *   - Adafruit PN532 (by Adafruit)
 *   - Adafruit BusIO (dependency, auto-installed)
 */

#include <Adafruit_PN532.h>

// PN532 in SPI mode using software SPI on bridged pins
#define PN532_IRQ   2
#define PN532_RST   3
#define PN532_SCK   4
#define PN532_MISO  5
#define PN532_SS    6
#define PN532_MOSI  7

Adafruit_PN532 nfc(PN532_SCK, PN532_MISO, PN532_MOSI, PN532_SS);

// Button
#define BUTTON_START_PIN  8
#define DEBOUNCE_MS       300

// Tag polling
#define TAG_POLL_MS       250   // How often to check for tags
#define TAG_TIMEOUT_MS    1000  // No-read time before "removed"

// State
bool tagPresent = false;
uint8_t lastUID[7] = {0};
uint8_t lastUIDLen = 0;
unsigned long lastTagSeen = 0;
unsigned long lastButtonPress = 0;
unsigned long lastPoll = 0;
bool nfcReady = false;

// Serial input buffer
String serialBuffer = "";

void setup() {
  Serial.begin(115200);
  while (!Serial) delay(10);  // Wait for USB serial

  pinMode(BUTTON_START_PIN, INPUT_PULLUP);

  // Reset PN532
  pinMode(PN532_RST, OUTPUT);
  digitalWrite(PN532_RST, LOW);
  delay(400);
  digitalWrite(PN532_RST, HIGH);
  delay(100);

  // Initialize PN532
  nfc.begin();
  uint32_t versiondata = nfc.getFirmwareVersion();
  if (!versiondata) {
    Serial.println("{\"type\":\"error\",\"msg\":\"PN532 not found\"}");
    nfcReady = false;
  } else {
    uint8_t ic = (versiondata >> 24) & 0xFF;
    uint8_t ver = (versiondata >> 16) & 0xFF;
    uint8_t rev = (versiondata >> 8) & 0xFF;

    // Configure for reading tags
    nfc.SAMConfig();
    nfcReady = true;

    Serial.print("{\"type\":\"ready\",\"ic\":\"");
    if (ic == 0x07) Serial.print("PN532");
    else Serial.print(ic);
    Serial.print("\",\"fw\":\"");
    Serial.print(ver);
    Serial.print(".");
    Serial.print(rev);
    Serial.println("\"}");
  }
}

void loop() {
  unsigned long now = millis();

  // Poll for NFC tags
  if (nfcReady && (now - lastPoll >= TAG_POLL_MS)) {
    lastPoll = now;
    pollTag(now);
  }

  // Check button
  checkButton(now);

  // Check for serial commands
  checkSerial();
}

void pollTag(unsigned long now) {
  uint8_t uid[7];
  uint8_t uidLen;

  // readPassiveTargetID with a short timeout (100ms)
  bool found = nfc.readPassiveTargetID(PN532_MIFARE_ISO14443A, uid, &uidLen, 100);

  if (found) {
    lastTagSeen = now;

    // Check if this is a new tag (different UID or was previously removed)
    if (!tagPresent || !uidMatch(uid, uidLen)) {
      tagPresent = true;
      memcpy(lastUID, uid, uidLen);
      lastUIDLen = uidLen;
      sendTagEvent(uid, uidLen);
    }
  } else {
    // No tag found — check if enough time passed to consider it removed
    if (tagPresent && (now - lastTagSeen >= TAG_TIMEOUT_MS)) {
      tagPresent = false;
      memset(lastUID, 0, sizeof(lastUID));
      lastUIDLen = 0;
      Serial.println("{\"type\":\"tag_removed\"}");
    }
  }
}

bool uidMatch(uint8_t *uid, uint8_t len) {
  if (len != lastUIDLen) return false;
  for (uint8_t i = 0; i < len; i++) {
    if (uid[i] != lastUID[i]) return false;
  }
  return true;
}

void sendTagEvent(uint8_t *uid, uint8_t len) {
  Serial.print("{\"type\":\"tag\",\"uid\":\"");
  for (uint8_t i = 0; i < len; i++) {
    if (uid[i] < 0x10) Serial.print("0");
    Serial.print(uid[i], HEX);
    if (i < len - 1) Serial.print(":");
  }
  Serial.println("\"}");
}

void checkButton(unsigned long now) {
  if (digitalRead(BUTTON_START_PIN) == LOW) {
    if (now - lastButtonPress >= DEBOUNCE_MS) {
      lastButtonPress = now;
      Serial.println("{\"type\":\"button\",\"id\":\"start\"}");
    }
  }
}

void checkSerial() {
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\n') {
      handleCommand(serialBuffer);
      serialBuffer = "";
    } else if (c != '\r') {
      serialBuffer += c;
    }
  }
}

void handleCommand(String cmd) {
  cmd.trim();
  if (cmd.length() == 0) return;

  if (cmd.indexOf("\"status\"") >= 0) {
    Serial.print("{\"type\":\"status\",\"nfc\":");
    Serial.print(nfcReady ? "true" : "false");
    Serial.print(",\"tag_present\":");
    Serial.print(tagPresent ? "true" : "false");
    if (tagPresent) {
      Serial.print(",\"uid\":\"");
      for (uint8_t i = 0; i < lastUIDLen; i++) {
        if (lastUID[i] < 0x10) Serial.print("0");
        Serial.print(lastUID[i], HEX);
        if (i < lastUIDLen - 1) Serial.print(":");
      }
      Serial.print("\"");
    }
    Serial.println("}");
  }
}
