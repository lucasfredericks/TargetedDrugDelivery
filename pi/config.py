"""Shared configuration for the Targeted Drug Delivery exhibit Pi master."""

import os

# Network
SERVER_HOST = "0.0.0.0"
SERVER_PORT = 5000

# I2C multiplexer address (TCA9548A default)
MUX_ADDRESS = 0x70

# Number of APDS-9960 sensors (one per ligand slot on the nanoparticle)
NUM_SENSORS = 6

# APDS-9960 color sensing settings
# color_gain: 0=1x, 1=4x, 2=16x, 3=64x
COLOR_GAIN = 1  # 4x
# color_integration_time: 1-256 cycles of 2.78ms (256=712ms max)
# 16 cycles (~44ms) keeps the color engine responsive. Do NOT raise the gain to
# "compensate" for the short integration: the ADC full-scale ceiling scales with
# integration time, so the fill fraction depends on gain alone. At 16x the clear
# channel saturated (railed at ~16384), flattening brightness and hue. 4x keeps
# clear comfortably below full-scale at this integration time.
# NOTE: changing gain or integration time changes the raw R/G/B/C scale, so
# color_map.json MUST be regenerated (run color_calibration.py) after editing these.
COLOR_INTEGRATION_TIME = 16
# Max seconds to wait for a completed integration before reading color data.
COLOR_READ_TIMEOUT = 0.1
# How often the master polls all sensors and pushes to the display (seconds).
# Reads are cheap, so a short interval keeps input latency low.
SENSOR_POLL_INTERVAL_SECONDS = 0.3

# Ligand color names matching the simulation's color indices (0-5)
LIGAND_COLORS = ["Red", "Blue", "Green", "Purple", "Orange", "Yellow"]

# Color index mapping (matches simulation constants)
COLOR_NONE = -1
COLOR_RED = 0
COLOR_BLUE = 1
COLOR_GREEN = 2
COLOR_PURPLE = 3
COLOR_ORANGE = 4
COLOR_YELLOW = 5

# Paths
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
COLOR_MAP_PATH = os.path.join(BASE_DIR, "color_map.json")
PUZZLES_DIR = os.path.join(BASE_DIR, "puzzles")
PUZZLES_INDEX_PATH = os.path.join(PUZZLES_DIR, "index.json")

# Simulation defaults
DEFAULT_PARTICLE_COUNT = 1000
DEFAULT_TOXICITY = 2

# Stats update interval from clients (ms)
STATS_INTERVAL_MS = 800

# Maximum time (seconds) a test may run before the watchdog auto-resets.
# Covers: stalled sim clients, all clients disconnecting mid-test, runaway tests.
TEST_TIMEOUT_SECONDS = 120

# Arduino serial connection (PN532 RFID + start button)
SERIAL_PORT = "/dev/ttyACM0"   # Arduino Uno native USB
SERIAL_BAUD = 115200
SERIAL_TIMEOUT = 2             # seconds
