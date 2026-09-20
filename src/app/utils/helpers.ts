/* eslint-disable @typescript-eslint/no-explicit-any */
export const isMatrixReady = (): boolean => {
  try {
    return typeof window !== 'undefined' && !!window.__matrix_ready;
  } catch {
    return false;
  }
};

export const isUnknownToken = (err: any): boolean => {
  const httpStatus = err?.httpStatus ?? err?.statusCode ?? err?.httpStatusCode ?? err?.data?.statusCode;
  const errcode = err?.errcode ?? err?.data?.errcode;
  const msg = String(err?.message ?? err ?? '');
  return (
    httpStatus === 401 ||
    errcode === 'M_UNKNOWN_TOKEN' ||
    msg.toLowerCase().includes('unknown token') ||
    msg.toLowerCase().includes('token is not active')
  );
};

/* Converts a Uint8Array to a binary string in 32 KB slices to avoid call-stack overflow */
export const u8ToBinaryString = (uint8Array: Uint8Array): string => {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < uint8Array.length; i += chunk) {
    bin += String.fromCharCode(...uint8Array.subarray(i, i + chunk));
  }
  return bin;
};

/* Unpadded base64 as required by the Matrix attachment encryption spec */
export const encodeBase64 = (uint8Array: Uint8Array): string =>
  window.btoa(u8ToBinaryString(uint8Array)).replace(/=+$/, '');

export const decodeBase64 = (base64: string): Uint8Array => {
  const paddedBase64 = base64 + '==='.slice(0, (4 - (base64.length % 4)) % 4);
  const latin1String = window.atob(paddedBase64);
  const uint8Array = new Uint8Array(new ArrayBuffer(latin1String.length));
  for (let i = 0; i < latin1String.length; i++) {
    uint8Array[i] = latin1String.charCodeAt(i);
  }
  return uint8Array;
};

export const formatBytes = (bytes?: number): string => {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  const fixed = i === 0 ? String(Math.round(v)) : v < 10 ? v.toFixed(1) : v.toFixed(0);
  return `${fixed} ${units[i]}`;
};

export const formatAge = (ts: number): string => {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
};

export const getFileExtension = (name?: string): string => {
  if (!name) return '';
  const base = name.split('?')[0].split('#')[0];
  const idx = base.lastIndexOf('.');
  if (idx < 0) return '';
  return base.slice(idx + 1).toLowerCase();
};

export const getFileTypeIcon = (mimetype?: string, name?: string): string => {
  const mt = (mimetype || '').toLowerCase();
  const ext = getFileExtension(name);

  if (mt === 'application/pdf' || ext === 'pdf') return '📄';
  if (mt.includes('zip') || ['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) return '🗜️';
  if (mt.includes('word') || ['doc', 'docx'].includes(ext)) return '📝';
  if (mt.includes('excel') || ['xls', 'xlsx', 'csv'].includes(ext)) return '📊';
  if (mt.includes('powerpoint') || ['ppt', 'pptx'].includes(ext)) return '📈';
  if (mt.startsWith('image/') || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'].includes(ext)) return '🖼️';
  if (mt.startsWith('video/') || ['mp4', 'mov', 'mkv', 'webm', 'avi'].includes(ext)) return '🎬';
  if (mt.startsWith('audio/') || ['mp3', 'wav', 'flac', 'ogg', 'm4a'].includes(ext)) return '🎵';
  if (['txt', 'md', 'log'].includes(ext) || mt.startsWith('text/')) return '📃';
  return '📎';
};

export interface EncryptedAttachment {
  data: ArrayBuffer;
  info: {
    v: string;
    key: JsonWebKey;
    iv: string;
    hashes: { sha256: string };
  };
}

/* AES-CTR per the Matrix attachment spec, with a 16-byte IV whose upper 8 bytes stay zero */
export const encryptAttachment = async (plaintextBuffer: ArrayBuffer): Promise<EncryptedAttachment> => {
  const ivArray = new Uint8Array(new ArrayBuffer(16));
  window.crypto.getRandomValues(ivArray.subarray(0, 8));

  const cryptoKey = await window.crypto.subtle.generateKey(
    { name: 'AES-CTR', length: 256 },
    true,
    ['encrypt', 'decrypt']
  );
  const exportedKey = await window.crypto.subtle.exportKey('jwk', cryptoKey);

  const ciphertextBuffer = await window.crypto.subtle.encrypt(
    { name: 'AES-CTR', counter: ivArray as BufferSource, length: 64 },
    cryptoKey,
    plaintextBuffer
  );

  const sha256Buffer = await window.crypto.subtle.digest('SHA-256', ciphertextBuffer);

  return {
    data: ciphertextBuffer,
    info: {
      v: 'v2',
      key: exportedKey,
      iv: encodeBase64(ivArray),
      hashes: { sha256: encodeBase64(new Uint8Array(sha256Buffer)) },
    },
  };
};

export const decryptAttachment = async (ciphertextBuffer: ArrayBuffer, info: any): Promise<ArrayBuffer> => {
  if (!info?.key || !info?.iv || !info?.hashes?.sha256) {
    throw new Error('Invalid encrypted attachment info');
  }

  const ivArray = decodeBase64(info.iv);
  const expectedSha256base64 = info.hashes.sha256;

  const cryptoKey = await window.crypto.subtle.importKey(
    'jwk',
    info.key,
    { name: 'AES-CTR' },
    false,
    ['encrypt', 'decrypt']
  );

  /* Verify the SHA-256 digest before decrypting to catch corruption or tampering early */
  const digest = await window.crypto.subtle.digest('SHA-256', ciphertextBuffer);
  if (encodeBase64(new Uint8Array(digest)) !== expectedSha256base64) {
    throw new Error('Mismatched SHA-256 digest');
  }

  const counterLength = info.v === 'v1' || info.v === 'v2' ? 64 : 128;
  return await window.crypto.subtle.decrypt(
    { name: 'AES-CTR', counter: ivArray as BufferSource, length: counterLength },
    cryptoKey,
    ciphertextBuffer
  );
};

/* localStorage keys, with mx_device_id excluded from most resets so the device can be reused */
export const SESSION_STORAGE_KEYS = [
  'mx_session',
  'mx_access_token',
  'mx_refresh_token',
  'mx_user_id',
  'mx_device_id',
] as const;

export type StoredSession = {
  accessToken: string;
  refreshToken?: string;
  userId: string;
  deviceId?: string;
  baseUrl: string;
};

/* Clears local session state and broadcasts matrix-not-ready */
export const hardClientReset = (opts?: { forgetDevice?: boolean }) => {
  if (typeof window !== 'undefined') {
    try {
      for (const k of SESSION_STORAGE_KEYS) {
        if (k === 'mx_device_id' && !opts?.forgetDevice) continue;
        localStorage.removeItem(k);
      }
    } catch {}

    try { window.__matrix_ready = false; } catch {}
    try { window.dispatchEvent(new Event('matrix-not-ready')); } catch {}
  }
};