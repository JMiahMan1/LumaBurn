const usb = require('usb');
const crypto = require('crypto');
const { crc8 } = require('../core/crc8.cjs');

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
        this.USB_VENDOR = 0x1A86;
        this.USB_PRODUCT = 0x5512;
        this.mCH341_PARA_INIT = 0xB1;
        this.mCH341A_STATUS = 0x52;
        this.mCH341_VENDOR_WRITE = 0x40;
        this.mCH341_VENDOR_READ = 0xC0;
        this.mCH341_PARA_CMD_W0 = 0xA6;
        
        // Lihuiyu Status Codes
        this.STATUS_SERIAL_CORRECT = 204;
        this.STATUS_OK = 206;
        this.STATUS_ERROR = 207;
        this.STATUS_BUSY = 238;
    }

    async open() {
        return new Promise((resolve, reject) => {
            const dev = usb.findByIds(this.USB_VENDOR, this.USB_PRODUCT);
            if (!dev) return reject(new Error('Laser (CH341) not found.'));

            dev.open();
            this.device = dev;
            this.interface = dev.interfaces[0];

            try {
                if (this.interface.isKernelDriverActive()) {
                    this.interface.detachKernelDriver();
                }
            } catch (e) {
                console.warn('[M2Nano] Kernel detach failed/skipped:', e.message);
            }

            this.interface.claim();

            this.outEndpoint = this.interface.endpoints.find(e => e.direction === 'out' && e.address === 0x02);
            this.inEndpoint = this.interface.endpoints.find(e => e.direction === 'in' && e.address === 0x82);

            this.isOpen = true;
            
            this.initCH341()
                .then(() => resolve())
                .catch(reject);
        });
    }

    async initCH341() {
        console.log('[M2Nano] Initializing CH341 (EPP 1.9 Mode)...');
        
        // Init Parallel Mode (Mode 1 = EPP 1.9)
        // MeerK40t: value = mode << 8 | 2 (if mode < 256) -> 0x0102
        await this.controlTransfer(this.mCH341_VENDOR_WRITE, this.mCH341_PARA_INIT, 0x0102, 0, Buffer.alloc(0));
        
        console.log('[M2Nano] Connected. Current Status:', await this.getStatus());
        
        // Handshake skipped by default for M2 mode, but we'll try a Reset
        await this.writeRaw("I\n");
    }

    async getStatus() {
        return new Promise((resolve, reject) => {
            if (!this.isOpen) return reject(new Error('Device closed'));
            
            this.device.controlTransfer(this.mCH341_VENDOR_READ, this.mCH341A_STATUS, 0, 0, 8, (err, data) => {
                if (err) return reject(err);
                // MeerK40t looks at index 1
                const status = data[1];
                if (status !== this.lastStatus) {
                    // console.log(`[M2Nano] Status: ${status}`);
                    this.lastStatus = status;
                }
                resolve(status);
            });
        });
    }

    async waitStatus(expectedStatus, timeoutMs = 2000) {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            const s = await this.getStatus();
            if (s === expectedStatus) return true;
            if (s === this.STATUS_ERROR && expectedStatus !== this.STATUS_ERROR) {
                // throw new Error(`Laser reported ERROR (${s})`);
            }
            await new Promise(r => setTimeout(r, 20));
        }
        return false;
    }

    async controlTransfer(bmRequestType, bRequest, wValue, wIndex, data) {
        return new Promise((resolve, reject) => {
            this.device.controlTransfer(bmRequestType, bRequest, wValue, wIndex, data, (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
    }

    /**
     * Formats and writes a 32-byte Lihuiyu packet.
     * @param {string|Buffer} payloadStr 
     * @param {string} padChar 
     */
    async write(payloadStr, padChar = 'F') {
        const payload = Buffer.alloc(30, padChar);
        const source = Buffer.from(payloadStr);
        source.copy(payload, 0, 0, Math.min(source.length, 30));
        
        const crc = crc8(payload, 0, 30);
        const packet = Buffer.alloc(32);
        packet[0] = 0x00;
        payload.copy(packet, 1);
        packet[31] = crc;
        
        return this.writePacket(packet);
    }

    async writePacket(packet) {
        // CH341 EPP Write Data: Prepends 0xA6 every 31 bytes
        // For a 32-byte packet: [0xA6] [31 bytes] [0xA6] [1 byte]
        const data = Buffer.alloc(34);
        data[0] = this.mCH341_PARA_CMD_W0;
        packet.copy(data, 1, 0, 31);
        data[32] = this.mCH341_PARA_CMD_W0;
        packet.copy(data, 33, 31, 32);
        
        return new Promise((resolve, reject) => {
            if (!this.isOpen) return reject(new Error('Device closed'));
            this.outEndpoint.transfer(data, (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
    }

    async writeRaw(cmd) {
        return this.write(cmd);
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
            } catch (e) {
                this.isOpen = false;
            }
        }
    }
}

module.exports = M2NanoDriver;
