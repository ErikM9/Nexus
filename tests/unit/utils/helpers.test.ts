import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import { MatrixError } from 'matrix-js-sdk';
import {
  decodeBase64,
  decryptAttachment,
  encodeBase64,
  encryptAttachment,
  formatAge,
  formatBytes,
  getFileExtension,
  getFileTypeIcon,
  isMatrixReady,
  isUnknownToken,
  u8ToBinaryString,
  type EncryptedAttachment,
} from '@/app/utils/helpers';

describe('isMatrixReady', () => {
  it.each([
    [true, true],
    [false, false],
    [undefined, false],
  ])('reads a window.__matrix_ready of %s as %s', (flag, ready) => {
    window.__matrix_ready = flag;

    expect(isMatrixReady()).toBe(ready);
  });
});

describe('isUnknownToken', () => {
  it.each<[string, unknown]>([
    ['a 401 from the homeserver', new MatrixError({ errcode: 'M_MISSING_TOKEN', error: 'Missing access token.' }, 401)],
    ['M_UNKNOWN_TOKEN without an HTTP status', new MatrixError({ errcode: 'M_UNKNOWN_TOKEN', error: 'Invalid access token passed.' })],
    ['an error saying "Unknown token"', new Error('Unknown token')],
    ['an error saying "Token is not active"', new Error('Token is not active')],
    ['the bare text "Unknown token"', 'Unknown token'],
  ])('recognises %s as a rejected access token', (_label, error) => {
    expect(isUnknownToken(error)).toBe(true);
  });

  it.each<[string, unknown]>([
    ['statusCode', { statusCode: 401 }],
    ['httpStatusCode', { httpStatusCode: 401 }],
    ['data.statusCode', { data: { statusCode: 401 } }],
    ['data.errcode', { data: { errcode: 'M_UNKNOWN_TOKEN' } }],
  ])('also reads the rejection from %s', (_property, error) => {
    expect(isUnknownToken(error)).toBe(true);
  });

  it.each<[string, unknown]>([
    ['a malformed request (400)', new MatrixError({ errcode: 'M_INVALID_PARAM', error: 'Invalid transaction ID' }, 400)],
    ['a forbidden request (403)', new MatrixError({ errcode: 'M_FORBIDDEN', error: 'You cannot send messages in this room' }, 403)],
    ['another complaint about a token', new Error('Missing access token')],
    ['a missing error', undefined],
  ])('does not mistake %s for a rejected access token', (_label, error) => {
    expect(isUnknownToken(error)).toBe(false);
  });
});

describe('u8ToBinaryString', () => {
  it('converts more bytes than one call can take as arguments, one character per byte', () => {
    const bytes = Buffer.alloc(1024 * 1024 + 1, 'Nexus ÿ');

    const binary = u8ToBinaryString(bytes);

    expect(Buffer.from(binary, 'latin1').equals(bytes)).toBe(true);
  });
});

/* Two RFC 4648 vectors and one with bytes either side of 0x7f, which need one, no and two padding characters */
const BASE64_VECTORS: Array<[number[], string]> = [
  [[0x66, 0x6f], 'Zm8'],
  [[0x66, 0x6f, 0x6f], 'Zm9v'],
  [[0x00, 0x7f, 0x80, 0xff], 'AH+A/w'],
];

describe('encodeBase64', () => {
  it.each(BASE64_VECTORS)('encodes the bytes %j as "%s" without padding', (bytes, encoded) => {
    expect(encodeBase64(Uint8Array.from(bytes))).toBe(encoded);
  });
});

describe('decodeBase64', () => {
  it.each(BASE64_VECTORS)('reads the bytes %j from the unpadded "%s"', (bytes, encoded) => {
    expect(Array.from(decodeBase64(encoded))).toEqual(bytes);
  });

  it('reads padded base64 too, which other clients may send', () => {
    expect(Array.from(decodeBase64('Zm8='))).toEqual([0x66, 0x6f]);
  });
});

describe('formatBytes', () => {
  it.each([
    [0, '0 B'],
    [1023, '1023 B'],
    [1024, '1.0 KB'],
    [10 * 1024, '10 KB'],
    [1.5 * 1024 ** 2, '1.5 MB'],
    [1024 ** 3, '1.0 GB'],
    [1024 ** 5, '1024 TB'],
  ])('shows %i bytes as "%s"', (bytes, text) => {
    expect(formatBytes(bytes)).toBe(text);
  });

  it.each([[undefined], [Infinity], [-1]])('shows nothing for a size of %s', (bytes) => {
    expect(formatBytes(bytes)).toBe('');
  });
});

