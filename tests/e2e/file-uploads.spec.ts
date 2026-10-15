import type { Page } from '@playwright/test';
import { test, expect } from './support/fixtures';
import { BOB } from './support/homeserver';
import { makeGif, makePng, makeRgbaPng, PNG_SIGNATURE } from './support/images';

const smallPng = makePng(4, 3);

/* Reads the media type the app gave a blob URL, which is what a browser tab would render it as */
const blobType = (page: Page, blobUrl: string | null) =>
  page.evaluate(async (url) => (await fetch(url!)).headers.get('content-type'), blobUrl);

/* Picks a file through the chooser the Attach image button opens, the way a user would */
const attach = async (page: Page, file: { name: string; mimeType: string; buffer: Buffer }) => {
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Attach image' }).click();
  await (await chooser).setFiles(file);
};

test.describe('Picking a file', () => {
  test('opens a chooser for a single image', async ({ nexus, hs, page }) => {
    hs.addRoom({ name: 'General' });
    await nexus.open();
    await nexus.openRoom('General');

    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Attach image' }).click();

    expect((await chooser).isMultiple()).toBe(false);
    expect(await (await chooser).element().getAttribute('accept')).toBe('image/jpeg,image/png,image/gif,image/webp');
  });

  test('refuses a file that is not an image and explains why', async ({ nexus, hs, page }) => {
    hs.addRoom({ name: 'General' });
    await nexus.open();
    await nexus.openRoom('General');

    await attach(page, { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') });

    const error = page.getByText('Only images can be attached. Please pick a JPG, PNG, GIF, or WebP file.');
    await expect(error).toBeVisible();
    await expect(page.getByText(/^Attached:/)).toHaveCount(0);
    await page.getByRole('button', { name: 'dismiss' }).click();
    await expect(error).toHaveCount(0);
  });

  test('shows the picked image with its size and sends no image once it is removed', async ({ nexus, hs, page }) => {
    const room = hs.addRoom({ name: 'General' });
    await nexus.open();
    await nexus.openRoom('General');

    await attach(page, { name: 'pixel.png', mimeType: 'image/png', buffer: smallPng });
    await expect(page.getByText(`Attached: pixel.png (${smallPng.length} B)`)).toBeVisible();
    await page.getByRole('button', { name: 'remove' }).click();
    await expect(page.getByText(/^Attached:/)).toHaveCount(0);
    await nexus.send('Just words');

    await expect.poll(() => hs.sentEvents(room, 'm.room.message').map((e) => e.content)).toEqual([{ msgtype: 'm.text', body: 'Just words' }]);
    expect(hs.uploadedMedia()).toHaveLength(0);
  });
});

test.describe('Sending images', () => {
  test('uploads a small image unchanged and shows it in the room', async ({ nexus, hs, page }) => {
    const room = hs.addRoom({ name: 'General' });
    await nexus.open();
    await nexus.openRoom('General');

    await attach(page, { name: 'pixel.png', mimeType: 'image/png', buffer: smallPng });
    await nexus.sendButton.click();

    await expect.poll(() => hs.sentEvents(room, 'm.room.message').length).toBe(1);
    const [media] = hs.uploadedMedia();
    expect(media.contentType).toBe('image/png');
    expect(media.body.equals(smallPng)).toBe(true);
    const [event] = hs.sentEvents(room, 'm.room.message');
    expect(event.content).toEqual({
      msgtype: 'm.image',
      body: 'pixel.png',
      filename: 'pixel.png',
      info: { mimetype: 'image/png', size: smallPng.length, w: 4, h: 3 },
      url: expect.stringMatching(/^mxc:\/\/hs\.nexus\.test\/media\d+$/),
    });

    const image = nexus.log.getByRole('button', { name: 'Click to view full size image' });
    await expect(image).toBeVisible();
    await expect(page.getByText(/^Attached:/)).toHaveCount(0);

    await image.click();
    await expect(page.getByAltText('Full size')).toBeVisible();
    await page.getByRole('button', { name: 'Close' }).click();
    await expect(page.getByAltText('Full size')).toHaveCount(0);
  });

  test('uses the typed text as the caption', async ({ nexus, hs, page }) => {
    const room = hs.addRoom({ name: 'General' });
    await nexus.open();
    await nexus.openRoom('General');

    await attach(page, { name: 'pixel.png', mimeType: 'image/png', buffer: smallPng });
    await nexus.messageInput.fill('Our new logo');
    await nexus.messageInput.press('Enter');

    await expect.poll(() => hs.sentEvents(room, 'm.room.message')[0]?.content.body).toBe('Our new logo');
    await expect(nexus.log.getByText('Our new logo')).toBeVisible();
    await expect(nexus.messageInput).toHaveValue('');
  });

  test('re-encodes an image over 100 KB as JPEG before uploading', async ({ nexus, hs, page }) => {
    const room = hs.addRoom({ name: 'General' });
    const large = makePng(200, 200, { noise: true });
    expect(large.length).toBeGreaterThan(100 * 1024);
    await nexus.open();
    await nexus.openRoom('General');

    await attach(page, { name: 'noise.png', mimeType: 'image/png', buffer: large });
    await nexus.sendButton.click();

    await expect.poll(() => hs.sentEvents(room, 'm.room.message').length).toBe(1);
    const [media] = hs.uploadedMedia();
    expect(media.contentType).toBe('image/jpeg');
    expect(media.body.subarray(0, 2).equals(Buffer.from([0xff, 0xd8]))).toBe(true);
    expect(hs.sentEvents(room, 'm.room.message')[0].content).toMatchObject({
      body: 'noise.jpg',
      filename: 'noise.jpg',
      info: { mimetype: 'image/jpeg', w: 200, h: 200, size: media.body.length },
    });
  });

  test('uploads a large transparent PNG unchanged', async ({ nexus, hs, page }) => {
    const room = hs.addRoom({ name: 'General' });
    const sticker = makeRgbaPng(300, 300);
    expect(sticker.length).toBeGreaterThan(100 * 1024);
    await nexus.open();
    await nexus.openRoom('General');

    await attach(page, { name: 'sticker.png', mimeType: 'image/png', buffer: sticker });
    await nexus.sendButton.click();

    await expect.poll(() => hs.sentEvents(room, 'm.room.message').length).toBe(1);
    const [media] = hs.uploadedMedia();
    expect(media.contentType).toBe('image/png');
    expect(media.body.equals(sticker)).toBe(true);
    expect(hs.sentEvents(room, 'm.room.message')[0].content).toMatchObject({
      body: 'sticker.png',
      filename: 'sticker.png',
      info: { mimetype: 'image/png', size: sticker.length, w: 300, h: 300 },
    });
  });

  test('scales an oversized transparent PNG down but keeps it a PNG', async ({ nexus, hs, page }) => {
    const room = hs.addRoom({ name: 'General' });
    await nexus.open();
    await nexus.openRoom('General');

    await attach(page, { name: 'banner.png', mimeType: 'image/png', buffer: makeRgbaPng(2400, 100) });
    await nexus.sendButton.click();

    await expect.poll(() => hs.sentEvents(room, 'm.room.message').length).toBe(1);
    const [media] = hs.uploadedMedia();
    expect(media.contentType).toBe('image/png');
    expect(media.body.subarray(0, 4).equals(PNG_SIGNATURE)).toBe(true);
    expect(hs.sentEvents(room, 'm.room.message')[0].content).toMatchObject({
      filename: 'banner.png',
      info: { mimetype: 'image/png', size: media.body.length, w: 1920, h: 80 },
    });
  });

  test('uploads a large GIF unchanged so it keeps its animation', async ({ nexus, hs, page }) => {
    const room = hs.addRoom({ name: 'General' });
    const gif = makeGif(400, 300);
    expect(gif.length).toBeGreaterThan(100 * 1024);
    await nexus.open();
    await nexus.openRoom('General');

    await attach(page, { name: 'party.gif', mimeType: 'image/gif', buffer: gif });
    await nexus.sendButton.click();

    await expect.poll(() => hs.sentEvents(room, 'm.room.message').length).toBe(1);
    const [media] = hs.uploadedMedia();
    expect(media.contentType).toBe('image/gif');
    expect(media.body.equals(gif)).toBe(true);
    expect(hs.sentEvents(room, 'm.room.message')[0].content).toMatchObject({
      filename: 'party.gif',
      info: { mimetype: 'image/gif', size: gif.length, w: 400, h: 300 },
    });
  });

  test('encrypts an image before uploading it to an encrypted room and still shows it', { tag: '@smoke' }, async ({ nexus, hs, page }) => {
    const room = hs.addRoom({ name: 'Vault', encrypted: true });
    await nexus.open();
    await nexus.openRoom('Vault');

    await attach(page, { name: 'secret-plans.png', mimeType: 'image/png', buffer: smallPng });
    await nexus.sendButton.click();

    await expect.poll(() => hs.sentEvents(room).length, { timeout: 15_000 }).toBe(1);
    const [media] = hs.uploadedMedia();
    expect(media.contentType).toBe('application/octet-stream');
    expect(media.body.length).toBe(smallPng.length);
    expect(media.body.subarray(0, 4).equals(PNG_SIGNATURE)).toBe(false);
    expect(hs.sentEvents(room)[0].type).toBe('m.room.encrypted');
    await expect(nexus.log.getByRole('button', { name: 'Click to view full size image' })).toBeVisible();
  });

  test('keeps the file name of an encrypted image away from the server', async ({ nexus, hs, page }) => {
    hs.addRoom({ name: 'Vault', encrypted: true });
    await nexus.open();
    await nexus.openRoom('Vault');

    await attach(page, { name: 'passport-scan.png', mimeType: 'image/png', buffer: smallPng });
    await nexus.sendButton.click();

    await expect.poll(() => hs.requestsTo(/media\/v3\/upload$/, 'POST').length, { timeout: 15_000 }).toBe(1);
    const [upload] = hs.requestsTo(/media\/v3\/upload$/, 'POST');
    expect(upload.query.get('filename')).toBeNull();
  });

  test('refreshes an expired session during an upload and still sends the image', async ({ nexus, hs, page }) => {
    const room = hs.addRoom({ name: 'General' });
    /* The access token lives far longer than the test, so only expireAccessTokens below makes the upload need a refresh */
    await nexus.seedSession({ refreshToken: hs.enableRefreshTokens({ accessTokenLifetimeMs: 60 * 60_000 }) });
    await page.goto('/');
    await nexus.waitUntilReady();
    await nexus.openRoom('General');
    await attach(page, { name: 'pixel.png', mimeType: 'image/png', buffer: smallPng });
    hs.expireAccessTokens();
    hs.failNext(/\/media\/v3\/upload$/, 401, { errcode: 'M_UNKNOWN_TOKEN', error: 'Access token has expired', soft_logout: true });

    await nexus.sendButton.click();

    await expect.poll(() => hs.sentEvents(room, 'm.room.message').length).toBe(1);
    await expect(nexus.log.getByRole('button', { name: 'Click to view full size image' })).toBeVisible();
    expect(hs.requestsTo(/\/refresh$/, 'POST')).toHaveLength(1);
    expect(hs.requestsTo(/\/media\/v3\/upload$/, 'POST')).toHaveLength(2);
    await expect(page).not.toHaveURL(/\/auth/);
  });

  test('deletes an image I sent after confirming', async ({ nexus, hs, page }) => {
    const room = hs.addRoom({ name: 'General' });
    await nexus.open();
    await nexus.openRoom('General');
    await attach(page, { name: 'pixel.png', mimeType: 'image/png', buffer: smallPng });
    await nexus.sendButton.click();
    const image = nexus.log.getByRole('button', { name: 'Click to view full size image' });
    await expect(image).toBeVisible();

    await image.hover();
    await nexus.log.getByRole('button', { name: 'Delete message' }).click();
    await expect(nexus.log.getByText('Delete this message?')).toBeVisible();
    await nexus.log.getByRole('button', { name: 'Delete', exact: true }).click();

    await expect(nexus.log.getByText('Message deleted.')).toBeVisible();
    await expect(image).toHaveCount(0);
    await expect.poll(() => hs.requestsTo(new RegExp(`/rooms/${room}/redact/`), 'PUT')).toHaveLength(1);
  });
});

test.describe('Receiving attachments', () => {
  test('shows an image someone else sent', async ({ nexus, hs }) => {
    const room = hs.addRoom({ name: 'General', members: [BOB] });
    const url = hs.uploadMedia(smallPng, 'image/png');
    hs.post(room, BOB, 'm.room.message', { msgtype: 'm.image', body: 'Holiday snap', info: { mimetype: 'image/png', w: 4, h: 3 }, url });
    await nexus.open();
    await nexus.openRoom('General');

    const image = nexus.log.getByRole('button', { name: 'Click to view full size image' });
    await expect(image).toBeVisible();
    await expect(image).toHaveAttribute('src', /^blob:/);
    await expect(nexus.message('Holiday snap')).toHaveAccessibleName(`Message from ${BOB}`);
    expect(hs.requestsTo(/\/client\/v1\/media\/download\//)).toHaveLength(1);
  });

  test('offers a file someone else sent as a download with its size', async ({ nexus, hs }) => {
    const room = hs.addRoom({ name: 'General', members: [BOB] });
    const pdf = Buffer.alloc(2048, 1);
    const url = hs.uploadMedia(pdf, 'application/pdf');
    hs.post(room, BOB, 'm.room.message', {
      msgtype: 'm.file',
      body: 'report.pdf',
      filename: 'report.pdf',
      info: { mimetype: 'application/pdf', size: pdf.length },
      url,
    });
    await nexus.open();
    await nexus.openRoom('General');

    const link = nexus.log.getByRole('link', { name: 'Download report.pdf' });
    await expect(link).toBeVisible();
    await expect(link).toContainText('2.0 KB');
    await expect(link).toHaveAttribute('download', 'report.pdf');
    await expect(link).toHaveAttribute('href', /^blob:/);
  });

  test('plays received audio and video and offers them as downloads', async ({ nexus, hs }) => {
    const room = hs.addRoom({ name: 'General', members: [BOB] });
    const voice = hs.uploadMedia(Buffer.from('audio bytes'), 'audio/ogg');
    const clip = hs.uploadMedia(Buffer.from('video bytes'), 'video/mp4');
    hs.post(room, BOB, 'm.room.message', { msgtype: 'm.audio', body: 'voice-note.ogg', info: { mimetype: 'audio/ogg', size: 11 }, url: voice });
    hs.post(room, BOB, 'm.room.message', { msgtype: 'm.video', body: 'clip.mp4', info: { mimetype: 'video/mp4', size: 11 }, url: clip });

    await nexus.open();
    await nexus.openRoom('General');

    await expect(nexus.log.getByLabel('Audio: voice-note.ogg')).toHaveAttribute('src', /^blob:/);
    await expect(nexus.log.getByLabel('Video: clip.mp4')).toHaveAttribute('src', /^blob:/);
    await expect(nexus.log.getByRole('link', { name: 'Download voice-note.ogg' })).toBeVisible();
    await expect(nexus.log.getByRole('link', { name: 'Download clip.mp4' })).toBeVisible();
  });

  test('says when an image cannot be found', async ({ nexus, hs }) => {
    const room = hs.addRoom({ name: 'General', members: [BOB] });
    hs.post(room, BOB, 'm.room.message', { msgtype: 'm.image', body: 'Gone', info: { mimetype: 'image/png' } });
    await nexus.open();
    await nexus.openRoom('General');

    await expect(nexus.log.getByText('Image unavailable')).toBeVisible();
  });

  test('never opens a received file as a web page in the app', async ({ nexus, hs, page }) => {
    const room = hs.addRoom({ name: 'General', members: [BOB] });
    const invoice = Buffer.from('<!doctype html><p>Invoice 1042</p>');
    const url = hs.uploadMedia(invoice, 'text/html');
    hs.post(room, BOB, 'm.room.message', { msgtype: 'm.file', body: 'invoice.html', info: { mimetype: 'text/html' }, url });
    await nexus.open();
    await nexus.openRoom('General');

    const href = await nexus.log.getByRole('link', { name: 'Download invoice.html' }).getAttribute('href');

    expect(await blobType(page, href)).toBe('application/octet-stream');
  });
});