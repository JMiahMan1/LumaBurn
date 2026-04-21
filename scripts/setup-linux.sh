#!/bin/bash

# scripts/setup-linux.sh
# Configures system permissions for LumaBurn laser hardware.
# This script installs udev rules for OMTech (CH341) and Longer Ray 5 (CH340).

RULES_FILE="packaging/linux/99-lumaburn.rules"
DEST_FILE="/etc/udev/rules.d/99-lumaburn.rules"

echo "--------------------------------------------------------"
echo "LumaBurn: Linux Hardware Permission Setup"
echo "--------------------------------------------------------"

if [[ $EUID -ne 0 ]]; then
   echo "Error: This script must be run as root (use sudo)." 
   exit 1
fi

if [ ! -f "$RULES_FILE" ]; then
    echo "Error: Rules file not found at $RULES_FILE"
    exit 1
fi

echo "Copying udev rules to $DEST_FILE..."
cp "$RULES_FILE" "$DEST_FILE"

echo "Setting permissions on rules file..."
chmod 644 "$DEST_FILE"

echo "Reloading udev rules..."
udevadm control --reload-rules
udevadm trigger

# Check for brltty conflict (The #1 reason CH340/CH341 lasers are missing on Linux)
if systemctl is-active --quiet brltty; then
    echo "CRITICAL: 'brltty' (Braille Display driver) is active and is likely BLOCKED your laser's serial port."
    echo "To fix this, run: sudo systemctl disable --now brltty"
    echo "Then unplug and replug your laser's USB cable."
fi

# Check for ModemManager conflict (Blocks communication)
if systemctl is-active --quiet ModemManager; then
    echo "WARNING: 'ModemManager' is active. It often interferes with laser communication."
    echo "To fix this, run: sudo systemctl disable --now ModemManager"
fi

# Check for spi-ch341 conflict (Driver stealing)
if lsmod | grep -q "spi_ch341"; then
    echo "CRITICAL: The 'spi_ch341' driver has claimed your laser in SPI mode."
    echo "This prevents the laser from appearing as a Serial Port (/dev/ttyUSB0)."
    echo ""
    echo "To fix this, run these commands:"
    echo "  sudo modprobe -r spi_ch341"
    echo "  sudo modprobe ch341"
    echo ""
    echo "To make this permanent, add a blacklist:"
    echo "  echo 'blacklist spi_ch341' | sudo tee /etc/modprobe.d/lumaburn-blacklist.conf"
    echo "Then unplug and replug your laser's USB cable."
fi

# Ensure serial drivers are loaded for standard GRBL hardware
if [ -d "/sys/bus/usb-serial/drivers/ch341-uart" ]; then
    echo "Serial drivers initialized for CH340/CH341 hardware."
fi

echo "--------------------------------------------------------"
echo "Done! Please replug your laser's USB cable."
echo "Hardware supported: OMTech (CH341), Longer Ray 5, and Generic GRBL (CP210x/FTDI)."
echo "--------------------------------------------------------"
