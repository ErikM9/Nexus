import { test, expect } from './support/fixtures';
import { BOB, CAROL, ME, SERVER_NAME } from './support/homeserver';

test.describe('Room list', () => {
  test('lists every joined room with a badge for its privacy and encryption', async ({ nexus, hs }) => {
    hs.addRoom({ name: 'Town Square', isPublic: true });
    hs.addRoom({ name: 'Open Vault', isPublic: true, encrypted: true });
    hs.addRoom({ name: 'Back Office' });
    hs.addRoom({ name: 'Safe House', encrypted: true });

    await nexus.open();

    const expected: [string, string, boolean][] = [
      ['Town Square', '🌍', false],
      ['Open Vault', '🛡️', true],
      ['Back Office', '🔒', false],
      ['Safe House', '🔐', true],
    ];
    for (const [name, badge, encrypted] of expected) {
      const row = nexus.room(name);
      await expect(row, name).toHaveAccessibleName(encrypted ? `${name}, encrypted` : name);
      await expect(row.getByTestId('encryption-badge'), name).toHaveText(badge);
    }
    await expect(nexus.rooms).toHaveCount(4);
  });

  test('shows the empty state until a room is picked, then opens it', async ({ nexus, hs }) => {
    const general = hs.addRoom({ name: 'General', members: [BOB] });
    hs.say(general, BOB, 'Morning all');

    await nexus.open();
    await expect(nexus.emptyState).toBeVisible();
    await expect(nexus.log).toHaveCount(0);

    await nexus.openRoom('General');
    await expect(nexus.emptyState).toHaveCount(0);
    await expect(nexus.message('Morning all')).toBeVisible();
    await expect(nexus.messageInput).toHaveAttribute('placeholder', 'Type a message');
  });

  test('puts the room with the latest activity first and reorders when a message arrives', async ({ nexus, hs }) => {
    const older = hs.addRoom({ name: 'Older', members: [BOB] });
    hs.addRoom({ name: 'Newer', members: [BOB] });

    await nexus.open();
    await expect(nexus.rooms).toHaveText([/Newer/, /Older/]);

    hs.say(older, BOB, 'Anyone here?');
    await expect(nexus.rooms).toHaveText([/Older/, /Newer/]);
  });

  test('keeps an upgraded room listed until I join its replacement', async ({ nexus, hs }) => {
    const old = hs.addRoom({ name: 'Project' });
    const replacement = hs.addRemoteRoom({ name: 'Project v2', creationContent: { predecessor: { room_id: old } } });
    hs.setState(old, BOB, 'm.room.tombstone', '', { body: 'This room has been replaced', replacement_room: replacement });

    await nexus.open();

    await expect(nexus.rooms).toHaveText([/Project/]);
  });

  test('adds a room that someone else creates for me and drops a room I am removed from', async ({ nexus, hs }) => {
    const book = hs.addRoom({ name: 'Book Club', members: [BOB] });
    await nexus.open();
    await expect(nexus.room('Book Club')).toBeVisible();

    hs.addRoom({ name: 'Late Arrival' });
    await expect(nexus.room('Late Arrival')).toBeVisible();

    hs.setState(book, BOB, 'm.room.member', ME, { membership: 'leave', reason: 'Removed' });
    await expect(nexus.room('Book Club')).toHaveCount(0);
  });

  test('closes the open chat when I am removed from that room', async ({ nexus, hs }) => {
    const book = hs.addRoom({ name: 'Book Club', members: [BOB], powerLevels: { users: { [BOB]: 100 }, users_default: 0 } });
    await nexus.open();
    await nexus.openRoom('Book Club');

    hs.setState(book, BOB, 'm.room.member', ME, { membership: 'ban', reason: 'Spam' });

    await expect(nexus.emptyState).toBeVisible();
    await expect(nexus.room('Book Club')).toHaveCount(0);
  });
});