describe('formatAge', () => {
  const NOW = Date.UTC(2026, 5, 12, 12, 0, 0);

  beforeEach(() => {
    vi.useFakeTimers({ now: NOW });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    [59_999, '59s ago'],
    [60_000, '1m ago'],
    [3_599_999, '59m ago'],
    [3_600_000, '1h ago'],
    [48 * 3_600_000 - 1, '47h ago'],
  ])('calls a moment %i ms back "%s"', (age, text) => {
    expect(formatAge(NOW - age)).toBe(text);
  });

  it('calls a moment that is still ahead "0s ago"', () => {
    expect(formatAge(NOW + 5_000)).toBe('0s ago');
  });
});

describe('getFileExtension', () => {
  it.each([
    [undefined, ''],
    ['README', ''],
    ['PHOTO.JPG', 'jpg'],
    ['archive.tar.gz', 'gz'],
    ['report.pdf?version=1.2', 'pdf'],
    ['photo.png#frame.2', 'png'],
  ])('reads the extension of %s as "%s"', (name, extension) => {
    expect(getFileExtension(name)).toBe(extension);
  });
});

describe('getFileTypeIcon', () => {
  it.each([
    ['application/pdf', '📄'],
    ['application/zip', '🗜️'],
    ['application/msword', '📝'],
    ['application/vnd.ms-excel', '📊'],
    ['application/vnd.ms-powerpoint', '📈'],
    ['image/png', '🖼️'],
    ['video/mp4', '🎬'],
    ['audio/ogg', '🎵'],
    ['text/plain', '📃'],
  ])('gives the media type %s the icon %s', (mimetype, icon) => {
    expect(getFileTypeIcon(mimetype)).toBe(icon);
  });

  it.each([
    ['manual.pdf', '📄'],
    ['backup.tar.gz', '🗜️'],
    ['letter.docx', '📝'],
    ['budget.xlsx', '📊'],
    ['slides.pptx', '📈'],
    ['photo.webp', '🖼️'],
    ['clip.mkv', '🎬'],
    ['song.flac', '🎵'],
    ['notes.md', '📃'],
  ])('goes by the name %s when there is no media type and picks %s', (name, icon) => {
    expect(getFileTypeIcon(undefined, name)).toBe(icon);
  });

  it('ignores the case of the media type', () => {
    expect(getFileTypeIcon('Image/PNG')).toBe('🖼️');
  });

  it('shows a CSV file as a spreadsheet although its media type is text', () => {
    expect(getFileTypeIcon('text/csv', 'table.csv')).toBe('📊');
  });

  it('falls back on a paperclip for a type and a name it does not know', () => {
    expect(getFileTypeIcon('application/octet-stream', 'data.bin')).toBe('📎');
  });
});

const PLAINTEXT = Buffer.from('attachment bytes that span more than one AES block');
const KEY = Buffer.from(Uint8Array.from({ length: 32 }, (_, i) => i));
const IV = Buffer.from('0102030405060708' + '0000000000000000', 'hex');

/* Buffers are views on a shared pool, so the bytes are copied into an ArrayBuffer of their own */
const arrayBufferOf = (bytes: Uint8Array) => new Uint8Array(bytes).buffer;

const unpaddedBase64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64').replace(/=+$/, '');

/* AES-256-CTR from OpenSSL, which counts through all 128 bits of the counter block */
const aesCtr = (counterBlock: Buffer, data: Uint8Array) => createCipheriv('aes-256-ctr', KEY, counterBlock).update(data);

/* The file block another client would send along with a ciphertext it made under KEY and the given counter block */
const fileBlockFor = (ciphertext: Uint8Array, counterBlock: Buffer, version?: string) => ({
  ...(version ? { v: version } : {}),
  key: { kty: 'oct', alg: 'A256CTR', ext: true, key_ops: ['encrypt', 'decrypt'], k: KEY.toString('base64url') },
  iv: unpaddedBase64(counterBlock),
  hashes: { sha256: unpaddedBase64(createHash('sha256').update(ciphertext).digest()) },
});

