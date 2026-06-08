"""Power control for simulation PCs from the Pi.

- Wake-on-LAN sends a UDP magic packet to each PC's MAC address.
- Shutdown SSHs into each PC and runs the Windows shutdown command.

Per-PC config lives in sim_pcs.json (gitignored). Copy sim_pcs.example.json
to sim_pcs.json and fill in real MAC addresses, IPs, and SSH usernames.

One-time setup on each sim PC (see exhibit_pc/SETUP.md for details):
  1. Enable Wake-on-LAN in BIOS and in Windows NIC advanced properties.
  2. Install Windows OpenSSH Server (Settings → Optional features).
  3. Append the Pi's SSH public key to
     C:\\ProgramData\\ssh\\administrators_authorized_keys (admin users) or
     %USERPROFILE%\\.ssh\\authorized_keys (non-admin users).
  4. From the Pi, verify: `ssh <user>@<simpc> hostname` returns without prompt.

CLI:
  python control_sims.py on              # wake all
  python control_sims.py off             # shutdown all
  python control_sims.py on --pc sim1    # one PC
  python control_sims.py list            # print config
"""

import argparse
import json
import logging
import os
import socket
import subprocess
from concurrent.futures import ThreadPoolExecutor
from typing import Dict, List, Tuple

logger = logging.getLogger(__name__)

SIM_PCS_PATH = os.path.join(os.path.dirname(__file__), "sim_pcs.json")
WOL_BROADCAST_ADDR = "255.255.255.255"
WOL_PORTS = (9, 7)
SSH_CONNECT_TIMEOUT_SECS = 5
SSH_OVERALL_TIMEOUT_SECS = 15
SHUTDOWN_COMMAND = 'shutdown /s /t 5 /c "TDD remote shutdown"'


def load_pcs() -> Dict[str, dict]:
    if not os.path.exists(SIM_PCS_PATH):
        raise FileNotFoundError(
            f"{SIM_PCS_PATH} not found. Copy sim_pcs.example.json to sim_pcs.json "
            "and fill in MAC addresses, hostnames, and SSH users."
        )
    with open(SIM_PCS_PATH) as f:
        return json.load(f)


def _mac_to_bytes(mac: str) -> bytes:
    cleaned = mac.replace(":", "").replace("-", "").replace(" ", "")
    if len(cleaned) != 12:
        raise ValueError(f"invalid MAC: {mac!r}")
    return bytes.fromhex(cleaned)


def _magic_packet(mac: str) -> bytes:
    return b"\xff" * 6 + _mac_to_bytes(mac) * 16


def wake_pc(name: str, cfg: dict) -> Tuple[bool, str]:
    mac = cfg.get("mac")
    if not mac:
        return False, "missing mac"
    try:
        packet = _magic_packet(mac)
    except ValueError as e:
        return False, str(e)
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
            for port in WOL_PORTS:
                s.sendto(packet, (WOL_BROADCAST_ADDR, port))
        return True, "magic packet sent"
    except OSError as e:
        return False, f"WoL send failed: {e}"


def shutdown_pc(name: str, cfg: dict) -> Tuple[bool, str]:
    host = cfg.get("host")
    user = cfg.get("ssh_user")
    if not host or not user:
        return False, "missing host or ssh_user"
    cmd = [
        "ssh",
        "-o", "BatchMode=yes",
        "-o", "StrictHostKeyChecking=accept-new",
        "-o", f"ConnectTimeout={SSH_CONNECT_TIMEOUT_SECS}",
        f"{user}@{host}",
        SHUTDOWN_COMMAND,
    ]
    try:
        result = subprocess.run(
            cmd, capture_output=True, text=True, timeout=SSH_OVERALL_TIMEOUT_SECS
        )
        if result.returncode == 0:
            return True, "shutdown initiated"
        stderr = (result.stderr or result.stdout or "").strip().replace("\n", " ")
        return False, f"ssh exit {result.returncode}: {stderr[:200]}"
    except subprocess.TimeoutExpired:
        return False, "ssh timeout"
    except FileNotFoundError:
        return False, "ssh not installed on Pi"


def wake_all() -> List[dict]:
    pcs = load_pcs()
    return [
        {"name": name, "ok": ok, "message": msg}
        for name, cfg in pcs.items()
        for ok, msg in [wake_pc(name, cfg)]
    ]


def shutdown_all() -> List[dict]:
    pcs = load_pcs()
    if not pcs:
        return []
    # SSH per PC takes up to SSH_OVERALL_TIMEOUT_SECS; fan out so total is
    # bounded by the slowest single PC rather than the sum.
    with ThreadPoolExecutor(max_workers=len(pcs)) as pool:
        futures = {name: pool.submit(shutdown_pc, name, cfg) for name, cfg in pcs.items()}
        return [
            {"name": name, "ok": ok, "message": msg}
            for name, f in futures.items()
            for ok, msg in [f.result()]
        ]


def main():
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    parser = argparse.ArgumentParser(description="Power control for sim PCs.")
    parser.add_argument("action", choices=["on", "off", "list"])
    parser.add_argument("--pc", help="Target a single PC by name (default: all).")
    args = parser.parse_args()

    pcs = load_pcs()
    if args.pc:
        if args.pc not in pcs:
            parser.error(f"unknown pc {args.pc!r} (have: {', '.join(pcs)})")
        pcs = {args.pc: pcs[args.pc]}

    if args.action == "list":
        for name, cfg in pcs.items():
            print(f"  {name}: mac={cfg.get('mac')}  host={cfg.get('host')}  user={cfg.get('ssh_user')}")
        return

    fn = wake_pc if args.action == "on" else shutdown_pc
    for name, cfg in pcs.items():
        ok, msg = fn(name, cfg)
        print(f"  [{'OK  ' if ok else 'FAIL'}] {name}: {msg}")


if __name__ == "__main__":
    main()
