# OmTech M2Nano V9 Protocol Audit

This document summarizes the technical findings for bypassing the security lockout and enabling laser control on the M2Nano V9 controller.

## 1. Physical Layer (USB)

- **Hardware**: CH341 USB-to-Parallel chip.
- **Mode**: Must be initialized to **Parallel EPP 1.9** (Control Request `0xB1`, Value `0x0102`).
- **Packet Structure**: Mandatory **34-byte EPP Hardware-Marker** format.
  - Every 32-byte CH341 frame must be split: `[0xA6] + [31 bytes] + [0xA6] + [1 byte]`.
  - Failure to use these markers causes the controller to ignore the stream.

## 2. Authentication (Handshake)

- **Challenge**: The board starts in a "Locked" state (Status `0xEC` / Busy).
- **Solution**: MD5-based Handshake.
  - Command: `A` + `MD5(KEY)`.
  - Verified Keys: `M2NANO`, `K40`, `CH341S`.
  - Status `204` (0xCC) or `206` (0xCE) indicates the board is unlocked and ready.

### 2026-04-18 Live M2Nano Result

- The tested Studio Labs `M2Nano` board enumerated already in `0xCE` (`ok`) before any auth packet was sent.
- Running the current Python auth sequence did **not** produce a positive unlock confirmation.
- `K40` and `M2NANO` drove the board into `0xCF` (`error`).
- `CH341S` returned the board to `0xCE` in one direct handshake test, but the broader auth/init flow still ended in `0xCF`.
- Once in `0xCF`, no-auth `D0`, `I`, and `IPP` recovery commands did not clear the state; the board appears to require a physical power cycle.
- Working assumption for LumaBurn: make auth optional and disabled by default for this M2Nano variant.
- Follow-up comparison against MeerK40t on 2026-04-18 found two issues in the local test harness:
  - The local packet CRC did not match MeerK40t's `onewire_crc_lookup()` implementation.
  - The local `I` / `IS1P` standalone init sequence does not match MeerK40t's normal controller flow, which waits for `STATUS_OK` and generally emits `I` only inside rapid-mode movement or laser on/off sequences.

## 3. Command Protocol (Lihuiyu-GL)

- **Initialization**:
  - `I\n`: Reset state.
  - `IS1P\n`: Arm stepper motors and lock rails.
- **Explicit Vector Speed**:
  - The local harness now exposes MeerK40t-style vector speed codes using the
    same formula already mirrored in `src/core/m2-protocol.cjs`.
  - Program-mode sequence now available in Python for live jobs:
    `I -> CV...1 -> N -> LT -> S1E`
  - Program-mode exit sequence:
    `FNSE-`
- **Firing Syntax**:
  - The V9 firmware ignores standard `D`/`U` commands.
  - **Laser ON**: `DA\n`
  - **Laser OFF**: `D0\n`
  - All commands MUST be terminated with `\n` (0x0A) and padded to 30 bytes with `F` before the 1-byte CRC.
- **Movement**:
  - `B`: X+ (Right) / _Note: Axis mapping varies by board configuration._
  - `T`: X- (Left)
  - `R`: Y+ (Down)
  - `L`: Y- (Up)
  - Distance encoding uses `z` for 255 steps and ASCII lookup for 1-51.

## 4. Current Blockers (Firing Failure)

Despite valid communication and motion, the laser tube failed to fire in tests.

- **Hypothesis 1: Hardware Interlocks**: The V9 board has physical inputs for "Lid" and "Water Protection". If these pins are high/low (depending on logic), the `DA` command is ignored by the onboard firmware safety gate.
- **Hypothesis 2: Motion-Gating**: The TTL gate may only assert while the internal step-generator is actively pulsing.
- **Hypothesis 3: Pulse of Life**: Some V9 variants require a 5-second "Heartbeat" (`S1` status polls) to keep the laser relay engaged.

## 5. Progress Log

