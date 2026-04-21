#!/usr/bin/env python3

from __future__ import annotations

import argparse
import time

from m2nano_usb import KNOWN_KEYS, add_connection_args, format_status, main_guard, open_device_from_args


def main() -> int:
    parser = argparse.ArgumentParser(description="Probe likely laser-fire blockers.")
    parser.add_argument("--cycles", type=int, default=3, help="How many pulse cycles to run.")
    parser.add_argument("--pulse-ms", type=int, default=30, help="Gate hold time for each cycle.")
    parser.add_argument("--steps", type=int, default=4, help="Motion steps during each cycle.")
    parser.add_argument("--gate-mode", choices=("legacy", "v9"), default="legacy", help="Laser gate dialect.")
    parser.add_argument("--skip-handshake", action="store_true", help="Do not try auth keys first.")
    add_connection_args(parser)
    args = parser.parse_args()

    device = open_device_from_args(args)
    try:
        device.initialize_epp()
        if not args.skip_handshake:
            for key in KNOWN_KEYS:
                device.handshake(key)
        for index in range(args.cycles):
            before = device.get_status()
            device.laser_gate(True, mode=args.gate_mode)
            during = device.get_status()
            device.rapid_move(dx_steps=args.steps)
            time.sleep(args.pulse_ms / 1000.0)
            device.rapid_move(dx_steps=-args.steps)
            device.laser_gate(False, mode=args.gate_mode)
            after = device.get_status()
            print(
                f"cycle={index + 1} "
                f"before={format_status(before)} "
                f"during={format_status(during)} "
                f"after={format_status(after)}"
            )
            time.sleep(0.2)
        return 0
    finally:
        device.close()


if __name__ == "__main__":
    raise SystemExit(main_guard(main))
