import { test, expect } from './support/fixtures';
import { BOB, CAROL, ME } from './support/homeserver';
import { makePng } from './support/images';

const reply = (eventId: string) => ({ 'm.relates_to': { 'm.in_reply_to': { event_id: eventId } } });

test.describe('Reading a room', () => {
  test('shows the history oldest first with each sender', async ({ nexus, hs }) => {
    const room = hs.addRoom({ name: 'General', members: [BOB] });
    hs.say(room, BOB, 'First from Bob');
    hs.say(room, ME, 'Then me');
    hs.say(room, BOB, 'Bob again');

    await nexus.open();
    await nexus.openRoom('General');

    await expect(nexus.messages).toHaveCount(3);
    await expect(nexus.messages.nth(0)).toContainText('First from Bob');
    await expect(nexus.messages.nth(1)).toContainText('Then me');
    await expect(nexus.messages.nth(2)).toContainText('Bob again');
    await expect(nexus.messages.nth(0)).toHaveAccessibleName(`Message from ${BOB}`);
    await expect(nexus.messages.nth(1)).toHaveAccessibleName(`Message from ${ME}`);
  });

  test('invites the first message in an empty room', async ({ nexus, hs }) => {
    hs.addRoom({ name: 'Quiet' });
    await nexus.open();
    await nexus.openRoom('Quiet');

    await expect(nexus.log.getByText('No messages yet. Start the conversation!')).toBeVisible();
  });

  test('shows messages from others as they arrive', { tag: '@smoke' }, async ({ nexus, hs }) => {
    const room = hs.addRoom({ name: 'General', members: [BOB, CAROL] });
    await nexus.open();
    await nexus.openRoom('General');

    hs.say(room, BOB, 'Live one');
    hs.say(room, CAROL, 'Live two');

    await expect(nexus.messages).toHaveText([/Live one/, /Live two/]);
  });

  test('loads older messages when scrolled to the top until the beginning of the room', async ({ nexus, hs }) => {
    const room = hs.addRoom({ name: 'Archive', members: [BOB] });
    /* Each body ends with a full stop so no number can run into the time printed after it */
    for (let i = 1; i <= 45; i++) hs.say(room, BOB, `Message ${i}.`);
    await nexus.open();
    await nexus.openRoom('Archive');

    await expect(nexus.message('Message 45.')).toBeVisible();
    await expect(nexus.message('Message 1.')).toHaveCount(0);

    await expect(async () => {
      await nexus.scrollToTop();
      await expect(nexus.log.getByText('Beginning of conversation')).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 20_000 });
    await expect(nexus.messages).toHaveCount(45);
    await expect(nexus.messages.first()).toContainText('Message 1.');
    expect(hs.requestsTo(/\/messages$/).length).toBeGreaterThan(0);
  });

  test('catches up after a gap in the sync and still reaches every older message in order', { tag: '@regression' }, async ({ nexus, hs }) => {
    const room = hs.addRoom({ name: 'Archive', members: [BOB] });
    for (let i = 1; i <= 30; i++) hs.say(room, BOB, `Message ${i}.`);
    await nexus.open();
    await nexus.openRoom('Archive');
    await expect(nexus.message('Message 30.')).toBeVisible();

    /* More new events than the sync timeline limit arrive before the next sync, which makes that sync limited (gappy) */
    for (let i = 31; i <= 55; i++) hs.say(room, BOB, `Message ${i}.`);
    await expect(nexus.message('Message 55.')).toBeVisible();

    await expect(async () => {
      await nexus.scrollToTop();
      await expect(nexus.log.getByText('Beginning of conversation')).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 30_000 });
    const shownNumbers = async () =>
      (await nexus.messages.allTextContents()).map((text) => Number(/Message (\d+)\./.exec(text)?.[1]));
    await expect.poll(shownNumbers).toEqual(Array.from({ length: 55 }, (_, i) => i + 1));
  });

  test('loads older messages when a gap in the sync brings only reactions', { tag: '@regression' }, async ({ nexus, hs }) => {
    const room = hs.addRoom({ name: 'Archive', members: [BOB, CAROL] });
    for (let i = 1; i <= 5; i++) hs.say(room, BOB, `Message ${i}.`);
    const target = hs.say(room, BOB, 'Vote here.');
    await nexus.open();
    await nexus.openRoom('Archive');
    await expect(nexus.message('Vote here.')).toBeVisible();

    /* A burst of reactions larger than the sync timeline limit makes a gappy sync whose events hold no message at all */
    for (let i = 0; i < 25; i++) {
      hs.post(room, i % 2 ? BOB : CAROL, 'm.reaction', { 'm.relates_to': { rel_type: 'm.annotation', event_id: target, key: '👍' } });
    }

    await expect(nexus.message('Vote here.').getByTestId('reaction-badge')).toHaveAccessibleName('👍 reaction, 2 people');
    await expect(nexus.message('Message 1.')).toBeVisible();
    await expect(nexus.log.getByText('No messages yet. Start the conversation!')).toHaveCount(0);
  });

  test('stops the input in a room where only moderators may speak', async ({ nexus, hs }) => {
    hs.addRoom({ name: 'Announcements', powerLevels: { users: { [BOB]: 100 }, users_default: 0, events_default: 50 } });
    await nexus.open();
    await nexus.openRoom('Announcements');

    await expect(nexus.messageInput).toHaveAttribute('placeholder', 'You cannot send messages in this room');
    await expect(nexus.messageInput).toBeDisabled();
    await expect(nexus.sendButton).toBeDisabled();
  });
});

