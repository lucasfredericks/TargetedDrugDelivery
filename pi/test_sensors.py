"""Standalone test script for APDS-9960 sensors.

Continuously reads all 6 sensors and prints color detection results.
Useful for verifying hardware connections and calibration.

Usage:
    python test_sensors.py
    python test_sensors.py --raw       # Show raw RGBC values
    python test_sensors.py --single 0  # Read only channel 0
"""

import argparse
import time
import sys

from sensor_service import SensorService
from config import NUM_SENSORS


def main():
    parser = argparse.ArgumentParser(description="Test APDS-9960 color sensors")
    parser.add_argument("--raw", action="store_true", help="Show raw RGBC values")
    parser.add_argument("--single", type=int, default=-1,
                        help="Read only a single channel (0-5)")
    parser.add_argument("--interval", type=float, default=1.0,
                        help="Seconds between readings (default: 1.0)")
    args = parser.parse_args()

    print("=== APDS-9960 Sensor Test ===")
    print("Initializing sensors...\n")

    service = SensorService()
    try:
        service.initialize()
    except Exception as e:
        print(f"ERROR: Failed to initialize sensors: {e}")
        print("Make sure I2C is enabled (raspi-config) and hardware is connected.")
        sys.exit(1)

    # Report which sensors are available
    available = sum(1 for s in service.sensors if s is not None)
    print(f"Sensors available: {available}/{NUM_SENSORS}\n")

    if available == 0:
        print("No sensors detected. Check wiring and I2C configuration.")
        sys.exit(1)

    print("Reading sensors (Ctrl+C to stop)...\n")

    try:
        while True:
            if args.single >= 0:
                # Single channel mode
                ch = args.single
                raw = service.read_raw(ch)
                if raw is None:
                    print(f"Channel {ch}: NO SENSOR")
                else:
                    r, g, b, c = raw
                    name, idx = service.classify_color(r, g, b, c)
                    if args.raw:
                        print(f"Channel {ch}: {name} (idx={idx})  "
                              f"Raw: R={r} G={g} B={b} C={c}")
                    else:
                        print(f"Channel {ch}: {name} (idx={idx})")
            else:
                # All channels
                result = service.read_all()
                parts = []
                for ch in range(NUM_SENSORS):
                    color = result["colors"][ch]
                    idx = result["ligandPositions"][ch]
                    part = f"[{ch}]{color:>7}"
                    if args.raw and result["raw"][ch]:
                        rd = result["raw"][ch]
                        part += f"(R={rd['r']:>5} G={rd['g']:>5} B={rd['b']:>5} C={rd['c']:>5})"
                    parts.append(part)
                print("  ".join(parts))
                print(f"  → ligandPositions: {result['ligandPositions']}")

            time.sleep(args.interval)

    except KeyboardInterrupt:
        print("\n\nDone.")


if __name__ == "__main__":
    main()
