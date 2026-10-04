import { useCallback, useEffect, useRef, useState } from 'react';
import type { MatrixClient } from 'matrix-js-sdk';
import { decryptAttachment } from '../../utils/helpers';
import { safeBlobMimeType } from '../../utils/media';
import type { EncryptedFileInfo } from './model';

export interface MediaSource {
  key: string;
  mxcUrl: string;
  encryptedFile?: EncryptedFileInfo;
  declaredType?: string;
}

export type MediaEntry = { status: 'loading' } | { status: 'failed' } | { status: 'ready'; url: string; blobType: string };

type CachedEntry = MediaEntry & { lastUsed: number };

/* Blob URLs kept for messages no longer on screen before the least recently used are released */
const MAX_CACHED_URLS = 150;

const NO_KEYS: readonly string[] = [];

/* Downloads media through the authenticated endpoint, decrypts it when needed and wraps it in a blob of an allow-listed type only */
const fetchMedia = async (client: MatrixClient, source: MediaSource): Promise<Blob> => {
  const httpUrl = client.mxcUrlToHttp(source.mxcUrl, undefined, undefined, undefined, false, true, true);
  const token = client.getAccessToken();
  if (!httpUrl || !token) throw new Error('Media cannot be requested');
  const res = await fetch(httpUrl, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Media download failed with status ${res.status}`);
  const bytes = source.encryptedFile
    ? await decryptAttachment(await res.arrayBuffer(), source.encryptedFile)
    : await res.arrayBuffer();
  return new Blob([bytes], { type: safeBlobMimeType(source.declaredType ?? res.headers.get('content-type')) });
};

/* Loads each shown attachment once, remembers failures instead of retrying them, and never releases a URL a rendered message still uses */
export const useMediaCache = (
  client: MatrixClient | null,
  sources: readonly MediaSource[],
  pinnedKeys: readonly string[] = NO_KEYS
): ((key: string) => MediaEntry | undefined) => {
  const entriesRef = useRef(new Map<string, CachedEntry>());
  const aliveRef = useRef(true);
  const inUseRef = useRef(new Set<string>());
  const [, setVersion] = useState(0);

  const evictUnused = useCallback(() => {
    const entries = entriesRef.current;
    const ready = [...entries].filter(([, entry]) => entry.status === 'ready');
    let excess = ready.length - MAX_CACHED_URLS;
    for (const [key, entry] of ready.sort((a, b) => a[1].lastUsed - b[1].lastUsed)) {
      if (excess <= 0) break;
      if (inUseRef.current.has(key) || entry.status !== 'ready') continue;
      URL.revokeObjectURL(entry.url);
      entries.delete(key);
      excess -= 1;
    }
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    const entries = entriesRef.current;
    return () => {
      aliveRef.current = false;
      for (const entry of entries.values()) {
        if (entry.status === 'ready') URL.revokeObjectURL(entry.url);
      }
      entries.clear();
    };
  }, []);

  useEffect(() => {
    inUseRef.current = new Set([...sources.map((source) => source.key), ...pinnedKeys]);
    if (!client) return;
    const entries = entriesRef.current;
    const now = Date.now();
    for (const source of sources) {
      const existing = entries.get(source.key);
      if (existing) {
        existing.lastUsed = now;
        continue;
      }
      entries.set(source.key, { status: 'loading', lastUsed: now });
      fetchMedia(client, source).then(
        (blob) => {
          if (!aliveRef.current) return;
          entries.set(source.key, { status: 'ready', url: URL.createObjectURL(blob), blobType: blob.type, lastUsed: Date.now() });
          evictUnused();
          setVersion((v) => v + 1);
        },
        () => {
          if (!aliveRef.current) return;
          entries.set(source.key, { status: 'failed', lastUsed: Date.now() });
          setVersion((v) => v + 1);
        }
      );
    }
    evictUnused();
  }, [client, sources, pinnedKeys, evictUnused]);

  return useCallback((key: string) => entriesRef.current.get(key), []);
};