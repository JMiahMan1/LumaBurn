const usb = globalThis.__lumaburnUsbMock || require("usb");
const crypto = require("crypto");
const { crc8 } = require("../core/crc8.cjs");

/**
 * M2Nano Driver (M3 Nano V9 Compatible)
 *
 * Replicates MeerK40t's Lihuiyu protocol for CH341-based laser controllers.
 */
class M2NanoDriver {
  constructor() {
    this.device = null;
    this.interface = null;
    this.outEndpoint = null;
    this.inEndpoint = null;
    this.isOpen = false;
    this.lastStatus = 0;

    // CH341 Constants
    this.USB_VENDOR = 0x1a86;
    this.USB_PRODUCT = 0x5512;
    this.mCH341_PARA_INIT = 0xb1;
    this.mCH341A_STATUS = 0x52;
    this.mCH341_VENDOR_WRITE = 0x40;
    this.mCH341_VENDOR_READ = 0xc0;
    this.mCH341_PARA_CMD_W0 = 0xa6;

    // Lihuiyu Status Codes
    this.STATUS_SERIAL_CORRECT = 0xcc; // 204
    this.STATUS_OK = 0xce; // 206
    this.STATUS_ERROR = 0xcf; // 207
    this.STATUS_FINISH = 0xec; // 236
    this.STATUS_BUSY = 0xee; // 238
    this.STATUS_POWER = 0xef; // 239

    // Configuration
    this.readyTimeout = 5000;
    this.confirmTimeout = 2000;
    this.verbose = false;
    this.programModeActive = false;
    this.programModeSpeed = null;
    this.gateMode = "legacy";

    // Direction mapping for Lihuiyu-GL (Verified: X+ is B, Y+ is R)
    this.CODE_RIGHT = "B";
    this.CODE_LEFT = "T";
    this.CODE_TOP = "L";
    this.CODE_BOTTOM = "R";
  }

  async open() {
    return new Promise((resolve, reject) => {
      const dev = usb.findByIds(this.USB_VENDOR, this.USB_PRODUCT);
      if (!dev) return reject(new Error("Laser (CH341) not found."));

      dev.open();
      this.device = dev;
      this.interface = dev.interfaces[0];

      try {
        if (this.interface.isKernelDriverActive()) {
          this.interface.detachKernelDriver();
        }
      } catch (e) {
        console.warn("[M2Nano] Kernel detach failed/skipped:", e.message);
      }

      this.interface.claim();

      this.outEndpoint = this.interface.endpoints.find((e) => e.direction === "out" && e.address === 0x02);
      this.inEndpoint = this.interface.endpoints.find((e) => e.direction === "in" && e.address === 0x82);

      this.isOpen = true;

      this.initCH341()
        .then(() => resolve())
        .catch(reject);
    });
  }

  async initCH341() {
    console.log("[M2Nano] Initializing CH341 (EPP 1.9 Mode)...");

    // Init Parallel Mode (Mode 1 = EPP 1.9)
    await this.controlTransfer(this.mCH341_VENDOR_WRITE, this.mCH341_PARA_INIT, 0x0102, 0, Buffer.alloc(0));

    const status = await this.getStatus();
    console.log("[M2Nano] Connected. Current Status:", this.formatStatus(status));

    // Security Handshake: Cycle through common keys until confirmed
    const keys = ["K40", "M2NANO", "CH341S"];
    let handshaked = false;
    for (const key of keys) {
      console.log(`[M2Nano] Attempting Handshake with key: ${key}`);
      const confirmed = await this.handshake(key);
      if (confirmed) {
        console.log(`[M2Nano] Handshake Successful with key: ${key}`);
        handshaked = true;
        break;
      }
    }

    if (!handshaked) {
      console.warn("[M2Nano] No handshake keys confirmed. Proceeding anyway...");
    }

    // Forceful Buffer Clear Burst
    console.log("[M2Nano] Clearing board buffer...");
    await this.clearBusyState();

    // Send Initialize / Lock sequence
    console.log("[M2Nano] Sending Initial Reset (I)...");
    await this.sendStream("I\n");
    await new Promise((r) => setTimeout(r, 100));

    console.log("[M2Nano] Locking Rail (IS1P)...");
    await this.sendStream("IS1P\n");
    await this.waitStatus(this.STATUS_OK, 1000);
  }

