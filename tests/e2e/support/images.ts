import { deflateSync } from 'zlib';
import { randomBytes } from 'crypto';

/* CRC-32 as PNG chunks need it, computed with the standard reflected polynomial */
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

const crc32 = (buf: Buffer): number => {
  let c = 0xffffffff;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const chunk = (type: string, data: Buffer): Buffer => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([length, typed, crc]);
};

/* Builds a valid RGB PNG, filled with one colour or with pseudo-random noise that does not compress, so a spec can pick the file size it needs */
export const makePng = (width: number, height: number, opts: { noise?: boolean; rgb?: [number, number, number] } = {}): Buffer => {
  const [r, g, b] = opts.rgb ?? [220, 40, 40];
  /* Real random bytes do not compress, so a noisy image keeps its uncompressed size and can cross the compression threshold */
  const noise = opts.noise ? randomBytes(width * height * 3) : null;
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x++) {
      const n = (y * width + x) * 3;
      row[1 + x * 3] = noise ? noise[n] : r;
      row[2 + x * 3] = noise ? noise[n + 1] : g;
      row[3 + x * 3] = noise ? noise[n + 2] : b;
    }
    rows.push(row);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
};

export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

const PNG_FILE_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/* Builds a valid RGBA PNG of noise that does not compress, with its top row fully transparent unless opaque is set, so a spec can send a large image with or without transparency */
export const makeRgbaPng = (width: number, height: number, opts: { opaque?: boolean } = {}): Buffer => {
  const noise = randomBytes(width * height * 3);
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 4);
    for (let x = 0; x < width; x++) {
      const n = (y * width + x) * 3;
      row[1 + x * 4] = noise[n];
      row[2 + x * 4] = noise[n + 1];
      row[3 + x * 4] = noise[n + 2];
      row[4 + x * 4] = y === 0 && !opts.opaque ? 0 : 255;
    }
    rows.push(row);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([PNG_FILE_SIGNATURE, chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
};

/* Builds a valid single-frame GIF of palette noise whose LZW stream restarts every 250 pixels, which keeps every code 9 bits wide so the file stays about as large as its pixel count */
export const makeGif = (width: number, height: number): Buffer => {
  const screen = Buffer.alloc(7);
  screen.writeUInt16LE(width, 0);
  screen.writeUInt16LE(height, 2);
  screen[4] = 0xf7;
  const descriptor = Buffer.alloc(10);
  descriptor[0] = 0x2c;
  descriptor.writeUInt16LE(width, 5);
  descriptor.writeUInt16LE(height, 7);

  const CLEAR = 256;
  const END = 257;
  const pixels = randomBytes(width * height);
  const codes: number[] = [];
  for (let i = 0; i < pixels.length; i++) {
    if (i % 250 === 0) codes.push(CLEAR);
    codes.push(pixels[i]);
  }
  codes.push(END);

  const packed: number[] = [];
  let bits = 0;
  let bitCount = 0;
  for (const code of codes) {
    bits |= code << bitCount;
    bitCount += 9;
    while (bitCount >= 8) {
      packed.push(bits & 0xff);
      bits >>= 8;
      bitCount -= 8;
    }
  }
  if (bitCount > 0) packed.push(bits & 0xff);

  const blocks: Buffer[] = [];
  for (let i = 0; i < packed.length; i += 255) {
    const slice = packed.slice(i, i + 255);
    blocks.push(Buffer.from([slice.length, ...slice]));
  }
  return Buffer.concat([
    Buffer.from('GIF89a', 'ascii'),
    screen,
    randomBytes(256 * 3),
    descriptor,
    Buffer.from([8]),
    ...blocks,
    Buffer.from([0x00, 0x3b]),
  ]);
};