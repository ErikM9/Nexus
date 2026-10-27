import type { FileType, MatrixClient, UploadOpts, UploadResponse } from 'matrix-js-sdk';

/* Tells whether a request failed because the homeserver no longer accepts the access token */
const isUnknownTokenError = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && (err as { errcode?: unknown }).errcode === 'M_UNKNOWN_TOKEN';

/* Uploads media, retrying once after a whoami call when the token is rejected, as uploads bypass the SDK's token refresh */
export const uploadWithSessionRefresh = async (
  client: Pick<MatrixClient, 'uploadContent' | 'whoami'>,
  file: FileType,
  opts: UploadOpts
): Promise<UploadResponse> => {
  try {
    return await client.uploadContent(file, opts);
  } catch (err) {
    if (!isUnknownTokenError(err)) throw err;
    /* The SDK refreshes the token inside whoami, which throws the same error when the session is really over */
    await client.whoami();
    return client.uploadContent(file, opts);
  }
};