import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { prepareImageForUpload } from '@/app/utils/image-upload';

/* Stands in for a browser that cannot decode the file and says so with an error event, since jsdom decodes no images */
class UndecodableImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;

  set src(_url: string) {
    queueMicrotask(() => this.onerror?.());
  }
}

const fileOf = (bytes: number, name: string, type: string) => new File([new Uint8Array(bytes)], name, { type });

describe('prepareImageForUpload with an image the browser cannot decode', () => {
  beforeEach(() => {
    vi.stubGlobal('Image', UndecodableImage);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    ['a still image of up to 100 KiB', fileOf(100 * 1024, 'scan.png', 'image/png')],
    ['a GIF of any size', fileOf(400 * 1024, 'party.gif', 'image/gif')],
    ['a WebP image of any size', fileOf(400 * 1024, 'sticker.webp', 'image/webp')],
  ])('sends %s as it is, without dimensions', async (_case, file) => {
    const prepared = await prepareImageForUpload(file);

    expect(prepared).toEqual({ blob: file, mimetype: file.type, filename: file.name });
  });

  it('refuses a larger still image, which it could only send re-encoded', async () => {
    const photo = fileOf(100 * 1024 + 1, 'photo.jpg', 'image/jpeg');

    await expect(prepareImageForUpload(photo)).rejects.toThrow('Could not load image');
  });

  it('releases the object URL it tried to decode', async () => {
    await prepareImageForUpload(fileOf(1024, 'scan.png', 'image/png'));

    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock-url');
  });
});