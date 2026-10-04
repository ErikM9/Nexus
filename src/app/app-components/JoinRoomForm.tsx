'use client';

import React, { useEffect, useId, useRef, useState } from 'react';
import { MatrixError, type IPublicRoomsChunkRoom, type MatrixClient } from 'matrix-js-sdk';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import type { RoomFallback } from './CreateRoomForm';

type PublicRoom = Pick<IPublicRoomsChunkRoom, 'room_id' | 'name'>;
type SearchStatus = 'idle' | 'searching' | 'done';
type JoinTarget = { kind: 'alias' | 'id'; value: string };

/* Wait after the last keystroke before searching the directory, so a request is not sent for every character */
const SEARCH_DEBOUNCE_MS = 280;

const HINT = 'Join a public room by searching for its name or entering its room ID.';

/* Input starting with # or ! is an address to join directly rather than a name to search for */
const isDirectInput = (value: string) => /^[#!]/.test(value.trim());

/* A server name is a DNS name, an IPv4 address or a bracketed IPv6 literal, optionally followed by a port */
const SERVER_NAME = String.raw`(?:\[[0-9a-fA-F:.]+\]|[a-zA-Z0-9.-]+)(?::\d{1,5})?`;
const ALIAS_PATTERN = new RegExp(String.raw`^#[^\s:]+:${SERVER_NAME}$`);
const ROOM_ID_PATTERN = new RegExp(String.raw`^![^\s:]+(?::${SERVER_NAME})?$`);

/* Aliases always name their server, while room IDs from room version 12 onwards have no server part */
export const parseJoinTarget = (value: string): JoinTarget | null => {
  const s = value.trim();
  if (ALIAS_PATTERN.test(s)) return { kind: 'alias', value: s };
  if (ROOM_ID_PATTERN.test(s)) return { kind: 'id', value: s };
  return null;
};

/* Exact name matches first, then names starting with the term, then the rest, alphabetically within each group */
const rankByName = (rooms: PublicRoom[], term: string): PublicRoom[] => {
  const q = term.toLowerCase();
  const rank = (name: string) => (name === q ? 0 : name.startsWith(q) ? 1 : 2);
  return [...rooms].sort((a, b) => {
    const aName = (a.name || '').toLowerCase();
    const bName = (b.name || '').toLowerCase();
    return rank(aName) - rank(bName) || aName.localeCompare(bName);
  });
};

interface JoinRoomFormProps {
  client: MatrixClient | null;
  onJoined: (roomId: string, fallback: RoomFallback) => void;
}

/* Directory search and Join button, where results are keyboard-reachable buttons and only the latest search may update them */
const JoinRoomForm: React.FC<JoinRoomFormProps> = ({ client, onJoined }) => {
  const [term, setTerm] = useState('');
  const [results, setResults] = useState<PublicRoom[]>([]);
  const [status, setStatus] = useState<SearchStatus>('idle');
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<PublicRoom | null>(null);
  const [joining, setJoining] = useState(false);
  const [inputError, setInputError] = useState<string | null>(null);
  const joiningRef = useRef(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const hintId = useId();

  /* Every edit bumps the sequence, so a response to anything but the latest search is dropped */
  const searchSeq = useRef(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelSearch = () => {
    searchSeq.current += 1;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = null;
  };

  useEffect(() => {
    const seq = searchSeq;
    const debounce = debounceRef;
    return () => {
      seq.current += 1;
      if (debounce.current) clearTimeout(debounce.current);
    };
  }, []);

  const direct = isDirectInput(term);

  const runSearch = async (query: string) => {
    if (!client) return;
    const seq = ++searchSeq.current;
    try {
      const response = await client.publicRooms({ filter: { generic_search_term: query } });
      if (seq !== searchSeq.current) return;
      setResults(rankByName(response.chunk ?? [], query));
      setStatus('done');
    } catch {
      if (seq !== searchSeq.current) return;
      toast.error('Search failed');
      setResults([]);
      setStatus('idle');
      setOpen(false);
    }
  };

  const scheduleSearch = (query: string, delayMs: number) => {
    cancelSearch();
    setResults([]);
    setStatus('searching');
    setOpen(true);
    debounceRef.current = setTimeout(() => {
      debounceRef.current = null;
      void runSearch(query);
    }, delayMs);
  };

  const onTermChange = (value: string) => {
    setTerm(value);
    setSelected(null);
    setInputError(null);
    if (!value.trim() || isDirectInput(value)) {
      cancelSearch();
      setResults([]);
      setStatus('idle');
      setOpen(false);
      return;
    }
    scheduleSearch(value.trim(), SEARCH_DEBOUNCE_MS);
  };

  const pick = (room: PublicRoom) => {
    cancelSearch();
    setSelected(room);
    setTerm(room.room_id);
    setResults([]);
    setStatus('idle');
    setOpen(false);
    inputRef.current?.focus();
  };

  const join = async () => {
    if (!client || joiningRef.current) return;
    const target: JoinTarget | null = selected ? { kind: 'id', value: selected.room_id } : parseJoinTarget(term);
    if (!target) {
      if (!term.trim()) toast.error('Select a room first');
      else setInputError(term.trim().startsWith('#') ? 'Enter the full address, like #room:server' : 'Enter the full room ID, like !abc:server');
      return;
    }

    joiningRef.current = true;
    setJoining(true);
    try {
      const joined = await client.joinRoom(target.value);
      toast.success('Joined room');
      setOpen(false);
      onJoined(joined.roomId, { name: selected?.name || target.value });
    } catch (err) {
      if (err instanceof MatrixError && err.errcode === 'M_NOT_FOUND') {
        setInputError(target.kind === 'alias' ? `No room found at ${target.value}` : `No room found with the ID ${target.value}`);
      } else {
        toast.error('Failed to join room');
      }
    } finally {
      joiningRef.current = false;
      setJoining(false);
    }
  };

  const focusResult = (index: number) => {
    const buttons = listRef.current?.querySelectorAll<HTMLButtonElement>('button');
    if (!buttons?.length) return;
    buttons[Math.max(0, Math.min(index, buttons.length - 1))].focus();
  };

  const onInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    /* Enter that confirms an IME composition belongs to the composition, not to the form */
    if (e.key === 'Enter' && !e.nativeEvent.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      if (isDirectInput(term)) void join();
      else if (term.trim()) scheduleSearch(term.trim(), 0);
    } else if (e.key === 'ArrowDown' && open && results.length > 0) {
      e.preventDefault();
      focusResult(0);
    } else if (e.key === 'Escape' && open) {
      e.stopPropagation();
      setOpen(false);
    }
  };

  const onResultKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      focusResult(index + 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (index === 0) inputRef.current?.focus();
      else focusResult(index - 1);
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      setOpen(false);
      inputRef.current?.focus();
    }
  };

  const showPanel = open && !direct && term.trim().length > 0 && status !== 'idle';
  const statusText =
    status === 'searching' ? 'Searching…' : results.length === 0 ? 'No results' : `${results.length} ${results.length === 1 ? 'room' : 'rooms'} found`;
  const inputOpenClass = showPanel ? 'rounded-b-none border-b-transparent' : '';

  return (
    <div className="flex flex-col justify-end h-full">
      {inputError ? (
        <div id={hintId} role="alert" className="text-xs font-medium tracking-wide text-destructive text-center mb-1">
          {inputError}
        </div>
      ) : (
        <div id={hintId} className="text-xs font-medium tracking-wide text-muted-foreground text-center mb-1">
          {HINT}
        </div>
      )}

      <div
        className="relative mx-auto w-[205px]"
        onBlur={(e) => {
          /* The panel closes once focus leaves the search box and its results, since it would otherwise cover the Join button */
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(false);
        }}
      >
        <Input
          ref={inputRef}
          type="text"
          placeholder="Search by name or enter ID"
          value={term}
          onChange={(e) => onTermChange(e.target.value)}
          onFocus={() => {
            if (term.trim() && !direct && status !== 'idle') setOpen(true);
          }}
          onKeyDown={onInputKeyDown}
          disabled={!client}
          aria-describedby={hintId}
          aria-invalid={inputError ? true : undefined}
          className={`w-full transition-[border-radius] duration-200 ease-out ${inputOpenClass}`}
        />

        {showPanel && (
          <div
            className="absolute left-0 right-0 top-full z-50 mt-[-1px] rounded-t-none rounded-b-md border-t-0 shadow-none border border-[hsl(var(--field-border))] bg-[hsl(var(--field))] text-[hsl(var(--field-foreground))]"
            onMouseDown={(e) => e.preventDefault()}
          >
            <ScrollArea viewportClassName="max-h-56 overflow-y-auto p-2">
              <div role="status" className={results.length > 0 ? 'sr-only' : 'px-2 py-2 text-sm text-muted-foreground'}>
                {statusText}
              </div>
              {results.length > 0 && (
                <ul ref={listRef} className="space-y-1" aria-label="Matching public rooms">
                  {results.map((room, index) => (
                    <li key={room.room_id}>
                      <button
                        type="button"
                        onClick={() => pick(room)}
                        onKeyDown={(e) => onResultKeyDown(e, index)}
                        className="w-full cursor-pointer select-none rounded-lg px-2 py-2 text-left transition-colors hover:bg-accent/60 dark:hover:bg-muted/50 focus-visible:outline-none focus-visible:bg-accent/60 dark:focus-visible:bg-muted/50"
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="shrink-0" aria-hidden="true">🌍</span>
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-sm">{room.name || room.room_id}</div>
                            <div className="truncate text-[11px] text-muted-foreground">{room.room_id}</div>
                          </div>
                        </div>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </ScrollArea>
          </div>
        )}
      </div>

      <div className="flex justify-center mt-2">
        <Button
          onClick={() => void join()}
          className="w-[66px]"
          disabled={!client || joining || !(selected || direct)}
        >
          Join
        </Button>
      </div>
    </div>
  );
};

export default JoinRoomForm;