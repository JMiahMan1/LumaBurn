const { SerialPort } = require("serialport");
const { ReadlineParser } = require("@serialport/parser-readline");

/**
 * GRBLDriver: Low-level Serial driver for GRBL-based lasers (Longer Ray 5, etc.)
 */
class GRBLDriver {
  constructor(path, baudRate = 115200) {
    this.path = path;
    this.baudRate = baudRate;
    this.port = null;
    this.parser = null;
    this.isOpen = false;
    this.latestStatus = "Idle";
    this.pos = { x: 0, y: 0, z: 0 };
    this.statusInterval = null;
    this.callbacks = new Set();
  }

  async open() {
    console.log(`[GRBL] Opening ${this.path} at ${this.baudRate} baud...`);
    return new Promise((resolve, reject) => {
      this.port = new SerialPort({
        path: this.path,
        baudRate: this.baudRate,
        hupcl: false,
        autoOpen: false,
      });

      this.parser = this.port.pipe(new ReadlineParser({ delimiter: "\r\n" }));

      this.port.open((err) => {
        if (err) return reject(err);

        // DTR/RTS pulse to reset some boards
        this.port.set({ dtr: true, rts: true }, async (err) => {
          if (err) console.warn("[GRBL] Failed to set DTR/RTS:", err.message);

          // Settle time
          await new Promise((r) => setTimeout(r, 1000));

          this.isOpen = true;

          this.parser.on("data", (line) => {
            this.handleData(line.trim());
          });

          // Start status polling
          this.statusInterval = setInterval(() => this.write("?"), 1500);

          console.log(`[GRBL] ${this.path} connected.`);
          resolve();
        });
      });

      this.port.on("error", (err) => {
        console.error(`[GRBL] Serial Error: ${err.message}`);
      });

      this.port.on("close", () => {
        this.isOpen = false;
        clearInterval(this.statusInterval);
        console.log(`[GRBL] ${this.path} closed.`);
      });
    });
  }

  handleData(line) {
    if (!line) return;

    // GRBL Status Report: <Idle|MPos:0.000,0.000,0.000|FS:0,0>
    if (line.startsWith("<") && line.endsWith(">")) {
      const parts = line.substring(1, line.length - 1).split("|");
      this.latestStatus = parts[0];
      const posPart = parts.find((p) => p.startsWith("MPos:") || p.startsWith("WPos:"));
      if (posPart) {
        const coords = posPart.split(":")[1].split(",");
        this.pos = {
          x: parseFloat(coords[0]),
          y: parseFloat(coords[1]),
          z: parseFloat(coords[2]),
        };
      }
    }

    // Notify subscribers (e.g. for 'ok' or 'error' responses)
    for (const cb of this.callbacks) {
      cb(line);
    }
  }

  async write(data) {
    if (!this.isOpen) return;
    return new Promise((resolve, reject) => {
      // GRBL expects \r or \n or both. \r\n is safest for most.
      // Real-time commands (?, !, ~) should NOT have a newline.
      const isRealtime = ["?", "!", "~", "\x18"].includes(data);
      const cmd = isRealtime ? data : data + "\n";

      this.port.write(cmd, (err) => {
        if (err) return reject(err);
        resolve();
      });
    });
  }

  async command(cmd, timeout = 5000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => {
          this.callbacks.delete(onData);
          reject(new Error(`Command timeout: ${cmd}`));
        },
        cmd === "$H" || cmd.startsWith("G28") ? 60000 : timeout
      );

      const onData = (line) => {
        if (line.includes("ok") || line.includes("error")) {
          clearTimeout(timer);
          this.callbacks.delete(onData);
          resolve(line);
        }
      };

      this.callbacks.add(onData);
      this.write(cmd).catch(reject);
    });
  }

  /**
   * Sends a dithered bitstring as a high-speed raster line.
   * @param {string} bitstring - "1" for ON, "0" for OFF
   * @param {number} stepSize - mm per pixel
   * @param {number} speed - feed rate in mm/min
   * @param {number} powerScale - 0-1000
   */
  async sendRasterRow(bitstring, stepSize = 0.1, speed = 3000, powerScale = 1000, options = {}) {
    if (!this.isOpen) return;
    const direction = options.direction === "left" ? -1 : 1;
    const rowAdvance = Number.isFinite(options.rowAdvance) ? Number(options.rowAdvance) : stepSize;

    // Ensure we are in G1 mode with M4 (Dynamic Power)
    await this.command("M4");
    await this.command(`G1 F${speed}`);

    let x = 0;

    while (x < bitstring.length) {
      const bit = bitstring[x];
      let count = 0;
      while (x < bitstring.length && bitstring[x] === bit) {
        count++;
        x++;
      }

      const dist = count * stepSize;
      const power = bit === "1" ? powerScale : 0;

      // We use relative movement G91 for the row segments to be precise
      await this.command("G91");
      await this.command(`G1 X${(dist * direction).toFixed(4)} S${power}`);
      await this.command("G90");
    }

    if (rowAdvance !== 0) {
      await this.command("G91");
      await this.command(`G0 Y${rowAdvance.toFixed(4)}`);
      await this.command("G90");
    }
  }

  async close() {
    if (this.isOpen) {
      clearInterval(this.statusInterval);
      return new Promise((resolve) => this.port.close(() => resolve()));
    }
  }
}

module.exports = GRBLDriver;
