#!/bin/bash
# LumaBurn Laser Unbind Script
# Forces the Linux kernel to release the CH341 driver from the M2Nano board.

DEVICE_PATH="1-3"
DRIVER="ch341"

echo "Attempting to unbind $DRIVER from $DEVICE_PATH..."

if [ -e "/sys/bus/usb/drivers/$DRIVER/$DEVICE_PATH" ]; then
    echo "Found active $DRIVER driver on $DEVICE_PATH. Unbinding..."
    echo -n "$DEVICE_PATH" | tee /sys/bus/usb/drivers/$DRIVER/unbind
    if [ $? -eq 0 ]; then
        echo "Successfully unbound $DRIVER."
    else
        echo "FAILED to unbind. You may need to run: sudo echo -n '$DEVICE_PATH' > /sys/bus/usb/drivers/$DRIVER/unbind"
    fi
else
    echo "Driver $DRIVER not found on $DEVICE_PATH. It might already be unbound or on a different path."
fi

# Fallback: check for generic usbserial
if [ -e "/sys/bus/usb/drivers/usbserial/$DEVICE_PATH" ]; then
    echo "Found usbserial on $DEVICE_PATH. Unbinding..."
    echo -n "$DEVICE_PATH" | tee /sys/bus/usb/drivers/usbserial/unbind
fi

lsusb -t | grep -C 2 "1a86"
