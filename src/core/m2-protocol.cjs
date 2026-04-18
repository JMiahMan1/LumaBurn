/**
 * Lhymicro-GL Protocol Translator for LumaBurn (M2Nano Boards)
 * This module converts G-code into the 32-byte binary "L-packets" 
 * required by stock K40 motherboards.
 */

class M2Protocol {
    constructor() {
        this.reset();
    }

    reset() {
        this.lastX = 0;
        this.lastY = 0;
        this.isMetric = true;
        this.absolute = true;
        this.isCompact = false;
    }

    /**
     * Encodes a numeric value into the Lhymicro magnitude format.
     * @param {number} val 
     * @returns {string} Encoded magnitude string
     */
    encodeMagnitude(val) {
        let v = Math.round(Math.abs(val));
        if (v <= 0) return "";
        
        let out = "";
        // Large distance jumps (255 steps)
        while (v >= 255) {
            out += "z";
            v -= 255;
        }

        // Medium distance jumps (25 steps)
        while (v >= 25) {
            out += "y"; // Standard M2/M3 encoding for 25
            v -= 25;
        }

        // Small distance jumps (1-25 steps)
        if (v > 0) {
            out += String.fromCharCode(96 + v); // 'a' through 'y'
        }

        return out;
    }

    /**
     * Translates a G-code command into a sequence of Lhymicro packets.
     * @param {string} gcode 
     * @returns {string[]} Array of command strings (to be packetized into 32-bytes each)
     */
    translate(gcode) {
        const cmd = gcode.trim().toUpperCase();
        if (!cmd || cmd.startsWith('(') || cmd.startsWith(';')) return [];

        if (cmd === 'G20') { this.isMetric = false; return []; }
        if (cmd === 'G21') { this.isMetric = true; return []; }
        if (cmd === 'G90') { this.absolute = true; return []; }
        if (cmd === 'G91') { this.absolute = false; return []; }
        if (cmd === 'G28' || cmd === '$H') return this.home();
        if (cmd === '!' || cmd === '\u0018') return ["\x1b@"];

        const parts = cmd.split(/\s+/);
        const op = parts[0];
        
        const params = {};
        for (let i = 1; i < parts.length; i++) {
            const p = parts[i];
            const key = p[0];
            const val = parseFloat(p.substring(1));
            if (!isNaN(val)) params[key] = val;
        }

        if (op === 'G0' || op === 'G1') {
            return this.move(params, op === 'G0');
        }

        if (op === 'M3' || op === 'M4') this.laserDown = true;
        if (op === 'M5') this.laserDown = false;

        return [];
    }

    home() {
        // M2Nano Home sequence: 
        // 1. \x1b@ - ESC @ Reset/Unlock state machine
        // 2. IPP - Reset Position
        // 3. IBH - Home
        // 4. IFE - Finish
        return ["\x1b@", "IPP", "IBH", "IFE"];
    }

    move(params, isRapid) {
        const targetX = params.X !== undefined ? (this.absolute ? params.X : this.lastX + params.X) : this.lastX;
        const targetY = params.Y !== undefined ? (this.absolute ? params.Y : this.lastY + params.Y) : this.lastY;

        // K40 is 1000 DPI (approx 39.37 steps per mm)
        const scale = this.isMetric ? 39.37 : 1000;
        
        let dx = Math.round((targetX - this.lastX) * scale);
        let dy = Math.round((targetY - this.lastY) * scale);

        this.lastX = targetX;
        this.lastY = targetY;

        if (dx === 0 && dy === 0) return [];

        const commands = [];
        const laser = this.laserDown && !isRapid ? "D" : "U";
        
        // M3-Nano Velocity: v + 3 digits (e.g., v010 for 10mm/s)
        commands.push("v010"); 

        if (dx !== 0) {
            const dir = dx > 0 ? "R" : "L";
            commands.push("B" + laser + dir + this.encodeMagnitude(dx) + "E");
        }
        
        if (dy !== 0) {
            const dir = dy > 0 ? "D" : "U";
            commands.push("B" + laser + dir + this.encodeMagnitude(dy) + "E");
        }

        // Finish block
        commands.push("IFE");

        return commands;
    }
}

module.exports = M2Protocol;