test.describe('Creating rooms', () => {
  const types = [
    { name: 'public unencrypted', label: '🌍 Public (Unencrypted)', preset: 'public_chat', encrypted: false, badge: '🌍' },
    { name: 'public encrypted', label: '🛡️ Public (Encrypted)', preset: 'public_chat', encrypted: true, badge: '🛡️' },
    { name: 'private unencrypted', label: '🔒 Private (Unencrypted)', preset: 'private_chat', encrypted: false, badge: '🔒' },
    { name: 'private encrypted', label: '🔐 Private (Encrypted)', preset: 'private_chat', encrypted: true, badge: '🔐' },
  ];

  for (const type of types) {
    test(`creates a ${type.name} room and opens it`, { tag: '@smoke' }, async ({ nexus, hs, page }) => {
      await nexus.open();

      await nexus.createRoom('Project X', type.label);

      await expect(page.getByText('Room created!')).toBeVisible();
      await expect(nexus.roomTitle).toHaveText('Project X');
      await expect(nexus.room('Project X').getByTestId('encryption-badge')).toHaveText(type.badge);

      const [request] = hs.requestsTo(/\/createRoom$/, 'POST');
      expect(request.body).toMatchObject({ name: 'Project X', preset: type.preset });
      const initialState = (request.body?.initial_state ?? []) as { type: string; content: unknown }[];
      expect(initialState.filter((s) => s.type === 'm.room.encryption')).toEqual(
        type.encrypted ? [{ type: 'm.room.encryption', state_key: '', content: { algorithm: 'm.megolm.v1.aes-sha2' } }] : []
      );

      await expect(nexus.newRoomName).toHaveValue('');
      await expect(nexus.roomType).toHaveText('🌍 Public (Unencrypted)');
    });
  }

  test('keeps Create disabled until the room has a name', async ({ nexus }) => {
    await nexus.open();

    await expect(nexus.createButton).toBeDisabled();
    await nexus.newRoomName.fill('   ');
    await expect(nexus.createButton).toBeDisabled();
    await nexus.newRoomName.fill('Ideas');
    await expect(nexus.createButton).toBeEnabled();
  });

  test('reports a failed create and keeps the typed name', async ({ nexus, hs, page }) => {
    hs.failNext(/\/createRoom$/, 403, { errcode: 'M_FORBIDDEN', error: 'You are not allowed to create rooms' });
    await nexus.open();

    await nexus.createRoom('Ideas');

    await expect(page.getByText('Failed to create room')).toBeVisible();
    await expect(nexus.newRoomName).toHaveValue('Ideas');
    await expect(nexus.emptyState).toBeVisible();
  });

  test('lists a room created as public in the room directory', async ({ nexus, hs }) => {
    await nexus.open();
    await nexus.createRoom('Book Club', '🌍 Public (Unencrypted)');
    await expect(nexus.roomTitle).toHaveText('Book Club');

    await nexus.joinToggle.click();
    await nexus.joinSearch.fill('Book');

    await expect(nexus.joinResults).toHaveText([/Book Club/]);
    expect(hs.requestsTo(/\/createRoom$/, 'POST')[0].body).toMatchObject({ preset: 'public_chat', visibility: 'public' });
  });

  test('keeps a room created as private out of the room directory', async ({ nexus, hs, page }) => {
    await nexus.open();
    await nexus.createRoom('Book Club', '🔒 Private (Unencrypted)');
    await expect(nexus.roomTitle).toHaveText('Book Club');

    await nexus.joinToggle.click();
    await nexus.joinSearch.fill('Book');

    await expect(page.getByText('No results')).toBeVisible();
    expect(hs.requestsTo(/\/createRoom$/, 'POST')[0].body).toMatchObject({ preset: 'private_chat', visibility: 'private' });
  });
});

