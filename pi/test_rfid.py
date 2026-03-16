"""Test script for the MFRC522 RFID reader.

Initializes the reader using the same code path as rfid_service.py, then
continuously scans for tags and prints their UIDs. Also checks the puzzle
index for any existing mapping.

Usage:
    python test_rfid.py              # Continuous scan (blocking reads)
    python test_rfid.py --poll       # Non-blocking polling mode
    python test_rfid.py --once       # Read one tag and exit
    python test_rfid.py --lookup     # Also show puzzle mapping if found
    python test_rfid.py -v           # Verbose: show SPI, register, and antenna diagnostics
"""

import argparse
import os
import sys
import time

from rfid_service import RFIDService
from config import RFID_RST_PIN, RFID_SPI_BUS, RFID_SPI_DEVICE


def verbose_diagnostics(service):
    """Run detailed hardware diagnostics and print results."""
    print("--- Verbose Diagnostics ---\n")

    # Check SPI device file exists
    spi_dev = f"/dev/spidev{RFID_SPI_BUS}.{RFID_SPI_DEVICE}"
    print(f"SPI device:  {spi_dev}")
    if os.path.exists(spi_dev):
        print(f"  Status:    FOUND")
    else:
        print(f"  Status:    MISSING — is SPI enabled? (sudo raspi-config)")
        # List what SPI devices do exist
        spi_devs = [f for f in os.listdir("/dev") if f.startswith("spidev")]
        if spi_devs:
            print(f"  Available: {', '.join(spi_devs)}")
        else:
            print(f"  Available: (none)")

    # Check GPIO RST pin
    print(f"\nRST pin:     GPIO {RFID_RST_PIN}")

    # Check SPI config
    print(f"SPI bus:     {RFID_SPI_BUS}")
    print(f"SPI device:  {RFID_SPI_DEVICE}")

    # Try to read MFRC522 registers
    reader = service.reader
    if reader is None:
        print("\nCannot read registers — reader not initialized.")
        return

    mfrc = reader.reader  # The underlying MFRC522 instance

    # Detect which method name the library uses (original vs Pi 5 fork)
    if hasattr(mfrc, 'read_mfrc522'):
        read_reg = mfrc.read_mfrc522
    elif hasattr(mfrc, 'Read_MFRC522'):
        read_reg = mfrc.Read_MFRC522
    else:
        print(f"\nCannot read registers — unknown MFRC522 API.")
        print(f"  Available methods: {[m for m in dir(mfrc) if not m.startswith('_')]}")
        return

    print(f"\nMFRC522 register dump:")

    try:
        # Key MFRC522 registers (from datasheet)
        reg_names = {
            0x01: "CommandReg",
            0x02: "ComIEnReg",
            0x03: "DivIEnReg",
            0x04: "ComIrqReg",
            0x05: "DivIrqReg",
            0x06: "ErrorReg",
            0x08: "FIFODataReg",
            0x09: "FIFOLevelReg",
            0x0A: "WaterLevelReg",
            0x0B: "ControlReg",
            0x0C: "BitFramingReg",
            0x14: "TxControlReg",
            0x24: "CRCResultRegH",
            0x25: "CRCResultRegL",
            0x26: "ModWidthReg",
            0x2C: "TModeReg",
            0x2D: "TPrescalerReg",
            0x37: "VersionReg",
        }

        all_zero = True
        all_ff = True
        for addr, name in reg_names.items():
            val = read_reg(addr)
            print(f"  0x{addr:02X} {name:20s} = 0x{val:02X} ({val:3d})")
            if val != 0x00:
                all_zero = False
            if val != 0xFF:
                all_ff = False

        # Interpret results
        print()
        if all_zero:
            print("  WARNING: All registers read 0x00 — SPI communication likely not working.")
            print("           Check wiring (MOSI, MISO, SCK, SDA/CS) and solder joints.")
        elif all_ff:
            print("  WARNING: All registers read 0xFF — SPI bus floating.")
            print("           MISO line may be disconnected or chip not powered.")
        else:
            version = read_reg(0x37)
            if version == 0x91:
                print("  Chip version: MFRC522 v1.0 (expected)")
            elif version == 0x92:
                print("  Chip version: MFRC522 v2.0 (expected)")
            elif version == 0x88:
                print("  Chip version: clone/FM17522 (should work)")
            else:
                print(f"  Chip version: 0x{version:02X} (unexpected — may be a different chip)")

        # Check antenna status (TxControlReg bits 0-1 enable antenna)
        tx_control = read_reg(0x14)
        antenna_on = (tx_control & 0x03) == 0x03
        print(f"  Antenna:     {'ON' if antenna_on else 'OFF'} (TxControlReg=0x{tx_control:02X})")
        if not antenna_on:
            print("  WARNING: Antenna is OFF — tags will not be detected.")
            print("           This usually means initialization did not complete properly.")

        # Check for errors
        error_reg = read_reg(0x06)
        if error_reg:
            errors = []
            if error_reg & 0x01: errors.append("ProtocolErr")
            if error_reg & 0x02: errors.append("ParityErr")
            if error_reg & 0x04: errors.append("CRCErr")
            if error_reg & 0x08: errors.append("CollErr")
            if error_reg & 0x10: errors.append("BufferOvfl")
            if error_reg & 0x40: errors.append("TempErr")
            if error_reg & 0x80: errors.append("WrErr")
            print(f"  Errors:      {', '.join(errors)}")

    except Exception as e:
        print(f"  Register read failed: {e}")
        print("  This may indicate SPI communication is broken.")

    print("\n--- End Diagnostics ---\n")


