import { describe, it, expect, vi, beforeEach, afterEach, onTestFinished, type MockInstance } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import toast from 'react-hot-toast';
import { EventType, KnownMembership, MatrixError, type MatrixClient, type Room } from 'matrix-js-sdk';
import { BOB, CAROL, ME, makeClient, makeRoom, setState } from '../support/matrixRoom';

const mocks = vi.hoisted(() => ({ client: null as MatrixClient | null }));

vi.mock('@/app/utils/matrix', () => ({
  getMatrixClient: () => {
    if (!mocks.client) throw new Error('Matrix client is not initialized');
    return mocks.client;
  },
}));

import RoomInviteOverlay from '@/app/app-components/RoomInviteOverlay';

/* A room the client's user has been invited to, delivered the way sync delivers a new invitation */
const invitation = (client: MatrixClient, name: string, from = BOB, roomId?: string) =>
  makeRoom(client, { roomId, name, creator: from, myMembership: KnownMembership.Invite });

/* The inviter takes the invitation back, which sync delivers as a leave in the invited user's member event */
const withdraw = (room: Room) =>
  setState(room, EventType.RoomMember, { membership: KnownMembership.Leave }, { stateKey: ME, sender: BOB });

/* The toast's line of details, which reads room, inviter and age */
const announcement = () => screen.getByText(/ago$/);

/* The backdrop has no role or label of its own, so it is found as the sibling the dialog panel sits on */
const backdrop = () => screen.getByRole('button', { name: 'Close' }).parentElement!.previousElementSibling!;

const refusal = () => new MatrixError({ errcode: 'M_UNKNOWN', error: 'Try again later' }, 500);

/* Records every event of one type that reaches the window until the test ends */
const eventsOnWindow = (type: string) => {
  const events: Event[] = [];
  const record = (event: Event) => events.push(event);
  window.addEventListener(type, record);
  onTestFinished(() => window.removeEventListener(type, record));
  return events;
};

/* A promise the test settles by hand, standing in for a request the homeserver has not answered yet */
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const signOut = () =>
  act(() => {
    mocks.client = null;
    window.__matrix_ready = false;
    window.dispatchEvent(new Event('matrix-not-ready'));
  });

const signIn = (client: MatrixClient) =>
  act(() => {
    mocks.client = client;
    window.__matrix_ready = true;
    window.dispatchEvent(new Event('matrix-ready'));
  });

/* The two answers to an invitation, with the client request each one sends and what the homeserver returns for it */
const ANSWERS = {
  Accept: {
    request: (client: MatrixClient): MockInstance => vi.spyOn(client, 'joinRoom'),
    granted: (room: Room): unknown => room,
    done: 'Joined room',
    failed: 'Failed to join room',
  },
  Decline: {
    request: (client: MatrixClient): MockInstance => vi.spyOn(client, 'leave'),
    granted: (): unknown => ({}),
    done: 'Invite declined',
    failed: 'Failed to decline invite',
  },
};

type Answer = keyof typeof ANSWERS;

