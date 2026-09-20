/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextRequest, NextResponse } from 'next/server';

function normalizeBaseUrl(url: string) {
  return url.replace(/\/+$/, '');
}

/* Server-side logout proxy that invalidates the access token without exposing the homeserver URL */
export async function POST(req: NextRequest) {
  let body: any;

  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ success: false, message: 'Invalid JSON payload' }, { status: 400 });
  }

  const rawBaseUrl = process.env.MATRIX_HOMESERVER || process.env.NEXT_PUBLIC_MATRIX_HOMESERVER;
  if (!rawBaseUrl) {
    return NextResponse.json({ success: false, message: 'Matrix server URL not configured' }, { status: 500 });
  }

  const baseUrl = normalizeBaseUrl(String(rawBaseUrl));
  const accessToken = String(body?.accessToken ?? '').trim();

  if (!accessToken) {
    return NextResponse.json({ success: false, message: 'Missing access token' }, { status: 400 });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);

  try {
    const res = await fetch(`${baseUrl}/_matrix/client/v3/logout`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: controller.signal,
    });

    if (!res.ok) {
      const data: any = await res.json().catch(() => null);
      const msg = data?.error || `Logout failed (${res.status})`;
      return NextResponse.json({ success: false, message: msg }, { status: res.status });
    }

    return NextResponse.json({ success: true });
  } catch (e: any) {
    const msg =
      e?.name === 'AbortError'
        ? 'Matrix server timed out. Please try again.'
        : e?.message || 'Logout failed';

    return NextResponse.json({ success: false, message: msg }, { status: 502 });
  } finally {
    clearTimeout(timer);
  }
}