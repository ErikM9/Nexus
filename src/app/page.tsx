'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import dynamic from 'next/dynamic';
import {
  getMatrixStartupStatus,
  hasStoredSession,
  logoutMatrixClient,
  type MatrixStartupStatus,
} from '@/app/utils/matrix';
import { ErrorBoundary } from './app-components/ErrorBoundary';

/* Chat components are lazy-loaded since they depend on the Matrix client being ready */
const ChatList = dynamic(() => import('./app-components/ChatList'), { ssr: false });
const ChatWindow = dynamic(() => import('./app-components/ChatWindow'), { ssr: false });
const MessageInput = dynamic(() => import('./app-components/MessageInput'), { ssr: false });
const ChatHeader = dynamic(() => import('./app-components/ChatHeader'), { ssr: false });

type SelectedRoom = {
  roomId: string;
  initialName?: string;
  isEncrypted?: boolean;
  isPublic?: boolean;
} | null;

const ChatPage: React.FC = () => {
  const router = useRouter();

  const [selectedRoom, setSelectedRoom] = useState<SelectedRoom>(null);
  const [matrixReady, setMatrixReady] = useState(false);
  const [timedOut, setTimedOut] = useState(false);
  const [startupStatus, setStartupStatus] = useState<MatrixStartupStatus>({ state: 'connecting' });
  const [retryCount, setRetryCount] = useState(0);
  const [signingOut, setSigningOut] = useState(false);

  const handleSelect = useCallback((roomId: string | null, initialName?: string, isEncrypted?: boolean, isPublic?: boolean) => {
    if (!roomId) setSelectedRoom(null);
    else setSelectedRoom({ roomId, initialName, isEncrypted, isPublic });
  }, []);

  /* A room ID limits the close to that room, so a late callback from a room already switched away from cannot close the one now open, while anything else (the header's Back button passes its click event) closes whatever is open */
  const handleLeaveSelectedRoom = useCallback((roomId?: string) => {
    setSelectedRoom((current) => (typeof roomId !== 'string' || current?.roomId === roomId ? null : current));
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    /* A missing session means there is nothing to connect, so go straight to sign-in */
    if (!window.__matrix_ready && !hasStoredSession()) {
      router.replace('/auth');
      return;
    }

    const onReady = () => {
      setMatrixReady(true);
      setTimedOut(false);
    };
    /* Not-ready with a session still stored is a client restart, while a cleared session means it ended */
    const onNotReady = () => {
      setMatrixReady(false);
      setSelectedRoom(null);
      if (!hasStoredSession()) router.replace('/auth');
    };
    const onStartupStatus = (ev: Event) => setStartupStatus((ev as CustomEvent<MatrixStartupStatus>).detail);

    setMatrixReady(!!window.__matrix_ready);
    setStartupStatus(getMatrixStartupStatus());
    window.addEventListener('matrix-ready', onReady);
    window.addEventListener('matrix-not-ready', onNotReady);
    window.addEventListener('matrix-startup-status', onStartupStatus);

    return () => {
      window.removeEventListener('matrix-ready', onReady);
      window.removeEventListener('matrix-not-ready', onNotReady);
      window.removeEventListener('matrix-startup-status', onStartupStatus);
    };
  }, [router]);

  /* Surface a warning after 12 seconds instead of leaving an indefinite spinner, counting again after each retry */
  useEffect(() => {
    if (matrixReady) return;
    setTimedOut(false);
    const timeout = setTimeout(() => setTimedOut(true), 12000);
    return () => clearTimeout(timeout);
  }, [matrixReady, retryCount]);

  const retryStartup = () => {
    setRetryCount((n) => n + 1);
    window.dispatchEvent(new Event('matrix-retry'));
  };

  const signOut = async () => {
    setSigningOut(true);
    try {
      await logoutMatrixClient();
    } finally {
      setSigningOut(false);
      router.replace('/auth');
    }
  };

  const useNexusHere = () => {
    /* The other tab may have signed out meanwhile, which leaves nothing here to take over */
    if (!hasStoredSession()) {
      router.replace('/auth');
      return;
    }
    window.dispatchEvent(new Event('matrix-take-over'));
  };

  if (!matrixReady && startupStatus.state === 'other-tab') {
    return (
      <div className="h-full w-full flex items-center justify-center bg-transparent">
        <div className="flex flex-col items-center justify-center gap-3 text-center px-6 max-w-lg">
          <h2 className="text-2xl font-semibold tracking-wide text-muted-foreground">Nexus is open in another tab</h2>
          <p className="text-sm text-muted-foreground">
            Nexus runs in one tab at a time so your messages and encryption keys stay in step. Close the other tab, or use
            Nexus here instead.
          </p>
          <button
            type="button"
            className="text-lg font-semibold tracking-wide text-blue-600 hover:underline"
            onClick={useNexusHere}
          >
            Use Nexus here
          </button>
        </div>
      </div>
    );
  }

  if (!matrixReady) {
    const failed = startupStatus.state === 'failed';
    const problem = startupStatus.state === 'reconnecting' || startupStatus.state === 'failed' ? startupStatus.message : '';

    return (
      <div
        className="h-full w-full flex items-center justify-center bg-transparent"
        role="status"
        aria-label="Loading"
      >
        <div className="flex flex-col items-center justify-center text-center px-6">
          <div
            className="mb-4 h-10 w-10 rounded-full border-4 border-border/60 border-t-muted-foreground animate-spin"
            aria-hidden="true"
          />

          <div className="text-2xl font-semibold tracking-wide text-muted-foreground">
            Connecting to Matrix server…
          </div>

          {(timedOut || failed) && (
            <div className="space-y-3 mt-4" role="alert">
              <div className="text-lg font-semibold tracking-wide text-red-500">
                {failed ? "Nexus couldn't start." : 'Connection is taking longer than expected.'}
              </div>
              {problem && <div className="text-sm text-muted-foreground">{problem}</div>}
              <div className="flex items-center justify-center gap-6">
                <button
                  type="button"
                  className="text-lg font-semibold tracking-wide text-blue-600 hover:underline disabled:opacity-60"
                  onClick={retryStartup}
                  disabled={signingOut}
                >
                  Retry
                </button>
                <button
                  type="button"
                  className="text-lg font-semibold tracking-wide text-blue-600 hover:underline disabled:opacity-60"
                  onClick={signOut}
                  disabled={signingOut}
                >
                  {signingOut ? 'Signing out…' : 'Sign out'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <main className="flex h-full min-h-0 overflow-hidden bg-transparent">
      <aside
        className={`relative z-0 w-full md:w-64 h-full min-h-0 overflow-hidden ${
          selectedRoom ? 'hidden md:block' : 'block'
        }`}
        aria-label="Chat rooms"
      >
        <ChatList onSelect={handleSelect} selectedRoomId={selectedRoom?.roomId ?? null} />
      </aside>

      <section
        className={`relative z-0 flex-col flex-1 h-full min-h-0 overflow-hidden bg-transparent ${
          selectedRoom ? 'flex' : 'hidden md:flex'
        }`}
        aria-label="Chat area"
      >
        {selectedRoom ? (
          <>
            <div className="shrink-0 hairline-b">
              <ChatHeader
                key={selectedRoom.roomId}
                roomName={selectedRoom.initialName || selectedRoom.roomId}
                roomId={selectedRoom.roomId}
                isEncrypted={!!selectedRoom.isEncrypted}
                isPublic={!!selectedRoom.isPublic}
                onLeave={handleLeaveSelectedRoom}
                onBack={handleLeaveSelectedRoom}
              />
            </div>

            <div className="flex-1 min-h-0 overflow-hidden bg-transparent">
              <ErrorBoundary
                resetKeys={[selectedRoom.roomId]}
                fallback={(retry) => (
                  <div className="flex items-center justify-center h-full" role="alert">
                    <div className="text-center">
                      <p className="text-sm font-semibold text-destructive">Chat failed to load.</p>
                      <div className="mt-3 flex items-center justify-center gap-4">
                        <button className="text-sm text-blue-600 hover:underline" onClick={retry}>
                          Try again
                        </button>
                        <button
                          className="text-sm text-blue-600 hover:underline"
                          onClick={() => window.location.reload()}
                        >
                          Reload page
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              >
                <ChatWindow
                  key={selectedRoom.roomId}
                  roomId={selectedRoom.roomId}
                  onLeave={handleLeaveSelectedRoom}
                />
              </ErrorBoundary>
            </div>

            <div className="shrink-0 hairline-t">
              <MessageInput key={selectedRoom.roomId} roomId={selectedRoom.roomId} />
            </div>
          </>
        ) : (
          <div
            className="flex-1 min-h-0 flex items-center justify-center bg-transparent"
            role="status"
          >
            <p className="text-xl font-bold text-muted-foreground">
              Select a chat to start messaging
            </p>
          </div>
        )}
      </section>
    </main>
  );
};

export default ChatPage;