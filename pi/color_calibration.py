"""Calibration utility for APDS-9960 color sensors.

Run this script interactively on the Pi to calibrate color reference values
for each ligand color. Uses 4D matching: clear-normalized RGB for hue plus
scaled raw clear for brightness.

Empty slots ("None") are calibrated as a color like any other. Empty detection
uses color distance only — not proximity — since some ligand materials (e.g.
green) are IR-absorptive and produce unreliable proximity readings.

Usage:
    python color_calibration.py
"""

import json
import time
import sys

from sensor_service import SensorService
from config import (
    LIGAND_COLORS, COLOR_MAP_PATH, NUM_SENSORS, COLOR_INTEGRATION_TIME,
    color_gain_list,
)


def read_sensor_avg(service, channel, num_samples=10, delay=0.1):
    """Take multiple readings from a single sensor and return the average RGBC."""
    readings = []
    for _ in range(num_samples):
        raw = service.read_raw(channel)
        if raw is not None:
            readings.append(raw)
        time.sleep(delay)

    if not readings:
        return None

    avg_r = sum(r for r, g, b, c in readings) / len(readings)
    avg_g = sum(g for r, g, b, c in readings) / len(readings)
    avg_b = sum(b for r, g, b, c in readings) / len(readings)
    avg_c = sum(c for r, g, b, c in readings) / len(readings)
    return (avg_r, avg_g, avg_b, avg_c)


def calibrate():
    print("=== APDS-9960 Color Calibration Utility ===\n")
    print("This utility will help you calibrate the color sensors.")
    print(f"For each color, place that ligand under ALL {NUM_SENSORS} sensors,")
    print("then readings will be taken and stored per-sensor.\n")

    service = SensorService()
    service.initialize()

    # Per-sensor calibration: sensors[ch][color_name] = {r, g, b, raw_c}
    sensor_maps = {ch: {} for ch in range(NUM_SENSORS)}
    # Track raw clear values per sensor for computing max
    raw_clears = {ch: [] for ch in range(NUM_SENSORS)}

    for color_name in LIGAND_COLORS:
        input(f"\nPlace the {color_name} ligand under ALL sensors and press Enter...")

        for ch in range(NUM_SENSORS):
            print(f"  Reading sensor {ch}...", end="", flush=True)
            avg = read_sensor_avg(service, ch)
            if avg is None:
                print(" ERROR: no readings.")
                continue

            avg_r, avg_g, avg_b, avg_c = avg
            nr, ng, nb = service.normalize_by_clear(avg_r, avg_g, avg_b, avg_c)
            sensor_maps[ch][color_name] = {
                "r": nr, "g": ng, "b": nb, "raw_c": round(avg_c)
            }
            raw_clears[ch].append(round(avg_c))
            print(f" done. Raw RGBC: ({avg_r:.0f}, {avg_g:.0f}, {avg_b:.0f}, {avg_c:.0f})"
                  f"  R/C G/C B/C: ({nr}, {ng}, {nb})")

    # Calibrate "None" (empty slot) per sensor as a color
    input("\nRemove all ligands (empty slots) and press Enter...")

    for ch in range(NUM_SENSORS):
        print(f"  Reading empty sensor {ch}...", end="", flush=True)
        avg = read_sensor_avg(service, ch)
        if avg is None:
            print(" ERROR: no readings.")
            continue

        avg_r, avg_g, avg_b, avg_c = avg
        nr, ng, nb = service.normalize_by_clear(avg_r, avg_g, avg_b, avg_c)
        sensor_maps[ch]["None"] = {
            "r": nr, "g": ng, "b": nb, "raw_c": round(avg_c)
        }
        raw_clears[ch].append(round(avg_c))

        print(f" done. R/C G/C B/C: ({nr}, {ng}, {nb})  Raw C: {avg_c:.0f}")

    # Compute max clear per sensor and scale clear to 0-1000
    clear_max = {}
    for ch in range(NUM_SENSORS):
        if raw_clears[ch]:
            clear_max[ch] = max(raw_clears[ch])
            for name in sensor_maps[ch]:
                raw_c = sensor_maps[ch][name]["raw_c"]
                sensor_maps[ch][name]["sc"] = round(1000.0 * raw_c / clear_max[ch])
                del sensor_maps[ch][name]["raw_c"]

    # Warn about any sensor that railed. Full-scale count is 1024 * cycles, so
    # a clear_max at that ceiling means the reading was clipped: brightness
    # stops discriminating (every color lands at sc=1000) and the exhibit
    # quietly loses the 4th matching dimension on that slot. Worth saying at
    # calibration time -- afterwards it is only visible by reading the numbers.
    full_scale = 1024 * COLOR_INTEGRATION_TIME
    railed = {}
    for ch in range(NUM_SENSORS):
        if clear_max.get(ch, 0) < full_scale:
            continue
        # sc is 1000 * raw_c / clear_max, so sc at 1000 means that color's raw
        # clear reading *is* the channel maximum -- i.e. it clipped.
        railed[ch] = sorted(n for n, v in sensor_maps[ch].items()
                            if v.get("sc", 0) >= 995)
    if railed:
        print()
        print("  WARNING: the clear channel hit its {}-count ceiling on "
              "sensor(s) {}.".format(
                  full_scale, ", ".join(str(c) for c in sorted(railed))))
        for ch in sorted(railed):
            clipped = railed[ch]
            total = len(sensor_maps[ch])
            if len(clipped) >= 3:
                print("    sensor {}: {} of {} colors clipped -- brightness "
                      "carries no information on this slot, so colors are "
                      "matched on hue alone.".format(ch, len(clipped), total))
            else:
                print("    sensor {}: only {} clipped -- mild, but that "
                      "reference is inexact.".format(ch, ", ".join(clipped)))
        print("  Fix the light first: shroud, mounting height, ambient leak.")
        print("  Failing that, lower COLOR_GAIN for just those sensors -- see")
        print("  config.py, COLOR_GAIN -- and calibrate again. Lowering")
        print("  COLOR_INTEGRATION_TIME will not help: the ceiling scales with")
        print("  it too, so the fill fraction is unchanged.")


    # Save
    color_map = {
        "_comment": "Per-sensor 4D color values (hue + brightness). Generated by color_calibration.py.",
        "settings": {
            "color_gain": color_gain_list(),
            "color_integration_time": COLOR_INTEGRATION_TIME,
        },
        "sensors": {str(ch): colors for ch, colors in sensor_maps.items()},
        "clear_max": {str(ch): v for ch, v in clear_max.items()},
    }

    with open(COLOR_MAP_PATH, "w") as f:
        json.dump(color_map, f, indent=2)

    print(f"\nCalibration saved to {COLOR_MAP_PATH}")
    print("\nCalibrated values per sensor:")
    for ch in range(NUM_SENSORS):
        print(f"\n  Sensor {ch} (clear_max={clear_max.get(ch, '?')}):")
        for name, vals in sensor_maps[ch].items():
            print(f"    {name}: R/C={vals['r']}, G/C={vals['g']}, "
                  f"B/C={vals['b']}, SC={vals['sc']}")


if __name__ == "__main__":
    calibrate()
