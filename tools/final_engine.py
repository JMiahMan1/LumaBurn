#!/usr/bin/env python3

from __future__ import annotations

import argparse
import math
import time
from dataclasses import dataclass

from m2nano_usb import (
    KNOWN_KEYS,
    STATUS_BUSY,
    add_connection_args,
    format_status,
    main_guard,
    open_device_from_args,
    print_results,
)


VIEWBOX_SIZE = 1000.0


Point = tuple[float, float]
Polyline = list[Point]


@dataclass
class JobLayer:
    name: str
    power: float
    polylines: list[Polyline]


def line(x1: float, y1: float, x2: float, y2: float) -> Polyline:
    return [(x1, y1), (x2, y2)]


def rounded_rect_outline(x: float, y: float, w: float, h: float, r: float, segments: int = 8) -> Polyline:
    points: Polyline = []
    corners = [
        (x + w - r, y + r, -90, 0),
        (x + w - r, y + h - r, 0, 90),
        (x + r, y + h - r, 90, 180),
        (x + r, y + r, 180, 270),
    ]
    for cx, cy, start_deg, end_deg in corners:
        for i in range(segments + 1):
            t = i / segments
            angle = math.radians(start_deg + (end_deg - start_deg) * t)
            points.append((cx + r * math.cos(angle), cy + r * math.sin(angle)))
    points.append(points[0])
    return points


def circle_outline(cx: float, cy: float, r: float, segments: int = 24) -> Polyline:
    pts = []
    for i in range(segments + 1):
      angle = (math.tau * i) / segments
      pts.append((cx + r * math.cos(angle), cy + r * math.sin(angle)))
    return pts


STROKE_FONT: dict[str, tuple[float, list[Polyline]]] = {
    " ": (0.45, []),
    "L": (0.62, [[(0.0, 0.0), (0.0, 1.0), (0.58, 1.0)]]),
    "U": (0.74, [[(0.0, 0.0), (0.0, 0.78), (0.14, 1.0), (0.60, 1.0), (0.74, 0.78), (0.74, 0.0)]]),
    "M": (0.94, [[(0.0, 1.0), (0.0, 0.0), (0.47, 0.48), (0.94, 0.0), (0.94, 1.0)]]),
    "A": (0.82, [[(0.0, 1.0), (0.22, 0.0), (0.60, 0.0), (0.82, 1.0)], [(0.16, 0.56), (0.68, 0.56)]]),
    "B": (
        0.78,
        [
            [(0.0, 0.0), (0.0, 1.0)],
            [(0.0, 0.0), (0.52, 0.0), (0.70, 0.14), (0.70, 0.38), (0.52, 0.50), (0.0, 0.50)],
            [(0.0, 0.50), (0.56, 0.50), (0.76, 0.66), (0.76, 0.90), (0.56, 1.0), (0.0, 1.0)],
        ],
    ),
    "R": (
        0.8,
        [
            [(0.0, 0.0), (0.0, 1.0)],
            [(0.0, 0.0), (0.52, 0.0), (0.72, 0.16), (0.72, 0.42), (0.52, 0.56), (0.0, 0.56)],
            [(0.32, 0.56), (0.80, 1.0)],
        ],
    ),
    "N": (0.82, [[(0.0, 1.0), (0.0, 0.0), (0.82, 1.0), (0.82, 0.0)]]),
}


def wordmark_polylines(text: str, x: float, y: float, height: float, tracking: float) -> list[Polyline]:
    polylines: list[Polyline] = []
    cursor = x
    for char in text:
        width, strokes = STROKE_FONT[char]
        for stroke in strokes:
            polylines.append([(cursor + px * height, y + py * height) for px, py in stroke])
        cursor += width * height + tracking
    return polylines


def load_raster_layer(path: str) -> JobLayer:
    import json
    with open(path, "r") as f:
        data = json.load(f)
    # Convert list of lists to list of tuples
    processed = []
    for poly in data["polylines"]:
        processed.append([(float(pt[0]), float(pt[1])) for pt in poly])
    return JobLayer("engrave", 1.0, processed)


