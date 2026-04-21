#!/usr/bin/env python3

from __future__ import annotations

import argparse
import time

from m2nano_usb import KNOWN_KEYS, add_connection_args, format_status, main_guard, open_device_from_args


def main() -> int:
    parser = argparse.ArgumentParser(description="Send periodic S1 heartbeat packets.")
    parser.add_argument("--seconds", type=float, default=15.0, help="Total heartbeat duration.")
    parser.add_argument("--interval", type=float, default=1.0, help="Seconds between S1 packets.")
    parser.add_argument("--skip-handshake", action="store_true", help="Do not try auth keys first.")
    add_connection_args(parser)
    args = parser.parse_args()

    device = open_device_from_args(args)
    try:
        device.initialize_epp()
        if not args.skip_handshake:
            for key in KNOWN_KEYS:
                device.handshake(key)
        deadline = time.time() + args.seconds
        while time.time() < deadline:
            result = device.send_command("S1\n", force=False, wait_ready=True)
            print(
                f"{time.strftime('%H:%M:%S')} heartbeat "
                f"{format_status(result.status_before)} -> {format_status(result.status_after)}"
            )
            time.sleep(args.interval)
        return 0
    finally:
        device.close()


if __name__ == "__main__":
    raise SystemExit(main_guard(main))
