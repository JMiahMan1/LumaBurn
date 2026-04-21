# M2Nano Python Bring-Up Scripts

This folder contains a direct Python test harness for the OMTech K40 `M2Nano`
controller shown in the board photo. The scripts are numbered so they can be
run in order while isolating each stage of USB bring-up and laser debugging.

## Board Identification

The board photo in `~/Downloads/20260417_132535.jpg` is silkscreened `M2Nano`.
It is not an `M3Nano`.

## Requirements

- Python 3.10+
- `pyusb`
- Access to the CH341 USB device (`1a86:5512`)

## Safety

- Remove material from the bed before laser-fire tests.
- Keep water protection and lid interlocks satisfied before testing.
- Start with low current on the analog ammeter and use the shortest pulse
  durations possible.
- Use `--dry-run` first to inspect packets without transmitting them.

## Script Order

1. `01_probe_device.py`
   Detect the CH341 board and print descriptors/endpoints.
2. `02_handshake.py`
   Initialize EPP mode and try the known unlock keys individually.
3. `03_status_monitor.py`
   Poll status continuously so you can see ready/busy/error transitions.
4. `04_initialize_controller.py`
   Probe ready state and optionally send `IS1P` / `IS2P`.
5. `05_motion_test.py`
   Exercise small axis moves using MeerK40t-style rapid packets.
6. `06_laser_gate_test.py`
   Test legacy `D` / `U` or V9 `DA` / `D0` gating with optional micro-moves.
7. `07_interlock_probe.py`
   Repeat short gate tests while reporting status changes that may indicate an
   interlock or motion-gated output requirement.
8. `08_heartbeat_test.py`
   Hold the board in an initialized state while sending periodic `S1` packets.
9. `09_home_and_release.py`
   Send a conservative shutdown/reset sequence.
10. `10_burn_test_icon.py`
    Burn the simplified `assets/lumaburn-test-icon.svg` design as a conservative
    two-pass K40 validation job using the current Python harness.

## Typical Session

```bash
python3 tools/m2nano_py/01_probe_device.py
python3 tools/m2nano_py/03_status_monitor.py --seconds 10
python3 tools/m2nano_py/04_initialize_controller.py --skip-handshake
python3 tools/m2nano_py/05_motion_test.py --skip-handshake --axis x --distance 2
python3 tools/m2nano_py/06_laser_gate_test.py --skip-handshake --gate-mode legacy --pulse-ms 50 --with-motion
python3 tools/m2nano_py/08_heartbeat_test.py --seconds 15
python3 tools/m2nano_py/10_burn_test_icon.py --dry-run --skip-handshake --skip-cut
python3 tools/m2nano_py/09_home_and_release.py --skip-handshake --gate-mode legacy
```

## Test Icon Burn

`10_burn_test_icon.py` draws a simplified version of the current
`assets/lumaburn-test-icon.svg` artwork:

- rounded-square cut outline
- bed/grid and center flare
- beam and spark lines
- a simple stroke-font `LUMABURN` wordmark at the bottom

Recommended first live run on scrap wood:

```bash
python3 tools/m2nano_py/10_burn_test_icon.py \
  --skip-handshake \
  --preflight-clear \
  --gate-mode legacy \
  --anchor lower-left \
  --bed-width-mm 300 \
  --bed-height-mm 200 \
  --size-mm 70 \
  --margin-x-mm 15 \
  --margin-y-mm 15 \
  --engrave-power 10 \
  --engrave-speed-mm-s 175 \
  --cut-power 16 \
  --cut-speed-mm-s 10
```

Notes:

- The script uses conservative defaults and keeps OMTech/K40 work isolated in
  `tools/m2nano_py/`; it does not touch the GRBL path.
- The icon runner now supports anchored placement. The default path is
  `--anchor lower-left` on a `300 x 200 mm` bed with explicit margin checks so
  the square badge has room to engrave and cut out.
- Explicit vector speed control is now exposed per layer via
  `--engrave-speed-mm-s` and `--cut-speed-mm-s`. The Python harness generates
  the same `CV...1` speed code formula used in `src/core/m2-protocol.cjs` and
  sends the same `I -> CV...1 -> N -> LT -> S1E` program-mode sequence already
  present in `src/drivers/m2nano.cjs`.
- Long-job diagnostics are now exposed via `--ready-timeout-s`,
  `--confirm-timeout-s`, `--inter-packet-delay-ms`, `--log-progress`, and
  `--verbose-io`.
- `--preflight-clear` runs an explicit gate-off / exit-program / unlock /
  release sequence before the job. It is also auto-triggered when the harness
  sees the controller already sitting in `0xEE` (`busy`) at job start.
- The live wordmark burn uses a built-in stroke font instead of resolving SVG
  text through a font engine, so the hardware job is deterministic in Python.
- Use `--skip-cut` or `--skip-engrave` if you want to validate one pass at a
  time before running the full badge.

## Notes

- The packet layout and auth flow match the findings in
  `V9_CONTROLLER_AUDIT.md`.
- Live testing on 2026-04-18 showed this specific `M2Nano` board starts in
  `0xCE` without auth and the current auth attempts can latch it into `0xCF`
  until the controller is power-cycled.
- Comparison against MeerK40t's current `ch341/libusb.py` and
  `lihuiyu/controller.py` showed our first-pass Python harness had the wrong
  packet CRC implementation and an oversimplified standalone init sequence.
- The current motion and gate scripts now emit MeerK40t-style buffered rapid
  packets rather than isolated `I\n` commands.
- A first live full-badge run reached the CH341 device with explicit vector
  speed enabled but timed out mid-stream with `ERROR: [Errno 110] Operation
timed out`; the next live validation should split the job into engrave-only
  and cut-only passes.
- A follow-up engrave-only run with longer wait windows and progress logging
  also timed out, but it showed the controller was already `0xEE` (`busy`)
  before the artwork stream began and stalled immediately after `AT1` / `I`.
- For this board, prefer the `--skip-handshake` path first.
- These scripts focus on the low-level hardware layer that LumaBurn will need
  to port into Node. They do not attempt to reproduce MeerK40t's full planning,
  raster, or spooler stack.
