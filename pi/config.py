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
COLOR_GAIN = 2  # 16x
# color_integration_time: 1-256 cycles of 2.78ms (256=712ms max)
COLOR_INTEGRATION_TIME = 256

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

# RFID (MFRC522 via SPI)
RFID_RST_PIN = 6        # GPIO 6 (D6 on Qwiic pHAT)
RFID_SPI_BUS = 0        # SPI0
RFID_SPI_DEVICE = 0     # CE0 (CS pin on Qwiic pHAT)

# GPIO pin assignments (BCM numbering)
GPIO_BUTTON_SCAN = 17
GPIO_BUTTON_TEST = 27
GPIO_BUTTON_RESET = 22
GPIO_DEBOUNCE_MS = 300