describe('encryptAttachment', () => {
  it('encrypts with AES-256-CTR under the key and IV it reports', async () => {
    const { data, info } = await encryptAttachment(arrayBufferOf(PLAINTEXT));
    const ciphertext = Buffer.from(data);

    const key = Buffer.from(info.key.k ?? '', 'base64url');
    const decrypted = createDecipheriv('aes-256-ctr', key, Buffer.from(info.iv, 'base64')).update(ciphertext);

    expect(ciphertext).not.toEqual(PLAINTEXT);
    expect(decrypted).toEqual(PLAINTEXT);
  });

  it('labels the result v2 and exports its 256-bit key as a JWK for AES-CTR', async () => {
    const { info } = await encryptAttachment(arrayBufferOf(PLAINTEXT));

    expect(info.v).toBe('v2');
    expect(info.key).toMatchObject({ kty: 'oct', alg: 'A256CTR', ext: true, key_ops: expect.arrayContaining(['encrypt', 'decrypt']) });
    expect(info.key.k).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('sends a 16-byte IV as unpadded base64 whose counter half starts at zero', async () => {
    const { info } = await encryptAttachment(arrayBufferOf(PLAINTEXT));

    expect(info.iv).toMatch(/^[A-Za-z0-9+/]{22}$/);
    expect(Buffer.from(info.iv, 'base64').subarray(8)).toEqual(Buffer.alloc(8));
  });

  it('publishes the SHA-256 of the ciphertext as unpadded base64', async () => {
    const { data, info } = await encryptAttachment(arrayBufferOf(PLAINTEXT));

    expect(info.hashes.sha256).toBe(unpaddedBase64(createHash('sha256').update(Buffer.from(data)).digest()));
  });

  it('draws all eight random bytes of the IV afresh for each attachment', async () => {
    const attachments = await Promise.all(Array.from({ length: 8 }, () => encryptAttachment(arrayBufferOf(PLAINTEXT))));
    const ivs = attachments.map(({ info }) => Buffer.from(info.iv, 'base64'));

    /* Eight random samples of one byte agree once in 256^7 runs, so a position that never varies is not random */
    for (let position = 0; position < 8; position++) {
      expect(new Set(ivs.map((iv) => iv[position])).size, `byte ${position}`).toBeGreaterThan(1);
    }
  });

  it('generates a new key for each attachment', async () => {
    const first = await encryptAttachment(arrayBufferOf(PLAINTEXT));
    const second = await encryptAttachment(arrayBufferOf(PLAINTEXT));

    expect(second.info.key.k).not.toBe(first.info.key.k);
  });
});

describe('decryptAttachment', () => {
  it('gives back every byte of a megabyte it encrypted', async () => {
    const plaintext = Buffer.alloc(1024 * 1024 + 1, 'Nexus');

    const { data, info } = await encryptAttachment(arrayBufferOf(plaintext));
    const decrypted = Buffer.from(await decryptAttachment(data, info));

    expect(decrypted.equals(plaintext)).toBe(true);
  });

  describe('when the counter half of the IV runs over', () => {
    /* A counter half at its highest value runs over after the first block, the one place where the two counter widths differ */
    const ivAtLimit = Buffer.from('0102030405060708' + 'ffffffffffffffff', 'hex');

    /* A 64-bit counter starts again at zero under the same IV half, while a 128-bit one carries into it */
    const encryptWithCounterOf = {
      64: () => Buffer.concat([aesCtr(ivAtLimit, PLAINTEXT.subarray(0, 16)), aesCtr(IV, PLAINTEXT.subarray(16))]),
      128: () => aesCtr(ivAtLimit, PLAINTEXT),
    };

    it.each([
      ['a v2', 64, 'v2'],
      ['a v1', 64, 'v1'],
      ['an unversioned', 128, undefined],
    ] as const)('decrypts %s attachment with a %i-bit counter', async (_label, bits, version) => {
      const ciphertext = encryptWithCounterOf[bits]();

      const decrypted = await decryptAttachment(arrayBufferOf(ciphertext), fileBlockFor(ciphertext, ivAtLimit, version));

      expect(Buffer.from(decrypted)).toEqual(PLAINTEXT);
    });
  });

  it('refuses a ciphertext that changed after it was hashed', async () => {
    const { data, info } = await encryptAttachment(arrayBufferOf(PLAINTEXT));
    new Uint8Array(data)[0] ^= 0x01;

    await expect(decryptAttachment(data, info)).rejects.toThrow('Mismatched SHA-256 digest');
  });

  it.each<[string, (info: EncryptedAttachment['info']) => unknown]>([
    ['no file block at all', () => undefined],
    ['no key', (info) => ({ ...info, key: undefined })],
    ['no IV', (info) => ({ ...info, iv: undefined })],
    ['no hashes', (info) => ({ ...info, hashes: undefined })],
    ['no SHA-256 among its hashes', (info) => ({ ...info, hashes: {} })],
  ])('refuses to decrypt with %s', async (_label, strip) => {
    const { data, info } = await encryptAttachment(arrayBufferOf(PLAINTEXT));

    await expect(decryptAttachment(data, strip(info))).rejects.toThrow('Invalid encrypted attachment info');
  });
});