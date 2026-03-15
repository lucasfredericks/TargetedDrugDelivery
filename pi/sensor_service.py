"""I2C sensor service for reading 6 APDS-9960 color sensors via TCA9548A multiplexer.

Each sensor reads the color of one ligand slot on the physical nanoparticle model.
Color matching uses 4D Euclidean distance: clear-normalized RGB for hue plus
scaled raw clear for brightness. Proximity is used as a hint for empty detection.
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
        self.sensor_color_maps = {}  # {channel: {color_name: (r, g, b, sc)}}
        self.proximity_thresholds = {}  # {channel: int}
        self.clear_max = {}  # {channel: int} for scaling raw clear to 0-1000

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
        """Load per-sensor color reference values from color_map.json."""
        with open(COLOR_MAP_PATH, "r") as f:
            data = json.load(f)

        self.sensor_color_maps = {}
        if "sensors" not in data:
            logger.warning("color_map.json missing 'sensors' key — "
                           "run color_calibration.py to generate it")
            return

        self.clear_max = {}
        for ch_str, val in data.get("clear_max", {}).items():
            self.clear_max[int(ch_str)] = val

        for ch_str, colors in data["sensors"].items():
            ch = int(ch_str)
            self.sensor_color_maps[ch] = {}
            for name, vals in colors.items():
                self.sensor_color_maps[ch][name] = (
                    vals["r"], vals["g"], vals["b"], vals.get("sc", 0)
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

    def normalize_by_clear(self, r, g, b, c):
        """Normalize RGB by the clear channel, scaled to 0-1000.

        Dividing by clear compensates for brightness while preserving
        more color information than dividing by the RGB sum.
        """
        if c == 0:
            return (0, 0, 0)

        return (
            round(1000.0 * r / c),
            round(1000.0 * g / c),
            round(1000.0 * b / c)
        )

    def scale_clear(self, c, channel):
        """Scale raw clear channel to 0-1000 using per-sensor max from calibration."""
        max_c = self.clear_max.get(channel, 1)
        if max_c == 0:
            return 0
        return round(1000.0 * c / max_c)

    def classify_color(self, r, g, b, c, channel):
        """Map reading to the nearest calibrated color using 4D distance.

        Uses clear-normalized RGB (hue) + scaled raw clear (brightness).
        Hue separates Blue/Green; brightness separates Red/Orange.
        Proximity provides a confident "empty" shortcut when available.
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

        nr, ng, nb = self.normalize_by_clear(r, g, b, c)
        sc = self.scale_clear(c, channel)

        best_name = "None"
        best_dist = float("inf")

        for name, (ref_r, ref_g, ref_b, ref_sc) in color_map.items():
            dist = math.sqrt(
                (nr - ref_r) ** 2 +
                (ng - ref_g) ** 2 +
                (nb - ref_b) ** 2 +
                (sc - ref_sc) ** 2
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
