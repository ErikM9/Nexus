import AxeBuilder from '@axe-core/playwright';
import { test, expect } from './support/fixtures';
import { BOB, CAROL, ME } from './support/homeserver';

/* A room where I am the admin and Bob a moderator, so members other than me exist to act on */
const staffed = (hs: import('./support/homeserver').FakeHomeserver) =>
  hs.addRoom({ name: 'Team', members: [BOB, CAROL], powerLevels: { users: { [ME]: 100, [BOB]: 50 }, users_default: 0, state_default: 50, ban: 50, kick: 50, redact: 50, invite: 0 } });

test.describe('Renaming a room', () => {
  test('renames the room and shows the new name in the header and the list', async ({ nexus, hs, page }) => {
    const room = hs.addRoom({ name: 'Old Name' });
    await nexus.open();
    await nexus.openRoom('Old Name');

    await page.getByRole('button', { name: 'Rename room' }).click();
    await page.getByPlaceholder('New name').fill('New Name');
    await page.getByRole('button', { name: 'Save rename' }).click();

    await expect(nexus.roomTitle).toHaveText('New Name');
    await expect(nexus.room('New Name')).toBeVisible();
    await expect.poll(() => hs.roomState(room, 'm.room.name')?.name).toBe('New Name');
  });

  test('offers renaming as soon as the room lets members rename it', async ({ nexus, hs, page }) => {
    const levels = { users: { [BOB]: 100 }, users_default: 0, state_default: 50 };
    const room = hs.addRoom({ name: 'Locked', members: [BOB], powerLevels: levels });
    await nexus.open();
    await nexus.openRoom('Locked');
    await expect(page.getByRole('button', { name: 'Rename room' })).toHaveCount(0);

    hs.setState(room, BOB, 'm.room.power_levels', '', { ...levels, events: { 'm.room.name': 0 } });

    await expect(page.getByRole('button', { name: 'Rename room' })).toBeVisible();
  });

  test('keeps a rename started in one room out of the next room', async ({ nexus, hs, page }) => {
    hs.addRoom({ name: 'Alpha' });
    hs.addRoom({ name: 'Beta' });
    await nexus.open();
    await nexus.openRoom('Alpha');
    await page.getByRole('button', { name: 'Rename room' }).click();
    await page.getByPlaceholder('New name').fill('Renamed');

    await nexus.openRoom('Beta');

    await expect(page.getByPlaceholder('New name')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Rename room' })).toBeVisible();
    expect(hs.requestsTo(/\/state\/m\.room\.name/, 'PUT')).toHaveLength(0);
  });
});

test.describe('Room privacy and encryption', () => {
  test('turns a private room public and back', async ({ nexus, hs, page }) => {
    const room = hs.addRoom({ name: 'General' });
    await nexus.open();
    await nexus.openRoom('General');

    await nexus.openRoomSettings();
    await expect(page.getByText('Private', { exact: true })).toBeVisible();
    await page.getByRole('menuitem', { name: 'Make Public' }).click();
    await expect.poll(() => hs.roomState(room, 'm.room.join_rules')?.join_rule).toBe('public');
    await expect(page.getByRole('heading', { level: 3 })).toContainText('🌍');

    await page.getByRole('menuitem', { name: 'Make Private' }).click();
    await expect.poll(() => hs.roomState(room, 'm.room.join_rules')?.join_rule).toBe('invite');
  });

  test('Make Public lists the room in the room directory', async ({ nexus, hs, page }) => {
    const room = hs.addRoom({ name: 'Garden Club' });
    await nexus.open();
    await nexus.openRoom('Garden Club');

    await nexus.openRoomSettings();
    await page.getByRole('menuitem', { name: 'Make Public' }).click();
    await expect.poll(() => hs.requestsTo(/\/directory\/list\/room\//, 'PUT').map((r) => r.body)).toEqual([{ visibility: 'public' }]);
    await page.keyboard.press('Escape');
    await nexus.joinToggle.click();
    await nexus.joinSearch.fill('Garden');

    await expect(nexus.joinResults).toHaveCount(1);
    await expect(nexus.joinResults.first()).toContainText(room);
  });

  test('Make Private takes the room out of the room directory', async ({ nexus, hs, page }) => {
    const room = hs.addRoom({ name: 'Garden Club', isPublic: true, publishToDirectory: true });
    await nexus.open();
    await nexus.openRoom('Garden Club');

    await nexus.openRoomSettings();
    await page.getByRole('menuitem', { name: 'Make Private' }).click();
    await expect.poll(() => hs.roomState(room, 'm.room.join_rules')?.join_rule).toBe('invite');
    await page.keyboard.press('Escape');
    await nexus.joinToggle.click();
    await nexus.joinSearch.fill('Garden');

    await expect(page.getByText('No results')).toBeVisible();
    expect(hs.requestsTo(/\/directory\/list\/room\//, 'PUT').map((r) => r.body)).toEqual([{ visibility: 'private' }]);
  });

  test('turns on encryption, which then cannot be turned off', async ({ nexus, hs, page }) => {
    const room = hs.addRoom({ name: 'General' });
    await nexus.open();
    await nexus.openRoom('General');

    await nexus.openRoomSettings();
    await expect(page.getByText('Not encrypted')).toBeVisible();
    await page.getByRole('menuitem', { name: 'Enable Encryption' }).click();

    await expect.poll(() => hs.roomState(room, 'm.room.encryption')?.algorithm).toBe('m.megolm.v1.aes-sha2');
    await expect(page.getByText('Encryption cannot be disabled once enabled.')).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Enable Encryption' })).toHaveCount(0);
  });

  test('reports a privacy change the server refuses and keeps the room out of the directory', async ({ nexus, hs, page }) => {
    hs.addRoom({ name: 'General' });
    hs.failNext(/\/state\/m\.room\.join_rules/, 403, { errcode: 'M_FORBIDDEN', error: 'Not allowed' });
    await nexus.open();
    await nexus.openRoom('General');

    const menu = await nexus.openRoomSettings();
    await page.getByRole('menuitem', { name: 'Make Public' }).click();

    await expect(page.getByText('Could not make the room public')).toBeVisible();
    await expect(menu.getByText('Private', { exact: true })).toBeVisible();
    expect(hs.requestsTo(/\/directory\/list\/room\//, 'PUT')).toHaveLength(0);
  });

  test('changes privacy and encryption with the keyboard only', async ({ nexus, hs, page }) => {
    const room = hs.addRoom({ name: 'General' });
    await nexus.open();
    await nexus.openRoom('General');
    await page.getByRole('button', { name: 'Room settings' }).focus();

    await page.keyboard.press('Enter');
    await expect(page.getByRole('menuitem', { name: 'Make Public' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect.poll(() => hs.roomState(room, 'm.room.join_rules')?.join_rule).toBe('public');
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('menuitem', { name: 'Enable Encryption' })).toBeFocused();
    await page.keyboard.press('Enter');

    await expect.poll(() => hs.roomState(room, 'm.room.encryption')?.algorithm).toBe('m.megolm.v1.aes-sha2');
    await expect(page.getByRole('menuitem', { name: 'Make Private' })).toBeVisible();
  });
});

test.describe('Members', () => {
  test('lists every joined member with their role and power level', async ({ nexus, hs }) => {
    staffed(hs);
    await nexus.open();
    await nexus.openRoom('Team');

    const menu = await nexus.openMembers();

    await expect(menu.getByRole('menuitem')).toHaveText([`${ME}Admin · PL: 100`, `${BOB}Moderator · PL: 50`, `${CAROL}Member · PL: 0`]);
  });

  test('kicks a member after confirming', async ({ nexus, hs, page }) => {
    const room = staffed(hs);
    await nexus.open();
    await nexus.openRoom('Team');

    const menu = await nexus.openMembers();
    await menu.getByText(CAROL).click();
    await page.getByRole('menuitem', { name: 'Kick' }).click();

    await expect(nexus.dialog).toHaveAccessibleName('Kick member');
    await expect(nexus.dialog).toContainText(CAROL);
    await nexus.dialog.getByRole('button', { name: 'Kick' }).click();

    await expect.poll(() => hs.membership(room, CAROL)).toBe('leave');
    expect(hs.requestsTo(/\/kick$/, 'POST')[0].body).toMatchObject({ user_id: CAROL });
  });

  test('bans a member after confirming', async ({ nexus, hs, page }) => {
    const room = staffed(hs);
    await nexus.open();
    await nexus.openRoom('Team');

    const menu = await nexus.openMembers();
    await menu.getByText(CAROL).click();
    await page.getByRole('menuitem', { name: 'Ban', exact: true }).click();

    await expect(nexus.dialog).toHaveAccessibleName('Ban member');
    await nexus.dialog.getByRole('button', { name: 'Ban' }).click();

    await expect.poll(() => hs.membership(room, CAROL)).toBe('ban');
  });

  test('changes a member role after confirming', async ({ nexus, hs, page }) => {
    const room = staffed(hs);
    await nexus.open();
    await nexus.openRoom('Team');

    const menu = await nexus.openMembers();
    await menu.getByText(CAROL).click();
    await page.getByRole('menuitem', { name: 'Role', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Moderator', exact: true }).click();

    await expect(nexus.dialog).toHaveAccessibleName('Change role');
    await expect(nexus.dialog).toContainText('Moderator');
    await nexus.dialog.getByRole('button', { name: 'Confirm' }).click();

    await expect.poll(() => hs.roomState(room, 'm.room.power_levels')?.users?.[CAROL]).toBe(50);
  });

  test('offers Leave rather than Kick on my own row', async ({ nexus, hs, page }) => {
    const room = staffed(hs);
    await nexus.open();
    await nexus.openRoom('Team');

    const menu = await nexus.openMembers();
    await menu.getByText(ME, { exact: true }).click();
    const leave = page.getByRole('menuitem', { name: 'Leave', exact: true });
    await expect(leave).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Kick' })).toHaveCount(0);
    await leave.click();
    await nexus.dialog.getByRole('button', { name: 'Leave' }).click();

    await expect(nexus.emptyState).toBeVisible();
    await expect.poll(() => hs.membership(room, ME)).toBe('leave');
  });

  test('kicks a member with the keyboard only, returning focus to Members afterwards', async ({ nexus, hs, page }) => {
    const room = staffed(hs);
    await nexus.open();
    await nexus.openRoom('Team');
    const members = page.getByRole('button', { name: 'Members' });
    await members.focus();

    /* Radix moves focus between menu items on the next task, so each key waits for the focus it should produce */
    await page.keyboard.press('Enter');
    await expect(page.getByRole('menuitem', { name: new RegExp(ME) })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('menuitem', { name: new RegExp(BOB) })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('menuitem', { name: new RegExp(CAROL) })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('menuitem', { name: 'Role' })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('menuitem', { name: 'Kick' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(nexus.dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(nexus.dialog.getByRole('button', { name: 'Kick' })).toBeFocused();
    await page.keyboard.press('Enter');

    await expect.poll(() => hs.membership(room, CAROL)).toBe('leave');
    await expect(nexus.dialog).toHaveCount(0);
    await expect(members).toBeFocused();
  });

  test('changes a member role with the keyboard only', async ({ nexus, hs, page }) => {
    const room = staffed(hs);
    await nexus.open();
    await nexus.openRoom('Team');
    await page.getByRole('button', { name: 'Members' }).focus();

    /* Radix moves focus between menu items on the next task, so each key waits for the focus it should produce */
    await page.keyboard.press('Enter');
    await expect(page.getByRole('menuitem', { name: new RegExp(ME) })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('menuitem', { name: new RegExp(BOB) })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('menuitem', { name: new RegExp(CAROL) })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('menuitem', { name: 'Role' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('menuitem', { name: 'Explain roles' })).toBeFocused();
    for (const role of ['Spectator', 'Member', 'Moderator']) {
      await page.keyboard.press('ArrowDown');
      await expect(page.getByRole('menuitem', { name: role, exact: true })).toBeFocused();
    }
    await page.keyboard.press('Enter');
    await expect(nexus.dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Enter');

    await expect.poll(() => hs.roomState(room, 'm.room.power_levels')?.users?.[CAROL]).toBe(50);
  });

  test('holds only menu items in the member actions menu', { tag: '@a11y' }, async ({ nexus, hs, page }) => {
    staffed(hs);
    await nexus.open();
    await nexus.openRoom('Team');
    const menu = await nexus.openMembers();
    await menu.getByText(CAROL).click();
    await expect(page.getByRole('menuitem', { name: 'Kick' })).toBeVisible();

    const { violations } = await new AxeBuilder({ page })
      /* AxeBuilder scopes by CSS selector only, and the open dropdown is the element with the menu role */
      .include('[role="menu"]')
      .withTags(['wcag2a', 'wcag2aa'])
      /* Colour contrast follows the app's own palette, as in the other axe scans */
      .disableRules(['color-contrast'])
      .analyze();

    expect(violations.map((v) => v.id)).toEqual([]);
  });

  test('shows why a refused kick failed and offers to try again', async ({ nexus, hs, page }) => {
    hs.addRoom({ name: 'Team', members: [BOB, CAROL], powerLevels: { users: { [ME]: 100 }, users_default: 0, state_default: 50, kick: 50, ban: 50 } });
    hs.failNext(/\/kick$/, 403, { errcode: 'M_FORBIDDEN', error: 'Cannot remove this user' });
    await nexus.open();
    await nexus.openRoom('Team');
    const menu = await nexus.openMembers();
    await menu.getByText(CAROL).click();
    await page.getByRole('menuitem', { name: 'Kick' }).click();

    await nexus.dialog.getByRole('button', { name: 'Kick' }).click();

    await expect(nexus.dialog.getByRole('alert')).toHaveText(new RegExp(`Failed to kick ${CAROL}.*Cannot remove this user`));
    await expect(nexus.dialog.getByRole('button', { name: 'Kick' })).toBeEnabled();
  });
});

test.describe('Device security', () => {
  test('lists an unverified device of another member in the Security section', async ({ nexus, hs }) => {
    hs.addDevice(BOB, 'BOBPHONE');
    hs.addRoom({ name: 'Secret Garden', members: [BOB], encrypted: true });
    await nexus.open();
    await nexus.openRoom('Secret Garden');

    const menu = await nexus.openMembers();

    await expect(menu.getByText('Security', { exact: true })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: /^Verify / })).toHaveText([`Verify ${BOB} · BOBPHONE`]);
  });

  test('Verify sends the verification request to that member\'s device', async ({ nexus, hs }) => {
    hs.addDevice(BOB, 'BOBPHONE');
    hs.addRoom({ name: 'Secret Garden', members: [BOB], encrypted: true });
    await nexus.open();
    await nexus.openRoom('Secret Garden');
    const menu = await nexus.openMembers();

    await menu.getByRole('menuitem', { name: `Verify ${BOB} · BOBPHONE` }).click();

    await expect
      .poll(() => hs.requestsTo(/\/sendToDevice\/m\.key\.verification\.request\//, 'PUT').map((r) => Object.keys(r.body?.messages?.[BOB] ?? {})))
      .toEqual([['BOBPHONE']]);
  });
});