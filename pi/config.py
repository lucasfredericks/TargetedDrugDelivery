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
#
# One value applies to every sensor. A list of NUM_SENSORS values sets each
# sensor separately, for a slot that receives more light than the rest and rails
# its clear channel. That is safe here because every calibrated reference and
# both match features are normalized per sensor (see sensor_service:
# normalize_by_clear divides by clear, scale_clear divides by that channel's own
# clear_max) and nothing ever compares brightness between sensors. Prefer
# fixing the light -- shroud, mounting height, ambient leak -- since the gain
# steps are coarse (4x apart) and uniform sensors are easier to reason about.
#
#     COLOR_GAIN = 1                    # 4x on all six
#     COLOR_GAIN = [1, 1, 1, 0, 0, 1]   # 1x on channels 3 and 4
COLOR_GAIN = 1  # 4x
# color_integration_time: 1-256 cycles of 2.78ms (256=712ms max)
# 16 cycles (~44ms) keeps the color engine responsive. Do NOT raise the gain to
# "compensate" for the short integration: full-scale count is 1024 * cycles, so
# at 16 cycles the ADC rails at 16384 -- and because the accumulated counts and
# that ceiling both scale with integration time, the fill fraction depends on
# gain alone. Lowering integration time does not cure saturation, it only costs
# resolution. At 16x the clear channel railed, flattening brightness. 4x keeps
# clear below full-scale at this integration time.
#
# This is deliberately not per-sensor: COLOR_READ_TIMEOUT and the poll loop
# assume one integration period for every sensor.
COLOR_INTEGRATION_TIME = 16
# Max seconds to wait for a completed integration before reading color data.
COLOR_READ_TIMEOUT = 0.1
# How often the master polls all sensors and pushes to the display (seconds).
# Reads are cheap, so a short interval keeps input latency low.
SENSOR_POLL_INTERVAL_SECONDS = 0.3

def color_gain_for(channel):
    """The gain setting for one sensor channel.

    COLOR_GAIN is either a single value shared by every sensor or a list of
    NUM_SENSORS values, one per channel.
    """
    if isinstance(COLOR_GAIN, (list, tuple)):
        if len(COLOR_GAIN) != NUM_SENSORS:
            raise ValueError(
                "COLOR_GAIN has {} entries but there are {} sensors; give one "
                "value per sensor or a single value for all of them".format(
                    len(COLOR_GAIN), NUM_SENSORS))
        return COLOR_GAIN[channel]
    return COLOR_GAIN


def color_gain_list():
    """Gain per channel, always as a list -- what gets recorded in color_map.json."""
    return [color_gain_for(ch) for ch in range(NUM_SENSORS)]


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
# color_map.json and puzzles/index.json are installation state: generated on
# this device by color_calibration.py and the /admin tag pairing UI, gitignored
# so no pull or branch switch can touch them, and snapshotted to the
# installation-state branch by installation_config.py. The .example files are
# tracked placeholders that let a fresh clone boot.
COLOR_MAP_PATH = os.path.join(BASE_DIR, "color_map.json")
COLOR_MAP_EXAMPLE_PATH = COLOR_MAP_PATH + ".example"
PUZZLES_DIR = os.path.join(BASE_DIR, "puzzles")
PUZZLES_INDEX_PATH = os.path.join(PUZZLES_DIR, "index.json")
PUZZLES_INDEX_EXAMPLE_PATH = PUZZLES_INDEX_PATH + ".example"

# Simulation defaults
DEFAULT_PARTICLE_COUNT = 1000
DEFAULT_TOXICITY = 2

# Stats update interval from clients (ms)
STATS_INTERVAL_MS = 800

# Maximum time (seconds) a test may run before the watchdog auto-resets.
# Covers: stalled sim clients, all clients disconnecting mid-test, runaway tests.
TEST_TIMEOUT_SECONDS = 120

# How long a screen that drops mid-test may take to come back before the server
# gives up on it. Sim clients reconnect on their own (see network.worker.js), so
# a momentary drop shouldn't cost a visitor their run. Swept by the test
# watchdog, so the real wait is this plus up to one 5s watchdog tick.
RECONNECT_GRACE_SECONDS = 15

# Health monitor: sampling period, the loop lag worth a warning, and how often
# to log a summary line. Lag is how far behind schedule the event loop is
# running; sustained lag above the Socket.IO ping timeout drops every client.
HEALTH_TICK_SECONDS = 1.0
HEALTH_LAG_WARN_SECONDS = 1.0
HEALTH_SUMMARY_SECONDS = 60

# Arduino serial connection (PN532 RFID + start button)
SERIAL_PORT = "/dev/ttyACM0"   # Arduino Uno native USB
SERIAL_BAUD = 115200
SERIAL_TIMEOUT = 2             # seconds