  async handshake(serial) {
    const hash = crypto.createHash("md5").update(serial.toUpperCase()).digest();
    const payload = Buffer.alloc(30, 0x46); // 'F'
    payload[0] = 0x41; // 'A'
    hash.copy(payload, 1);

    const packet = this.buildPacket(payload);
    await this.writePacket(packet, true); // Force handshake packet

    // Wait for STATUS_SERIAL_CORRECT (0xCC)
    const start = Date.now();
    while (Date.now() - start < 1000) {
      const s = await this.getStatus();
      if (s === this.STATUS_SERIAL_CORRECT) return true;
      if (s === this.STATUS_OK) return false;
      await new Promise((r) => setTimeout(r, 50));
    }
    return false;
  }

  formatStatus(status) {
    const names = {
      0xcc: "serial-correct",
      0xce: "ok",
      0xcf: "error",
      0xec: "finish",
      0xee: "busy",
      0xef: "low-power",
    };
    return `0x${status.toString(16).toUpperCase()} (${names[status] || "unknown"})`;
  }

  async getStatus() {
    return new Promise((resolve, reject) => {
      if (!this.isOpen) return reject(new Error("Device closed"));

      this.device.controlTransfer(this.mCH341_VENDOR_READ, this.mCH341A_STATUS, 0, 0, 8, (err, data) => {
        if (err) return reject(err);
        const status = data[1];
        if (status !== this.lastStatus && this.verbose) {
          console.log(`[M2Nano] Status Change: ${this.formatStatus(status)}`);
        }
        this.lastStatus = status;
        resolve(status);
      });
    });
  }

