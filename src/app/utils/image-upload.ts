import { fitWithin, planImageUpload, MAX_UNCOMPRESSED_IMAGE_BYTES } from './media';

export interface PreparedImage {
  blob: Blob;
  mimetype: string;
  filename: string;
  width?: number;
  height?: number;
}

const TARGET_JPEG_BYTES = 400 * 1024;

/* Largest image whose every pixel is checked for transparency, beyond which the check runs on the downscaled copy to bound memory */
const MAX_EXACT_ALPHA_PIXELS = 4096 * 4096;

/* Decodes an image file for measuring and drawing, releasing its object URL as soon as the browser has decoded it */
const loadImage = (file: Blob): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const src = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(src);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(src);
      reject(new Error('Could not load image'));
    };
    img.src = src;
  });

const drawScaled = (img: HTMLImageElement, width: number, height: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } => {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Canvas not available');
  ctx.drawImage(img, 0, 0, width, height);
  return { canvas, ctx };
};

/* Reads the alpha channel, since a PNG may declare alpha yet leave every pixel opaque, and only a truly transparent pixel needs the PNG kept */
const hasTransparentPixel = (ctx: CanvasRenderingContext2D, width: number, height: number): boolean => {
  const { data } = ctx.getImageData(0, 0, width, height);
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] !== 255) return true;
  }
  return false;
};

const toBlob = (canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> =>
  new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Compression failed'))), type, quality);
  });

/* Turns an attached image into the bytes to upload following planImageUpload, and reports the dimensions for the event's info block */
export const prepareImageForUpload = async (file: File): Promise<PreparedImage> => {
  const mimetype = file.type.toLowerCase();
  const filename = file.name || 'image';
  const small = file.size <= MAX_UNCOMPRESSED_IMAGE_BYTES;
  const animated = mimetype === 'image/gif' || mimetype === 'image/webp';

  let img: HTMLImageElement;
  try {
    img = await loadImage(file);
  } catch (err) {
    /* A file that needs no re-encoding can still be sent without its dimensions when the browser cannot decode it */
    if (small || animated) return { blob: file, mimetype, filename };
    throw err;
  }
  const width = img.naturalWidth;
  const height = img.naturalHeight;

  let hasTransparency = false;
  if (mimetype === 'image/png' && !small) {
    const probe = width * height <= MAX_EXACT_ALPHA_PIXELS ? { width, height } : fitWithin(width, height);
    hasTransparency = hasTransparentPixel(drawScaled(img, probe.width, probe.height).ctx, probe.width, probe.height);
  }

  const plan = planImageUpload({ mimeType: mimetype, size: file.size, width, height, hasTransparency });
  if (plan.action === 'original') return { blob: file, mimetype, filename, width, height };

  const { canvas } = drawScaled(img, plan.width, plan.height);
  if (plan.mimeType === 'image/png') {
    return { blob: await toBlob(canvas, 'image/png'), mimetype: 'image/png', filename, width: plan.width, height: plan.height };
  }

  let quality = 0.85;
  let blob = await toBlob(canvas, 'image/jpeg', quality);
  while (blob.size > TARGET_JPEG_BYTES && quality > 0.4) {
    quality = Math.max(0.4, quality - 0.1);
    blob = await toBlob(canvas, 'image/jpeg', quality);
  }
  return { blob, mimetype: 'image/jpeg', filename: `${filename.replace(/\.[^.]+$/, '')}.jpg`, width: plan.width, height: plan.height };
};