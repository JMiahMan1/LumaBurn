#!/usr/bin/env python3

from __future__ import annotations

import argparse
import hashlib
import sys
import time
from dataclasses import dataclass
from typing import Iterable

import usb.core
import usb.util


USB_VENDOR = 0x1A86
USB_PRODUCT = 0x5512

CH341_PARA_INIT = 0xB1
CH341_STATUS = 0x52
CH341_VENDOR_WRITE = 0x40
CH341_VENDOR_READ = 0xC0
CH341_PARA_CMD_W0 = 0xA6

STATUS_SERIAL_CORRECT = 0xCC
STATUS_OK = 0xCE
STATUS_ERROR = 0xCF
STATUS_FINISH = 0xEC
STATUS_BUSY = 0xEE
STATUS_POWER = 0xEF

KNOWN_KEYS = ("K40", "M2NANO", "CH341S")


STATUS_NAMES = {
    STATUS_SERIAL_CORRECT: "serial-correct",
    STATUS_OK: "ok",
    STATUS_ERROR: "error",
    STATUS_FINISH: "finish",
    STATUS_BUSY: "busy",
    STATUS_POWER: "low-power",
}


DISTANCE_LOOKUP = [
    "",
    "a",
    "b",
    "c",
    "d",
    "e",
    "f",
    "g",
    "h",
    "i",
    "j",
    "k",
    "l",
    "m",
    "n",
    "o",
    "p",
    "q",
    "r",
    "s",
    "t",
    "u",
    "v",
    "w",
    "x",
    "y",
    "|a",
    "|b",
    "|c",
    "|d",
    "|e",
    "|f",
    "|g",
    "|h",
    "|i",
    "|j",
    "|k",
    "|l",
    "|m",
    "|n",
    "|o",
    "|p",
    "|q",
    "|r",
    "|s",
    "|t",
    "|u",
    "|v",
    "|w",
    "|x",
    "|y",
    "|z",
]

CRC_TABLE = [
    0x00,
    0x5E,
    0xBC,
    0xE2,
    0x61,
    0x3F,
    0xDD,
    0x83,
    0xC2,
    0x9C,
    0x7E,
    0x20,
    0xA3,
    0xFD,
    0x1F,
    0x41,
    0x00,
    0x9D,
    0x23,
    0xBE,
    0x46,
    0xDB,
    0x65,
    0xF8,
    0x8C,
    0x11,
    0xAF,
    0x32,
    0xCA,
    0x57,
    0xE9,
    0x74,
]


def crc8(data: bytes, start: int = 0, end: int | None = None) -> int:
    end = len(data) if end is None else end
    crc = 0
    for value in data[start:end]:
        crc ^= value
        crc = CRC_TABLE[crc & 0x0F] ^ CRC_TABLE[16 + ((crc >> 4) & 0x0F)]
    return crc