def icon_layers() -> tuple[JobLayer, JobLayer]:
    engrave: list[Polyline] = [
        rounded_rect_outline(150, 150, 700, 700, 94, segments=6),
        line(500, 150, 500, 470),
        line(476, 150, 486, 456),
        line(524, 150, 514, 456),
        [(500, 265), (790, 455), (500, 645), (210, 455), (500, 265)],
        line(282, 408, 500, 551),
        line(354, 361, 572, 504),
        line(426, 314, 644, 457),
        line(574, 314, 356, 457),
        line(646, 361, 428, 504),
        line(718, 408, 500, 551),
        circle_outline(500, 470, 16, segments=16),
        line(466, 470, 534, 470),
        line(500, 436, 500, 504),
        line(476, 446, 524, 494),
        line(476, 494, 524, 446),
        line(500, 470, 610, 540),
        line(500, 470, 648, 494),
        line(500, 470, 626, 438),
        line(500, 470, 674, 424),
        line(500, 470, 712, 400),
        line(500, 470, 640, 470),
        line(500, 470, 684, 486),
        line(500, 470, 706, 520),
    ]

    engrave.extend(wordmark_polylines("LUMABURN", x=235, y=730, height=56, tracking=12))

    cut = [rounded_rect_outline(120, 120, 760, 760, 120, segments=10)]
    return JobLayer("engrave", 12.0, engrave), JobLayer("cut", 18.0, cut)


def resolve_origin(args: argparse.Namespace) -> tuple[float, float]:
    size = args.size_mm
    margin_x = args.margin_x_mm
    margin_y = args.margin_y_mm
    bed_width = args.bed_width_mm
    bed_height = args.bed_height_mm

    if args.anchor == "manual":
        origin_x = args.origin_x_mm
        origin_y = args.origin_y_mm
    elif args.anchor == "lower-left":
        origin_x = margin_x
        origin_y = bed_height - margin_y - size
    elif args.anchor == "lower-right":
        origin_x = bed_width - margin_x - size
        origin_y = bed_height - margin_y - size
    elif args.anchor == "upper-right":
        origin_x = bed_width - margin_x - size
        origin_y = margin_y
    else:
        origin_x = margin_x
        origin_y = margin_y

    if origin_x < 0 or origin_y < 0:
        raise ValueError("Computed origin is negative; reduce size or margins.")
    if origin_x + size > bed_width or origin_y + size > bed_height:
        raise ValueError(
            f"Artwork would exceed the bed ({bed_width} x {bed_height} mm). "
            f"Computed box: x={origin_x:.2f}, y={origin_y:.2f}, size={size:.2f}."
        )
    return origin_x, origin_y


def viewbox_to_steps(point: Point, origin_x_mm: float, origin_y_mm: float, size_mm: float, steps_per_mm: float) -> tuple[int, int]:
    scale = size_mm / VIEWBOX_SIZE
    mm_x = origin_x_mm + point[0] * scale
    mm_y = origin_y_mm + point[1] * scale
    return int(round(mm_x * steps_per_mm)), int(round(mm_y * steps_per_mm))


def burn_polyline(device, polyline: Polyline, current_steps: tuple[int, int], origin_x_mm: float, origin_y_mm: float, size_mm: float, steps_per_mm: float, gate_mode: str, segment_pause_ms: float) -> tuple[list, tuple[int, int]]:
    results = []
    target_steps = [viewbox_to_steps(pt, origin_x_mm, origin_y_mm, size_mm, steps_per_mm) for pt in polyline]
    if not target_steps:
        return results, current_steps

    start_x, start_y = target_steps[0]
    dx0 = start_x - current_steps[0]
    dy0 = start_y - current_steps[1]
    if dx0 or dy0:
        results.extend(device.rapid_move(dx_steps=dx0, dy_steps=dy0))
    current_steps = (start_x, start_y)

    results.extend(device.laser_gate(True, mode=gate_mode))
    for next_x, next_y in target_steps[1:]:
        dx = next_x - current_steps[0]
        dy = next_y - current_steps[1]
        if dx or dy:
            results.extend(device.rapid_move(dx_steps=dx, dy_steps=dy))
            current_steps = (next_x, next_y)
            if segment_pause_ms > 0:
                time.sleep(segment_pause_ms / 1000.0)
    results.extend(device.laser_gate(False, mode=gate_mode))
    return results, current_steps


def run_layer(device, layer: JobLayer, current_steps: tuple[int, int], args: argparse.Namespace) -> tuple[list, tuple[int, int]]:
    results = []
    power = layer.power if getattr(args, f"{layer.name}_power") is None else getattr(args, f"{layer.name}_power")
    speed = getattr(args, f"{layer.name}_speed_mm_s")
    total = len(layer.polylines)
    print(f"[{layer.name}] start power={power}% speed={speed if speed is not None else 'default'} mm/s polylines={total}")
    results.extend(device.set_power(power))
    if speed is not None:
        results.extend(device.enter_program_mode(speed))
    # Batch Streaming for Speed
    batch = []
    for index, polyline in enumerate(layer.polylines, start=1):
        if args.log_progress and index % 100 == 0:
            print(f"[{layer.name}] polyline {index}/{total}")
        
        layer_results, current_steps = burn_polyline(
            device,
            polyline,
            current_steps,
            origin_x_mm=args.origin_x_mm,
            origin_y_mm=args.origin_y_mm,
            size_mm=args.size_mm,
            steps_per_mm=args.steps_per_mm,
            gate_mode=args.gate_mode,
            segment_pause_ms=args.segment_pause_ms,
        )
        results.extend(layer_results)
        
        # Reduced pause for batching
        if args.polyline_pause_ms > 0:
            time.sleep(args.polyline_pause_ms / 1000.0)

    if speed is not None:
        results.extend(device.exit_program_mode())
    print(f"[{layer.name}] complete commands={len(results)}")
    return results, current_steps


