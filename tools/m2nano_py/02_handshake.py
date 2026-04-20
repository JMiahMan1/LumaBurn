#!/usr/bin/env python3

from __future__ import annotations

import argparse

from m2nano_usb import KNOWN_KEYS, add_connection_args, format_status, main_guard, open_device_from_args


def main() -> int:
    parser = argparse.ArgumentParser(description="Try the known M2Nano auth keys.")
    parser.add_argument("--key", action="append", dest="keys", help="Override keys to try.")
    add_connection_args(parser)
    args = parser.parse_args()

    keys = args.keys or list(KNOWN_KEYS)
    device = open_device_from_args(args)
    try:
        device.initialize_epp()
        print(f"Initial status: {format_status(device.get_status())}")
        for key in keys:
            matched = device.handshake(key)
            status = format_status(device.get_status())
            print(f"Key {key}: {'accepted' if matched else 'not confirmed'}; status={status}")
        return 0
    finally:
        device.close()


if __name__ == "__main__":
    raise SystemExit(main_guard(main))
