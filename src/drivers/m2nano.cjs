const usb = require('usb');
const crypto = require('crypto');
const { crc8 } = require('../core/crc8.cjs');

class M2NanoDriver {
    constructor() {
        this.device = null;
        this.interface = null;
        this.outEndpoint = null;
        this.inEndpoint = null;
        this.isOpen = false;
        this.lastS = 0;
        this.packetIndex = 0;
    }

    async open() {
        return new Promise((resolve, reject) => {
            const dev = usb.findByIds(0x1a86, 0x5512);
            if (!dev) return reject(new Error('Laser not found.'));

            dev.open();
            this.device = dev;
            this.interface = dev.interfaces[0];

            try {
                if (this.interface.isKernelDriverActive()) {
                    this.interface.detachKernelDriver();
                }
            } catch (e) {}

            this.interface.claim();

            this.outEndpoint = this.interface.endpoints.find(e => e.direction === 'out' && e.address === 0x02);
            this.inEndpoint = this.interface.endpoints.find(e => e.direction === 'in' && e.address === 0x82);

            this.isOpen = true;
            this.initCH341().then(() => {
                this.finishInit().then(resolve).catch(reject);
            }).catch(reject);
        });
    }

    async initCH341() {
        console.log('[M2Nano] Initializing CH341 with Security Handshake...');
        // EPP Handshake
        await new Promise(r => this.device.controlTransfer(0x40, 0x51, 0xA8A8, 0x0000, Buffer.alloc(0), () => r()));
        
        // Security Challenge (Using Generic Serial M2N1234567890)
        console.log('[M2Nano] Sending Security Unlock...');
        const genericSerial = "M2N1234567890";
        const hash = crypto.createHash('md5').update(genericSerial).digest('hex').toUpperCase();
        const challenge = "A" + hash;
        
        // Send challenge as a 32-byte packet
        const packet = Buffer.alloc(32, 0x00);
        packet[0] = 0xA6;
        packet[1] = this.packetIndex++ & 0xFF;
        Buffer.from(challenge).copy(packet, 2);
        packet[31] = crc8(packet, 1, 31); // Dallas CRC over index + data
        
        await new Promise(r => this.outEndpoint.transfer(packet, () => r()));
        
        // Clear Feature Halt
        await new Promise(r => this.device.controlTransfer(0x02, 0x01, 0x0000, 0x0002, Buffer.alloc(0), () => r()));
        await new Promise(r => setTimeout(r, 100));
    }

    async waitReady() {
        return new Promise((resolve, reject) => {
            const poll = () => {
                if (!this.isOpen) return reject(new Error('Closed'));
                this.device.controlTransfer(0xC0, 0x95, 0x0706, 0x0000, 2, (err, data) => {
                    if (err) {
                        this.device.controlTransfer(0x02, 0x01, 0x0000, 0x0002, Buffer.alloc(0), () => {});
                        return setTimeout(poll, 10);
                    }
                    const s = data[1];
                    if (s !== this.lastS) {
                        const now = new Date().toISOString().split('T')[1].replace('Z', '');
                        console.log(`[${now}] [M2Nano-Status] 0x${s.toString(16).toUpperCase()} (${s})`);
                        this.lastS = s;
                    }
                    if (s === 206 || s === 142 || s === 110 || s === 111) return resolve(true);
                    setTimeout(poll, 10);
                });
            };
            poll();
        });
    }

    async finishInit() {
        console.log('[M2Nano] Purging hardware buffer (5x Reset)...');
        for (let i = 0; i < 5; i++) {
            console.log(`[M2Nano] Reset ${i+1}/5...`);
            await this.write("\x1b@");
            await new Promise(r => setTimeout(r, 200)); 
        }
        console.log('[M2Nano] Initializing Motion Engine...');
        await this.write("\x1bV"); 
        await this.write("IPP");    
        await this.write("IFE");    
    }

    async write(payload) {
        if (!this.isOpen) return;
        const MAX_DATA = 30;
        
        for (let offset = 0; offset < payload.length; offset += MAX_DATA) {
            await this.waitReady();
            const chunk = payload.slice(offset, offset + MAX_DATA);
            const packet = Buffer.alloc(32, 0x00);
            packet[0] = 0xA6;
            packet[1] = (this.packetIndex++) & 0xFF;
            Buffer.from(chunk).copy(packet, 2);
            
            let sum = 0;
            for(let i=0; i<31; i++) sum = (sum + packet[i]) & 0xFF;
            packet[31] = sum;
            
            await new Promise((resolve, reject) => {
                this.outEndpoint.transfer(packet, (err) => {
                    if (err) {
                        this.device.controlTransfer(0x02, 0x01, 0x0000, 0x0002, Buffer.alloc(0), () => {
                            this.outEndpoint.transfer(packet, (err2) => {
                                if (err2) return reject(err2);
                                resolve();
                            });
                        });
                    } else {
                        resolve();
                    }
                });
            });
            await new Promise(r => setTimeout(r, 50));
        }
    }

    async writeRaw(char) {
        return this.write(char);
    }

    async close() {
        if (this.device) {
            try {
                this.interface.release(true, () => {
                    this.device.close();
                    this.isOpen = false;
                });
            } catch (e) {
                this.isOpen = false;
            }
        }
    }
}

module.exports = M2NanoDriver;
