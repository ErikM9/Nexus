'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import dynamic from 'next/dynamic';
import { hardClientReset } from '@/app/utils/helpers';
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

  const handleSelect = useCallback((roomId: string | null, initialName?: string, isEncrypted?: boolean, isPublic?: boolean) => {
    if (!roomId) setSelectedRoom(null);
    else setSelectedRoom({ roomId, initialName, isEncrypted, isPublic });
  }, []);

  const handleLeaveSelectedRoom = useCallback(() => {
    setSelectedRoom(null);
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    if (window.__matrix_ready) {
      setMatrixReady(true);
      setTimedOut(false);
      return;
    }

    /* No session at all, so skip the loading screen and go straight to auth */
    const hasSession = !!(localStorage.getItem('mx_session') || localStorage.getItem('mx_access_token'));
    if (!hasSession) {
      router.replace('/auth');
      return;
    }

    const onReady = () => { setMatrixReady(true); setTimedOut(false); };
    const onNotReady = () => { setMatrixReady(false); setSelectedRoom(null); router.replace('/auth'); };

    window.addEventListener('matrix-ready', onReady);
    window.addEventListener('matrix-not-ready', onNotReady);

    /* Poll as a fallback in case matrix-ready fired before this listener attached */
    const poll = setInterval(() => {
      if (window.__matrix_ready) {
        setMatrixReady(true);
        setTimedOut(false);
        clearInterval(poll);
      }
    }, 200);

    /* Surface a warning after 12 seconds instead of leaving an indefinite spinner */
    const timeout = setTimeout(() => {
      if (!window.__matrix_ready) setTimedOut(true);
    }, 12000);

    return () => {
      window.removeEventListener('matrix-ready', onReady);
      window.removeEventListener('matrix-not-ready', onNotReady);
      clearInterval(poll);
      clearTimeout(timeout);
    };
  }, [router]);

  if (!matrixReady) {
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

          {timedOut && (
            <div className="space-y-3 mt-4" role="alert">
              <div className="text-lg font-semibold tracking-wide text-red-500">
                Connection is taking longer than expected.
              </div>
              <button
                className="text-lg font-semibold tracking-wide text-blue-600 hover:underline"
                onClick={() => {
                  hardClientReset();
                  router.replace('/auth');
                }}
                aria-label="Go to sign in page"
              >
                Go to sign in
              </button>
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
        <ChatList onSelect={handleSelect} />
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
                fallback={
                  <div className="flex items-center justify-center h-full">
                    <div className="text-center">
                      <p className="text-sm font-semibold text-destructive">Chat failed to load.</p>
                      <button
                        className="mt-3 text-sm text-blue-600 hover:underline"
                        onClick={() => window.location.reload()}
                      >
                        Reload page
                      </button>
                    </div>
                  </div>
                }
              >
                <ChatWindow
                  roomId={selectedRoom.roomId}
                  onLeave={handleLeaveSelectedRoom}
                />
              </ErrorBoundary>
            </div>

            <div className="shrink-0 hairline-t">
              <MessageInput roomId={selectedRoom.roomId} />
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