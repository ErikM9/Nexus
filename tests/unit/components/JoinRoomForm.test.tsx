import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import toast from 'react-hot-toast';
import { MatrixError, Room } from 'matrix-js-sdk';
import JoinRoomForm, { parseJoinTarget } from '@/app/app-components/JoinRoomForm';
import { HS, ME, makeClient } from '../support/matrixRoom';

const JOINED_ID = `!joined:${HS}`;

/* A real client whose join request resolves with the Room the SDK builds before sync delivers the room's state */
const setup = () => {
  const client = makeClient();
  const joinRoom = vi.spyOn(client, 'joinRoom').mockImplementation(async () => new Room(JOINED_ID, client, ME));
  const onJoined = vi.fn();
  render(<JoinRoomForm client={client} onJoined={onJoined} />);
  return { client, joinRoom, onJoined, input: screen.getByPlaceholderText('Search by name or enter ID') };
};

describe('parseJoinTarget', () => {
  it.each([
    [`#books:${HS}`, { kind: 'alias', value: `#books:${HS}` }],
    ['#books:[::1]:8448', { kind: 'alias', value: '#books:[::1]:8448' }],
    [`  !abc:${HS}  `, { kind: 'id', value: `!abc:${HS}` }],
    ['!OpaqueRoomIdWithoutServer', { kind: 'id', value: '!OpaqueRoomIdWithoutServer' }],
  ])('reads %s as a join target', (input, expected) => {
    expect(parseJoinTarget(input)).toEqual(expected);
  });

  it.each(['#books', '#books:', '#two words:hs.test', '!abc:bad host', 'books'])('rejects %s', (input) => {
    expect(parseJoinTarget(input)).toBeNull();
  });
});

