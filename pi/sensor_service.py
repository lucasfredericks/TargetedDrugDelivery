"""I2C sensor service for reading 6 APDS-9960 color sensors via TCA9548A multiplexer.

Each sensor reads the color of one ligand slot on the physical nanoparticle model.
Proximity is used as a hint for empty slot detection when available; color matching
uses 4D Euclidean distance (normalized R, G, B + normalized Clear).
"""

import json
import math
import logging

import board
import busio
import adafruit_tca9548a
from adafruit_apds9960.apds9960 import APDS9960

from config import (
    MUX_ADDRESS, NUM_SENSORS, LIGAND_COLORS, COLOR_MAP_PATH, COLOR_NONE,
    COLOR_GAIN, COLOR_INTEGRATION_TIME
)

logger = logging.getLogger(__name__)


class SensorService:
    """Reads 6 APDS-9960 color sensors through a TCA9548A I2C multiplexer."""

    def __init__(self):
        self.i2c = None
        self.mux = None
        self.sensors = []
        self.sensor_color_maps = {}  # {channel: {color_name: (r, g, b, nc)}}
        self.proximity_thresholds = {}  # {channel: int}

    def initialize(self):
        """Set up I2C bus, multiplexer, and all 6 sensors."""
        self._load_color_map()

        self.i2c = busio.I2C(board.SCL, board.SDA)
        self.mux = adafruit_tca9548a.TCA9548A(self.i2c, address=MUX_ADDRESS)

        self.sensors = []
        for channel in range(NUM_SENSORS):
            try:
                sensor = APDS9960(self.mux[channel])
                sensor.color_gain = COLOR_GAIN
                sensor.color_integration_time = COLOR_INTEGRATION_TIME
                sensor.enable_color = True
                sensor.enable_proximity = True
                self.sensors.append(sensor)
                logger.info("Initialized APDS-9960 on mux channel %d", channel)
            except Exception as e:
                logger.error("Failed to init sensor on channel %d: %s", channel, e)
                self.sensors.append(None)

    def _load_color_map(self):
        """Load per-sensor RGBC reference values from color_map.json."""
        with open(COLOR_MAP_PATH, "r") as f:
            data = json.load(f)

        self.sensor_color_maps = {}
        if "sensors" not in data:
            logger.warning("color_map.json missing 'sensors' key — "
                           "run color_calibration.py to generate it")
            return

        for ch_str, colors in data["sensors"].items():
            ch = int(ch_str)
            self.sensor_color_maps[ch] = {}
            for name, rgb in colors.items():
                self.sensor_color_maps[ch][name] = (
                    rgb["r"], rgb["g"], rgb["b"], rgb.get("nc", 0)
                )

        self.proximity_thresholds = {}
        for ch_str, threshold in data.get("proximity_thresholds", {}).items():
            self.proximity_thresholds[int(ch_str)] = threshold

        logger.info("Loaded per-sensor color maps for %d sensors",
                     len(self.sensor_color_maps))

    def read_raw(self, channel):
        """Read raw RGBC values from a single sensor channel.

        Returns (r, g, b, c) tuple or None if sensor unavailable.
        """
        if channel >= len(self.sensors) or self.sensors[channel] is None:
            return None

        try:
            r, g, b, c = self.sensors[channel].color_data
            return (r, g, b, c)
        except Exception as e:
            logger.error("Error reading sensor channel %d: %s", channel, e)
            return None

    def read_proximity(self, channel):
        """Read proximity value (0-255) from a single sensor channel.

        Higher values mean closer objects. Returns None if sensor unavailable.
        """
        if channel >= len(self.sensors) or self.sensors[channel] is None:
            return None

        try:
            return self.sensors[channel].proximity
        except Exception as e:
            logger.error("Error reading proximity channel %d: %s", channel, e)
            return None

    def normalize_rgb(self, r, g, b):
        """Normalize raw RGB to ratios using the RGB sum.

        Produces light-independent color fingerprints by dividing each
        channel by the total (R+G+B), then scaling to 0-1000 for precision.
        """
        total = r + g + b
        if total == 0:
            return (0, 0, 0)

        return (
            round(1000.0 * r / total),
            round(1000.0 * g / total),
            round(1000.0 * b / total)
        )

    def normalize_clear(self, r, g, b, c):
        """Normalize clear channel relative to RGB sum, scaled to 0-1000.

        This captures how much light passes through vs. how much is
        color-filtered, on the same scale as normalized RGB.
        """
        total = r + g + b
        if total == 0:
            return 0
        return round(1000.0 * c / total)

    def classify_color(self, r, g, b, c, channel):
        """Map normalized RGBC to the nearest calibrated color for this sensor.

        Uses proximity as a confident "empty" signal when well below threshold.
        Falls back to 4D color matching (including "None" as a calibrated color)
        so materials that don't reflect IR (e.g. green) still get classified.
        Returns (color_name, color_index).
        """
        # Use proximity only when confidently empty (well below threshold)
        threshold = self.proximity_thresholds.get(channel)
        if threshold is not None:
            prox = self.read_proximity(channel)
            if prox is not None and prox < threshold * 0.5:
                return ("None", COLOR_NONE)

        color_map = self.sensor_color_maps.get(channel, {})
        if not color_map:
            return ("None", COLOR_NONE)

        nr, ng, nb = self.normalize_rgb(r, g, b)
        nc = self.normalize_clear(r, g, b, c)

        best_name = "None"
        best_dist = float("inf")

        for name, (ref_r, ref_g, ref_b, ref_nc) in color_map.items():
            dist = math.sqrt(
                (nr - ref_r) ** 2 +
                (ng - ref_g) ** 2 +
                (nb - ref_b) ** 2 +
                (nc - ref_nc) ** 2
            )
            if dist < best_dist:
                best_dist = dist
                best_name = name

        if best_name in LIGAND_COLORS:
            return (best_name, LIGAND_COLORS.index(best_name))
        return ("None", COLOR_NONE)

    def read_all(self):
        """Read all 6 sensors and return ligand positions array.

        Returns a dict with:
          - ligandPositions: [int] array of 6 color indices (-1 for empty)
          - colors: [str] array of 6 color names
          - raw: [dict] raw RGBC data per channel (for debugging)
        """
        ligand_positions = []
        color_names = []
        raw_data = []

        for ch in range(NUM_SENSORS):
            reading = self.read_raw(ch)
            if reading is None:
                ligand_positions.append(COLOR_NONE)
                color_names.append("None")
                raw_data.append(None)
                continue

            r, g, b, c = reading
            name, index = self.classify_color(r, g, b, c, ch)

            ligand_positions.append(index)
            color_names.append(name)
            raw_data.append({"r": r, "g": g, "b": b, "c": c})

        logger.info("Sensor read: %s", color_names)

        return {
            "ligandPositions": ligand_positions,
            "colors": color_names,
            "raw": raw_data
        }
