/**
 * Dallas/Maxim 1-Wire CRC (CRC-8)
 * Polynomial: x^8 + x^5 + x^4 + 1 (0x31)
 * Reflected: 0x8C
 */
function crc8(buffer, start, end) {
    let crc = 0;
    for (let i = start; i < end; i++) {
        let byte = buffer[i];
        for (let j = 0; j < 8; j++) {
            let mix = (crc ^ byte) & 0x01;
            crc >>= 1;
            if (mix) crc ^= 0x8C;
            byte >>= 1;
        }
    }
    return crc;
}

module.exports = { crc8 };
