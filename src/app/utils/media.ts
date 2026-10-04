/* Media types a blob built from received bytes may carry, after Element Web's list: images, audio and video a browser only ever displays or plays, never SVG, HTML, XML or script, because a blob URL opened in a tab runs as the app's own origin */
const SAFE_BLOB_MIME_TYPES: ReadonlySet<string> = new Set([
  'image/jpeg',
  'image/gif',
  'image/png',
  'image/apng',
  'image/webp',
  'image/avif',
  'video/mp4',
  'video/webm',
  'video/ogg',
  'video/quicktime',
  'audio/mp4',
  'audio/webm',
  'audio/aac',
  'audio/mpeg',
  'audio/ogg',
  'audio/wave',
  'audio/wav',
  'audio/x-wav',
  'audio/x-pn-wav',
  'audio/flac',
  'audio/x-flac',
]);

export const OPAQUE_BLOB_MIME_TYPE = 'application/octet-stream';

/* Maps a sender-declared media type onto the allow-list, turning anything unknown into a download-only type */
export const safeBlobMimeType = (declared?: string | null): string => {
  const base = typeof declared === 'string' ? declared.split(';')[0].trim().toLowerCase() : '';
  return SAFE_BLOB_MIME_TYPES.has(base) ? base : OPAQUE_BLOB_MIME_TYPE;
};

export type PlayableKind = 'image' | 'audio' | 'video';

/* Tells whether a blob type may be shown inline as the given kind, which only allow-listed types can */
export const isPlayableAs = (blobType: string, kind: PlayableKind): boolean =>
  blobType !== OPAQUE_BLOB_MIME_TYPE && SAFE_BLOB_MIME_TYPES.has(blobType) && blobType.startsWith(`${kind}/`);

/* Image types the composer accepts, matching the formats named in its error message */
export const ATTACHABLE_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const;

export const isAttachableImageType = (type: string): boolean =>
  (ATTACHABLE_IMAGE_TYPES as readonly string[]).includes(type.toLowerCase());

export const MAX_UNCOMPRESSED_IMAGE_BYTES = 100 * 1024;
export const MAX_IMAGE_DIMENSION = 1920;

export interface ImageFacts {
  mimeType: string;
  size: number;
  width: number;
  height: number;
  hasTransparency: boolean;
}

export type ImageUploadPlan =
  | { action: 'original' }
  | { action: 'reencode'; mimeType: 'image/png' | 'image/jpeg'; width: number; height: number };

/* Scales dimensions down proportionally until both fit within the limit, leaving smaller images as they are */
export const fitWithin = (width: number, height: number, max: number = MAX_IMAGE_DIMENSION): { width: number; height: number } => {
  if (width <= max && height <= max) return { width, height };
  const scale = Math.min(max / width, max / height);
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
};

/* Decides how an attached image is uploaded: animated formats and small files go up untouched, transparent images stay PNG and are only scaled, and other large images become JPEG */
export const planImageUpload = (facts: ImageFacts): ImageUploadPlan => {
  const type = facts.mimeType.toLowerCase();
  if (type === 'image/gif' || type === 'image/webp') return { action: 'original' };
  if (facts.size <= MAX_UNCOMPRESSED_IMAGE_BYTES) return { action: 'original' };

  const target = fitWithin(facts.width, facts.height);
  const oversized = target.width !== facts.width || target.height !== facts.height;
  if (facts.hasTransparency) {
    return oversized ? { action: 'reencode', mimeType: 'image/png', ...target } : { action: 'original' };
  }
  return { action: 'reencode', mimeType: 'image/jpeg', ...target };
};