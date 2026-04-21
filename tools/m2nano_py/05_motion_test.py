#!/usr/bin/env python3

from __future__ import annotations

import argparse
import time

from m2nano_usb import KNOWN_KEYS, add_connection_args, main_guard, open_device_from_args, print_results


def main() -> int:
    parser = argparse.ArgumentParser(description="Run a small orthogonal movement test.")
    parser.add_argument("--axis", choices=("x", "y"), default="x", help="Axis to move.")
    parser.add_argument("--distance", type=int, default=2, help="Distance in mm.")
    parser.add_argument("--steps-per-mm", type=float, default=39.37, help="Controller step scale.")
    parser.add_argument("--repeat", type=int, default=1, help="How many back-and-forth cycles to perform.")
    parser.add_argument("--seconds", type=float, default=0.0, help="Run back-and-forth motion for this many seconds.")
    parser.add_argument("--unlock-after", action="store_true", help="Append IS2P after each rapid move.")
    parser.add_argument("--skip-handshake", action="store_true", help="Do not try auth keys first.")
    add_connection_args(parser)
    args = parser.parse_args()

    steps = max(1, int(round(args.distance * args.steps_per_mm)))
    device = open_device_from_args(args)
    try:
        device.initialize_epp()
        if not args.skip_handshake:
            for key in KNOWN_KEYS:
                device.handshake(key)
        results = []
        end_time = time.time() + args.seconds if args.seconds > 0 else None
        cycles = 0
        while True:
            kwargs = {"unlock_after": args.unlock_after}
            if args.axis == "x":
                results.extend(device.rapid_move(dx_steps=steps, **kwargs))
            else:
                results.extend(device.rapid_move(dy_steps=steps, **kwargs))
            time.sleep(0.2)
            if args.axis == "x":
                results.extend(device.rapid_move(dx_steps=-steps, **kwargs))
            else:
                results.extend(device.rapid_move(dy_steps=-steps, **kwargs))
            time.sleep(0.2)
            cycles += 1
            if end_time is not None:
                if time.time() >= end_time:
                    break
            elif cycles >= args.repeat:
                break
        print_results(results)
        return 0
    finally:
        device.close()


if __name__ == "__main__":
    raise SystemExit(main_guard(main))