test.describe('Joining rooms', () => {
  test('finds a public room by name, joins it and opens it', { tag: '@smoke' }, async ({ nexus, hs, page }) => {
    const club = hs.addRemoteRoom({ name: 'Book Club', publishToDirectory: true, members: [CAROL] });
    hs.say(club, BOB, 'Welcome, new members!');
    await nexus.open();

    await nexus.joinToggle.click();
    await expect(page.getByText('Join a public room by searching for its name or entering its room ID.')).toBeVisible();
    await expect(nexus.joinButton).toBeDisabled();
    await nexus.joinSearch.fill('book');

    const result = nexus.joinResults.filter({ hasText: club });
    await expect(result).toContainText('Book Club');
    await result.click();
    await expect(nexus.joinSearch).toHaveValue(club);
    await nexus.joinButton.click();

    await expect(page.getByText('Joined room')).toBeVisible();
    await expect(nexus.roomTitle).toHaveText('Book Club');
    await expect(nexus.message('Welcome, new members!')).toBeVisible();
    await expect(nexus.room('Book Club')).toBeVisible();
    expect(hs.membership(club, ME)).toBe('join');
  });

  test('orders search results as exact name, then names that start with the term, then the rest', async ({ nexus, hs }) => {
    for (const name of ['Club Chess', 'Chess Club', 'Anti Chess', 'Chess']) hs.addRemoteRoom({ name, publishToDirectory: true });
    await nexus.open();

    await nexus.joinToggle.click();
    await nexus.joinSearch.fill('chess');

    await expect(nexus.joinResults).toHaveText([/^🌍Chess!remote/, /^🌍Chess Club!remote/, /^🌍Anti Chess!remote/, /^🌍Club Chess!remote/]);
  });

  test('reports a search the server rejects', async ({ nexus, hs, page }) => {
    hs.failNext(/\/publicRooms$/, 500, { errcode: 'M_UNKNOWN', error: 'Directory unavailable' });
    await nexus.open();

    await nexus.joinToggle.click();
    await nexus.joinSearch.fill('book');

    await expect(page.getByText('Search failed')).toBeVisible();
  });

  test('joins a room by its ID with the Enter key', async ({ nexus, hs, page }) => {
    const hidden = hs.addRemoteRoom({ name: 'Hidden Garden' });
    hs.say(hidden, BOB, 'You found us');
    await nexus.open();

    await nexus.joinToggle.click();
    await nexus.joinSearch.fill(hidden);
    await expect(nexus.joinButton).toBeEnabled();
    await nexus.joinSearch.press('Enter');

    await expect(page.getByText('Joined room')).toBeVisible();
    await expect(nexus.room('Hidden Garden')).toBeVisible();
    await expect(nexus.message('You found us')).toBeVisible();
    expect(hs.requestsTo(/\/join\//, 'POST').map((r) => r.path)).toEqual([`/_matrix/client/v3/join/${hidden}`]);
  });

  test('reports a room the server will not let me join', async ({ nexus, hs, page }) => {
    const privateRoom = hs.addRemoteRoom({ name: 'Staff Only', isPublic: false });
    await nexus.open();

    await nexus.joinToggle.click();
    await nexus.joinSearch.fill(privateRoom);
    await nexus.joinButton.click();

    await expect(page.getByText('Failed to join room')).toBeVisible();
    expect(hs.membership(privateRoom, ME)).toBeUndefined();
    await expect(nexus.room('Staff Only')).toHaveCount(0);
  });

  test('joins a room by its alias and opens it with its history, header and composer working', async ({ nexus, hs, page }) => {
    const club = hs.addRemoteRoom({ name: 'Book Club', alias: `#books:${SERVER_NAME}` });
    hs.say(club, BOB, 'Chapter one starts tonight');
    await nexus.open();

    await nexus.joinToggle.click();
    await nexus.joinSearch.fill(`#books:${SERVER_NAME}`);
    await nexus.joinButton.click();
    await expect(page.getByText('Joined room')).toBeVisible();
    await expect(nexus.message('Chapter one starts tonight')).toBeVisible();
    await nexus.send('Count me in');

    await expect(nexus.roomTitle).toHaveText('Book Club');
    await expect(page.getByRole('heading', { level: 3 })).toContainText('🌍');
    await expect(nexus.room('Book Club')).toHaveAttribute('aria-current', 'true');
    await expect.poll(() => hs.sentEvents(club, 'm.room.message').map((e) => e.content.body)).toEqual(['Count me in']);
    expect(hs.requestsTo(/\/join\//, 'POST').map((r) => r.path)).toEqual([`/_matrix/client/v3/join/#books:${SERVER_NAME}`]);
  });
});

test.describe('Room menu', () => {
  test('Copy Room ID puts the room ID on the clipboard', async ({ nexus, hs, page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const general = hs.addRoom({ name: 'General' });
    await nexus.open();

    await nexus.roomMenu('General', 'Copy Room ID');

    await expect(page.getByText('Room ID copied!')).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(general);
  });

  test('Send Invite invites someone by their Matrix ID', async ({ nexus, hs, page }) => {
    const general = hs.addRoom({ name: 'General', members: [BOB] });
    await nexus.open();

    await nexus.roomMenu('General', 'Send Invite');
    await expect(page.getByText('Invite someone')).toBeVisible();
    const invite = page.getByRole('button', { name: 'Invite', exact: true });
    await expect(invite).toBeDisabled();

    await page.getByPlaceholder('@user:matrix.org').fill(`  ${CAROL}  `);
    await invite.click();

    await expect(page.getByText('Invited!')).toBeVisible();
    await expect(page.getByText('Invite someone')).toHaveCount(0);
    expect(hs.membership(general, CAROL)).toBe('invite');
    expect(hs.requestsTo(/\/invite$/, 'POST')[0].body).toEqual({ user_id: CAROL });
  });

  test('a refused invite keeps the dialog open with an error', async ({ nexus, hs, page }) => {
    hs.addRoom({ name: 'General' });
    hs.failNext(/\/invite$/, 403, { errcode: 'M_FORBIDDEN', error: 'User is banned' });
    await nexus.open();

    await nexus.roomMenu('General', 'Send Invite');
    await page.getByPlaceholder('@user:matrix.org').fill(CAROL);
    await page.getByPlaceholder('@user:matrix.org').press('Enter');

    await expect(page.getByText('Invite failed')).toBeVisible();
    await expect(page.getByText('Invite someone')).toBeVisible();

    await page.getByRole('button', { name: 'Close' }).click();
    await expect(page.getByText('Invite someone')).toHaveCount(0);
  });

  test('hides Send Invite without the power level to invite', async ({ nexus, hs, page }) => {
    hs.addRoom({ name: 'Announcements', powerLevels: { users: { [BOB]: 100 }, users_default: 0, invite: 50 } });
    await nexus.open();

    await page.getByRole('button', { name: 'Open menu for Announcements' }).click();
    const menu = page.getByRole('menu', { name: 'Actions for Announcements' });
    await expect(menu.getByRole('menuitem')).toHaveText(['Copy Room ID', 'Leave Room']);
  });

  test('offers Send Invite to a plain member when the room sets no invite level', async ({ nexus, hs, page }) => {
    hs.addRoom({ name: 'Open Door', members: [BOB], powerLevels: { users: { [BOB]: 100 }, users_default: 0 } });
    await nexus.open();

    await page.getByRole('button', { name: 'Open menu for Open Door' }).click();

    const menu = page.getByRole('menu', { name: 'Actions for Open Door' });
    await expect(menu.getByRole('menuitem')).toHaveText(['Send Invite', 'Copy Room ID', 'Leave Room']);
  });

  test('Leave Room asks first, and leaves only after confirming', async ({ nexus, hs, page }) => {
    const general = hs.addRoom({ name: 'General', members: [BOB] });
    await nexus.open();

    await nexus.roomMenu('General', 'Leave Room');
    await expect(nexus.dialog).toHaveAccessibleName('Leave room');
    await expect(nexus.dialog).toContainText('Leave General? You can rejoin later');
    await nexus.dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(nexus.dialog).toHaveCount(0);
    expect(hs.membership(general, ME)).toBe('join');

    await nexus.roomMenu('General', 'Leave Room');
    await nexus.dialog.getByRole('button', { name: 'Leave' }).click();

    await expect(page.getByText('Left room')).toBeVisible();
    await expect(nexus.room('General')).toHaveCount(0);
    expect(hs.membership(general, ME)).toBe('leave');
  });

  test('waits for the server before taking a left room off the list', async ({ nexus, hs, page }) => {
    hs.addRoom({ name: 'General' });
    hs.delay(/\/leave$/, 1_500);
    await nexus.open();

    await nexus.roomMenu('General', 'Leave Room');
    await nexus.dialog.getByRole('button', { name: 'Leave' }).click();

    await expect(nexus.dialog.getByRole('button', { name: 'Please wait…' })).toBeDisabled();
    await expect(nexus.room('General')).toBeVisible();
    await expect(page.getByText('Left room')).toBeVisible();
    await expect(nexus.room('General')).toHaveCount(0);
  });

  test('keeps the open chat when another room is left from the sidebar', async ({ nexus, hs, page }) => {
    const general = hs.addRoom({ name: 'General', members: [BOB] });
    hs.say(general, BOB, 'Still here');
    hs.addRoom({ name: 'Old Project' });
    await nexus.open();
    await nexus.openRoom('General');

    await nexus.roomMenu('Old Project', 'Leave Room');
    await nexus.dialog.getByRole('button', { name: 'Leave' }).click();
    await expect(page.getByText('Left room')).toBeVisible();

    await expect(nexus.room('Old Project')).toHaveCount(0);
    await expect(nexus.roomTitle).toHaveText('General');
    await expect(nexus.message('Still here')).toBeVisible();
  });

  test('closes the chat when the open room is left from the sidebar', async ({ nexus, hs, page }) => {
    hs.addRoom({ name: 'General' });
    await nexus.open();
    await nexus.openRoom('General');

    await nexus.roomMenu('General', 'Leave Room');
    await nexus.dialog.getByRole('button', { name: 'Leave' }).click();

    await expect(page.getByText('Left room')).toBeVisible();
    await expect(nexus.emptyState).toBeVisible();
  });
});

test.describe('Room options in the header', () => {
  test('Leave Room leaves the open room after confirming, closing the chat and taking the room off the list', async ({ nexus, hs, page }) => {
    const general = hs.addRoom({ name: 'General', members: [BOB] });
    await nexus.open();
    await nexus.openRoom('General');

    await nexus.roomOptions('General', 'Leave Room');
    await expect(nexus.dialog).toContainText('Leave General? You can rejoin later');
    await nexus.dialog.getByRole('button', { name: 'Leave' }).click();

    await expect(page.getByText('Left room')).toBeVisible();
    await expect(nexus.emptyState).toBeVisible();
    await expect(nexus.room('General')).toHaveCount(0);
    expect(hs.membership(general, ME)).toBe('leave');
  });
});

test.describe('Room list keyboard and accessibility', () => {
  test('opens a room from the list with Tab and Enter', async ({ nexus, hs, page }) => {
    const general = hs.addRoom({ name: 'General', members: [BOB] });
    hs.say(general, BOB, 'Hello keyboard');
    await nexus.open();
    await nexus.roomType.focus();

    await page.keyboard.press('Tab');
    await expect(nexus.room('General')).toBeFocused();
    await page.keyboard.press('Enter');

    await expect(nexus.roomTitle).toHaveText('General');
    await expect(nexus.message('Hello keyboard')).toBeVisible();
    await expect(nexus.room('General')).toHaveAttribute('aria-current', 'true');
  });

  test('opens a room menu with the keyboard and closes it with Escape', async ({ nexus, hs, page }) => {
    hs.addRoom({ name: 'General' });
    await nexus.open();
    const trigger = page.getByRole('button', { name: 'Open menu for General' });
    await nexus.room('General').focus();

    await page.keyboard.press('Tab');
    await expect(trigger).toBeFocused();
    await page.keyboard.press('Enter');
    const menu = page.getByRole('menu', { name: 'Actions for General' });
    await expect(menu.getByRole('menuitem', { name: 'Send Invite' })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(menu.getByRole('menuitem', { name: 'Copy Room ID' })).toBeFocused();
    await page.keyboard.press('Escape');

    await expect(menu).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });
});