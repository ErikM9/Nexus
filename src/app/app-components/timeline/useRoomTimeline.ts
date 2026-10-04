import { useCallback, useEffect, useRef, useState } from 'react';
import { Direction, MatrixEventEvent, RoomEvent, RoomStateEvent, type MatrixClient, type MatrixEvent, type Room } from 'matrix-js-sdk';
import { deriveTimeline, EMPTY_VIEW, type RelationMemory, type TimelineView } from './model';

export interface RoomTimeline {
  view: TimelineView;
  /* False until the view has been built from the room, so layout-driven loading does not act on an empty first render */
  ready: boolean;
  hasMoreHistory: boolean;
  isLoadingHistory: boolean;
  historyFailed: boolean;
  /* Counts live-timeline resets after a gappy sync, so the view can drop its scroll position */
  resets: number;
  /* Counts room state changes, so permissions shown next to messages follow power level changes */
  stateVersion: number;
  /* Starts loading an older page and tells whether a request actually started */
  loadOlder: () => boolean;
}

const PAGE_SIZE = 30;

export const useRoomTimeline = (client: MatrixClient | null, room: Room | null): RoomTimeline => {
  const [view, setView] = useState<TimelineView>(EMPTY_VIEW);
  const [ready, setReady] = useState(false);
  const [hasMoreHistory, setHasMoreHistory] = useState(true);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [historyFailed, setHistoryFailed] = useState(false);
  const [resets, setResets] = useState(0);
  const [stateVersion, setStateVersion] = useState(0);
  const memoryRef = useRef<RelationMemory>(new Map());
  /* Names the timeline a history request started on, so a page finishing after a reset, a room change or unmount is ignored */
  const epochRef = useRef(0);
  const loadingRef = useRef(false);

  useEffect(() => {
    if (!client || !room) return;
    let alive = true;
    let scheduled = false;
    epochRef.current += 1;
    loadingRef.current = false;

    const recompute = () => {
      scheduled = false;
      if (!alive) return;
      setView(deriveTimeline(room.getLiveTimeline().getEvents(), memoryRef.current, client.getUserId()));
    };
    /* SDK updates come in bursts and some, like an edit applied after decryption, land after other listeners run, so the view is rebuilt once per microtask */
    const schedule = () => {
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(recompute);
    };
    const readBackToken = () => setHasMoreHistory(room.getLiveTimeline().getPaginationToken(Direction.Backward) !== null);
    const onEventChanged = (event: MatrixEvent) => {
      if (event.getRoomId() === room.roomId) schedule();
    };
    const onReset = () => {
      epochRef.current += 1;
      loadingRef.current = false;
      setIsLoadingHistory(false);
      setHistoryFailed(false);
      readBackToken();
      setResets((n) => n + 1);
      schedule();
    };
    const onStateChanged = () => setStateVersion((n) => n + 1);

    recompute();
    readBackToken();
    setReady(true);
    setIsLoadingHistory(false);
    setHistoryFailed(false);

    room.on(RoomEvent.Timeline, schedule);
    room.on(RoomEvent.TimelineReset, onReset);
    room.on(RoomEvent.LocalEchoUpdated, schedule);
    room.on(RoomEvent.Redaction, schedule);
    room.on(RoomStateEvent.Update, onStateChanged);
    client.on(MatrixEventEvent.Decrypted, onEventChanged);
    client.on(MatrixEventEvent.Replaced, onEventChanged);

    return () => {
      alive = false;
      epochRef.current += 1;
      setReady(false);
      room.off(RoomEvent.Timeline, schedule);
      room.off(RoomEvent.TimelineReset, onReset);
      room.off(RoomEvent.LocalEchoUpdated, schedule);
      room.off(RoomEvent.Redaction, schedule);
      room.off(RoomStateEvent.Update, onStateChanged);
      client.off(MatrixEventEvent.Decrypted, onEventChanged);
      client.off(MatrixEventEvent.Replaced, onEventChanged);
    };
  }, [client, room]);

  const loadOlder = useCallback((): boolean => {
    if (!client || !room || loadingRef.current) return false;
    const timeline = room.getLiveTimeline();
    if (timeline.getPaginationToken(Direction.Backward) === null) {
      setHasMoreHistory(false);
      return false;
    }

    const epoch = epochRef.current;
    loadingRef.current = true;
    setIsLoadingHistory(true);
    client.paginateEventTimeline(timeline, { backwards: true, limit: PAGE_SIZE }).then(
      (more) => {
        if (epoch !== epochRef.current) return;
        loadingRef.current = false;
        setIsLoadingHistory(false);
        setHistoryFailed(false);
        setHasMoreHistory(more && timeline.getPaginationToken(Direction.Backward) !== null);
      },
      () => {
        if (epoch !== epochRef.current) return;
        loadingRef.current = false;
        setIsLoadingHistory(false);
        setHistoryFailed(true);
      }
    );
    return true;
  }, [client, room]);

  return { view, ready, hasMoreHistory, isLoadingHistory, historyFailed, resets, stateVersion, loadOlder };
};