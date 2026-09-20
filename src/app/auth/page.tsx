/* eslint-disable @typescript-eslint/no-explicit-any */
'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardHeader, CardContent, CardFooter } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import { StoredSession } from '@/app/utils/helpers';

export default function AuthPage() {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const router = useRouter();
  const registerUrl = 'https://app.element.io/#/register';

  useEffect(() => {
    if (typeof window === 'undefined') return;

    /* Pre-fill username from the last session so returning users don't retype it */
    const storedUser = localStorage.getItem('mx_user_id');
    if (storedUser) setUsername(storedUser);

    /* Skip the auth page when a session already exists in localStorage */
    const rawSession = localStorage.getItem('mx_session');
    const accessToken = localStorage.getItem('mx_access_token');

    if (rawSession || accessToken) {
      router.replace('/');
    }
  }, [router]);

  const changeMode = (newMode: 'login' | 'register') => {
    setMode(newMode);
    setPassword('');
  };

  const handleAuth = async (e: React.FormEvent) => {
    e.preventDefault();

    const trimmedUsername = username.trim();

    if (!trimmedUsername || !password) {
      toast.error('Please enter a username and password');
      return;
    }

    setLoading(true);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);

    try {
      /* Reuse the stored device ID so the homeserver doesn't register a new device each login */
      const storedDeviceId = typeof window !== 'undefined' ? localStorage.getItem('mx_device_id') : null;

      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          user: trimmedUsername,
          password,
          deviceId: storedDeviceId || undefined,
        }),
      });

      const data: any = await res.json().catch(() => null);

      if (!res.ok || !data?.success) {
        toast.error(data?.message || 'Login failed');
        return;
      }

      const baseUrl = process.env.NEXT_PUBLIC_MATRIX_HOMESERVER || '';

      if (typeof window !== 'undefined') {
        localStorage.setItem('mx_access_token', data.accessToken);
        localStorage.setItem('mx_user_id', data.userId);

        if (data.deviceId) localStorage.setItem('mx_device_id', data.deviceId);
        if (data.refreshToken) localStorage.setItem('mx_refresh_token', data.refreshToken);

        const session: StoredSession = {
          accessToken: data.accessToken,
          refreshToken: data.refreshToken || undefined,
          userId: data.userId,
          deviceId: data.deviceId || undefined,
          baseUrl,
        };

        /* Persist the unified session blob and fire matrix-start to boot the client */
        localStorage.setItem('mx_session', JSON.stringify(session));
        window.dispatchEvent(new CustomEvent('matrix-start', { detail: session }));
      }

      router.replace('/');
    } catch (err: any) {
      const msg =
        err?.name === 'AbortError'
          ? 'Request timed out. Please try again.'
          : err?.message || 'An unexpected error occurred.';

      toast.error(msg);
    } finally {
      clearTimeout(timer);
      setLoading(false);
    }
  };

  const selectedToggleClass =
    'bg-sky-500 text-white dark:bg-sky-400 dark:text-slate-950';

  const sectionHeaderClass = 'text-[1em] font-semibold tracking-[0.18em] uppercase text-muted-foreground';
  const formLabelClass = 'text-sm font-semibold tracking-[0.025em] text-muted-foreground';

  return (
    <div className="h-full w-full flex bg-transparent">

      <div className="hidden xl:block w-1/2 h-full [container-type:size]">
        <div className="w-full h-full glass no-border-top no-border-right no-border-left no-border-bottom glass-opaque hairline-r flex flex-col overflow-hidden">
          <div className="pl-[1.25em] pr-[1.75em] py-[1.25em] flex flex-col gap-[1.75em] text-[clamp(0.4rem,min(1.05cqh_+_0.78vh,1.98cqw),2.5rem)]">
            <div className="space-y-[1.25em] max-w-none">
              <h1 className="text-[1.6875em] font-semibold tracking-[0.18em] uppercase text-muted-foreground">What is Nexus?</h1>

              <div className="space-y-[1.5em]">
                <section className="space-y-[0.5em]">
                  <div className={sectionHeaderClass}>A Matrix client</div>
                  <p className="text-[1em] leading-relaxed text-muted-foreground">
                    Nexus is a chat app built on the Matrix protocol — an open standard for decentralised, real-time communication.
                    Unlike centralised platforms, no single company owns the network or your account: your identity lives on a
                    homeserver of your choice, and you can reach anyone across the Matrix network no matter which server they use.
                    Nexus is the interface that sits on top of all that — focused, fast, and without the clutter.
                  </p>
                </section>

                <section className="space-y-[0.5em]">
                  <div className={sectionHeaderClass}>Rooms and messaging</div>
                  <p className="text-[1em] leading-relaxed text-muted-foreground">
                    Rooms are the basic unit of conversation — create public or private ones, invite people directly, or join existing
                    spaces across the network. Nexus keeps invitations, member management, and room settings together in one place.
                    Messages support reactions, edits, deletions, and threaded replies, so longer side-discussions don&apos;t take over
                    the main timeline, and admins can assign roles and moderate membership as a room grows.
                  </p>
                </section>

                <section className="space-y-[0.5em]">
                  <div className={sectionHeaderClass}>Encryption and verification</div>
                  <p className="text-[1em] leading-relaxed text-muted-foreground">
                    Encrypted rooms use the Rust-based Matrix crypto backend — messages are encrypted on your device before they leave
                    it, and only participants with verified sessions can read them. Device verification happens through emoji
                    comparison, so you can confirm you&apos;re talking to who you think you are, and images and files are encrypted before
                    upload so attachments stay private end-to-end. Recovery Keys let you restore your encrypted history when you sign
                    in on a new device, without losing anything.
                  </p>
                </section>

                <section className="space-y-[0.5em]">
                  <div className={sectionHeaderClass}>Your account, your homeserver</div>
                  <p className="text-[1em] leading-relaxed text-muted-foreground">
                    Nexus works with any Matrix homeserver — the public matrix.org server, one run by your organisation, or one you
                    self-host — and federation means your choice never limits who you can reach. Sign in with your existing Matrix
                    credentials and your rooms, messages, and encrypted history are right where you left them, whatever device
                    you&apos;re on.
                  </p>
                </section>
              </div>
            </div>

            <div className="pt-[0.75em] border-t border-border/60 text-[1em] leading-relaxed text-muted-foreground">
              <span className="text-[1em] font-semibold">Tip:</span> Set up a Recovery Key early from the Settings panel — your encryption keys are stored locally on your
              device, so it&apos;s the only way to restore your encrypted message history if you sign in from a new device, clear your
              browser data, or use the &quot;Forget this session&quot; option.
            </div>
          </div>
        </div>
      </div>

      <ScrollArea className="w-full xl:w-1/2 h-full" viewportClassName="h-full w-full flex items-center justify-center p-4 xl:p-8 overflow-auto">
        <div className="origin-center scale-100 [--auth-zoom:1] [@media(min-width:768px)_and_(max-width:1279px)_and_(min-height:1000px)]:scale-[1.4] [@media(min-width:768px)_and_(max-width:1279px)_and_(min-height:1000px)]:[--auth-zoom:1.4] xl:scale-[1.22] xl:[--auth-zoom:1.22] w-full max-w-[20rem] xl:w-[22.4rem] xl:max-w-[90vw]">
          <Card className="w-full min-h-[380px] rounded-3xl flex flex-col overflow-visible relative border-border/50 ![border-width:calc(1px/var(--auth-zoom))]">
            <CardHeader className="relative h-[170px] pb-3">
              <div className="flex justify-center pt-1">
                <div className="inline-flex rounded-full border border-border/50 overflow-hidden bg-muted/20 dark:bg-secondary dark:border-border ![border-width:calc(1px/var(--auth-zoom))]">
                  <button
                    type="button"
                    className={`w-[92px] px-3.5 pt-2.5 pb-1.5 text-[13px] font-semibold tracking-wide transition-all ${
                      mode === 'login'
                        ? selectedToggleClass
                        : 'text-muted-foreground hover:text-foreground hover:bg-muted/40 dark:hover:bg-muted/25'
                    }`}
                    onClick={() => { if (!loading) changeMode('login'); }}
                    disabled={loading}
                  >
                    Sign in
                  </button>
                  <button
                    type="button"
                    className={`w-[92px] px-3.5 pt-2.5 pb-1.5 text-[13px] font-semibold tracking-wide transition-all ${
                      mode === 'register'
                        ? selectedToggleClass
                        : 'text-muted-foreground hover:text-foreground hover:bg-muted/40 dark:hover:bg-muted/25'
                    }`}
                    onClick={() => { if (!loading) changeMode('register'); }}
                    disabled={loading}
                  >
                    Sign up
                  </button>
                </div>
              </div>

              <div className="absolute left-6 right-6 top-[75px] flex flex-col items-center">
                {mode === 'login' ? (
                  <div className="text-xs font-semibold tracking-[0.18em] uppercase text-muted-foreground text-center mb-1">
                    Sign in to Nexus
                  </div>
                ) : (
                  <div className="text-xs font-semibold tracking-[0.18em] uppercase text-muted-foreground text-center mb-1">
                    Create your Matrix account
                  </div>
                )}
              </div>

              {mode === 'register' && (
                <div className="absolute left-6 right-6 top-[105px] flex justify-center">
                  <div className="relative w-[245px] max-w-full rounded-lg px-3 py-2 bg-muted/30 dark:bg-muted/20 border border-border/50 backdrop-blur-sm ![border-width:calc(1px/var(--auth-zoom))]">
                    <div className="w-full text-center text-[12px] font-semibold text-foreground mb-1">
                      How does this work?
                    </div>
                    <p className="text-[10px] leading-relaxed text-muted-foreground font-normal text-left">
                      This app relies on the public Matrix network. Account creation is handled securely by the Matrix homeserver
                      provider. Click on the <span className="font-semibold text-foreground">Sign up</span> button below and
                      create a Matrix account on the next page. Once you have successfully signed up, return to this app and sign
                      in with your details on the <span className="font-semibold text-foreground">Sign in</span> section of the
                      form.
                    </p>
                  </div>
                </div>
              )}
            </CardHeader>

            <CardContent className="flex-1 flex flex-col pb-2 relative">
              {mode === 'login' && (
                <div className="absolute left-0 right-0 top-[-67px] flex justify-center">
                  <div className="relative w-[275px] max-w-full rounded-lg px-3 py-2">
                    <form id="login-form" onSubmit={handleAuth} className="w-full space-y-3">
                      <div className="space-y-1">
                        <Label htmlFor="username" className={formLabelClass}>Username:</Label>
                        <Input
                          id="username"
                          type="text"
                          value={username}
                          onChange={(e) => setUsername(e.target.value)}
                          placeholder="@yourname:matrix.org or yourname"
                          autoComplete="username"
                          disabled={loading}
                          className="h-10 text-sm w-full border-border/50 ![border-width:calc(1px/var(--auth-zoom))]"
                        />
                      </div>

                      <div className="space-y-1">
                        <Label htmlFor="password" className={formLabelClass}>Password:</Label>
                        <Input
                          id="password"
                          type="password"
                          value={password}
                          onChange={(e) => setPassword(e.target.value)}
                          placeholder="••••••••"
                          autoComplete="current-password"
                          disabled={loading}
                          className="h-10 text-sm w-full border-border/50 ![border-width:calc(1px/var(--auth-zoom))]"
                        />
                      </div>
                    </form>
                  </div>
                </div>
              )}
            </CardContent>

            <div className="absolute left-0 right-0 bottom-[58px] flex justify-center pointer-events-none">
              {mode === 'register' ? (
                <Button
                  type="button"
                  className="w-[91px] text-base h-[39px] pointer-events-auto"
                  onClick={() => window.open(registerUrl, '_blank', 'noopener,noreferrer')}
                  disabled={loading}
                >
                  Sign up
                </Button>
              ) : (
                <Button
                  type="submit"
                  form="login-form"
                  className="w-[91px] text-base h-[39px] pointer-events-auto"
                  disabled={loading}
                >
                  Sign in
                </Button>
              )}
            </div>

            <CardFooter className="flex justify-center pt-0 pb-4">
              <p className="text-[clamp(0.8rem,3.2vw,0.95rem)] xl:text-lg text-muted-foreground text-center">
                {mode === 'login' ? (
                  <>
                    New to Matrix?{' '}
                    <button type="button" onClick={() => changeMode('register')} className="text-blue-600 hover:underline font-medium" disabled={loading}>
                      Create an account
                    </button>
                  </>
                ) : (
                  <>
                    Already have an account?{' '}
                    <button type="button" onClick={() => changeMode('login')} className="text-blue-600 hover:underline font-medium" disabled={loading}>
                      Sign in
                    </button>
                  </>
                )}
              </p>
            </CardFooter>
          </Card>
        </div>
      </ScrollArea>
    </div>
  );
}