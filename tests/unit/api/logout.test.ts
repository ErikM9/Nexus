import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from '@/app/api/logout/route';
import {
  htmlReply,
  jsonReply,
  neverAnswerUntilAborted,
  sentRequest,
  stubHomeserverFetch,
  waitForFetchCall,
  type FetchMock,
} from './homeserver';

const HOMESERVER = 'https://matrix.example.org';
const LOGOUT_URL = `${HOMESERVER}/_matrix/client/v3/logout`;
const ACCESS_TOKEN = 'syt_YWxpY2U_access_token';

/* Builds the request the session overlay posts to the proxy, passing string bodies through untouched so malformed JSON can be sent */
const logoutRequest = (body: unknown) =>
  new NextRequest('https://nexus.test/api/logout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

describe('POST /api/logout', () => {
  let fetchMock: FetchMock;

  beforeEach(() => {
    vi.stubEnv('MATRIX_HOMESERVER', HOMESERVER);
    vi.stubEnv('NEXT_PUBLIC_MATRIX_HOMESERVER', undefined);
    fetchMock = stubHomeserverFetch();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  describe('request validation', () => {
    it.each([
      ['a form-encoded body', `accessToken=${ACCESS_TOKEN}`],
      ['truncated JSON', '{"accessToken":'],
      ['an empty body', ''],
    ])('returns 400 for %s', async (_case, body) => {
      const res = await POST(logoutRequest(body));

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ success: false, message: 'Invalid JSON payload' });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('returns 500 when neither homeserver variable is set', async () => {
      vi.stubEnv('MATRIX_HOMESERVER', undefined);

      const res = await POST(logoutRequest({ accessToken: ACCESS_TOKEN }));

      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ success: false, message: 'Matrix server URL not configured' });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it.each([
      ['the token is missing', {}],
      ['the token is empty', { accessToken: '' }],
      ['the token is only whitespace', { accessToken: '   ' }],
      ['the JSON body is null', null],
    ])('returns 400 when %s', async (_case, body) => {
      const res = await POST(logoutRequest(body));

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ success: false, message: 'Missing access token' });
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('outgoing homeserver request', () => {
    beforeEach(() => {
      fetchMock.mockResolvedValue(jsonReply(200, {}));
    });

    it('revokes the trimmed token with a Bearer header and no body', async () => {
      await POST(logoutRequest({ accessToken: `  ${ACCESS_TOKEN}  ` }));

      const { url, init } = sentRequest(fetchMock);
      expect(url).toBe(LOGOUT_URL);
      expect(init).toStrictEqual({
        method: 'POST',
        headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
        signal: expect.any(AbortSignal),
      });
    });

    it('prefers MATRIX_HOMESERVER over NEXT_PUBLIC_MATRIX_HOMESERVER', async () => {
      vi.stubEnv('NEXT_PUBLIC_MATRIX_HOMESERVER', 'https://public.example.org');

      await POST(logoutRequest({ accessToken: ACCESS_TOKEN }));

      expect(sentRequest(fetchMock).url).toBe(LOGOUT_URL);
    });

    it('falls back to NEXT_PUBLIC_MATRIX_HOMESERVER and drops its trailing slashes', async () => {
      vi.stubEnv('MATRIX_HOMESERVER', undefined);
      vi.stubEnv('NEXT_PUBLIC_MATRIX_HOMESERVER', 'https://public.example.org///');

      await POST(logoutRequest({ accessToken: ACCESS_TOKEN }));

      expect(sentRequest(fetchMock).url).toBe('https://public.example.org/_matrix/client/v3/logout');
    });
  });

  describe('homeserver replies', () => {
    it('reports success when the homeserver accepts the logout', async () => {
      fetchMock.mockResolvedValueOnce(jsonReply(200, {}));

      const res = await POST(logoutRequest({ accessToken: ACCESS_TOKEN }));

      expect(res.status).toBe(200);
      expect(await res.json()).toStrictEqual({ success: true });
    });

    it('passes a Matrix error through with its status and message', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonReply(401, { errcode: 'M_UNKNOWN_TOKEN', error: 'Invalid access token passed.', soft_logout: false })
      );

      const res = await POST(logoutRequest({ accessToken: ACCESS_TOKEN }));

      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ success: false, message: 'Invalid access token passed.' });
    });

    it('reports the status when the error reply has no error text', async () => {
      fetchMock.mockResolvedValueOnce(jsonReply(500, { errcode: 'M_UNKNOWN' }));

      const res = await POST(logoutRequest({ accessToken: ACCESS_TOKEN }));

      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ success: false, message: 'Logout failed (500)' });
    });

    it('reports the status when the error reply is not JSON', async () => {
      fetchMock.mockResolvedValueOnce(htmlReply(502));

      const res = await POST(logoutRequest({ accessToken: ACCESS_TOKEN }));

      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({ success: false, message: 'Logout failed (502)' });
    });
  });

  describe('network failures', () => {
    it.each([
      ['a fetch TypeError', new TypeError('fetch failed')],
      ['an error with internal details', new Error('getaddrinfo ENOTFOUND matrix.internal.lan')],
      ['an error without a message', new Error()],
    ])('reports %s as an unreachable homeserver without its text', async (_case, error) => {
      fetchMock.mockRejectedValueOnce(error);

      const res = await POST(logoutRequest({ accessToken: ACCESS_TOKEN }));

      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({ success: false, message: "Couldn't reach the Matrix server. Please try again." });
    });

    it('aborts the homeserver request after 15 seconds and reports a timeout as 504', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      fetchMock.mockImplementationOnce(neverAnswerUntilAborted);

      const pending = POST(logoutRequest({ accessToken: ACCESS_TOKEN }));
      await waitForFetchCall(fetchMock);
      const { signal } = sentRequest(fetchMock).init;

      await vi.advanceTimersByTimeAsync(14_999);
      expect(signal?.aborted).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      expect(signal?.aborted).toBe(true);

      const res = await pending;
      expect(res.status).toBe(504);
      expect(await res.json()).toEqual({ success: false, message: 'Matrix server timed out. Please try again.' });
    });

    it('clears the abort timer once the homeserver answers', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      fetchMock.mockResolvedValueOnce(jsonReply(200, {}));

      const res = await POST(logoutRequest({ accessToken: ACCESS_TOKEN }));
      const { signal } = sentRequest(fetchMock).init;
      await vi.advanceTimersByTimeAsync(15_000);

      expect(res.status).toBe(200);
      expect(signal?.aborted).toBe(false);
    });
  });
});