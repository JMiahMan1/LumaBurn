#!/usr/bin/env python3

from __future__ import annotations

import argparse

from m2nano_usb import KNOWN_KEYS, add_connection_args, main_guard, open_device_from_args, print_results


def main() -> int:
    parser = argparse.ArgumentParser(description="Send a conservative reset/release sequence.")
    parser.add_argument(
        "--gate-mode",
        choices=("legacy", "v9"),
        default="legacy",
        help="Laser gate dialect to use for the off command.",
    )
    parser.add_argument("--skip-handshake", action="store_true", help="Do not try auth keys first.")
    add_connection_args(parser)
    args = parser.parse_args()

    device = open_device_from_args(args)
    try:
        device.initialize_epp()
        if not args.skip_handshake:
            for key in KNOWN_KEYS:
                device.handshake(key)
        results = []
        results.extend(device.laser_gate(False, mode=args.gate_mode))
        results.extend(device.unlock_rail())
        results.extend(device.send_stream("IPP\n"))
        print_results(results)
        return 0
    finally:
        device.close()


if __name__ == "__main__":
    raise SystemExit(main_guard(main))
