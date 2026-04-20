#!/usr/bin/env python3

from __future__ import annotations

import argparse

import usb.core
import usb.util

from m2nano_usb import USB_PRODUCT, USB_VENDOR, add_connection_args, main_guard


def main() -> int:
    parser = argparse.ArgumentParser(description="Detect the M2Nano CH341 controller.")
    add_connection_args(parser)
    args = parser.parse_args()

    device = usb.core.find(idVendor=USB_VENDOR, idProduct=USB_PRODUCT)
    if device is None:
        raise RuntimeError("CH341 device 1a86:5512 not found.")

    print(f"Found device: {device.idVendor:04x}:{device.idProduct:04x}")
    print(f"Bus/address: {getattr(device, 'bus', '?')} / {getattr(device, 'address', '?')}")
    print(f"Class/subclass/protocol: {device.bDeviceClass}/{device.bDeviceSubClass}/{device.bDeviceProtocol}")

    if args.dry_run:
        return 0

    device.set_configuration()
    cfg = device.get_active_configuration()
    for interface in cfg:
        print(f"Interface {interface.bInterfaceNumber}: class {interface.bInterfaceClass}")
        for endpoint in interface:
            direction = usb.util.endpoint_direction(endpoint.bEndpointAddress)
            label = "IN" if direction == usb.util.ENDPOINT_IN else "OUT"
            print(f"  Endpoint 0x{endpoint.bEndpointAddress:02X} {label} max_packet={endpoint.wMaxPacketSize}")
    usb.util.dispose_resources(device)
    return 0


if __name__ == "__main__":
    raise SystemExit(main_guard(main))
