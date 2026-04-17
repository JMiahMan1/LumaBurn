#!/bin/bash

# LumaBurn: Linux Post-Installation Script
# Runs with root privileges to configure laser hardware permissions.

echo "LumaBurn: Finalizing hardware integration..."

# 1. Reload udev rules (bundled via extraFiles)
if command -v udevadm >/dev/null 2>&1; then
    echo "Reloading udev rules..."
    udevadm control --reload-rules
    udevadm trigger
fi

# 2. Handle brltty and ModemManager conflicts (Blocks Serial Ports)
if systemctl is-active --quiet brltty; then
    echo "Deactivating 'brltty' to prevent serial port blockage..."
    systemctl disable --now brltty
fi

if systemctl is-active --quiet ModemManager; then
    echo "Deactivating 'ModemManager' to prevent serial communication interference..."
    systemctl disable --now ModemManager
fi

# Ensure serial drivers are loaded
echo "Initializing serial drivers..."
modprobe ch341 2>/dev/null || true

echo "Hardware setup complete. Please replug your laser."
exit 0