describe('RoomInviteOverlay', () => {
  let client: MatrixClient;

  beforeEach(() => {
    client = makeClient();
    mocks.client = client;
    window.__matrix_ready = true;
  });

  afterEach(() => {
    mocks.client = null;
    vi.useRealTimers();
  });

  describe('announcing invitations', () => {
    it('shows nothing while no invitation is waiting', async () => {
      await makeRoom(client, { name: 'General' });

      render(<RoomInviteOverlay />);

      expect(screen.queryByText('Room invitation')).not.toBeInTheDocument();
    });

    it('announces an invitation that was waiting before the app started, with its room and inviter', async () => {
      await invitation(client, 'Book Club', CAROL);

      render(<RoomInviteOverlay />);

      expect(announcement()).toHaveTextContent(`Book Club · from ${CAROL}`);
    });

    it('announces an invitation that arrives while the app is running, by the name of its room', async () => {
      render(<RoomInviteOverlay />);

      await act(async () => {
        await invitation(client, 'Book Club');
      });

      expect(announcement()).toHaveTextContent(`Book Club · from ${BOB}`);
    });

    it('announces nothing before the client is ready', async () => {
      await invitation(client, 'Book Club');
      window.__matrix_ready = false;

      render(<RoomInviteOverlay />);

      expect(screen.queryByText('Room invitation')).not.toBeInTheDocument();
    });

    it('announces waiting invitations once the client becomes ready', async () => {
      await invitation(client, 'Book Club');
      window.__matrix_ready = false;
      render(<RoomInviteOverlay />);

      signIn(client);

      expect(announcement()).toHaveTextContent('Book Club');
    });

    it('takes the announcement back when the inviter withdraws the invitation', async () => {
      const room = await invitation(client, 'Book Club');
      render(<RoomInviteOverlay />);

      await act(() => withdraw(room));

      expect(screen.queryByText('Room invitation')).not.toBeInTheDocument();
    });
  });

  describe('with two invitations waiting', () => {
    /* The clock moves on between the two, as their order is the order in which the app noticed them */
    const twoInvitations = async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      const first = await invitation(client, 'Book Club');
      render(<RoomInviteOverlay />);
      vi.setSystemTime(Date.now() + 60_000);
      await act(async () => {
        await invitation(client, 'Chess Club', CAROL);
      });
      return first;
    };

    it('announces the one it noticed first', async () => {
      await twoInvitations();

      expect(announcement()).toHaveTextContent(`Book Club · from ${BOB} · 1m ago`);
    });

    it.each([
      [
        'dismissed',
        async () => {
          await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
        },
      ],
      [
        'accepted',
        async (first: Room) => {
          vi.spyOn(client, 'joinRoom').mockResolvedValue(first);
          await userEvent.click(screen.getByRole('button', { name: 'Open' }));
          await userEvent.click(screen.getByRole('button', { name: 'Accept' }));
        },
      ],
      [
        'declined',
        async () => {
          vi.spyOn(client, 'leave').mockResolvedValue({});
          await userEvent.click(screen.getByRole('button', { name: 'Open' }));
          await userEvent.click(screen.getByRole('button', { name: 'Decline' }));
        },
      ],
      [
        'withdrawn while its dialog is open',
        async (first: Room) => {
          await userEvent.click(screen.getByRole('button', { name: 'Open' }));
          await act(() => withdraw(first));
        },
      ],
    ])('announces the next one once the first is %s', async (_outcome, settleFirst) => {
      const first = await twoInvitations();

      await settleFirst(first);

      expect(announcement()).toHaveTextContent(`Chess Club · from ${CAROL}`);
    });
  });

  describe('the invitation dialog', () => {
    const openDialog = async () => {
      const room = await invitation(client, 'Book Club');
      render(<RoomInviteOverlay />);
      await userEvent.click(screen.getByRole('button', { name: 'Open' }));
      return room;
    };

    it('names the room and the inviter and takes the place of the toast', async () => {
      await openDialog();

      expect(screen.getByText(/^You have been invited to/)).toHaveTextContent('You have been invited to Book Club');
      expect(screen.getByText(/^by/)).toHaveTextContent(`by ${BOB}`);
      expect(screen.queryByRole('button', { name: 'Dismiss' })).not.toBeInTheDocument();
    });

    it.each([
      ['the close button', () => userEvent.click(screen.getByRole('button', { name: 'Close' }))],
      ['a press on the backdrop', () => userEvent.click(backdrop())],
    ])('closes on %s without answering and announces the invitation again', async (_way, close) => {
      const accept = vi.spyOn(client, 'joinRoom');
      const decline = vi.spyOn(client, 'leave');
      await openDialog();

      await close();

      expect(screen.queryByRole('button', { name: 'Accept' })).not.toBeInTheDocument();
      expect(announcement()).toHaveTextContent('Book Club');
      expect(accept).not.toHaveBeenCalled();
      expect(decline).not.toHaveBeenCalled();
    });

    describe.each(Object.keys(ANSWERS) as Answer[])('%s', (answer) => {
      const { request, granted, done, failed } = ANSWERS[answer];

      it('sends the answer for that room, says so and closes for good', async () => {
        const sent = request(client);
        const room = await openDialog();
        sent.mockResolvedValue(granted(room));

        await userEvent.click(screen.getByRole('button', { name: answer }));

        expect(sent).toHaveBeenCalledWith(room.roomId);
        expect(toast.success).toHaveBeenCalledWith(done);
        expect(screen.queryByText('Room invitation')).not.toBeInTheDocument();
      });

      it('disables both answers while the homeserver has not replied', async () => {
        request(client).mockReturnValue(new Promise(() => {}));
        await openDialog();

        await userEvent.click(screen.getByRole('button', { name: answer }));

        expect(screen.getByRole('button', { name: 'Accept' })).toBeDisabled();
        expect(screen.getByRole('button', { name: 'Decline' })).toBeDisabled();
      });

      it('reports a refusal and stays open for another answer', async () => {
        request(client).mockRejectedValue(refusal());
        await openDialog();

        await userEvent.click(screen.getByRole('button', { name: answer }));

        expect(toast.error).toHaveBeenCalledWith(failed);
        expect(toast.success).not.toHaveBeenCalled();
        expect(screen.getByRole('button', { name: 'Accept' })).toBeEnabled();
        expect(screen.getByRole('button', { name: 'Decline' })).toBeEnabled();
      });
    });

    it('tells the rest of the app when an invitation is accepted', async () => {
      const accepted = eventsOnWindow('matrix-invite-accepted');
      const join = vi.spyOn(client, 'joinRoom');
      const room = await openDialog();
      join.mockResolvedValue(room);

      await userEvent.click(screen.getByRole('button', { name: 'Accept' }));

      expect(accepted).toHaveLength(1);
    });
  });

  describe('across sign-out and sign-in', () => {
    it("announces the next account's invitations and none of the previous session's", async () => {
      await invitation(client, 'Book Club');
      render(<RoomInviteOverlay />);
      const carol = makeClient(CAROL);
      await invitation(carol, 'Chess Club');

      signOut();
      signIn(carol);

      expect(announcement()).toHaveTextContent('Chess Club');
      expect(screen.queryByText('Book Club')).not.toBeInTheDocument();
    });

    it("closes a dialog left open at sign-out, so the next account's invitations are announced", async () => {
      await invitation(client, 'Book Club');
      render(<RoomInviteOverlay />);
      await userEvent.click(screen.getByRole('button', { name: 'Open' }));
      const carol = makeClient(CAROL);
      await invitation(carol, 'Chess Club');

      signOut();
      signIn(carol);

      expect(screen.queryByRole('button', { name: 'Accept' })).not.toBeInTheDocument();
      expect(announcement()).toHaveTextContent('Chess Club');
    });

    it("ignores an invitation the previous session's client still delivers as the session ends", async () => {
      render(<RoomInviteOverlay />);

      /* The old client delivers before React has re-rendered, while the overlay still listens to it */
      await act(async () => {
        mocks.client = null;
        window.__matrix_ready = false;
        window.dispatchEvent(new Event('matrix-not-ready'));
        await invitation(client, 'Book Club');
      });
      signIn(makeClient(CAROL));

      expect(screen.queryByText('Room invitation')).not.toBeInTheDocument();
    });

    describe.each(Object.keys(ANSWERS) as Answer[])('with %s still on its way at sign-out', (answer) => {
      const { request, granted } = ANSWERS[answer];

      /* The same account signs in again and finds the same invitation, while the first session's answer is still on its way */
      const answerThenSignInAgain = async () => {
        const reply = deferred<unknown>();
        request(client).mockReturnValue(reply.promise);
        const room = await invitation(client, 'Book Club');
        render(<RoomInviteOverlay />);
        await userEvent.click(screen.getByRole('button', { name: 'Open' }));
        await userEvent.click(screen.getByRole('button', { name: answer }));
        const next = makeClient();
        await invitation(next, 'Book Club', BOB, room.roomId);
        signOut();
        signIn(next);
        return { reply, room, next };
      };

      it('says nothing and keeps the invitation of the new session when the answer succeeds late', async () => {
        const { reply, room } = await answerThenSignInAgain();

        await act(async () => {
          reply.resolve(granted(room));
          await reply.promise;
        });

        expect(toast.success).not.toHaveBeenCalled();
        expect(announcement()).toHaveTextContent('Book Club');
      });

      it('says nothing when the answer fails late', async () => {
        const { reply } = await answerThenSignInAgain();

        await act(async () => {
          reply.reject(refusal());
          await reply.promise.catch(() => {});
        });

        expect(toast.error).not.toHaveBeenCalled();
      });

      it('lets the new session answer its invitation straight away', async () => {
        await answerThenSignInAgain();

        await userEvent.click(screen.getByRole('button', { name: 'Open' }));

        expect(screen.getByRole('button', { name: 'Accept' })).toBeEnabled();
        expect(screen.getByRole('button', { name: 'Decline' })).toBeEnabled();
      });

      it("keeps the new session's own answer in progress when the earlier one is replied to", async () => {
        const { reply, room, next } = await answerThenSignInAgain();
        request(next).mockReturnValue(new Promise(() => {}));
        await userEvent.click(screen.getByRole('button', { name: 'Open' }));
        await userEvent.click(screen.getByRole('button', { name: answer }));

        await act(async () => {
          reply.resolve(granted(room));
          await reply.promise;
        });

        expect(screen.getByRole('button', { name: answer })).toBeDisabled();
      });
    });
  });
});