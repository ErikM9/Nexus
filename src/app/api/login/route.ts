/* eslint-disable @typescript-eslint/no-explicit-any */

import { NextRequest, NextResponse } from 'next/server';

/* Shorter than the sign-in page's own 15-second limit, so the page always hears back before it gives up */
const UPSTREAM_TIMEOUT_MS = 10_000;

function normalizeBaseUrl(url: string) {
  return url.replace(/\/+$/, '');
}

const fail = (status: number, message: string, extra: Record<string, unknown> = {}) =>
  NextResponse.json({ success: false, message, ...extra }, { status });

/* The homeserver may name its preferred client-server URL in the login response, which the client should then use */
function wellKnownBaseUrl(data: any): string | null {
  const raw = data?.well_known?.['m.homeserver']?.base_url;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return normalizeBaseUrl(url.toString());
  } catch {
    return null;
  }
}

/* Reads the retry delay from the Matrix error body, or from the Retry-After header some proxies send instead */
function retryAfterMs(res: Response, data: any): number | undefined {
  if (typeof data?.retry_after_ms === 'number' && data.retry_after_ms >= 0) return data.retry_after_ms;
  const header = res.headers.get('retry-after');
  const seconds = header?.trim() ? Number(header) : NaN;
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
}

const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/* Server-side login proxy that signs in against the configured homeserver and reports which base URL the session belongs to */
export async function POST(req: NextRequest) {
  let body: any;

  try {
    body = await req.json();
  } catch {
    return fail(400, 'Invalid JSON payload');
  }

  const rawBaseUrl = process.env.MATRIX_HOMESERVER || process.env.NEXT_PUBLIC_MATRIX_HOMESERVER;
  if (!rawBaseUrl) return fail(500, 'Matrix server URL not configured');

  const baseUrl = normalizeBaseUrl(String(rawBaseUrl));

  const user = String(body?.user ?? '').trim();
  const password = String(body?.password ?? '');
  /* Reuse the device slot on the homeserver when the client sends a device ID */
  const deviceId = body?.deviceId ? String(body.deviceId).trim() : undefined;

  if (!user || !password) return fail(400, 'Username and password are required');

  const payload: any = {
    type: 'm.login.password',
    identifier: { type: 'm.id.user', user },
    password,
    refresh_token: true,
  };

  if (deviceId) payload.device_id = deviceId;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

  try {
    let res: Response;
    let data: any;
    try {
      res = await fetch(`${baseUrl}/_matrix/client/v3/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify(payload),
      });
      data = await res.json().catch(() => null);
    } catch {
      /* Network and abort errors carry implementation details, so the user only learns which of the two happened */
      return controller.signal.aborted
        ? fail(504, 'Matrix server timed out. Please try again.')
        : fail(502, "Couldn't reach the Matrix server. Please try again.");
    }

    if (!res.ok) {
      if (res.status === 429) {
        const waitMs = retryAfterMs(res, data);
        const seconds = waitMs !== undefined ? Math.max(1, Math.ceil(waitMs / 1000)) : undefined;
        const message = seconds
          ? `Too many sign-in attempts. Please wait ${seconds} second${seconds === 1 ? '' : 's'} and try again.`
          : 'Too many sign-in attempts. Please wait a moment and try again.';
        return fail(429, message, waitMs !== undefined ? { retryAfterMs: waitMs } : {});
      }

      const msg =
        data?.errcode === 'M_FORBIDDEN'
          ? 'Invalid username or password'
          : isNonEmptyString(data?.error)
            ? data.error
            : 'Login failed';

      return fail(res.status, msg);
    }

    if (!isNonEmptyString(data?.access_token) || !isNonEmptyString(data?.user_id) || !isNonEmptyString(data?.device_id)) {
      return fail(502, 'Unexpected response from the homeserver');
    }

    return NextResponse.json({
      success: true,
      accessToken: data.access_token,
      userId: data.user_id,
      deviceId: data.device_id,
      refreshToken: isNonEmptyString(data.refresh_token) ? data.refresh_token : undefined,
      baseUrl: wellKnownBaseUrl(data) ?? baseUrl,
    });
  } finally {
    clearTimeout(timer);
  }
}