  async waitStatus(expectedStatus, timeoutMs = 2000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const s = await this.getStatus();
      if (s === expectedStatus) return true;
      await new Promise((r) => setTimeout(r, 5));
    }
    return false;
  }

  async waitUntilAcceptingPackets(timeoutMs = 5000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const s = await this.getStatus();
      if (s === this.STATUS_OK || s === this.STATUS_ERROR) {
        return s;
      }
      await new Promise((r) => setTimeout(r, 5));
    }
    return this.lastStatus;
  }

  async confirmPacket(timeoutMs = 2000) {
    const start = Date.now();
    let attempts = 0;
    while (Date.now() - start < timeoutMs) {
      attempts++;
      const s = await this.getStatus();
      if (s === 0) continue;
      if (s === this.STATUS_OK) return s;
      if (s === this.STATUS_BUSY) {
        if (attempts > 10) await new Promise((r) => setTimeout(r, Math.min(attempts, 100)));
        continue;
      }
      if (s === this.STATUS_ERROR) return s;
      if (s === this.STATUS_FINISH || s === this.STATUS_SERIAL_CORRECT) continue;
      if (attempts > 10) await new Promise((r) => setTimeout(r, Math.min(attempts, 100)));
    }
    return this.lastStatus;
  }

  async clearBusyState() {
    const recoveryCommands = ["D0\n", "FNSE-\n", "IS2P\n", "IPP\n"];
    for (let i = 0; i < 2; i++) {
      const s = await this.getStatus();
      if (s === this.STATUS_OK) return;
      for (const cmd of recoveryCommands) {
        await this.sendStream(cmd, false);
        await new Promise((r) => setTimeout(r, 250));
        const status = await this.waitUntilAcceptingPackets(1000);
        if (status === this.STATUS_OK) return;
      }
    }
  }

  buildPacket(payload, padChar = 0x46) {
    const buffer = Buffer.alloc(30, padChar);
    if (Buffer.isBuffer(payload)) {
      payload.copy(buffer, 0, 0, Math.min(payload.length, 30));
    } else {
      const source = Buffer.from(payload);
      source.copy(buffer, 0, 0, Math.min(source.length, 30));
    }

    const crc = crc8(buffer, 0, 30);
    const packet = Buffer.alloc(32);
    packet[0] = 0x00;
    buffer.copy(packet, 1);
    packet[31] = crc;
    return packet;
  }

  packetizeStream(stream) {
    const buffer = Buffer.isBuffer(stream) ? stream : Buffer.from(stream, "ascii");
    const packets = [];
    let offset = 0;
    while (offset < buffer.length) {
      let find = -1;
      // Look for \n within the next 30 bytes
      for (let i = offset; i < Math.min(offset + 30, buffer.length); i++) {
        if (buffer[i] === 0x0a) {
          find = i;
          break;
        }
      }

      let length;
      if (find === -1) {
        length = Math.min(30, buffer.length - offset);
      } else {
        length = Math.min(30, buffer.length - offset, find - offset + 1);
      }

      let chunk = buffer.slice(offset, offset + length);
      if (chunk[chunk.length - 1] === 0x0a) {
        // Handle newline
        const isAT = chunk.toString().startsWith("AT");
        chunk = chunk.slice(0, chunk.length - 1);
        if (!isAT) {
          if (chunk.length === 0) chunk = Buffer.from("F");
          if (chunk[chunk.length - 1] === 0x50) {
            // 'P'
            chunk = Buffer.concat([chunk, Buffer.from("F")]);
          }
        }
      }
      packets.push(chunk);
      offset += length;
    }
    return packets;
  }

  async sendStream(stream, waitReady = true) {
    const chunks = this.packetizeStream(stream);
    const results = [];
    const isManual = stream.includes("S1P") || stream.length < 10;

    for (const chunk of chunks) {
      // Fast-path for manual commands: skip pre-wait if not in a critical job
      if (waitReady && !isManual) {
        await this.waitUntilAcceptingPackets(this.readyTimeout);
      }

      const before = this.lastStatus;
      const chunkStr = chunk.toString();
      const isAT = chunkStr.startsWith("AT");
      const packet = this.buildPacket(chunk, isAT ? 0x00 : 0x46);

      await this.writePacket(packet);

      // Fast-path for manual: minimal wait for confirmation
      const confirmTimeout = isManual ? 100 : this.confirmTimeout;
      const after = await this.confirmPacket(confirmTimeout);

      results.push({ command: chunkStr, before, after });
    }
    return results;
  }

  async write(payloadStr, padChar = "F") {
    // Legacy support for single-packet writes
    return this.sendStream(payloadStr);
  }

  async writeRaw(cmd, force = false) {
    // Legacy support for single-packet writes
    // Note: server.cjs uses writeRaw(cmdStr)
    return this.sendStream(cmd, !force);
  }

  async controlTransfer(bmRequestType, bRequest, wValue, wIndex, data) {
    return new Promise((resolve, reject) => {
      this.device.controlTransfer(bmRequestType, bRequest, wValue, wIndex, data, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async writePacket(packet) {
    const data = Buffer.alloc(34);
    data[0] = this.mCH341_PARA_CMD_W0;
    packet.copy(data, 1, 0, 31);
    data[32] = this.mCH341_PARA_CMD_W0;
    packet.copy(data, 33, 31, 32);

    return new Promise((resolve, reject) => {
      if (!this.isOpen) return reject(new Error("Device closed"));
      this.outEndpoint.transfer(data, (err) => {
        if (err) {
          if (err.errno === 16 || err.message.includes("Resource busy")) {
            console.error("[M2Nano] Resource busy! PLEASE POWER CYCLE THE LASER CUTTER.");
          }
          reject(err);
        } else resolve();
      });
    });
  }

  /**
   * Sets the laser power percentage (0-100).
   * Sends the AT1m\nn sequence used by the V1-V9 boards.
   */
  async setPower(percent) {
    const m = 1;
    const n = Math.floor(255 * (percent / 100));
    // MATCH PYTHON: I + A + m + T + n + 1
    const cmd = `IA${this.buildDistance(m)}T${this.buildDistance(n)}1\n`;
    await this.sendStream(cmd);
  }

  buildSpeedCode(mmPerSec) {
    const value = Math.max(0.1, mmPerSec);
    const periodMs = 1.0 / (value / 25.4);
    let encodedValue = Math.round(65536 - (5120 + 12120 * periodMs));
    encodedValue = Math.max(0, Math.min(0xffff, encodedValue));
    const low = (encodedValue & 0xff).toString().padStart(3, "0");
    const high = ((encodedValue >> 8) & 0xff).toString().padStart(3, "0");
    return `CV${high}${low}1`;
  }

  async enterProgramMode(mmPerSec, declareAxes = "LT") {
    const speedCode = this.buildSpeedCode(mmPerSec);
    console.log(`[M2Nano] Entering Program Mode (Speed: ${mmPerSec} mm/s -> ${speedCode})...`);
    const result = await this.sendStream(`I\n${speedCode}\nN\n${declareAxes}\nS1E\n`);
    this.programModeActive = true;
    this.programModeSpeed = mmPerSec;
    return result;
  }

  async exitProgramMode() {
    console.log("[M2Nano] Exiting Program Mode...");
    const result = await this.sendStream("FNSE-\n");
    this.programModeActive = false;
    this.programModeSpeed = null;
    return result;
  }

  getGateCommands() {
    if (this.gateMode === "v9") {
      return { on: "DA", off: "D0" };
    }
    return { on: "D", off: "U" };
  }

  async beginRasterJob(speedMmPerSec = 100, powerPercent = null) {
    if (powerPercent !== null) {
      await this.setPower(powerPercent);
    }
    if (!this.programModeActive || this.programModeSpeed !== speedMmPerSec) {
      if (this.programModeActive) {
        await this.exitProgramMode();
      }
      await this.enterProgramMode(speedMmPerSec);
    }
  }

  async finishRasterJob() {
    if (this.programModeActive) {
      await this.exitProgramMode();
    }
  }

  /**
   * Sends a raster row using the Ironclad Stable method.
   * Hard-codes directions (B/T) into every packet to prevent wall-crashes.
   */
  async sendRasterRow(bitstring, stepSize = 4, speed = 100, powerPercent = null, options = {}) {
    if (!this.isOpen) return;
    const direction = options.direction === "left" ? "left" : "right";
    const rowAdvance = Number.isFinite(options.rowAdvance) ? Number(options.rowAdvance) : stepSize;
    const { on: gateOn, off: gateOff } = this.getGateCommands();
    const moveRight = this.CODE_RIGHT;
    const moveLeft = this.CODE_LEFT;
    const moveRow = rowAdvance > 0 ? this.CODE_BOTTOM : this.CODE_TOP;
    const rowDistance = this.buildDistance(Math.abs(rowAdvance));
    const horizontalCode = direction === "left" ? moveLeft : moveRight;

    await this.beginRasterJob(speed, powerPercent);

    let x = 0;
    while (x < bitstring.length) {
      const bit = bitstring[x];
      let count = 0;
      while (x < bitstring.length && bitstring[x] === bit) {
        count++;
        x++;
      }

      const dist = this.buildDistance(count * stepSize);
      if (bit === "1") {
        await this.sendStream(`I${gateOn}S1P\n`);
        await this.sendStream(`I${horizontalCode}${dist}S1P\n`);
        await this.sendStream(`I${gateOff}S1P\n`);
      } else {
        await this.sendStream(`I${horizontalCode}${dist}S1P\n`);
      }
    }

    if (rowDistance) {
      await this.sendStream(`I${moveRow}${rowDistance}S1P\n`);
    }
  }

  buildDistance(val) {
    if (val === 0) return "";
    const DISTANCE_LOOKUP = [
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
    ];
    let dist = "";
    let v = val;
    if (v >= 255) {
      const zs = Math.floor(v / 255);
      v %= 255;
      dist += "z".repeat(zs);
    }
    if (v >= 52) {
      dist += v.toString().padStart(3, "0");
    } else {
      dist += DISTANCE_LOOKUP[v];
    }
    return dist;
  }

  async close() {
    if (this.device) {
      try {
        this.isOpen = false;
        await new Promise((resolve) => {
          this.interface.release(true, () => {
            this.device.close();
            resolve();
          });
        });
      } catch {
        this.isOpen = false;
      }
    }
  }
}

module.exports = M2NanoDriver;
