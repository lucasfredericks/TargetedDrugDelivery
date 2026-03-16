"""Test script for Arduino I/O board over USB serial.

Verifies connectivity, sensor readings, RFID, and button events.

Usage:
    python test_arduino.py                    # Run all tests
    python test_arduino.py --port /dev/ttyACM0
    python test_arduino.py --sensors          # Continuous sensor readings
    python test_arduino.py --rfid             # Poll for RFID tags
    python test_arduino.py --buttons          # Listen for button presses
"""

import argparse
import time
import sys

from serial_service import SerialService
from config import SERIAL_PORT


def main():
    parser = argparse.ArgumentParser(description="Test Arduino I/O board")
    parser.add_argument("--port", default=SERIAL_PORT,
                        help=f"Serial port (default: {SERIAL_PORT})")
    parser.add_argument("--sensors", action="store_true",
                        help="Continuous sensor reading loop")
    parser.add_argument("--rfid", action="store_true",
                        help="Poll for RFID tags")
    parser.add_argument("--buttons", action="store_true",
                        help="Listen for button presses")
    parser.add_argument("--interval", type=float, default=1.0,
                        help="Polling interval in seconds (default: 1.0)")
    args = parser.parse_args()

    print("=== Arduino I/O Board Test ===\n")
    print(f"Connecting to {args.port}...")

    service = SerialService(port=args.port)
    service.initialize()

    if service.ser is None:
        print("ERROR: Could not connect to Arduino.")
        print("Check USB cable and port name.")
        sys.exit(1)

    print("Connected.\n")

    if args.sensors:
        test_sensors_loop(service, args.interval)
    elif args.rfid:
        test_rfid_loop(service, args.interval)
    elif args.buttons:
        test_buttons(service)
    else:
        test_all(service)

    service.cleanup()


def test_all(service):
    """Run a single pass of all tests."""
    print("--- Sensor Test ---")
    result = service.read_sensors()
    for ch in range(6):
        color = result["colors"][ch]
        pos = result["ligandPositions"][ch]
        raw = result["raw"][ch]
        if raw:
            print(f"  Sensor {ch}: {color} (idx={pos})  "
                  f"RGBC=({raw['r']}, {raw['g']}, {raw['b']}, {raw['c']})  "
                  f"Prox={raw.get('prox', '?')}")
        else:
            print(f"  Sensor {ch}: ERROR")

    print("\n--- RFID Test ---")
    print("  Checking for tag (quick poll)...")
    tag_id, text = service.read_rfid()
    if tag_id:
        print(f"  Tag found: {tag_id}")
    else:
        print(f"  No tag present")

    print("\n--- Button Test ---")
    print("  Buttons are event-driven. Use --buttons flag to listen.\n")

    print("All tests complete.")


def test_sensors_loop(service, interval):
    """Continuous sensor reading."""
    print("Reading sensors (Ctrl+C to stop)...\n")
    try:
        count = 0
        while True:
            count += 1
            result = service.read_sensors()
            colors = result["colors"]
            positions = result["ligandPositions"]
            print(f"[{count}] {' | '.join(f'{ch}:{c}' for ch, c in enumerate(colors))}")
            time.sleep(interval)
    except KeyboardInterrupt:
        print(f"\n\nDone. ({count} reads)")


def test_rfid_loop(service, interval):
    """Poll for RFID tags."""
    print("Polling for RFID tags (Ctrl+C to stop)...\n")
    seen = set()
    try:
        count = 0
        while True:
            count += 1
            tag_id, text = service.read_rfid()
            if tag_id:
                is_new = tag_id not in seen
                seen.add(tag_id)
                label = "NEW" if is_new else "   "
                print(f"  [{label}] UID: {tag_id}")
            time.sleep(interval)
    except KeyboardInterrupt:
        print(f"\n\nDone. ({count} polls, {len(seen)} unique tags)")


def test_buttons(service):
    """Listen for button presses."""
    print("Listening for button presses (Ctrl+C to stop)...\n")

    presses = []

    def on_btn(name):
        def handler():
            presses.append(name)
            print(f"  Button: {name}")
        return handler

    service.on_scan(on_btn("scan"))
    service.on_test(on_btn("test"))
    service.on_reset(on_btn("reset"))

    try:
        while True:
            time.sleep(0.1)
    except KeyboardInterrupt:
        print(f"\n\nDone. ({len(presses)} presses)")


if __name__ == "__main__":
    main()