test.describe('Date separators', () => {
  test.use({ timezoneId: 'Europe/London', locale: 'en-GB' });

  test('labels today, yesterday, this week and older days', async ({ nexus, hs, page }) => {
    await page.clock.install({ time: new Date('2026-06-12T12:00:00+01:00') });
    await page.clock.resume();
    const room = hs.addRoom({ name: 'General', members: [BOB] });
    hs.setClock(new Date('2026-05-01T10:00:00+01:00').getTime());
    hs.say(room, BOB, 'Last month');
    hs.setClock(new Date('2026-06-08T10:00:00+01:00').getTime());
    hs.say(room, BOB, 'On Monday');
    hs.setClock(new Date('2026-06-11T10:00:00+01:00').getTime());
    hs.say(room, BOB, 'Yesterday morning');
    hs.setClock(new Date('2026-06-12T09:00:00+01:00').getTime());
    hs.say(room, BOB, 'This morning');
    hs.say(room, BOB, 'Same day, no new separator');

    await nexus.open();
    await nexus.openRoom('General');

    await expect(nexus.log.getByRole('separator')).toHaveText(['1 May', 'Monday', 'Yesterday', 'Today']);
  });

  test('keeps day labels right in the week after the clocks go forward', { tag: '@regression' }, async ({ nexus, hs, page }) => {
    await page.clock.install({ time: new Date('2026-03-30T12:00:00+01:00') });
    await page.clock.resume();
    const room = hs.addRoom({ name: 'General', members: [BOB] });
    hs.setClock(new Date('2026-03-28T12:00:00Z').getTime());
    hs.say(room, BOB, 'Saturday');
    hs.setClock(new Date('2026-03-29T12:00:00+01:00').getTime());
    hs.say(room, BOB, 'Sunday, after the change');
    hs.setClock(new Date('2026-03-30T09:00:00+01:00').getTime());
    hs.say(room, BOB, 'Monday');

    await nexus.open();
    await nexus.openRoom('General');

    await expect(nexus.log.getByRole('separator')).toHaveText(['Saturday', 'Yesterday', 'Today']);
  });
});