def encode_distance(steps: int) -> str:
    value = max(0, int(round(steps)))
    encoded = []
    if value >= 255:
        encoded.append("z" * (value // 255))
        value %= 255
    if value >= 52:
        encoded.append(f"{value:03d}")
    else:
        encoded.append(DISTANCE_LOOKUP[value])
    return "".join(encoded)


def build_motion(axis: str, steps: int) -> str:
    axis = axis.lower()
    if axis == "x":
        return f"B{encode_distance(abs(steps))}" if steps >= 0 else f"T{encode_distance(abs(steps))}"
    if axis == "y":
        return f"R{encode_distance(abs(steps))}" if steps >= 0 else f"L{encode_distance(abs(steps))}"
    raise ValueError(f"Unsupported axis: {axis}")


def build_rapid_move(dx_steps: int = 0, dy_steps: int = 0, unlock_after: bool = False) -> str:
    if dx_steps == 0 and dy_steps == 0:
        raise ValueError("Rapid move requires non-zero movement.")
    stream = ["I"]
    if dx_steps != 0:
        stream.append(build_motion("x", dx_steps))
    if dy_steps != 0:
        stream.append(build_motion("y", dy_steps))
    stream.append("S1P\n")
    if unlock_after:
        stream.append("IS2P\n")
    return "".join(stream)


def build_laser_gate(on: bool, mode: str = "legacy", unlock_after: bool = False) -> str:
    if mode == "legacy":
        gate = "D" if on else "U"
    elif mode == "v9":
        gate = "DA" if on else "D0"
    else:
        raise ValueError(f"Unsupported gate mode: {mode}")
    stream = ["I", gate, "S1P\n"]
    if unlock_after:
        stream.append("IS2P\n")
    return "".join(stream)


def build_power_command(percent: float) -> bytes:
    percent = max(0.0, min(100.0, float(percent)))
    power = int(round(percent * 10.0))
    m = int(power / 254)
    n = int(power % 254)
    return bytes((ord("A"), ord("T"), ord("1"), m, n, ord("\n")))


def build_speed_code(mm_per_sec: float) -> str:
    value = max(0.1, float(mm_per_sec))
    period_ms = 1.0 / (value / 25.4)
    encoded_value = int(round(65536 - (5120 + 12120 * period_ms)))
    encoded_value = max(0, min(0xFFFF, encoded_value))
    low = encoded_value & 0xFF
    high = (encoded_value >> 8) & 0xFF
    return f"CV{high:03d}{low:03d}1"


def format_status(status: int) -> str:
    return f"0x{status:02X} ({STATUS_NAMES.get(status, 'unknown')})"


def hexdump(data: bytes) -> str:
    return " ".join(f"{byte:02X}" for byte in data)


@dataclass
class CommandResult:
    command: str
    status_before: int
    status_after: int


class M2NanoDevice:
    def __init__(
        self,
        dry_run: bool = False,
        timeout_ms: int = 1000,
        ready_timeout: float = 5.0,
        confirm_timeout: float = 2.0,
        inter_packet_delay_ms: float = 0.0,
        verbose: bool = False,
    ):
        self.dry_run = dry_run
        self.timeout_ms = timeout_ms
        self.ready_timeout = ready_timeout
        self.confirm_timeout = confirm_timeout
        self.inter_packet_delay_ms = inter_packet_delay_ms
        self.verbose = verbose
        self.device = None
        self.out_endpoint = 0x02
        self.interface_number = 0
        self._last_status = None

    def open(self) -> "M2NanoDevice":
        self.device = usb.core.find(idVendor=USB_VENDOR, idProduct=USB_PRODUCT)
        if self.device is None and self.dry_run:
            return self
        if self.device is None:
            raise RuntimeError("CH341 laser controller not found.")
        if self.dry_run:
            return self
        self.device.set_configuration()
        cfg = self.device.get_active_configuration()
        interface = cfg[(0, 0)]
        self.interface_number = interface.bInterfaceNumber
        if self.device.is_kernel_driver_active(self.interface_number):
            self.device.detach_kernel_driver(self.interface_number)
        usb.util.claim_interface(self.device, self.interface_number)
        return self

    def close(self) -> None:
        if self.device is None or self.dry_run:
            return
        try:
            usb.util.release_interface(self.device, self.interface_number)
        except usb.core.USBError:
            pass
        usb.util.dispose_resources(self.device)

    def initialize_epp(self) -> None:
        self.control_write(CH341_PARA_INIT, 0x0102, 0, b"")

    def control_write(self, request: int, value: int, index: int, payload: bytes) -> None:
        if self.dry_run:
            return
        self.device.ctrl_transfer(CH341_VENDOR_WRITE, request, value, index, payload, timeout=self.timeout_ms)

    def control_read(self, request: int, value: int, index: int, length: int) -> bytes:
        if self.dry_run:
            return bytes([0] * length)
        data = self.device.ctrl_transfer(
            CH341_VENDOR_READ, request, value, index, length, timeout=self.timeout_ms
        )
        return bytes(data)

    def get_status(self) -> int:
        data = self.control_read(CH341_STATUS, 0, 0, 8)
        status = data[1]
        self._last_status = status
        return status

    def wait_for_status(self, expected: int, timeout: float = 2.0, interval: float = 0.05) -> bool:
        if self.dry_run:
            return False
        deadline = time.time() + timeout
        while time.time() < deadline:
            status = self.get_status()
            if status == expected:
                return True
            time.sleep(interval)
        return False

    def wait_until_accepting_packets(self, timeout: float = 5.0, interval: float = 0.05) -> int:
        if self.dry_run:
            return 0
        deadline = time.time() + timeout
        status = self.get_status()
        while time.time() < deadline:
            if status in (STATUS_OK, STATUS_ERROR):
                return status
            time.sleep(interval)
            status = self.get_status()
        return status

    def clear_busy_state(
        self,
        gate_mode: str = "legacy",
        attempts: int = 2,
        settle_time: float = 0.25,
    ) -> list[CommandResult]:
        if self.dry_run:
            return []
        results: list[CommandResult] = []
        gate_off = "U\n" if gate_mode == "legacy" else "D0\n"
        recovery_commands = (gate_off, "FNSE-\n", "IS2P\n", "IPP\n")

        for _ in range(max(1, attempts)):
            status = self.get_status()
            if status == STATUS_OK:
                return results
            for command in recovery_commands:
                command_results = self.send_stream(command, wait_ready=False)
                results.extend(command_results)
                time.sleep(settle_time)
                status = self.wait_until_accepting_packets(timeout=min(1.0, self.ready_timeout))
                if status == STATUS_OK:
                    return results
        return results

    def build_packet(self, command: str | bytes, pad: str = "F") -> bytes:
        encoded = command.encode("ascii") if isinstance(command, str) else command
        pad_byte = 0x00 if encoded.startswith(b"AT") else ord(pad)
        payload = bytearray(pad_byte for _ in range(30))
        payload[: min(len(encoded), 30)] = encoded[:30]
        packet = bytearray(32)
        packet[0] = 0x00
        packet[1:31] = payload
        packet[31] = crc8(payload)
        return bytes(packet)

    def wrap_epp_frame(self, packet: bytes) -> bytes:
        frame = bytearray(34)
        frame[0] = CH341_PARA_CMD_W0
        frame[1:32] = packet[:31]
        frame[32] = CH341_PARA_CMD_W0
        frame[33] = packet[31]
        return bytes(frame)

    def write_packet(self, packet: bytes) -> None:
        frame = self.wrap_epp_frame(packet)
        if self.dry_run:
            print(f"TX packet: {hexdump(packet)}")
            print(f"TX frame:  {hexdump(frame)}")
            return
        self.device.write(self.out_endpoint, frame, timeout=self.timeout_ms)

    def packetize_stream(self, stream: str | bytes) -> list[bytes]:
        buffer = bytearray(stream.encode("ascii") if isinstance(stream, str) else stream)
        packets: list[bytes] = []
        while buffer:
            find = buffer.find(b"\n", 0, 30)
            if find == -1:
                length = min(30, len(buffer))
            else:
                length = min(30, len(buffer), find + 1)
            chunk = bytes(buffer[:length])
            if chunk.endswith(b"\n"):
                if chunk.startswith(b"AT"):
                    chunk = chunk[:-1]
                else:
                    chunk = chunk[:-1]
                    if len(chunk) == 0:
                        chunk = b"F"
                    if chunk.endswith(b"P"):
                        chunk += b"F"
            packets.append(chunk)
            del buffer[:length]
        return packets

    def confirm_packet(self, post_timeout: float = 2.0) -> int:
        if self.dry_run:
            return 0
        deadline = time.time() + post_timeout
        status = self.get_status()
        flawless = True
        attempts = 0
        while time.time() < deadline:
            attempts += 1
            try:
                status = self.get_status()
            except usb.core.USBError:
                flawless = False
                continue
            if status == 0:
                continue
            if status == STATUS_OK:
                return status
            if status == STATUS_BUSY:
                if attempts > 10:
                    time.sleep(min(0.001 * attempts, 0.1))
                continue
            if status == STATUS_ERROR:
                if flawless:
                    return status
                break
            if status in (STATUS_FINISH, STATUS_SERIAL_CORRECT):
                continue
            if attempts > 10:
                time.sleep(min(0.001 * attempts, 0.1))
        return status

    def send_stream(self, stream: str | bytes, wait_ready: bool = True) -> list[CommandResult]:
        results = []
        for chunk in self.packetize_stream(stream):
            before = self.get_status()
            if self.dry_run:
                self.write_packet(self.build_packet(chunk))
                label = chunk.decode("ascii", errors="replace")
                results.append(CommandResult(command=label, status_before=before, status_after=before))
                continue
            if wait_ready:
                self.wait_until_accepting_packets(timeout=self.ready_timeout)
                before = self.get_status()
            label = chunk.decode("ascii", errors="replace")
            if self.verbose:
                print(f"TX {label}: waiting={format_status(before)}")
            self.write_packet(self.build_packet(chunk))
            after = self.confirm_packet(post_timeout=self.confirm_timeout)
            results.append(CommandResult(command=label, status_before=before, status_after=after))
            if self.verbose:
                print(f"RX {label}: {format_status(after)}")
            if self.inter_packet_delay_ms > 0:
                time.sleep(self.inter_packet_delay_ms / 1000.0)
        return results

    def send_command(self, command: str, force: bool = False, wait_ready: bool = True) -> CommandResult:
        results = self.send_stream(command, wait_ready=wait_ready and not force)
        return results[-1]

    def handshake_packet(self, key: str) -> bytes:
        digest = hashlib.md5(key.upper().encode("ascii")).digest()
        payload = bytearray(ord("F") for _ in range(30))
        payload[0] = ord("A")
        payload[1:17] = digest
        packet = bytearray(32)
        packet[0] = 0x00
        packet[1:31] = payload
        packet[31] = crc8(payload)
        return bytes(packet)

    def handshake(self, key: str, timeout: float = 1.0) -> bool:
        self.write_packet(self.handshake_packet(key))
        if self.dry_run:
            return False
        deadline = time.time() + timeout
        while time.time() < deadline:
            status = self.get_status()
            if status == STATUS_SERIAL_CORRECT:
                return True
            if status == STATUS_OK:
                return False
            time.sleep(0.05)
        return False

    def initialize_controller(self) -> list[CommandResult]:
        return []

    def lock_rail(self) -> list[CommandResult]:
        return self.send_stream("IS1P\n")

    def unlock_rail(self) -> list[CommandResult]:
        return self.send_stream("IS2P\n")

    def rapid_move(self, dx_steps: int = 0, dy_steps: int = 0, unlock_after: bool = False) -> list[CommandResult]:
        return self.send_stream(build_rapid_move(dx_steps=dx_steps, dy_steps=dy_steps, unlock_after=unlock_after))

    def laser_gate(
        self, on: bool, mode: str = "legacy", unlock_after: bool = False
    ) -> list[CommandResult]:
        return self.send_stream(build_laser_gate(on=on, mode=mode, unlock_after=unlock_after))

    def set_power(self, percent: float) -> list[CommandResult]:
        return self.send_stream(build_power_command(percent), wait_ready=True)

    def set_vector_speed(self, mm_per_sec: float) -> list[CommandResult]:
        return self.send_stream(f"{build_speed_code(mm_per_sec)}\n")

    def enter_program_mode(self, mm_per_sec: float, declare_axes: str = "LT") -> list[CommandResult]:
        speed_code = build_speed_code(mm_per_sec)
        return self.send_stream(f"I\n{speed_code}\nN\n{declare_axes}\nS1E\n")

    def exit_program_mode(self) -> list[CommandResult]:
        return self.send_stream("FNSE-\n")


def add_connection_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--dry-run", action="store_true", help="Print packets without writing to USB.")
    parser.add_argument("--timeout-ms", type=int, default=1000, help="USB timeout in milliseconds.")
    parser.add_argument("--ready-timeout-s", type=float, default=8.0, help="How long to wait for the controller to accept the next packet.")
    parser.add_argument("--confirm-timeout-s", type=float, default=5.0, help="How long to wait for controller status to settle after each packet.")
    parser.add_argument("--inter-packet-delay-ms", type=float, default=0.0, help="Optional delay between packet writes for long streamed jobs.")
    parser.add_argument("--verbose-io", action="store_true", help="Print per-packet TX/RX status while streaming.")


def open_device_from_args(args: argparse.Namespace) -> M2NanoDevice:
    return M2NanoDevice(
        dry_run=args.dry_run,
        timeout_ms=args.timeout_ms,
        ready_timeout=args.ready_timeout_s,
        confirm_timeout=args.confirm_timeout_s,
        inter_packet_delay_ms=args.inter_packet_delay_ms,
        verbose=args.verbose_io,
    ).open()


def print_results(results: Iterable[CommandResult]) -> None:
    for result in results:
        print(
            f"{result.command or '<binary>'}: "
            f"{format_status(result.status_before)} -> {format_status(result.status_after)}"
        )


def main_guard(main_fn) -> int:
    try:
        return main_fn()
    except KeyboardInterrupt:
        print("Interrupted.", file=sys.stderr)
        return 130
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1
