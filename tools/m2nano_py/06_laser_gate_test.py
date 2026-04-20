#!/usr/bin/env python3

from __future__ import annotations

import argparse
import time

from m2nano_usb import KNOWN_KEYS, add_connection_args, main_guard, open_device_from_args, print_results


def main() -> int:
    parser = argparse.ArgumentParser(description="Test direct laser gate commands.")
    parser.add_argument("--pulse-ms", type=int, default=50, help="Laser on duration in milliseconds.")
    parser.add_argument("--with-motion", action="store_true", help="Add a tiny move while the gate is asserted.")
    parser.add_argument("--steps", type=int, default=4, help="Steps to use for the optional micro-move.")
    parser.add_argument("--power-percent", type=float, default=None, help="Optional AT1 power command percent before gating.")
    parser.add_argument(
        "--gate-mode",
        choices=("legacy", "v9"),
        default="legacy",
        help="Use MeerK40t-style D/U gating or V9-style DA/D0 gating.",
    )
    parser.add_argument("--unlock-after", action="store_true", help="Append IS2P after rapid packets.")
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
        if args.power_percent is not None:
            results.extend(device.set_power(args.power_percent))
        results.extend(device.laser_gate(True, mode=args.gate_mode, unlock_after=args.unlock_after))
        if args.with_motion:
            results.extend(device.rapid_move(dx_steps=args.steps, unlock_after=args.unlock_after))
        time.sleep(args.pulse_ms / 1000.0)
        if args.with_motion:
            results.extend(device.rapid_move(dx_steps=-args.steps, unlock_after=args.unlock_after))
        results.extend(device.laser_gate(False, mode=args.gate_mode, unlock_after=args.unlock_after))
        print_results(results)
        return 0
    finally:
        device.close()


if __name__ == "__main__":
    raise SystemExit(main_guard(main))
