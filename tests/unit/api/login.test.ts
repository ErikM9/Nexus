import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from '@/app/api/login/route';
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
const LOGIN_URL = `${HOMESERVER}/_matrix/client/v3/login`;

/* Mirrors a spec-compliant /login response, including fields the proxy is expected to drop */
const LOGIN_REPLY = {
  user_id: '@alice:matrix.example.org',
  access_token: 'syt_YWxpY2U_access_token',
  device_id: 'GHTYAJCE',
  refresh_token: 'syr_YWxpY2U_refresh_token',
  expires_in_ms: 300000,
  home_server: 'matrix.example.org',
  well_known: { 'm.homeserver': { base_url: `${HOMESERVER}/` } },
};

/* Builds the request the auth page posts to the proxy, passing string bodies through untouched so malformed JSON can be sent */
const loginRequest = (body: unknown) =>
  new NextRequest('https://nexus.test/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

const sentLoginBody = (fetchMock: FetchMock) => JSON.parse(String(sentRequest(fetchMock).init.body));

describe('POST /api/login', () => {
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
      ['a form-encoded body', 'user=alice&password=secret'],
      ['truncated JSON', '{"user":"alice",'],
      ['an empty body', ''],
    ])('returns 400 for %s', async (_case, body) => {
      const res = await POST(loginRequest(body));

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ success: false, message: 'Invalid JSON payload' });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('returns 500 when neither homeserver variable is set', async () => {
      vi.stubEnv('MATRIX_HOMESERVER', undefined);

      const res = await POST(loginRequest({ user: 'alice', password: 'secret' }));

      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ success: false, message: 'Matrix server URL not configured' });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it.each([
      ['the user is missing', { password: 'secret' }],
      ['the user is only whitespace', { user: '   ', password: 'secret' }],
      ['the password is missing', { user: 'alice' }],
      ['the password is empty', { user: 'alice', password: '' }],
      ['the JSON body is null', null],
    ])('returns 400 when %s', async (_case, body) => {
      const res = await POST(loginRequest(body));

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ success: false, message: 'Username and password are required' });
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('outgoing homeserver request', () => {
    beforeEach(() => {
      fetchMock.mockResolvedValue(jsonReply(200, LOGIN_REPLY));
    });

    it('posts an m.login.password login that asks for a refresh token', async () => {
      await POST(loginRequest({ user: 'alice', password: 'correct horse battery staple' }));

      const { url, init } = sentRequest(fetchMock);
      expect(url).toBe(LOGIN_URL);
      expect(init).toEqual({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: expect.any(AbortSignal),
        body: expect.any(String),
      });
      expect(JSON.parse(String(init.body))).toEqual({
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: 'alice' },
        password: 'correct horse battery staple',
        refresh_token: true,
      });
    });

    it('trims the user and device ID but sends the password exactly as typed', async () => {
      await POST(loginRequest({ user: '  alice  ', password: '  padded secret  ', deviceId: '  GHTYAJCE  ' }));

      expect(sentLoginBody(fetchMock)).toEqual({
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: 'alice' },
        password: '  padded secret  ',
        refresh_token: true,
        device_id: 'GHTYAJCE',
      });
    });

    it('leaves device_id out when the device ID is blank', async () => {
      await POST(loginRequest({ user: 'alice', password: 'secret', deviceId: '   ' }));

      expect(sentLoginBody(fetchMock)).not.toHaveProperty('device_id');
    });

    it('prefers MATRIX_HOMESERVER over NEXT_PUBLIC_MATRIX_HOMESERVER', async () => {
      vi.stubEnv('NEXT_PUBLIC_MATRIX_HOMESERVER', 'https://public.example.org');

      await POST(loginRequest({ user: 'alice', password: 'secret' }));

      expect(sentRequest(fetchMock).url).toBe(LOGIN_URL);
    });

    it('falls back to NEXT_PUBLIC_MATRIX_HOMESERVER and drops its trailing slashes', async () => {
      vi.stubEnv('MATRIX_HOMESERVER', undefined);
      vi.stubEnv('NEXT_PUBLIC_MATRIX_HOMESERVER', 'https://public.example.org///');

      await POST(loginRequest({ user: 'alice', password: 'secret' }));

      expect(sentRequest(fetchMock).url).toBe('https://public.example.org/_matrix/client/v3/login');
    });
  });

  describe('homeserver replies', () => {
    it('maps a successful login to the session fields the auth page stores', async () => {
      fetchMock.mockResolvedValueOnce(jsonReply(200, LOGIN_REPLY));

      const res = await POST(loginRequest({ user: 'alice', password: 'secret' }));

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        success: true,
        accessToken: 'syt_YWxpY2U_access_token',
        userId: '@alice:matrix.example.org',
        deviceId: 'GHTYAJCE',
        refreshToken: 'syr_YWxpY2U_refresh_token',
        baseUrl: HOMESERVER,
      });
    });

    it('omits refreshToken when the homeserver does not issue one', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonReply(200, {
          user_id: '@alice:matrix.example.org',
          access_token: 'syt_YWxpY2U_access_token',
          device_id: 'GHTYAJCE',
        })
      );

      const res = await POST(loginRequest({ user: 'alice', password: 'secret' }));

      expect(res.status).toBe(200);
      expect(await res.json()).toStrictEqual({
        success: true,
        accessToken: 'syt_YWxpY2U_access_token',
        userId: '@alice:matrix.example.org',
        deviceId: 'GHTYAJCE',
        baseUrl: HOMESERVER,
      });
    });

    it('returns the client-server URL the homeserver names in well_known, so the session talks to it', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonReply(200, { ...LOGIN_REPLY, well_known: { 'm.homeserver': { base_url: 'https://client.matrix.example.org/' } } })
      );

      const res = await POST(loginRequest({ user: 'alice', password: 'secret' }));

      expect((await res.json()).baseUrl).toBe('https://client.matrix.example.org');
    });

    it.each([
      ['a relative URL', 'client.example.org'],
      ['a non-HTTP scheme', 'ftp://client.example.org'],
      ['an empty string', '   '],
      ['a non-string value', 42],
    ])('ignores a well_known base URL that is %s and keeps the configured homeserver', async (_case, baseUrl) => {
      fetchMock.mockResolvedValueOnce(jsonReply(200, { ...LOGIN_REPLY, well_known: { 'm.homeserver': { base_url: baseUrl } } }));

      const res = await POST(loginRequest({ user: 'alice', password: 'secret' }));

      expect((await res.json()).baseUrl).toBe(HOMESERVER);
    });

    it.each([
      ['access_token', { access_token: undefined }],
      ['user_id', { user_id: undefined }],
      ['device_id', { device_id: undefined }],
      ['a string access token', { access_token: 12345 }],
    ])('turns a 2xx reply without %s into a 502 instead of an unusable session', async (_case, broken) => {
      fetchMock.mockResolvedValueOnce(jsonReply(200, { ...LOGIN_REPLY, ...broken }));

      const res = await POST(loginRequest({ user: 'alice', password: 'secret' }));

      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({ success: false, message: 'Unexpected response from the homeserver' });
    });

    it('turns a 2xx reply that is not JSON into a 502', async () => {
      fetchMock.mockResolvedValueOnce(htmlReply(200));

      const res = await POST(loginRequest({ user: 'alice', password: 'secret' }));

      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({ success: false, message: 'Unexpected response from the homeserver' });
    });

    it('replaces the M_FORBIDDEN error text with a generic credentials message and keeps the status', async () => {
      fetchMock.mockResolvedValueOnce(jsonReply(403, { errcode: 'M_FORBIDDEN', error: 'Invalid password' }));

      const res = await POST(loginRequest({ user: 'alice', password: 'wrong' }));

      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ success: false, message: 'Invalid username or password' });
    });

    it("passes the homeserver's own error text through for other refusals", async () => {
      fetchMock.mockResolvedValueOnce(jsonReply(403, { errcode: 'M_USER_DEACTIVATED', error: 'This account has been deactivated' }));

      const res = await POST(loginRequest({ user: 'alice', password: 'secret' }));

      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ success: false, message: 'This account has been deactivated' });
    });

    it('explains a rate limit in seconds and passes retry_after_ms on to the page', async () => {
      fetchMock.mockResolvedValueOnce(jsonReply(429, { errcode: 'M_LIMIT_EXCEEDED', error: 'Too Many Requests', retry_after_ms: 2500 }));

      const res = await POST(loginRequest({ user: 'alice', password: 'secret' }));

      expect(res.status).toBe(429);
      expect(await res.json()).toEqual({
        success: false,
        message: 'Too many sign-in attempts. Please wait 3 seconds and try again.',
        retryAfterMs: 2500,
      });
    });

    it('reads the delay from a Retry-After header when the body has none', async () => {
      fetchMock.mockResolvedValueOnce(
        new Response('', { status: 429, headers: { 'Retry-After': '1' } })
      );

      const res = await POST(loginRequest({ user: 'alice', password: 'secret' }));

      expect(await res.json()).toEqual({
        success: false,
        message: 'Too many sign-in attempts. Please wait 1 second and try again.',
        retryAfterMs: 1000,
      });
    });

    it('still explains a rate limit that names no delay', async () => {
      fetchMock.mockResolvedValueOnce(jsonReply(429, { errcode: 'M_LIMIT_EXCEEDED', error: 'Too Many Requests' }));

      const res = await POST(loginRequest({ user: 'alice', password: 'secret' }));

      expect(res.status).toBe(429);
      expect(await res.json()).toEqual({ success: false, message: 'Too many sign-in attempts. Please wait a moment and try again.' });
    });

    it('falls back to "Login failed" when the error reply has no error text', async () => {
      fetchMock.mockResolvedValueOnce(jsonReply(500, { errcode: 'M_UNKNOWN' }));

      const res = await POST(loginRequest({ user: 'alice', password: 'secret' }));

      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ success: false, message: 'Login failed' });
    });

    it('falls back to "Login failed" when the error reply is not JSON', async () => {
      fetchMock.mockResolvedValueOnce(htmlReply(502));

      const res = await POST(loginRequest({ user: 'alice', password: 'secret' }));

      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({ success: false, message: 'Login failed' });
    });
  });

  describe('network failures', () => {
    it.each([
      ['a fetch TypeError', new TypeError('fetch failed')],
      ['an error with internal details', new Error('getaddrinfo ENOTFOUND matrix.internal.lan')],
      ['an error without a message', new Error()],
    ])('reports %s as an unreachable homeserver without its text', async (_case, error) => {
      fetchMock.mockRejectedValueOnce(error);

      const res = await POST(loginRequest({ user: 'alice', password: 'secret' }));

      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({ success: false, message: "Couldn't reach the Matrix server. Please try again." });
    });

    it("aborts the homeserver request after 10 seconds, before the sign-in page's own 15-second limit", async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      fetchMock.mockImplementationOnce(neverAnswerUntilAborted);

      const pending = POST(loginRequest({ user: 'alice', password: 'secret' }));
      await waitForFetchCall(fetchMock);
      const { signal } = sentRequest(fetchMock).init;

      await vi.advanceTimersByTimeAsync(9_999);
      expect(signal?.aborted).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      expect(signal?.aborted).toBe(true);

      const res = await pending;
      expect(res.status).toBe(504);
      expect(await res.json()).toEqual({ success: false, message: 'Matrix server timed out. Please try again.' });
    });

    it('clears the abort timer once the homeserver answers', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      fetchMock.mockResolvedValueOnce(jsonReply(200, LOGIN_REPLY));

      const res = await POST(loginRequest({ user: 'alice', password: 'secret' }));
      const { signal } = sentRequest(fetchMock).init;
      await vi.advanceTimersByTimeAsync(15_000);

      expect(res.status).toBe(200);
      expect(signal?.aborted).toBe(false);
    });
  });
});