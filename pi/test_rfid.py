"""Test script for the MFRC522 RFID reader.

Initializes the reader using the same code path as rfid_service.py, then
continuously scans for tags and prints their UIDs. Also checks the puzzle
index for any existing mapping.

Usage:
    python test_rfid.py              # Continuous scan (blocking reads)
    python test_rfid.py --poll       # Non-blocking polling mode
    python test_rfid.py --once       # Read one tag and exit
    python test_rfid.py --lookup     # Also show puzzle mapping if found
"""

import argparse
import sys
import time

from rfid_service import RFIDService


def main():
    parser = argparse.ArgumentParser(description="Test MFRC522 RFID reader")
    parser.add_argument("--once", action="store_true",
                        help="Read one tag and exit")
    parser.add_argument("--poll", action="store_true",
                        help="Use non-blocking polling instead of blocking read")
    parser.add_argument("--lookup", action="store_true",
                        help="Check puzzle index for each scanned tag")
    parser.add_argument("--interval", type=float, default=0.5,
                        help="Polling interval in seconds (default: 0.5, --poll only)")
    args = parser.parse_args()

    print("=== MFRC522 RFID Reader Test ===")
    print("Initializing reader...\n")

    service = RFIDService()
    service.initialize()

    if service.reader is None:
        print("ERROR: RFID reader failed to initialize.")
        print("Check that SPI is enabled (raspi-config) and wiring is correct.")
        print("See SETUP.md Step 2 for wiring diagram.")
        sys.exit(1)

    print("Reader initialized OK.")
    if args.lookup:
        count = len([k for k in service.puzzle_index if not k.startswith("_")])
        print(f"Puzzle index loaded: {count} tag(s) registered.")
    print()

    seen_uids = set()

    if args.poll:
        print("Polling for tags (Ctrl+C to stop)...\n")
        try:
            while True:
                tag_id, text = service.read_tag_no_block()
                if tag_id is not None:
                    uid_str = str(tag_id)
                    is_new = uid_str not in seen_uids
                    seen_uids.add(uid_str)
                    print_tag(uid_str, text, is_new, service if args.lookup else None)
                    if args.once:
                        break
                time.sleep(args.interval)
        except KeyboardInterrupt:
            print("\n\nDone.")
    else:
        prompt = "Place a tag on the reader..." if args.once else \
                 "Place a tag on the reader (Ctrl+C to stop)..."
        print(prompt + "\n")
        try:
            while True:
                tag_id, text = service.read_tag()
                if tag_id is not None:
                    uid_str = str(tag_id)
                    is_new = uid_str not in seen_uids
                    seen_uids.add(uid_str)
                    print_tag(uid_str, text, is_new, service if args.lookup else None)
                    if args.once:
                        break
                    print("\nPlace next tag...")
                else:
                    print("Read failed — try again.")
        except KeyboardInterrupt:
            print("\n\nDone.")

    if seen_uids:
        print(f"\nUIDs seen this session ({len(seen_uids)}):")
        for uid in sorted(seen_uids):
            print(f"  {uid}")


def print_tag(uid_str, text, is_new, service=None):
    """Print tag info to the console."""
    label = "NEW" if is_new else "   "
    print(f"  [{label}] UID: {uid_str}")
    if text:
        print(f"         Data: '{text}'")

    if service is not None:
        puzzle = service.lookup_puzzle(uid_str)
        if puzzle:
            name = puzzle.get("name", puzzle.get("title", "unnamed"))
            tissues = puzzle.get("tissues", [])
            print(f"         Puzzle: {name} ({len(tissues)} tissues)")
        else:
            print(f"         Puzzle: (not registered)")


if __name__ == "__main__":
    main()