test.describe('Sending messages', () => {
  test('sends with Enter or the Send button and clears the input', { tag: '@smoke' }, async ({ nexus, hs }) => {
    const room = hs.addRoom({ name: 'General', members: [BOB] });
    await nexus.open();
    await nexus.openRoom('General');

    await nexus.send('  Hello there  ');
    await expect(nexus.message('Hello there')).toBeVisible();
    await expect(nexus.messageInput).toHaveValue('');

    await nexus.messageInput.fill('Second one');
    await nexus.sendButton.click();
    await expect(nexus.message('Second one')).toBeVisible();

    await expect.poll(() => hs.sentEvents(room, 'm.room.message').map((e) => e.content)).toEqual([
      { msgtype: 'm.text', body: 'Hello there' },
      { msgtype: 'm.text', body: 'Second one' },
    ]);
  });

  test('does not send an empty or blank message', async ({ nexus, hs }) => {
    hs.addRoom({ name: 'General' });
    await nexus.open();
    await nexus.openRoom('General');

    await nexus.messageInput.press('Enter');
    await nexus.messageInput.fill('    ');
    await nexus.messageInput.press('Enter');
    await nexus.sendButton.click();

    await expect(nexus.log.getByText('No messages yet. Start the conversation!')).toBeVisible();
    expect(hs.requestsTo(/\/send\//)).toHaveLength(0);
  });

  test('marks a message as sending until the server confirms it', async ({ nexus, hs }) => {
    hs.addRoom({ name: 'General' });
    hs.delay(/\/send\/m\.room\.message\//, 1_500);
    await nexus.open();
    await nexus.openRoom('General');

    await nexus.send('Slow network');

    const message = nexus.message('Slow network');
    await expect(message.getByRole('status')).toHaveText('⏳ Sending…');
    await expect(message.getByRole('status')).toHaveCount(0, { timeout: 5_000 });
    await expect(message.getByRole('alert')).toHaveCount(0);
  });

  test('marks a message the server rejects as failed', async ({ nexus, hs }) => {
    hs.addRoom({ name: 'General' });
    hs.failNext(/\/send\/m\.room\.message\//, 400, { errcode: 'M_UNKNOWN', error: 'Rejected' });
    await nexus.open();
    await nexus.openRoom('General');

    await nexus.send('Doomed');

    await expect(nexus.message('Doomed').getByRole('alert')).toHaveText('⚠️ Failed');
  });

  test('shows a rejected message as failed only and sends it again on Retry', { tag: '@regression' }, async ({ nexus, hs }) => {
    const room = hs.addRoom({ name: 'General' });
    hs.failNext(/\/send\/m\.room\.message\//, 400, { errcode: 'M_UNKNOWN', error: 'Rejected' });
    await nexus.open();
    await nexus.openRoom('General');
    await nexus.send('Doomed');
    const message = nexus.message('Doomed');
    await expect(message.getByRole('alert')).toHaveText('⚠️ Failed');
    await expect(message.getByRole('status')).toHaveCount(0);
    await expect(nexus.messageWrapper('Doomed').getByTestId('message-actions')).toHaveCount(0);

    await message.getByRole('button', { name: 'Retry' }).click();

    await expect.poll(() => hs.sentEvents(room, 'm.room.message').map((e) => e.content.body)).toEqual(['Doomed']);
    await expect(message.getByRole('alert')).toHaveCount(0);
    await expect(nexus.messageWrapper('Doomed').getByTestId('message-actions')).toHaveCount(1);
  });

  test('removes a rejected message on Delete without sending anything', { tag: '@regression' }, async ({ nexus, hs }) => {
    const room = hs.addRoom({ name: 'General' });
    hs.failNext(/\/send\/m\.room\.message\//, 400, { errcode: 'M_UNKNOWN', error: 'Rejected' });
    await nexus.open();
    await nexus.openRoom('General');
    await nexus.send('Doomed');
    await expect(nexus.message('Doomed').getByRole('alert')).toHaveText('⚠️ Failed');

    await nexus.message('Doomed').getByRole('button', { name: 'Delete' }).click();

    await expect(nexus.message('Doomed')).toHaveCount(0);
    await expect(nexus.log.getByText('No messages yet. Start the conversation!')).toBeVisible();
    expect(hs.sentEvents(room)).toHaveLength(0);
    expect(hs.requestsTo(/\/redact\//)).toHaveLength(0);
  });

  test('inserts an emoji from the picker into the draft', async ({ nexus, hs, page }) => {
    hs.addRoom({ name: 'General' });
    await nexus.open();
    await nexus.openRoom('General');

    await nexus.messageInput.fill('Nice');
    await page.getByRole('button', { name: 'Emoji' }).click();
    await page.getByRole('button', { name: '🎉' }).click();

    await expect(nexus.messageInput).toHaveValue('Nice🎉');
    await expect(page.getByRole('button', { name: '🎉' })).toHaveCount(0);

    await page.getByRole('button', { name: 'Emoji' }).click();
    await expect(page.getByRole('button', { name: '🔥' })).toBeVisible();
    await nexus.log.click({ position: { x: 20, y: 20 } });
    await expect(page.getByRole('button', { name: '🔥' })).toHaveCount(0);
  });

  test('keeps a draft typed in another room while a send is still going', { tag: '@regression' }, async ({ nexus, hs, page }) => {
    const first = hs.addRoom({ name: 'First' });
    const second = hs.addRoom({ name: 'Second', members: [BOB] });
    hs.delay(new RegExp(`/rooms/${first}/send/`), 3_000);
    await nexus.open();
    await nexus.openRoom('First');
    const slowSend = page.waitForResponse((r) => decodeURIComponent(r.url()).includes(`/rooms/${first}/send/`));
    await nexus.send('Slow message');

    await nexus.openRoom('Second');
    await nexus.messageInput.fill('Draft for the second room');
    await slowSend;
    /* A message synced after the slow send's response can only render once that response has been handled */
    hs.say(second, BOB, 'Arrived after the send finished');
    await expect(nexus.message('Arrived after the send finished')).toBeVisible();

    await expect(nexus.messageInput).toHaveValue('Draft for the second room');
    await expect(nexus.messageInput).toBeEnabled();
  });
});

test.describe('Replies', () => {
  test('replies to a message with a quote of it', async ({ nexus, hs, page }) => {
    const room = hs.addRoom({ name: 'General', members: [BOB] });
    const original = hs.say(room, BOB, 'Pizza tonight?');
    await nexus.open();
    await nexus.openRoom('General');

    await nexus.messageAction('Pizza tonight?', 'reply');
    const banner = page.getByTestId('reply-banner');
    await expect(banner).toContainText(BOB);
    await expect(banner).toContainText('Pizza tonight?');
    await expect(nexus.messageInput).toBeFocused();

    await nexus.send('Count me in');

    const sent = nexus.message('Count me in');
    await expect(sent.getByTestId('reply-context')).toHaveText(`${BOB}Pizza tonight?`);
    await expect(banner).toHaveCount(0);
    await expect.poll(() => hs.sentEvents(room, 'm.room.message')[0]?.content).toEqual({
      msgtype: 'm.text',
      body: 'Count me in',
      ...reply(original),
    });
  });

  test('cancelling a reply sends a plain message', async ({ nexus, hs, page }) => {
    const room = hs.addRoom({ name: 'General', members: [BOB] });
    hs.say(room, BOB, 'Pizza tonight?');
    await nexus.open();
    await nexus.openRoom('General');

    await nexus.messageAction('Pizza tonight?', 'reply');
    await page.getByRole('button', { name: 'Cancel reply' }).click();
    await expect(page.getByTestId('reply-banner')).toHaveCount(0);
    await nexus.send('Unrelated');

    await expect.poll(() => hs.sentEvents(room, 'm.room.message')[0]?.content).toEqual({ msgtype: 'm.text', body: 'Unrelated' });
  });

  test('shows replies from others with the quoted message', async ({ nexus, hs }) => {
    const room = hs.addRoom({ name: 'General', members: [BOB, CAROL] });
    const question = hs.say(room, BOB, 'Who has the keys?');
    hs.say(room, CAROL, 'I do', reply(question));
    await nexus.open();
    await nexus.openRoom('General');

    await expect(nexus.message('I do').getByTestId('reply-context')).toHaveText(`${BOB}Who has the keys?`);
  });

  test('drops the text of a deleted message from replies that quote it', { tag: '@regression' }, async ({ nexus, hs }) => {
    const room = hs.addRoom({ name: 'General', members: [BOB, CAROL] });
    const secret = hs.say(room, BOB, 'My door code is 4321');
    hs.say(room, CAROL, 'Got it', reply(secret));
    await nexus.open();
    await nexus.openRoom('General');
    await expect(nexus.message('Got it').getByTestId('reply-context')).toContainText('4321');

    hs.redact(room, BOB, secret);
    await expect(nexus.log.getByTestId('deleted-message')).toBeVisible();

    await expect(nexus.message('Got it').getByTestId('reply-context')).not.toContainText('4321', { timeout: 3_000 });
  });

  test('shows the quote of a message deleted before the room was opened as deleted', { tag: '@regression' }, async ({ nexus, hs }) => {
    const room = hs.addRoom({ name: 'General', members: [BOB, CAROL] });
    const secret = hs.say(room, BOB, 'My door code is 4321');
    hs.say(room, CAROL, 'Got it', reply(secret));
    hs.redact(room, BOB, secret);
    await nexus.open();

    await nexus.openRoom('General');

    await expect(nexus.message('Got it').getByTestId('reply-context')).toHaveText(`${BOB}(deleted)`);
  });

  test('keeps the quote when a reply is edited', { tag: '@regression' }, async ({ nexus, hs }) => {
    const room = hs.addRoom({ name: 'General', members: [BOB] });
    hs.say(room, BOB, 'Pizza tonight?');
    await nexus.open();
    await nexus.openRoom('General');
    await nexus.messageAction('Pizza tonight?', 'reply');
    await nexus.send('Count me in');
    await expect(nexus.message('Count me in').getByTestId('reply-context')).toBeVisible();

    await nexus.messageAction('Count me in', 'edit');
    await nexus.page.getByTestId('edit-input').fill('Count me in, with garlic bread');
    await nexus.page.getByTestId('edit-input').press('Enter');
    await expect(nexus.message('with garlic bread')).toBeVisible();

    hs.say(room, BOB, 'Great');
    await expect(nexus.message('Great')).toBeVisible();
    await expect(nexus.message('with garlic bread').getByTestId('reply-context')).toHaveText(`${BOB}Pizza tonight?`, { timeout: 3_000 });
  });
});

test.describe('Editing and deleting', () => {
  test('edits my own message and marks it as edited', async ({ nexus, hs, page }) => {
    const room = hs.addRoom({ name: 'General', members: [BOB] });
    await nexus.open();
    await nexus.openRoom('General');
    await nexus.send('See you at 6');
    await expect.poll(() => hs.sentEvents(room).length).toBe(1);
    const [original] = hs.sentEvents(room);

    await nexus.messageAction('See you at 6', 'edit');
    const editInput = page.getByTestId('edit-input');
    await expect(editInput).toHaveValue('See you at 6');
    await expect(editInput).toBeFocused();
    await editInput.fill('See you at 7');
    await page.getByTestId('edit-save').click();

    const edited = nexus.message('See you at 7');
    await expect(edited.getByTestId('edited-label')).toHaveText('(edited)');
    await expect.poll(() => hs.sentEvents(room, 'm.room.message')[1]?.content).toEqual({
      msgtype: 'm.text',
      body: '* See you at 7',
      'm.new_content': { msgtype: 'm.text', body: 'See you at 7' },
      'm.relates_to': { rel_type: 'm.replace', event_id: original.event_id },
    });
  });

  test('Escape, Cancel or an unchanged text leave the message as it was', async ({ nexus, hs, page }) => {
    const room = hs.addRoom({ name: 'General' });
    await nexus.open();
    await nexus.openRoom('General');
    await nexus.send('Original');
    await expect.poll(() => hs.sentEvents(room).length).toBe(1);

    await nexus.messageAction('Original', 'edit');
    await page.getByTestId('edit-input').fill('Changed my mind');
    await page.getByTestId('edit-input').press('Escape');
    await expect(page.getByTestId('edit-input')).toHaveCount(0);

    await nexus.messageAction('Original', 'edit');
    await page.getByTestId('edit-cancel').click();

    await nexus.messageAction('Original', 'edit');
    await page.getByTestId('edit-input').fill('');
    await expect(page.getByTestId('edit-save')).toBeDisabled();
    await page.getByTestId('edit-input').fill('Original');
    await page.getByTestId('edit-input').press('Enter');
    await expect(page.getByTestId('edit-input')).toHaveCount(0);

    await expect(nexus.message('Original').getByTestId('edited-label')).toHaveCount(0);
    expect(hs.sentEvents(room)).toHaveLength(1);
  });

  test('offers edit only on my own text messages', async ({ nexus, hs }) => {
    const room = hs.addRoom({ name: 'General', members: [BOB] });
    hs.say(room, BOB, 'Bob wrote this');
    hs.say(room, ME, 'I wrote this');
    await nexus.open();
    await nexus.openRoom('General');

    await nexus.messageWrapper('Bob wrote this').hover();
    await expect(nexus.messageWrapper('Bob wrote this').getByTestId('action-edit')).toHaveCount(0);
    await nexus.messageWrapper('I wrote this').hover();
    await expect(nexus.messageWrapper('I wrote this').getByTestId('action-edit')).toBeVisible();
  });

  test('shows edits the author made elsewhere', async ({ nexus, hs }) => {
    const room = hs.addRoom({ name: 'General', members: [BOB] });
    const original = hs.say(room, BOB, 'Meet at the cafe');
    await nexus.open();
    await nexus.openRoom('General');

    hs.say(room, BOB, '* Meet at the library', {
      'm.new_content': { msgtype: 'm.text', body: 'Meet at the library' },
      'm.relates_to': { rel_type: 'm.replace', event_id: original },
    });

    const edited = nexus.message('Meet at the library');
    await expect(edited.getByTestId('edited-label')).toBeVisible();
    await expect(nexus.message('Meet at the cafe')).toHaveCount(0);
    await expect(nexus.messages).toHaveCount(1);
  });

  test('ignores an edit of my message sent by someone else', { tag: '@regression' }, async ({ nexus, hs, page }) => {
    const room = hs.addRoom({ name: 'General', members: [BOB] });
    const mine = hs.say(room, ME, 'I owe Bob £5');
    await nexus.open();
    await nexus.openRoom('General');
    await expect(nexus.message('I owe Bob £5')).toBeVisible();
    await nexus.log.evaluate((el) => {
      const seen: string[] = [];
      (window as unknown as { __forged: string[] }).__forged = seen;
      new MutationObserver(() => {
        if (el.textContent?.includes('£500')) seen.push(el.textContent);
      }).observe(el, { subtree: true, childList: true, characterData: true });
    });

    hs.say(room, BOB, '* I owe Bob £500', {
      'm.new_content': { msgtype: 'm.text', body: 'I owe Bob £500' },
      'm.relates_to': { rel_type: 'm.replace', event_id: mine },
    });
    hs.say(room, BOB, 'Noted');
    await expect(nexus.message('Noted')).toBeVisible();

    expect(await page.evaluate(() => (window as unknown as { __forged: string[] }).__forged.length), 'times the forged text was shown').toBe(0);
    await expect(nexus.messages.first().getByTestId('edited-label')).toHaveCount(0);
  });

  test('ignores an edit of my thread reply sent by someone else', { tag: '@regression' }, async ({ nexus, hs, page }) => {
    const room = hs.addRoom({ name: 'General', members: [BOB] });
    const root = hs.say(room, BOB, 'Who brings chairs?');
    const mine = hs.say(room, ME, 'I can bring 2', { 'm.relates_to': { rel_type: 'm.thread', event_id: root, is_falling_back: true } });
    await nexus.open();
    await nexus.openRoom('General');
    await nexus.messageWrapper('Who brings chairs?').getByTestId('thread-count').click();
    const panel = page.getByTestId('thread-panel');
    await expect(panel.getByTestId('thread-message').last()).toContainText('I can bring 2');

    hs.say(room, BOB, '* I can bring 20', {
      'm.new_content': { msgtype: 'm.text', body: 'I can bring 20' },
      'm.relates_to': { rel_type: 'm.replace', event_id: mine },
    });
    hs.say(room, BOB, 'Noted');
    await expect(nexus.message('Noted')).toBeVisible();

    await expect(panel.getByTestId('thread-message').last()).toContainText('I can bring 2', { timeout: 3_000 });
    await expect(panel.getByTestId('thread-message').last()).not.toContainText('20');
  });

  test('deletes my own message after confirming', async ({ nexus, hs, page }) => {
    const room = hs.addRoom({ name: 'General' });
    await nexus.open();
    await nexus.openRoom('General');
    await nexus.send('Oops, wrong room');
    await expect.poll(() => hs.sentEvents(room).length).toBe(1);
    const [sent] = hs.sentEvents(room);

    await nexus.messageAction('Oops, wrong room', 'delete');
    await expect(page.getByTestId('delete-confirm')).toContainText('Delete this message?');
    await page.getByTestId('delete-cancel').click();
    await expect(page.getByTestId('delete-confirm')).toHaveCount(0);
    expect(hs.requestsTo(/\/redact\//)).toHaveLength(0);

    await nexus.messageAction('Oops, wrong room', 'delete');
    await page.getByTestId('delete-confirm-yes').click();

    await expect(nexus.log.getByTestId('deleted-message')).toHaveText('Message deleted.');
    await expect(nexus.log.getByText('Oops, wrong room')).toHaveCount(0);
    await expect.poll(() => hs.requestsTo(/\/redact\//, 'PUT').map((r) => r.path.match(/\/redact\/([^/]+)\//)?.[1])).toEqual([sent.event_id]);
  });

  test('lets moderators delete messages of others but not plain members', async ({ nexus, hs }) => {
    const modRoom = hs.addRoom({ name: 'Moderated', members: [BOB] });
    hs.say(modRoom, BOB, 'Spam in a room I moderate');
    const plainRoom = hs.addRoom({ name: 'Plain', members: [BOB], powerLevels: { users: { [BOB]: 100 }, users_default: 0, redact: 50 } });
    hs.say(plainRoom, BOB, 'Spam in a room I do not moderate');
    await nexus.open();

    await nexus.openRoom('Moderated');
    await nexus.messageWrapper('Spam in a room I moderate').hover();
    await expect(nexus.messageWrapper('Spam in a room I moderate').getByTestId('action-delete')).toBeVisible();

    await nexus.openRoom('Plain');
    await nexus.messageWrapper('Spam in a room I do not moderate').hover();
    await expect(nexus.messageWrapper('Spam in a room I do not moderate').getByTestId('action-reply')).toBeVisible();
    await expect(nexus.messageWrapper('Spam in a room I do not moderate').getByTestId('action-delete')).toHaveCount(0);
  });

  test('lets the creator of a version 12 room delete other people’s messages', { tag: '@regression' }, async ({ nexus, hs }) => {
    const room = hs.addRoom({
      name: 'Hydra',
      members: [BOB],
      roomVersion: '12',
      powerLevels: { users: { [BOB]: 50 }, users_default: 0, events_default: 0, redact: 50 },
    });
    hs.say(room, BOB, 'Spam in my new room');
    await nexus.open();
    await nexus.openRoom('Hydra');

    await nexus.messageWrapper('Spam in my new room').hover();

    await expect(nexus.messageWrapper('Spam in my new room').getByTestId('action-delete')).toBeVisible();
  });

  test('shows messages deleted elsewhere as deleted', async ({ nexus, hs }) => {
    const room = hs.addRoom({ name: 'General', members: [BOB] });
    const early = hs.say(room, BOB, 'Deleted before I looked');
    hs.redact(room, BOB, early);
    const live = hs.say(room, BOB, 'Deleted while I watch');
    await nexus.open();
    await nexus.openRoom('General');
    await expect(nexus.message('Deleted while I watch')).toBeVisible();

    hs.redact(room, BOB, live);

    await expect(nexus.log.getByTestId('deleted-message')).toHaveCount(2);
    await expect(nexus.log.getByText(/Deleted (before|while)/)).toHaveCount(0);
  });
});

test.describe('Reactions', () => {
  test('adds a reaction from the picker and removes it by clicking the badge', async ({ nexus, hs, page }) => {
    const room = hs.addRoom({ name: 'General', members: [BOB] });
    const target = hs.say(room, BOB, 'Shipped it!');
    await nexus.open();
    await nexus.openRoom('General');

    await nexus.messageAction('Shipped it!', 'react');
    const picker = page.getByTestId('reaction-picker');
    await expect(picker.getByRole('button')).toHaveCount(15);
    await picker.getByRole('button', { name: 'React with 🎉' }).click();

    const badge = nexus.message('Shipped it!').getByTestId('reaction-badge');
    await expect(badge).toHaveAccessibleName('🎉 reaction, 1 person, you reacted');
    await expect(picker).toHaveCount(0);
    await expect.poll(() => hs.sentEvents(room, 'm.reaction').map((e) => e.content)).toEqual([
      { 'm.relates_to': { rel_type: 'm.annotation', event_id: target, key: '🎉' } },
    ]);

    await badge.click();
    await expect(badge).toHaveCount(0);
    await expect.poll(() => hs.requestsTo(/\/redact\//, 'PUT')).toHaveLength(1);
  });

  test('reveals the actions on keyboard focus and reacts from the keyboard', { tag: '@regression' }, async ({ nexus, hs, page }) => {
    const room = hs.addRoom({ name: 'General', members: [BOB] });
    hs.say(room, BOB, 'React to me');
    await nexus.open();
    await nexus.openRoom('General');
    const wrapper = nexus.messageWrapper('React to me');
    const trigger = wrapper.getByRole('button', { name: 'Add reaction' });

    await trigger.focus();
    await expect(wrapper.getByTestId('message-actions')).toHaveCSS('opacity', '1');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('reaction-picker').getByRole('button', { name: 'React with 😀' })).toBeFocused();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');

    await expect.poll(() => hs.sentEvents(room, 'm.reaction').map((e) => e.content['m.relates_to'].key)).toEqual(['😂']);
    await expect(page.getByTestId('reaction-picker')).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });

  test('closes the reaction picker with Escape and returns focus to its button', { tag: '@regression' }, async ({ nexus, hs, page }) => {
    const room = hs.addRoom({ name: 'General', members: [BOB] });
    hs.say(room, BOB, 'React to me');
    await nexus.open();
    await nexus.openRoom('General');
    const trigger = nexus.messageWrapper('React to me').getByRole('button', { name: 'Add reaction' });
    await trigger.focus();
    await page.keyboard.press('Space');
    await expect(page.getByTestId('reaction-picker')).toBeVisible();

    await page.keyboard.press('Escape');

    await expect(page.getByTestId('reaction-picker')).toHaveCount(0);
    await expect(trigger).toBeFocused();
    expect(hs.sentEvents(room, 'm.reaction')).toHaveLength(0);
  });

  test('counts reactions from several people and follows their changes', async ({ nexus, hs }) => {
    const room = hs.addRoom({ name: 'General', members: [BOB, CAROL] });
    const target = hs.say(room, ME, 'New logo is up');
    const annotation = { 'm.relates_to': { rel_type: 'm.annotation', event_id: target, key: '👍' } };
    hs.post(room, BOB, 'm.reaction', annotation);
    await nexus.open();
    await nexus.openRoom('General');

    const badge = nexus.message('New logo is up').getByTestId('reaction-badge');
    await expect(badge).toHaveAccessibleName('👍 reaction, 1 person');

    const carols = hs.post(room, CAROL, 'm.reaction', annotation);
    await expect(badge).toHaveAccessibleName('👍 reaction, 2 people');
    await expect(badge).toHaveText('👍2');

    hs.redact(room, CAROL, carols);
    await expect(badge).toHaveAccessibleName('👍 reaction, 1 person');
  });
});

test.describe('Threads', () => {
  test('opens a thread on a message and replies in it', async ({ nexus, hs, page }) => {
    const room = hs.addRoom({ name: 'General', members: [BOB] });
    const root = hs.say(room, BOB, 'Release planning');
    await nexus.open();
    await nexus.openRoom('General');

    await nexus.messageAction('Release planning', 'thread');
    const panel = page.getByTestId('thread-panel');
    await expect(panel.getByTestId('thread-message')).toHaveCount(1);
    await expect(panel.getByTestId('thread-message').first()).toContainText('Release planning');
    await expect(page.getByTestId('thread-send')).toBeDisabled();

    await page.getByTestId('thread-input').fill('I can take the notes');
    await page.getByTestId('thread-input').press('Enter');

    await expect(panel.getByTestId('thread-message')).toHaveCount(2);
    await expect(panel.getByTestId('thread-message').last()).toContainText('I can take the notes');
    await expect.poll(() => hs.sentEvents(room, 'm.room.message')[0]?.content).toEqual({
      msgtype: 'm.text',
      body: 'I can take the notes',
      'm.relates_to': { rel_type: 'm.thread', event_id: root, is_falling_back: true },
    });

    await page.getByRole('button', { name: 'Close thread' }).click();
    await expect(panel).toHaveCount(0);
    await expect(nexus.messageWrapper('Release planning').getByTestId('thread-count')).toHaveText('1 reply');
    await expect(nexus.message('I can take the notes')).toHaveCount(0);
  });

  test('shows thread replies from others under their root message', async ({ nexus, hs, page }) => {
    const room = hs.addRoom({ name: 'General', members: [BOB, CAROL] });
    const root = hs.say(room, BOB, 'Lunch options');
    const inThread = { 'm.relates_to': { rel_type: 'm.thread', event_id: root, is_falling_back: true } };
    hs.say(room, CAROL, 'Sushi', inThread);
    await nexus.open();
    await nexus.openRoom('General');

    const count = nexus.messageWrapper('Lunch options').getByTestId('thread-count');
    await expect(count).toHaveText('1 reply');
    hs.say(room, BOB, 'Tacos', inThread);
    await expect(count).toHaveText('2 replies');

    await count.click();
    await expect(page.getByTestId('thread-panel').getByTestId('thread-message')).toHaveText([/Lunch options/, /Sushi/, /Tacos/]);
    await expect(nexus.messages).toHaveCount(1);
  });
});

test.describe('Encrypted rooms', () => {
  test('shows my edit and thread reply from encrypted history as such', { tag: '@regression' }, async ({ nexus, hs, page }) => {
    const room = hs.addRoom({ name: 'Vault', encrypted: true, members: [BOB] });
    await nexus.open();
    await nexus.openRoom('Vault');
    await nexus.send('Meet at noon');
    await expect.poll(() => hs.sentEvents(room).length).toBe(1);
    await nexus.messageAction('Meet at noon', 'edit');
    await page.getByTestId('edit-input').fill('Meet at one');
    await page.getByTestId('edit-input').press('Enter');
    await nexus.messageAction('Meet at one', 'thread');
    await page.getByTestId('thread-input').fill('Bring the slides');
    await page.getByTestId('thread-input').press('Enter');
    await expect.poll(() => hs.sentEvents(room).map((e) => e.type)).toEqual(['m.room.encrypted', 'm.room.encrypted', 'm.room.encrypted']);
    /* Newer messages push my encrypted events out of the first sync, so after a reload they arrive through history pagination */
    for (let i = 1; i <= 25; i++) hs.say(room, BOB, `Filler ${i}.`);

    await page.reload();
    await nexus.waitUntilReady();
    await nexus.openRoom('Vault');
    await expect(async () => {
      await nexus.scrollToTop();
      await expect(nexus.log.getByText('Beginning of conversation')).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 20_000 });

    const mine = nexus.messageWrapper('Meet at one');
    await expect(mine.getByTestId('edited-label')).toBeVisible();
    await expect(mine.getByTestId('thread-count')).toHaveText('1 reply');
    await expect(nexus.log.getByText(/Unable to decrypt|Cannot decrypt/)).toHaveCount(0);
    await expect(nexus.messages).toHaveCount(26);
  });
});

test.describe('Keeping the view in place', () => {
  test('keeps the newest message in view when an image above it finishes loading', { tag: '@regression' }, async ({ nexus, hs }) => {
    const room = hs.addRoom({ name: 'General', members: [BOB] });
    for (let i = 1; i <= 8; i++) hs.say(room, BOB, `Earlier message ${i}.`);
    const photo = hs.uploadMedia(makePng(320, 240), 'image/png');
    hs.post(room, BOB, 'm.room.message', { msgtype: 'm.image', body: 'photo.png', info: { mimetype: 'image/png', w: 320, h: 240 }, url: photo });
    hs.say(room, BOB, 'The newest message.');
    /* The image arrives after the room has opened and scrolled to the newest message, as on a slow connection */
    hs.delay(/\/(media\/v3|client\/v1\/media)\/download\//, 1_500);
    await nexus.open();
    await nexus.openRoom('General');
    await expect(nexus.message('The newest message.')).toBeInViewport();

    await expect(nexus.log.getByRole('button', { name: 'Click to view full size image' })).toBeVisible();

    await expect(nexus.message('The newest message.')).toBeInViewport();
  });

  test('keeps following new messages in a room whose whole history fits on screen', { tag: '@regression' }, async ({ nexus, hs }) => {
    const room = hs.addRoom({ name: 'Fresh', members: [BOB] });
    hs.say(room, BOB, 'Hi');
    await nexus.open();
    await nexus.openRoom('Fresh');
    await expect(nexus.log.getByText('Beginning of conversation')).toBeVisible();

    for (let i = 1; i <= 15; i++) {
      hs.say(room, BOB, `Line ${i}.`);
      if (i % 5 === 0) await expect(nexus.message(`Line ${i}.`)).toHaveCount(1);
    }

    await expect(nexus.message('Line 15.')).toBeInViewport();
  });

  test('keeps my place in older history while my newest message has failed to send', { tag: '@regression' }, async ({ nexus, hs }) => {
    const room = hs.addRoom({ name: 'Archive', members: [BOB] });
    for (let i = 1; i <= 45; i++) hs.say(room, BOB, `Message ${i}.`);
    hs.failNext(/\/send\/m\.room\.message\//, 400, { errcode: 'M_UNKNOWN', error: 'Rejected' });
    await nexus.open();
    await nexus.openRoom('Archive');
    await nexus.send('Doomed');
    await expect(nexus.message('Doomed').getByRole('alert')).toHaveText('⚠️ Failed');

    await nexus.scrollToTop();
    await expect(nexus.message('Message 5.')).toHaveCount(1);

    await expect(nexus.message('Message 26.')).toBeInViewport();
    await expect(nexus.message('Doomed')).not.toBeInViewport();
  });

  test('never shows older messages of the previous room in the room just opened', { tag: '@regression' }, async ({ nexus, hs, page }) => {
    const busy = hs.addRoom({ name: 'Busy', members: [BOB] });
    for (let i = 1; i <= 60; i++) hs.say(busy, BOB, `Busy ${i}`);
    const calm = hs.addRoom({ name: 'Calm', members: [CAROL] });
    hs.say(calm, CAROL, 'Calm 1');
    hs.delay(new RegExp(`/rooms/${busy}/messages`), 2_500);
    await nexus.open();
    await nexus.openRoom('Busy');
    await expect(nexus.message('Busy 60')).toBeVisible();
    const olderPage = page.waitForResponse((r) => decodeURIComponent(r.url()).includes(`/rooms/${busy}/messages`));

    await nexus.scrollToTop();
    await expect(nexus.log.getByText('Loading message history…')).toBeVisible();
    await nexus.openRoom('Calm');
    await expect(nexus.message('Calm 1')).toBeVisible();
    await olderPage;
    /* A message synced after the older page's response can only render once that response has been handled */
    hs.say(calm, CAROL, 'Calm 2');

    await expect(nexus.messages).toHaveText([/Calm 1/, /Calm 2/]);
  });
});