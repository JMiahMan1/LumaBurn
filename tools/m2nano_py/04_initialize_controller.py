#!/usr/bin/env python3

from __future__ import annotations

import argparse

from m2nano_usb import KNOWN_KEYS, add_connection_args, format_status, main_guard, open_device_from_args, print_results


def main() -> int:
    parser = argparse.ArgumentParser(description="Probe ready state and optionally lock or unlock the rail.")
    parser.add_argument("--lock-rail", action="store_true", help="Send IS1P after probing.")
    parser.add_argument("--unlock-rail", action="store_true", help="Send IS2P after probing.")
    parser.add_argument("--skip-handshake", action="store_true", help="Do not try auth keys first.")
    add_connection_args(parser)
    args = parser.parse_args()

    device = open_device_from_args(args)
    try:
        device.initialize_epp()
        print(f"Status before handshake: {format_status(device.get_status())}")
        if not args.skip_handshake:
            for key in KNOWN_KEYS:
                matched = device.handshake(key)
                print(f"Handshake {key}: {'accepted' if matched else 'not confirmed'}")
        results = []
        if args.lock_rail:
            results.extend(device.lock_rail())
        if args.unlock_rail:
            results.extend(device.unlock_rail())
        print_results(results)
        print(f"Final status: {format_status(device.get_status())}")
        return 0
    finally:
        device.close()


if __name__ == "__main__":
    raise SystemExit(main_guard(main))
