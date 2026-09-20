import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  isMatrixReady,
  isUnknownToken,
  encodeBase64,
  decodeBase64,
  formatBytes,
  formatAge,
  getFileExtension,
  getFileTypeIcon,
  encryptAttachment,
  decryptAttachment,
  SESSION_STORAGE_KEYS,
  hardClientReset,
} from '@/app/utils/helpers';

describe('helpers', () => {
  describe('isMatrixReady', () => {
    it('returns true when __matrix_ready is set', () => {
      (global.window as any).__matrix_ready = true;
      expect(isMatrixReady()).toBe(true);
    });

    it('returns false when __matrix_ready is not set', () => {
      delete (global.window as any).__matrix_ready;
      expect(isMatrixReady()).toBe(false);
    });

    it('returns false when __matrix_ready is false', () => {
      (global.window as any).__matrix_ready = false;
      expect(isMatrixReady()).toBe(false);
    });
  });

  describe('isUnknownToken', () => {
    it('returns true for 401 httpStatus', () => {
      expect(isUnknownToken({ httpStatus: 401 })).toBe(true);
    });

    it('returns true for 401 statusCode', () => {
      expect(isUnknownToken({ statusCode: 401 })).toBe(true);
    });

    it('returns true for M_UNKNOWN_TOKEN errcode', () => {
      expect(isUnknownToken({ errcode: 'M_UNKNOWN_TOKEN' })).toBe(true);
    });

    it('returns true for nested data.errcode', () => {
      expect(isUnknownToken({ data: { errcode: 'M_UNKNOWN_TOKEN' } })).toBe(true);
    });

    it('returns true when message contains "unknown token"', () => {
      expect(isUnknownToken({ message: 'Error: Unknown token detected' })).toBe(true);
    });

    it('returns true when message contains "token is not active"', () => {
      expect(isUnknownToken({ message: 'Token is not active' })).toBe(true);
    });

    it('returns false for other errors', () => {
      expect(isUnknownToken({ httpStatus: 500, message: 'Server error' })).toBe(false);
    });

    it('returns false for null/undefined', () => {
      expect(isUnknownToken(null)).toBe(false);
      expect(isUnknownToken(undefined)).toBe(false);
    });

    it('handles string errors', () => {
      expect(isUnknownToken('Unknown token')).toBe(true);
      expect(isUnknownToken('Some other error')).toBe(false);
    });
  });

  describe('encodeBase64 / decodeBase64', () => {
    it('encodes and decodes empty array', () => {
      const input = new Uint8Array([]);
      const encoded = encodeBase64(input);
      const decoded = decodeBase64(encoded);
      expect(decoded).toEqual(input);
    });

    it('encodes and decodes simple data', () => {
      const input = new Uint8Array([72, 101, 108, 108, 111]);
      const encoded = encodeBase64(input);
      const decoded = decodeBase64(encoded);
      expect(decoded).toEqual(input);
    });

    it('encodes and decodes binary data', () => {
      const input = new Uint8Array([0, 127, 255, 128, 64, 32]);
      const encoded = encodeBase64(input);
      const decoded = decodeBase64(encoded);
      expect(decoded).toEqual(input);
    });

    it('produces unpadded base64 per Matrix spec', () => {
      /* Length 1 would normally produce == padding in standard base64 */
      const input = new Uint8Array([65]);
      const encoded = encodeBase64(input);
      expect(encoded).not.toContain('=');
    });

    it('handles all three padding edge cases (lengths 1, 2, 3)', () => {
      /* len 1 strips ==, len 2 strips =, len 3 needs no padding */
      const len1 = new Uint8Array([1]);
      expect(decodeBase64(encodeBase64(len1))).toEqual(len1);

      const len2 = new Uint8Array([1, 2]);
      expect(decodeBase64(encodeBase64(len2))).toEqual(len2);

      const len3 = new Uint8Array([1, 2, 3]);
      expect(decodeBase64(encodeBase64(len3))).toEqual(len3);
    });
  });

  describe('formatBytes', () => {
    it('returns empty string for undefined', () => {
      expect(formatBytes(undefined)).toBe('');
    });

    it('returns empty string for negative numbers', () => {
      expect(formatBytes(-100)).toBe('');
    });

    it('returns empty string for NaN', () => {
      expect(formatBytes(NaN)).toBe('');
    });

    it('returns empty string for Infinity', () => {
      expect(formatBytes(Infinity)).toBe('');
    });

    it('formats bytes correctly', () => {
      expect(formatBytes(0)).toBe('0 B');
      expect(formatBytes(500)).toBe('500 B');
      expect(formatBytes(1023)).toBe('1023 B');
    });

    it('formats kilobytes correctly', () => {
      expect(formatBytes(1024)).toBe('1.0 KB');
      expect(formatBytes(1536)).toBe('1.5 KB');
      expect(formatBytes(10240)).toBe('10 KB');
    });

    it('formats megabytes correctly', () => {
      expect(formatBytes(1048576)).toBe('1.0 MB');
      expect(formatBytes(1572864)).toBe('1.5 MB');
      expect(formatBytes(10485760)).toBe('10 MB');
    });

    it('formats gigabytes correctly', () => {
      expect(formatBytes(1073741824)).toBe('1.0 GB');
    });

    it('formats terabytes correctly', () => {
      expect(formatBytes(1099511627776)).toBe('1.0 TB');
    });
  });

  describe('formatAge', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2024-01-15T12:00:00Z'));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('formats seconds ago', () => {
      const now = Date.now();
      expect(formatAge(now)).toBe('0s ago');
      expect(formatAge(now - 30000)).toBe('30s ago');
      expect(formatAge(now - 59000)).toBe('59s ago');
    });

    it('formats minutes ago', () => {
      const now = Date.now();
      expect(formatAge(now - 60000)).toBe('1m ago');
      expect(formatAge(now - 300000)).toBe('5m ago');
      expect(formatAge(now - 3540000)).toBe('59m ago');
    });

    it('formats hours ago', () => {
      const now = Date.now();
      expect(formatAge(now - 3600000)).toBe('1h ago');
      expect(formatAge(now - 7200000)).toBe('2h ago');
      expect(formatAge(now - 86400000)).toBe('24h ago');
    });

    it('clamps future timestamps to 0s ago', () => {
      const future = Date.now() + 10000;
      expect(formatAge(future)).toBe('0s ago');
    });
  });

  describe('getFileExtension', () => {
    it('returns empty string for undefined/empty', () => {
      expect(getFileExtension(undefined)).toBe('');
      expect(getFileExtension('')).toBe('');
    });

    it('extracts simple extensions', () => {
      expect(getFileExtension('file.txt')).toBe('txt');
      expect(getFileExtension('image.PNG')).toBe('png');
      expect(getFileExtension('document.pdf')).toBe('pdf');
    });

    it('returns the last extension for multiple dots', () => {
      expect(getFileExtension('archive.tar.gz')).toBe('gz');
      expect(getFileExtension('file.name.with.dots.jpg')).toBe('jpg');
    });

    it('strips query parameters before extracting extension', () => {
      expect(getFileExtension('file.jpg?width=100')).toBe('jpg');
      expect(getFileExtension('image.png?v=123&size=large')).toBe('png');
    });

    it('strips hash fragments before extracting extension', () => {
      expect(getFileExtension('file.pdf#page=5')).toBe('pdf');
    });

    it('returns empty for files without extension', () => {
      expect(getFileExtension('README')).toBe('');
      expect(getFileExtension('Makefile')).toBe('');
    });
  });

  describe('getFileTypeIcon', () => {
    it('returns PDF icon', () => {
      expect(getFileTypeIcon('application/pdf')).toBe('📄');
      expect(getFileTypeIcon(undefined, 'document.pdf')).toBe('📄');
    });

    it('returns archive icon', () => {
      expect(getFileTypeIcon('application/zip')).toBe('🗜️');
      expect(getFileTypeIcon(undefined, 'archive.tar.gz')).toBe('🗜️');
      expect(getFileTypeIcon(undefined, 'file.rar')).toBe('🗜️');
    });

    it('returns Word icon', () => {
      expect(getFileTypeIcon('application/msword')).toBe('📝');
      expect(getFileTypeIcon(undefined, 'doc.docx')).toBe('📝');
    });

    it('returns Excel icon', () => {
      expect(getFileTypeIcon('application/vnd.ms-excel')).toBe('📊');
      expect(getFileTypeIcon(undefined, 'data.xlsx')).toBe('📊');
      expect(getFileTypeIcon(undefined, 'data.csv')).toBe('📊');
    });

    it('returns PowerPoint icon', () => {
      expect(getFileTypeIcon('application/vnd.ms-powerpoint')).toBe('📈');
      expect(getFileTypeIcon(undefined, 'slides.pptx')).toBe('📈');
    });

    it('returns image icon', () => {
      expect(getFileTypeIcon('image/png')).toBe('🖼️');
      expect(getFileTypeIcon('image/jpeg')).toBe('🖼️');
      expect(getFileTypeIcon(undefined, 'photo.webp')).toBe('🖼️');
    });

    it('returns video icon', () => {
      expect(getFileTypeIcon('video/mp4')).toBe('🎬');
      expect(getFileTypeIcon(undefined, 'movie.mkv')).toBe('🎬');
    });

    it('returns audio icon', () => {
      expect(getFileTypeIcon('audio/mpeg')).toBe('🎵');
      expect(getFileTypeIcon(undefined, 'song.mp3')).toBe('🎵');
    });

    it('returns text icon', () => {
      expect(getFileTypeIcon('text/plain')).toBe('📃');
      expect(getFileTypeIcon(undefined, 'readme.md')).toBe('📃');
      expect(getFileTypeIcon(undefined, 'log.txt')).toBe('📃');
    });

    it('returns generic icon for unknown types', () => {
      expect(getFileTypeIcon('application/octet-stream')).toBe('📎');
      expect(getFileTypeIcon(undefined, 'file.xyz')).toBe('📎');
      expect(getFileTypeIcon()).toBe('📎');
    });
  });

  describe('SESSION_STORAGE_KEYS', () => {
    it('contains all expected key names', () => {
      expect(SESSION_STORAGE_KEYS).toContain('mx_session');
      expect(SESSION_STORAGE_KEYS).toContain('mx_access_token');
      expect(SESSION_STORAGE_KEYS).toContain('mx_refresh_token');
      expect(SESSION_STORAGE_KEYS).toContain('mx_user_id');
      expect(SESSION_STORAGE_KEYS).toContain('mx_device_id');
    });

    it('is a readonly array of length 5', () => {
      expect(Array.isArray(SESSION_STORAGE_KEYS)).toBe(true);
      expect(SESSION_STORAGE_KEYS.length).toBe(5);
    });
  });

  describe('hardClientReset', () => {
    it('clears session keys from localStorage', () => {
      localStorage.setItem('mx_session', '{}');
      localStorage.setItem('mx_access_token', 'token');
      localStorage.setItem('mx_refresh_token', 'refresh');
      localStorage.setItem('mx_user_id', '@user:matrix.org');

      hardClientReset();

      expect(localStorage.getItem('mx_session')).toBeNull();
      expect(localStorage.getItem('mx_access_token')).toBeNull();
      expect(localStorage.getItem('mx_refresh_token')).toBeNull();
      expect(localStorage.getItem('mx_user_id')).toBeNull();
    });

    it('preserves mx_device_id by default', () => {
      localStorage.setItem('mx_device_id', 'DEVICE123');
      hardClientReset();
      expect(localStorage.getItem('mx_device_id')).toBe('DEVICE123');
    });

    it('removes mx_device_id when forgetDevice is true', () => {
      localStorage.setItem('mx_device_id', 'DEVICE123');
      hardClientReset({ forgetDevice: true });
      expect(localStorage.getItem('mx_device_id')).toBeNull();
    });

    it('sets window.__matrix_ready to false', () => {
      window.__matrix_ready = true;
      hardClientReset();
      expect(window.__matrix_ready).toBe(false);
    });

    it('dispatches matrix-not-ready event', () => {
      const dispatchSpy = vi.spyOn(window, 'dispatchEvent');

      hardClientReset();

      const fired = dispatchSpy.mock.calls.some(([e]) => (e as Event).type === 'matrix-not-ready');
      expect(fired).toBe(true);
    });
  });

  describe('encryptAttachment / decryptAttachment', () => {
    it('encrypts and decrypts data correctly', async () => {
      const plaintext = new TextEncoder().encode('Hello, Matrix!');
      const encrypted = await encryptAttachment(plaintext.buffer);

      expect(encrypted.data).toBeDefined();
      expect(encrypted.data.byteLength).toBeGreaterThan(0);
      expect(encrypted.info.v).toBe('v2');
      expect(encrypted.info.key).toBeDefined();
      expect(encrypted.info.iv).toBeDefined();
      expect(encrypted.info.hashes.sha256).toBeDefined();

      const decrypted = await decryptAttachment(encrypted.data, encrypted.info);
      const decryptedText = new TextDecoder().decode(new Uint8Array(decrypted));
      expect(decryptedText).toBe('Hello, Matrix!');
    });

    it('produces a different IV each time (random IV)', async () => {
      const plaintext = new TextEncoder().encode('Test data');
      const encrypted1 = await encryptAttachment(plaintext.buffer);
      const encrypted2 = await encryptAttachment(plaintext.buffer);
      expect(encrypted1.info.iv).not.toBe(encrypted2.info.iv);
    });

    it('throws on missing or incomplete decryption info', async () => {
      const ciphertext = new ArrayBuffer(16);
      await expect(decryptAttachment(ciphertext, {})).rejects.toThrow('Invalid encrypted attachment info');
      await expect(decryptAttachment(ciphertext, { key: {} })).rejects.toThrow('Invalid encrypted attachment info');
      await expect(decryptAttachment(ciphertext, { key: {}, iv: 'abc' })).rejects.toThrow('Invalid encrypted attachment info');
    });

    it('handles empty data', async () => {
      const empty = new ArrayBuffer(0);
      const encrypted = await encryptAttachment(empty);
      const decrypted = await decryptAttachment(encrypted.data, encrypted.info);
      expect(decrypted.byteLength).toBe(0);
    });

    it('handles large data (1 MB round-trip)', async () => {
      const largeData = new Uint8Array(1024 * 1024);
      for (let i = 0; i < largeData.length; i++) {
        largeData[i] = Math.floor(Math.random() * 256);
      }
      const encrypted = await encryptAttachment(largeData.buffer);
      const decrypted = await decryptAttachment(encrypted.data, encrypted.info);
      expect(new Uint8Array(decrypted)).toEqual(largeData);
    });
  });
});