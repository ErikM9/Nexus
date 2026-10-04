import { test, expect } from './support/fixtures';
import { BOB, ME, PASSWORD } from './support/homeserver';

test.describe('Room invitations', () => {
  test('shows an invitation that arrives while I am online, from the right person', async ({ nexus, hs, page }) => {
    const room = hs.inviteMe({ from: BOB, name: 'Book Club' });
    hs.addRoom({ name: 'General' });
    await nexus.open();

    await expect(page.getByText('Room invitation').first()).toBeVisible();
    await expect(page.getByText('Book Club')).toBeVisible();
    await expect(page.locator('body')).toContainText(BOB);

    await page.getByRole('button', { name: 'Open', exact: true }).click();
    await page.getByRole('button', { name: 'Accept' }).click();
    await expect(nexus.room('Book Club')).toBeVisible();
    expect(hs.membership(room, ME)).toBe('join');
  });

  test('opens the invitation and accepts it, which adds the room', { tag: '@smoke' }, async ({ nexus, hs, page }) => {
    const room = hs.inviteMe({ from: BOB, name: 'Book Club' });
    hs.say(room, BOB, 'Welcome!');
    await nexus.open();

    await page.getByRole('button', { name: 'Open', exact: true }).click();
    await expect(page.getByText('You have been invited to')).toBeVisible();
    await page.getByRole('button', { name: 'Accept' }).click();

    await expect(page.getByText('Joined room')).toBeVisible();
    await expect(page.getByText('You have been invited to')).toHaveCount(0);
    await expect(nexus.room('Book Club')).toBeVisible();
    expect(hs.membership(room, ME)).toBe('join');
  });

  test('declines an invitation, which leaves the room without joining', async ({ nexus, hs, page }) => {
    const room = hs.inviteMe({ from: BOB, name: 'Spam Room' });
    await nexus.open();

    await page.getByRole('button', { name: 'Open', exact: true }).click();
    await page.getByRole('button', { name: 'Decline' }).click();

    await expect(page.getByText('Invite declined')).toBeVisible();
    await expect(nexus.room('Spam Room')).toHaveCount(0);
    expect(hs.membership(room, ME)).toBe('leave');
  });

  test('dismisses the toast without joining or leaving', async ({ nexus, hs, page }) => {
    const room = hs.inviteMe({ from: BOB, name: 'Later Maybe' });
    await nexus.open();

    await page.getByRole('button', { name: 'Dismiss' }).click();

    await expect(page.getByText('Room invitation')).toHaveCount(0);
    expect(hs.membership(room, ME)).toBe('invite');
  });

  test('reports an invitation that fails to accept and keeps it', async ({ nexus, hs, page }) => {
    const room = hs.inviteMe({ from: BOB, name: 'Broken' });
    hs.failNext(/\/join\//, 500, { errcode: 'M_UNKNOWN', error: 'Try later' });
    await nexus.open();

    await page.getByRole('button', { name: 'Open', exact: true }).click();
    await page.getByRole('button', { name: 'Accept' }).click();

    await expect(page.getByText('Failed to join room')).toBeVisible();
    expect(hs.membership(room, ME)).toBe('invite');
  });

  test('drops invitations from the previous session when I sign out', { tag: '@regression' }, async ({ nexus, hs, page }) => {
    await hs.mockAppApi(page);
    const room = hs.inviteMe({ from: BOB, name: 'Book Club' });
    await nexus.open();
    await expect(page.getByText('Room invitation')).toBeVisible();
    await page.getByRole('button', { name: 'Logout' }).click();
    await expect(page).toHaveURL(/\/auth$/);
    hs.setState(room, BOB, 'm.room.member', ME, { membership: 'leave', reason: 'Invite withdrawn' });

    await nexus.signIn('alice', PASSWORD);
    await nexus.waitUntilReady();

    await expect(page.getByText('Room invitation')).toHaveCount(0);
  });
});