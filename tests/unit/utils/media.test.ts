import { describe, it, expect } from 'vitest';
import {
  safeBlobMimeType,
  isPlayableAs,
  isAttachableImageType,
  planImageUpload,
  fitWithin,
  OPAQUE_BLOB_MIME_TYPE,
} from '@/app/utils/media';

describe('safeBlobMimeType', () => {
  it('keeps image, audio and video types from the allow-list', () => {
    expect(['image/png', 'image/jpeg', 'image/webp', 'video/mp4', 'audio/ogg'].map(safeBlobMimeType)).toEqual([
      'image/png',
      'image/jpeg',
      'image/webp',
      'video/mp4',
      'audio/ogg',
    ]);
  });

  it('normalises case and drops parameters before checking the list', () => {
    expect(safeBlobMimeType('Image/PNG; charset=binary')).toBe('image/png');
  });

  it('turns page, vector and script types into a download-only type', () => {
    const active = ['text/html', 'image/svg+xml', 'application/xhtml+xml', 'text/xml', 'application/xml', 'text/javascript', 'application/pdf'];

    expect(active.map(safeBlobMimeType)).toEqual(active.map(() => OPAQUE_BLOB_MIME_TYPE));
  });

  it('treats a missing or malformed type as download-only', () => {
    expect([undefined, null, '', 'png', 'image/'].map(safeBlobMimeType)).toEqual(Array(5).fill(OPAQUE_BLOB_MIME_TYPE));
  });
});

describe('isPlayableAs', () => {
  it('shows an allow-listed type only as its own kind', () => {
    expect(isPlayableAs('image/png', 'image')).toBe(true);
    expect(isPlayableAs('image/png', 'video')).toBe(false);
    expect(isPlayableAs('audio/mpeg', 'audio')).toBe(true);
  });

  it('never shows a download-only blob inline', () => {
    expect(isPlayableAs(OPAQUE_BLOB_MIME_TYPE, 'image')).toBe(false);
  });
});

describe('isAttachableImageType', () => {
  it('accepts JPG, PNG, GIF and WebP', () => {
    expect(['image/jpeg', 'image/png', 'image/gif', 'image/webp'].every(isAttachableImageType)).toBe(true);
  });

  it('refuses other image formats the composer does not name', () => {
    expect(['image/svg+xml', 'image/heic', 'image/bmp', 'image/tiff', 'text/plain'].some(isAttachableImageType)).toBe(false);
  });
});

describe('planImageUpload', () => {
  const large = 400 * 1024;

  it('uploads an animated format untouched however large it is', () => {
    expect(planImageUpload({ mimeType: 'image/gif', size: large, width: 4000, height: 3000, hasTransparency: false })).toEqual({ action: 'original' });
    expect(planImageUpload({ mimeType: 'image/webp', size: large, width: 800, height: 600, hasTransparency: true })).toEqual({ action: 'original' });
  });

  it('uploads a small image untouched', () => {
    expect(planImageUpload({ mimeType: 'image/png', size: 90 * 1024, width: 3000, height: 3000, hasTransparency: false })).toEqual({ action: 'original' });
  });

  it('keeps a large transparent PNG that fits the size limit as it is', () => {
    expect(planImageUpload({ mimeType: 'image/png', size: large, width: 1200, height: 800, hasTransparency: true })).toEqual({ action: 'original' });
  });

  it('scales an oversized transparent PNG but keeps it a PNG', () => {
    expect(planImageUpload({ mimeType: 'image/png', size: large, width: 3840, height: 960, hasTransparency: true })).toEqual({
      action: 'reencode',
      mimeType: 'image/png',
      width: 1920,
      height: 480,
    });
  });

  it('compresses a large opaque image to JPEG within the size limit', () => {
    expect(planImageUpload({ mimeType: 'image/png', size: large, width: 200, height: 200, hasTransparency: false })).toEqual({
      action: 'reencode',
      mimeType: 'image/jpeg',
      width: 200,
      height: 200,
    });
    expect(planImageUpload({ mimeType: 'image/jpeg', size: large, width: 4000, height: 3000, hasTransparency: false })).toEqual({
      action: 'reencode',
      mimeType: 'image/jpeg',
      width: 1920,
      height: 1440,
    });
  });
});

describe('fitWithin', () => {
  it('leaves dimensions inside the limit alone', () => {
    expect(fitWithin(1920, 1080)).toEqual({ width: 1920, height: 1080 });
  });

  it('scales the longer side down to the limit and keeps the aspect ratio', () => {
    expect(fitWithin(1000, 5000)).toEqual({ width: 384, height: 1920 });
  });
});