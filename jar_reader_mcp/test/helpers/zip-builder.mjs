// Minimal ZIP (JAR) writer used to build test fixtures without any
// dependencies. Entries are STORED (compression method 0) by default;
// pass { deflate: true } to write DEFLATED entries (method 8) like real JARs.

import { deflateRawSync } from 'node:zlib';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Build a ZIP archive in memory.
 *
 * @param {Array<{ name: string, data?: string | Buffer, isDir?: boolean, deflate?: boolean }>} entries
 * @returns {Buffer}
 */
export function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf-8');
    const isDir = entry.isDir === true;
    const method = entry.deflate === true && !isDir ? 8 : 0;
    const raw = isDir ? Buffer.alloc(0) : Buffer.from(entry.data ?? '');
    const data = method === 8 ? deflateRawSync(raw) : raw;
    const crc = crc32(raw);

    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);  // local file header signature
    local.writeUInt16LE(20, 4);          // version needed to extract
    local.writeUInt16LE(0x0800, 6);      // general purpose flags: UTF-8 names
    local.writeUInt16LE(method, 8);      // compression method
    local.writeUInt16LE(0, 10);          // mod time
    local.writeUInt16LE(0x21, 12);       // mod date (1980-01-01)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);  // compressed size
    local.writeUInt32LE(raw.length, 22);   // uncompressed size
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);          // extra field length
    name.copy(local, 30);
    locals.push(local, data);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);  // central directory header signature
    central.writeUInt16LE(20, 4);          // version made by
    central.writeUInt16LE(20, 6);          // version needed to extract
    central.writeUInt16LE(0x0800, 8);      // general purpose flags
    central.writeUInt16LE(method, 10);     // compression method
    central.writeUInt16LE(0, 12);          // mod time
    central.writeUInt16LE(0x21, 14);       // mod date
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);          // extra field length
    central.writeUInt16LE(0, 32);          // file comment length
    central.writeUInt16LE(0, 34);          // disk number start
    central.writeUInt16LE(0, 36);          // internal file attributes
    central.writeUInt32LE(isDir ? 0x10 : 0, 38);  // external file attributes
    central.writeUInt32LE(offset, 42);     // local header offset
    name.copy(central, 46);
    centrals.push(central);

    offset += local.length + data.length;
  }

  const centralDirectory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);       // end of central directory signature
  eocd.writeUInt16LE(0, 4);                // disk number
  eocd.writeUInt16LE(0, 6);                // central directory start disk
  eocd.writeUInt16LE(entries.length, 8);   // entries on this disk
  eocd.writeUInt16LE(entries.length, 10);  // total entries
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(offset, 16);          // central directory offset
  eocd.writeUInt16LE(0, 20);              // comment length

  return Buffer.concat([...locals, centralDirectory, eocd]);
}
