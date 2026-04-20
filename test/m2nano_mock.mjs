import { EventEmitter } from "node:events";

/**
 * Mock USB Device for M2Nano Testing
 * Simulates a CH341 in EPP mode with M2Nano (Lihuiyu) status registers.
 */
export class MockM2NanoUSB extends EventEmitter {
  constructor() {
    super();
    this.isOpen = false;
    this.isClaimed = false;
    this.status = 0xce; // STATUS_OK
    this.receivedPackets = [];
    this.lastPacket = null;
    this.interfaces = [
      {
        bInterfaceNumber: 0,
        isKernelDriverActive: () => false,
        detachKernelDriver: () => {},
        claim: () => {
          this.isClaimed = true;
        },
        release: (force, cb) => {
          this.isClaimed = false;
          if (cb) cb();
        },
        endpoints: [
          {
            address: 0x02,
            direction: "out",
            transfer: (data, cb) => this._handleOutTransfer(data, cb),
          },
          {
            address: 0x82,
            direction: "in",
            transfer: (len, cb) => this._handleInTransfer(len, cb),
          },
        ],
      },
    ];
  }

  open() {
    this.isOpen = true;
  }

  close() {
    this.isOpen = false;
  }

  controlTransfer(bmRequestType, bRequest, wValue, wIndex, data, cb) {
    // CH341_VENDOR_READ (0xC0) and CH341_STATUS (0x52)
    if (bmRequestType === 0xc0 && bRequest === 0x52) {
      const response = Buffer.alloc(8, 0);
      response[1] = this.status;
      if (cb) cb(null, response);
      return;
    }
    // CH341_PARA_INIT (0xB1)
    if (bmRequestType === 0x40 && bRequest === 0xb1) {
      if (cb) cb(null);
      return;
    }
    if (cb) cb(null);
  }

  _handleOutTransfer(data, cb) {
    // EPP Wrapped Packet: [0xA6] [31 bytes] [0xA6] [1 byte]
    if (data[0] !== 0xa6 || data[32] !== 0xa6) {
      this.status = 0xcf; // ERROR
      if (cb) cb(new Error("Invalid EPP format"));
      return;
    }

    const packet = Buffer.alloc(32);
    data.copy(packet, 0, 1, 32);
    packet[31] = data[33];

    this.receivedPackets.push(packet);
    this.lastPacket = packet;

    // Detect Handshake: [0x00] [0x41] [16 bytes MD5] ...
    if (packet[1] === 0x41) {
      // Correct Handshake Key (simplification: accept any handshake for now)
      this.status = 0xcc; // STATUS_SERIAL_CORRECT
      if (cb) cb(null);
      return;
    }

    // Simulate busy state after a regular packet is received
    this.status = 0xee; // BUSY

    // Auto-clear busy after a short delay in the mock
    setTimeout(() => {
      if (this.status === 0xee) {
        this.status = 0xce; // OK
      }
    }, 10);

    if (cb) cb(null);
  }

  _handleInTransfer(len, cb) {
    if (cb) cb(null, Buffer.alloc(len, 0));
  }

  // Test Helpers
  setStatus(newStatus) {
    this.status = newStatus;
  }

  getPackets() {
    return this.receivedPackets;
  }

  getPayloadStrings() {
    return this.receivedPackets.map((packet) => Buffer.from(packet.slice(1, 31)).toString("ascii").replace(/\0/g, ""));
  }

  clearPackets() {
    this.receivedPackets = [];
  }
}

export const mockUsbModule = {
  findByIds: (vid, pid) => {
    if (vid === 0x1a86 && pid === 0x5512) {
      return new MockM2NanoUSB();
    }
    return null;
  },
};
