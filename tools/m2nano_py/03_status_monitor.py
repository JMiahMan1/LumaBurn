#!/usr/bin/env python3

from __future__ import annotations

import argparse
import time

from m2nano_usb import add_connection_args, format_status, main_guard, open_device_from_args


def main() -> int:
    parser = argparse.ArgumentParser(description="Poll controller status repeatedly.")
    parser.add_argument("--seconds", type=float, default=10.0, help="How long to poll.")
    parser.add_argument("--interval", type=float, default=0.2, help="Polling interval in seconds.")
    add_connection_args(parser)
    args = parser.parse_args()

    device = open_device_from_args(args)
    try:
        device.initialize_epp()
        deadline = time.time() + args.seconds
        while time.time() < deadline:
            status = device.get_status()
            print(f"{time.strftime('%H:%M:%S')} status={format_status(status)}")
            time.sleep(args.interval)
        return 0
    finally:
        device.close()


if __name__ == "__main__":
    raise SystemExit(main_guard(main))