describe('JoinRoomForm', () => {
  it('joins by alias and opens the room the server resolved it to', async () => {
    const { joinRoom, onJoined, input } = setup();

    await userEvent.type(input, `#books:${HS}`);
    await userEvent.click(screen.getByRole('button', { name: 'Join' }));

    await waitFor(() => expect(onJoined).toHaveBeenCalledWith(JOINED_ID, { name: `#books:${HS}` }));
    expect(joinRoom).toHaveBeenCalledWith(`#books:${HS}`);
  });

  it.each([
    ['an alias', `#nowhere:${HS}`, `No room found at #nowhere:${HS}`],
    ['a room ID', `!nowhere:${HS}`, `No room found with the ID !nowhere:${HS}`],
  ])('explains %s that leads to no room', async (_kind, address, explanation) => {
    const { joinRoom, onJoined, input } = setup();
    joinRoom.mockRejectedValue(new MatrixError({ errcode: 'M_NOT_FOUND', error: 'Room not found' }, 404));

    await userEvent.type(input, address);
    await userEvent.click(screen.getByRole('button', { name: 'Join' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(explanation);
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(onJoined).not.toHaveBeenCalled();
  });

  it.each([
    ['alias', '#books', 'Enter the full address, like #room:server'],
    ['room ID', '!books:', 'Enter the full room ID, like !abc:server'],
  ])('asks for the rest of an incomplete %s without contacting the server', async (_kind, address, request) => {
    const { joinRoom, input } = setup();

    await userEvent.type(input, `${address}{Enter}`);

    expect(await screen.findByRole('alert')).toHaveTextContent(request);
    expect(joinRoom).not.toHaveBeenCalled();
  });

  it('joins once however often Enter and Join are pressed while the request is on its way', async () => {
    const { joinRoom, input } = setup();
    joinRoom.mockReturnValue(new Promise(() => {}));
    await userEvent.type(input, `#books:${HS}{Enter}`);

    await userEvent.type(input, '{Enter}');
    await userEvent.click(screen.getByRole('button', { name: 'Join' }));

    expect(joinRoom).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Join' })).toBeDisabled();
  });

  it('reports a join the server refused and lets the user try again', async () => {
    const { joinRoom, onJoined, input } = setup();
    joinRoom.mockRejectedValueOnce(new MatrixError({ errcode: 'M_FORBIDDEN', error: 'You are not invited to this room' }, 403));
    await userEvent.type(input, `!private:${HS}{Enter}`);
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Failed to join room'));

    await userEvent.click(screen.getByRole('button', { name: 'Join' }));

    await waitFor(() => expect(onJoined).toHaveBeenCalledWith(JOINED_ID, { name: `!private:${HS}` }));
  });
});

/* A promise the test settles by hand, standing in for a directory response that is still on its way */
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

const directoryPage = (rooms: { room_id: string; name: string }[]) => ({
  chunk: rooms.map((room) => ({ ...room, num_joined_members: 1, world_readable: false, guest_can_join: false })),
});

describe('JoinRoomForm directory search', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('says No results once a search finds nothing', async () => {
    const { client, input } = setup();
    vi.spyOn(client, 'publicRooms').mockResolvedValue(directoryPage([]));

    await userEvent.type(input, 'gardening');

    expect(await screen.findByText('No results')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Join' })).toBeDisabled();
  });

  it('ignores the answer to an older search that arrives after the latest one', async () => {
    const { client, input } = setup();
    const older = deferred<ReturnType<typeof directoryPage>>();
    const latest = deferred<ReturnType<typeof directoryPage>>();
    const publicRooms = vi.spyOn(client, 'publicRooms').mockReturnValueOnce(older.promise).mockReturnValueOnce(latest.promise);
    await userEvent.type(input, 'garden{Enter}');
    await waitFor(() => expect(publicRooms).toHaveBeenCalledTimes(1));
    await userEvent.type(input, 'ing{Enter}');
    await waitFor(() => expect(publicRooms).toHaveBeenCalledTimes(2));

    latest.resolve(directoryPage([]));
    await screen.findByText('No results');
    await act(async () => {
      older.resolve(directoryPage([{ room_id: `!garden:${HS}`, name: 'Garden Club' }]));
      await older.promise;
    });

    expect(screen.getByText('No results')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Garden Club/ })).not.toBeInTheDocument();
  });

  it('sends no directory search for a room address', async () => {
    const { client, input } = setup();
    const publicRooms = vi.spyOn(client, 'publicRooms');
    vi.useFakeTimers({ shouldAdvanceTime: true });

    await userEvent.type(input, `#books:${HS}`);
    await act(() => vi.advanceTimersByTimeAsync(1_000));

    expect(publicRooms).not.toHaveBeenCalled();
  });

  it('joins the room typed after a result was picked, not the picked one', async () => {
    const { client, joinRoom, input } = setup();
    vi.spyOn(client, 'publicRooms').mockResolvedValue(directoryPage([{ room_id: `!book:${HS}`, name: 'Book Club' }]));
    await userEvent.type(input, 'book');
    await userEvent.click(await screen.findByRole('button', { name: /Book Club/ }));

    await userEvent.clear(input);
    await userEvent.type(input, `!chess:${HS}{Enter}`);

    expect(joinRoom).toHaveBeenCalledTimes(1);
    expect(joinRoom).toHaveBeenCalledWith(`!chess:${HS}`);
  });

  it('moves from the search box into the results with the arrow keys and picks one with Enter', async () => {
    const { client, input } = setup();
    vi.spyOn(client, 'publicRooms').mockResolvedValue(
      directoryPage([
        { room_id: `!book:${HS}`, name: 'Book Club' },
        { room_id: `!books:${HS}`, name: 'Bookshop' },
      ])
    );
    await userEvent.type(input, 'book');
    const results = await screen.findAllByRole('button', { name: /Book/ });

    await userEvent.keyboard('{ArrowDown}');
    expect(results[0]).toHaveFocus();
    await userEvent.keyboard('{ArrowDown}{Enter}');

    expect(input).toHaveValue(`!books:${HS}`);
    expect(input).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Join' })).toBeEnabled();
  });

  it('returns from the first result to the search box with ArrowUp', async () => {
    const { client, input } = setup();
    vi.spyOn(client, 'publicRooms').mockResolvedValue(directoryPage([{ room_id: `!book:${HS}`, name: 'Book Club' }]));
    await userEvent.type(input, 'book');
    await screen.findByRole('button', { name: /Book Club/ });
    await userEvent.keyboard('{ArrowDown}');

    await userEvent.keyboard('{ArrowUp}');

    expect(input).toHaveFocus();
  });

  it('closes the results with Escape', async () => {
    const { client, input } = setup();
    vi.spyOn(client, 'publicRooms').mockResolvedValue(directoryPage([{ room_id: `!book:${HS}`, name: 'Book Club' }]));
    await userEvent.type(input, 'book');
    await screen.findByRole('button', { name: /Book Club/ });

    await userEvent.keyboard('{Escape}');

    expect(screen.queryByRole('button', { name: /Book Club/ })).not.toBeInTheDocument();
  });

  it('closes the results with Escape pressed on a result and returns to the search box', async () => {
    const { client, input } = setup();
    vi.spyOn(client, 'publicRooms').mockResolvedValue(directoryPage([{ room_id: `!book:${HS}`, name: 'Book Club' }]));
    await userEvent.type(input, 'book');
    await screen.findByRole('button', { name: /Book Club/ });
    await userEvent.keyboard('{ArrowDown}');

    await userEvent.keyboard('{Escape}');

    expect(screen.queryByRole('button', { name: /Book Club/ })).not.toBeInTheDocument();
    expect(input).toHaveFocus();
  });
});

describe('JoinRoomForm with an input method editor', () => {
  it('leaves Enter that confirms a composition to the composition', async () => {
    const { joinRoom, input } = setup();
    await userEvent.type(input, `#books:${HS}`);

    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 });

    expect(joinRoom).not.toHaveBeenCalled();
  });
});