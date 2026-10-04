import { describe, it, expect, vi } from 'vitest';
import { MatrixError, type MatrixClient } from 'matrix-js-sdk';
import { uploadWithSessionRefresh } from '@/app/utils/upload';

type UploadClient = Pick<MatrixClient, 'uploadContent' | 'whoami'>;

const expiredToken = () =>
  new MatrixError({ errcode: 'M_UNKNOWN_TOKEN', error: 'Access token has expired', soft_logout: true }, 401);

const fakeClient = (overrides: Partial<Record<keyof UploadClient, ReturnType<typeof vi.fn>>>) =>
  ({ uploadContent: vi.fn(), whoami: vi.fn(), ...overrides }) as unknown as UploadClient & Record<keyof UploadClient, ReturnType<typeof vi.fn>>;

describe('uploadWithSessionRefresh', () => {
  it('lets the SDK refresh the session and retries the upload once when the token has expired', async () => {
    const client = fakeClient({
      uploadContent: vi.fn().mockRejectedValueOnce(expiredToken()).mockResolvedValueOnce({ content_uri: 'mxc://hs.test/1' }),
      whoami: vi.fn().mockResolvedValue({ user_id: '@alice:hs.test' }),
    });

    const result = await uploadWithSessionRefresh(client, new Blob(['png']), { type: 'image/png' });

    expect(result).toEqual({ content_uri: 'mxc://hs.test/1' });
    expect(client.whoami).toHaveBeenCalledTimes(1);
    expect(client.uploadContent).toHaveBeenCalledTimes(2);
  });

  it('fails with the refresh error when the session cannot be refreshed', async () => {
    const refused = expiredToken();
    const client = fakeClient({
      uploadContent: vi.fn().mockRejectedValue(expiredToken()),
      whoami: vi.fn().mockRejectedValue(refused),
    });

    await expect(uploadWithSessionRefresh(client, new Blob(['png']), { type: 'image/png' })).rejects.toBe(refused);
    expect(client.uploadContent).toHaveBeenCalledTimes(1);
  });

  it('passes other upload failures straight through without retrying', async () => {
    const tooLarge = new MatrixError({ errcode: 'M_TOO_LARGE', error: 'File too large' }, 413);
    const client = fakeClient({ uploadContent: vi.fn().mockRejectedValue(tooLarge) });

    await expect(uploadWithSessionRefresh(client, new Blob(['png']), { type: 'image/png' })).rejects.toBe(tooLarge);
    expect(client.whoami).not.toHaveBeenCalled();
  });
});