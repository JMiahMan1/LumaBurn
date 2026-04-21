/**
 * M2Protocol: Translates G-code into M2/M3 Nano (Lihuiyu) binary instruction strings.
 * Aligned with verified Python prototype and MeerK40t logic.
 */
class M2Protocol {
  constructor(options = {}) {
    this.isMetric = options.units !== "inches";
    this.laserOn = false;
    this.x = 0;
    this.y = 0;

    // Direction mapping for Lihuiyu-GL
    // Direction mapping for Lihuiyu-GL (Verified: B is Right, T is Left, R is Down, L is Up)
    this.CODE_RIGHT = "B";
    this.CODE_LEFT = "T";
    this.CODE_UP = "R";
    this.CODE_DOWN = "L";

    this.DISTANCE_LOOKUP = [
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

    this.relative = false; // G90 by default
  }

  encodeDistance(v) {
    if (v < 0) return "";
    let val = Math.round(v);
    let dist = "";

    if (val >= 255) {
      const zs = Math.floor(val / 255);
      val %= 255;
      dist += "z".repeat(zs);
    }

    if (val >= 52) {
      dist += val.toString().padStart(3, "0");
    } else {
      dist += this.DISTANCE_LOOKUP[val];
    }
    return dist;
  }

  getSpeedCode(mmPerSec) {
    // MeerK40t M2/M3 Equation: 65536 - (5120 + 12120 * (1 / (speed/25.4)))
    const periodMs = 1.0 / (mmPerSec / 25.4);
    const val = Math.round(65536 - (5120 + 12120 * periodMs));

    const b0 = val & 0xff;
    const b1 = (val >> 8) & 0xff;

    const encoded = b1.toString().padStart(3, "0") + b0.toString().padStart(3, "0");
    return `CV${encoded}1`;
  }

  translate(gcode) {
    const lines = gcode.split("\n");
    const packets = [];

    lines.forEach((line) => {
      const clean = line.replace(/\s*;.*$/, "").trim();
      if (!clean) return;

      const tokens = this.parseTokens(clean);
      if (!tokens) {
        // Special raw commands
        if (clean === "I" || clean === "$X") packets.push("I\n");
        return;
      }

      const g = tokens.G;
      const m = tokens.M;
      const x = tokens.X;
      const y = tokens.Y;

      if (g === 90) this.relative = false;
      if (g === 91) this.relative = true;

      if (m === 3 || m === 4) {
        this.laserOn = true;
        packets.push("I" + "DA" + "S1P\n"); // V9 Safe Laser ON
      } else if (m === 5) {
        this.laserOn = false;
        packets.push("I" + "D0" + "S1P\n"); // V9 Safe Laser OFF
      }

      if (g === 0 || g === 1) {
        let dx = 0;
        let dy = 0;

        if (this.relative) {
          dx = x !== undefined ? (this.isMetric ? x * 39.37 : x * 1000) : 0;
          dy = y !== undefined ? (this.isMetric ? y * 39.37 : y * 1000) : 0;
        } else {
          dx = x !== undefined ? (this.isMetric ? x * 39.37 : x * 1000) - this.x : 0;
          dy = y !== undefined ? (this.isMetric ? y * 39.37 : y * 1000) - this.y : 0;
        }

        if (dx !== 0 || dy !== 0) {
          packets.push(...this.move(dx, dy));
          if (this.relative) {
            if (x !== undefined) this.x += this.isMetric ? x * 39.37 : x * 1000;
            if (y !== undefined) this.y += this.isMetric ? y * 39.37 : y * 1000;
          } else {
            if (x !== undefined) this.x = this.isMetric ? x * 39.37 : x * 1000;
            if (y !== undefined) this.y = this.isMetric ? y * 39.37 : y * 1000;
          }
        }
      } else if (g === 28) {
        // Home
        packets.push("IPP\n");
        this.x = 0;
        this.y = 0;
      }
    });

    return packets;
  }

  move(dx, dy) {
    const commands = [];
    const adx = Math.abs(dx);
    const ady = Math.abs(dy);

    // M2Nano V9 requires I...S1P wrapping for every move to be stable
    if (dx !== 0) {
      const code = dx > 0 ? this.CODE_RIGHT : this.CODE_LEFT;
      commands.push("I" + code + this.encodeDistance(adx) + "S1P\n");
    }
    if (dy !== 0) {
      // dy > 0 is "Up" button.
      const code = dy > 0 ? this.CODE_UP : this.CODE_DOWN;
      console.log(`[Protocol] Y-Jog: dy=${dy} -> Code: ${code}`);
      commands.push("I" + code + this.encodeDistance(ady) + "S1P\n");
    }

    return commands;
  }

  parseTokens(line) {
    const tokens = {};
    const matches = line.matchAll(/([A-Z])([+-]?\d*(?:\.\d+)?)/gi);
    let count = 0;
    for (const match of matches) {
      tokens[match[1].toUpperCase()] = parseFloat(match[2]);
      count++;
    }
    return count > 0 ? tokens : null;
  }
}

module.exports = M2Protocol;
