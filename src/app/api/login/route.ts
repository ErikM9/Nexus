/* eslint-disable @typescript-eslint/no-explicit-any */

import { NextRequest, NextResponse } from 'next/server';

function normalizeBaseUrl(url: string) {
  return url.replace(/\/+$/, '');
}

/* Server-side login proxy that keeps the homeserver URL out of client JS and forwards login responses */
export async function POST(req: NextRequest) {
  let body: any;

  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { success: false, message: 'Invalid JSON payload' },
      { status: 400 }
    );
  }

  const rawBaseUrl =
    process.env.MATRIX_HOMESERVER || process.env.NEXT_PUBLIC_MATRIX_HOMESERVER;

  if (!rawBaseUrl) {
    return NextResponse.json(
      { success: false, message: 'Matrix server URL not configured' },
      { status: 500 }
    );
  }

  const baseUrl = normalizeBaseUrl(String(rawBaseUrl));

  const user = String(body?.user ?? '').trim();
  const password = String(body?.password ?? '');
  /* Reuse the device slot on the homeserver when the client sends a device ID */
  const deviceId = body?.deviceId ? String(body.deviceId).trim() : undefined;

  if (!user || !password) {
    return NextResponse.json(
      { success: false, message: 'Username and password are required' },
      { status: 400 }
    );
  }

  const payload: any = {
    type: 'm.login.password',
    identifier: { type: 'm.id.user', user },
    password,
    refresh_token: true,
  };

  if (deviceId) payload.device_id = deviceId;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);

  try {
    const res = await fetch(`${baseUrl}/_matrix/client/v3/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify(payload),
    });

    const data: any = await res.json().catch(() => null);

    if (!res.ok) {
      const msg =
        data?.errcode === 'M_FORBIDDEN'
          ? 'Invalid username or password'
          : data?.error || 'Login failed';

      return NextResponse.json({ success: false, message: msg }, { status: res.status });
    }

    return NextResponse.json({
      success: true,
      accessToken: data.access_token,
      userId: data.user_id,
      deviceId: data.device_id,
      refreshToken: data.refresh_token,
    });
  } catch (e: any) {
    const msg =
      e?.name === 'AbortError'
        ? 'Matrix server timed out. Please try again.'
        : e?.message || 'Login failed';

    return NextResponse.json({ success: false, message: msg }, { status: 502 });
  } finally {
    clearTimeout(timer);
  }
}