def main() -> int:
    parser = argparse.ArgumentParser(description="Burn the simplified LumaBurn K40 test icon via the Python M2Nano harness.")
    parser.add_argument("--bed-width-mm", type=float, default=300.0, help="Machine bed width in mm.")
    parser.add_argument("--bed-height-mm", type=float, default=200.0, help="Machine bed height in mm.")
    parser.add_argument(
        "--anchor",
        choices=("manual", "upper-left", "upper-right", "lower-left", "lower-right"),
        default="lower-left",
        help="Placement anchor for the square badge within the bed.",
    )
    parser.add_argument("--origin-x-mm", type=float, default=15.0, help="Manual top-left placement x in bed mm.")
    parser.add_argument("--origin-y-mm", type=float, default=15.0, help="Manual top-left placement y in bed mm.")
    parser.add_argument("--margin-x-mm", type=float, default=15.0, help="Horizontal edge margin in mm when using anchored placement.")
    parser.add_argument("--margin-y-mm", type=float, default=15.0, help="Vertical edge margin in mm when using anchored placement.")
    parser.add_argument("--size-mm", type=float, default=70.0, help="Rendered width/height of the square icon on the bed.")
    parser.add_argument("--steps-per-mm", type=float, default=39.37, help="Controller step scale.")
    parser.add_argument("--engrave-power", type=float, default=None, help="Override engrave power percent.")
    parser.add_argument("--cut-power", type=float, default=None, help="Override cut power percent.")
    parser.add_argument("--engrave-speed-mm-s", type=float, default=175.0, help="Explicit engrave vector speed in mm/s.")
    parser.add_argument("--cut-speed-mm-s", type=float, default=10.0, help="Explicit cut vector speed in mm/s.")
    parser.add_argument("--segment-pause-ms", type=float, default=0.0, help="Optional pause after each lit segment.")
    parser.add_argument("--polyline-pause-ms", type=float, default=10.0, help="Pause between lit polylines.")
    parser.add_argument("--skip-cut", action="store_true", help="Only run the engrave pass.")
    parser.add_argument("--skip-engrave", action="store_true", help="Only run the cut outline.")
    parser.add_argument("--skip-handshake", action="store_true", help="Do not try auth keys first.")
    parser.add_argument(
        "--preflight-clear",
        action="store_true",
        help="Run an explicit release/reset sequence before the job if the controller is already busy.",
    )
    parser.add_argument("--log-progress", action="store_true", help="Print per-layer and per-polyline progress while running.")
    parser.add_argument(
        "--gate-mode",
        choices=("legacy", "v9"),
        default="legacy",
        help="Use MeerK40t-style D/U gating or V9-style DA/D0 gating.",
    )
    parser.add_argument("--polyline-json", type=str, default=None, help="Path to JSON file containing polyline layers.")
    add_connection_args(parser)
    args = parser.parse_args()
    args.origin_x_mm, args.origin_y_mm = resolve_origin(args)

    if args.polyline_json:
        engrave_layer = load_raster_layer(args.polyline_json)
        cut_layer = JobLayer("cut", 1.0, []) # Empty cut layer
    else:
        engrave_layer, cut_layer = icon_layers()

    device = open_device_from_args(args)
    try:
        device.initialize_epp()
        if not args.skip_handshake:
            for key in KNOWN_KEYS:
                device.handshake(key)

        initial_status = device.get_status()
        print(f"Initial controller status: {format_status(initial_status)}")
        if args.preflight_clear or initial_status == STATUS_BUSY:
            print("Running busy-state recovery sequence before streaming the job.")
            recovery_results = device.clear_busy_state(gate_mode=args.gate_mode)
            print_results(recovery_results)
            cleared_status = device.get_status()
            print(f"Status after recovery: {format_status(cleared_status)}")

        results = []
        current_steps = (0, 0)

        if not args.skip_engrave:
            layer_results, current_steps = run_layer(device, engrave_layer, current_steps, args)
            results.extend(layer_results)

        if not args.skip_cut:
            layer_results, current_steps = run_layer(device, cut_layer, current_steps, args)
            results.extend(layer_results)

        print_results(results)
        print(f"Completed {len(results)} command results.")
        return 0
    finally:
        device.close()


if __name__ == "__main__":
    raise SystemExit(main_guard(main))