def main():
    parser = argparse.ArgumentParser(description="Test MFRC522 RFID reader")
    parser.add_argument("--once", action="store_true",
                        help="Read one tag and exit")
    parser.add_argument("--poll", action="store_true",
                        help="Use non-blocking polling instead of blocking read")
    parser.add_argument("--lookup", action="store_true",
                        help="Check puzzle index for each scanned tag")
    parser.add_argument("-v", "--verbose", action="store_true",
                        help="Show detailed hardware diagnostics")
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
        if args.verbose:
            print("\nAttempting diagnostics anyway...")
            verbose_diagnostics(service)
        sys.exit(1)

    print("Reader initialized OK.")
    if args.verbose:
        verbose_diagnostics(service)
    if args.lookup:
        count = len([k for k in service.puzzle_index if not k.startswith("_")])
        print(f"Puzzle index loaded: {count} tag(s) registered.")
    print()

    seen_uids = set()

    poll_count = 0

    if args.poll:
        print("Polling for tags (Ctrl+C to stop)...\n")
        try:
            while True:
                poll_count += 1
                if args.verbose:
                    print(f"  [poll #{poll_count}] ", end="", flush=True)
                tag_id, text = service.read_tag_no_block()
                if tag_id is not None:
                    uid_str = str(tag_id)
                    is_new = uid_str not in seen_uids
                    seen_uids.add(uid_str)
                    if args.verbose:
                        print(f"TAG FOUND id={tag_id}")
                    print_tag(uid_str, text, is_new, service if args.lookup else None)
                    if args.once:
                        break
                else:
                    if args.verbose:
                        print("no tag")
                time.sleep(args.interval)
        except KeyboardInterrupt:
            print(f"\n\nDone. ({poll_count} polls)")
    else:
        prompt = "Place a tag on the reader..." if args.once else \
                 "Place a tag on the reader (Ctrl+C to stop)..."
        print(prompt + "\n")
        try:
            while True:
                poll_count += 1
                if args.verbose:
                    print(f"  [read #{poll_count}] waiting... ", end="", flush=True)
                tag_id, text = service.read_tag()
                if tag_id is not None:
                    uid_str = str(tag_id)
                    is_new = uid_str not in seen_uids
                    seen_uids.add(uid_str)
                    if args.verbose:
                        print(f"TAG FOUND id={tag_id}")
                    print_tag(uid_str, text, is_new, service if args.lookup else None)
                    if args.once:
                        break
                    print("\nPlace next tag...")
                else:
                    if args.verbose:
                        print("read returned None")
                    print("Read failed — try again.")
        except KeyboardInterrupt:
            print(f"\n\nDone. ({poll_count} reads)")

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