- 2026-04-18: Confirmed from the board photo that the installed controller is silkscreened `M2Nano`.
- 2026-04-18: Built a numbered Python bring-up harness under `tools/m2nano_py/`.
- 2026-04-18: Live USB probe confirmed the controller enumerates as `1a86:5512` and exposes CH341 bulk endpoints.
- 2026-04-18: Live testing showed the board starts in `0xCE` without auth; auth is therefore not a required prerequisite on this unit.
- 2026-04-18: Live testing also showed the first-pass local harness could drive the board into `0xCF`, requiring a power cycle.
- 2026-04-18: MeerK40t comparison identified two local defects: incorrect CRC and incorrect standalone init assumptions.
- 2026-04-18: The Python harness was updated to use MeerK40t's CRC algorithm, default direction codes, and buffered command-stream packetization.
- 2026-04-18: Dry-run validation now emits MeerK40t-style rapid packets such as `IB079S1PF` and gate packets such as `IDS1PF`.
- 2026-04-18: The controller remained in `0xCF` during the next live retest window, so another physical power cycle is required before validating the revised packet flow.
- 2026-04-18: After a fresh power cycle, the revised no-auth rapid move packets `IB079S1PF` and `IT079S1PF` were both accepted with `0xCE -> 0xCE`.
- 2026-04-18: After the same power cycle, the revised legacy gate-and-move sequence `IDS1PF`, `IBdS1PF`, `ITdS1PF`, `IUS1PF` was accepted with `0xCE -> 0xCE` for every packet.
- 2026-04-18: Added a simplified `assets/lumaburn-test-icon.svg` badge for wood-burn validation and a dedicated `tools/m2nano_py/10_burn_test_icon.py` runner for that artwork.
- 2026-04-18: Added explicit vector speed support to the Python harness using the same `CV...1` formula used in the Node-side `src/core/m2-protocol.cjs`.
- 2026-04-18: Added lower-left anchored placement logic to the icon runner for a `300 x 200 mm` K40 bed with bounds validation.
- 2026-04-18: Dry-run validation of the icon runner confirmed program-mode packets including `I`, `CV2290331`, `N`, `LT`, `S1E`, and `FNSE-`.
- 2026-04-18: First live full-job attempt against the connected CH341 device reached the controller but ended with `ERROR: [Errno 110] Operation timed out` during the badge stream.
- 2026-04-18: Current next step is to split validation into engrave-only and cut-only runs and improve long-job flow control before retrying the full badge job.
- 2026-04-18: Added longer ready/confirm timeouts, optional inter-packet throttling, and progress logging to the Python harness for long streamed jobs.
- 2026-04-18: A follow-up engrave-only live test with those diagnostics still timed out, but it showed the controller was already `0xEE` (`busy`) before the artwork stream began and stalled immediately after `AT1` / `I`.
- 2026-04-18: Working diagnosis is now that the controller state must be explicitly cleared/reset before long vector jobs, or the local flow-control logic must treat `0xEE` as an in-flight condition rather than proceeding into the program-mode/job stream.

## 6. Source References

- MeerK40t CH341 libusb layer:
  `https://raw.githubusercontent.com/meerk40t/meerk40t/refs/heads/main/meerk40t/ch341/libusb.py`
- MeerK40t Lihuiyu controller:
  `https://raw.githubusercontent.com/meerk40t/meerk40t/refs/heads/main/meerk40t/lihuiyu/controller.py`
- MeerK40t Lihuiyu driver:
  `https://raw.githubusercontent.com/meerk40t/meerk40t/refs/heads/main/meerk40t/lihuiyu/driver.py`
- MeerK40t speed-code implementation:
  `https://raw.githubusercontent.com/meerk40t/meerk40t/refs/heads/main/meerk40t/lihuiyu/laserspeed.py`

## 7. Verified Reference Files

- `scratch/meerk40t_ref.py`: The gold-standard implementation.
- `scratch/v9_perfect_mirror.py`: The last functional test of the communication layer.
