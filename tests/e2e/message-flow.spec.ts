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

  test('catches up after a gap in the sync and still reaches every older message in order', async ({ nexus, hs }) => {
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

  test('loads older messages when a gap in the sync brings only reactions', async ({ nexus, hs }) => {
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

    await expect(nexus.message('Vote here.').getByRole('button', { name: /^👍 reaction/ })).toHaveAccessibleName('👍 reaction, 2 people');
    await expect(nexus.message('Message 1.')).toBeVisible();
    await expect(nexus.log.getByText('No messages yet. Start the conversation!')).toHaveCount(0);
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
    const room = hs.addRoom({ name: 'General' });
    await nexus.open();
    await nexus.openRoom('General');

    await nexus.messageInput.press('Enter');
    await nexus.messageInput.fill('    ');
    await nexus.messageInput.press('Enter');
    await nexus.sendButton.click();
    /* Sends to a room go out in order, so this message reaches the server after anything the blank attempts sent */
    await nexus.send('Not blank');

    await expect(nexus.message('Not blank')).toBeVisible();
    await expect.poll(() => hs.sentEvents(room).map((e) => e.content.body)).toEqual(['Not blank']);
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

  test('shows a rejected message as failed only and sends it again on Retry', async ({ nexus, hs }) => {
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

  test('keeps a draft typed in another room while a send is still going', async ({ nexus, hs, page }) => {
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

  test('shows the quote of a message deleted before the room was opened as deleted', async ({ nexus, hs }) => {
    const room = hs.addRoom({ name: 'General', members: [BOB, CAROL] });
    const secret = hs.say(room, BOB, 'My door code is 4321');
    hs.say(room, CAROL, 'Got it', reply(secret));
    hs.redact(room, BOB, secret);
    await nexus.open();

    await nexus.openRoom('General');

    await expect(nexus.message('Got it').getByTestId('reply-context')).toHaveText(`${BOB}(deleted)`);
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
    await nexus.log.getByRole('button', { name: 'Save' }).click();

    await expect(nexus.message('See you at 7').getByText('(edited)')).toBeVisible();
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
    const editInput = page.getByTestId('edit-input');

    await nexus.messageAction('Original', 'edit');
    await editInput.fill('Changed my mind');
    await editInput.press('Escape');
    await expect(editInput).toHaveCount(0);

    await nexus.messageAction('Original', 'edit');
    await nexus.log.getByRole('button', { name: 'Cancel' }).click();

    await nexus.messageAction('Original', 'edit');
    await editInput.fill('');
    await expect(nexus.log.getByRole('button', { name: 'Save' })).toBeDisabled();
    await editInput.fill('Original');
    await editInput.press('Enter');
    await expect(editInput).toHaveCount(0);
    /* Sends to a room go out in order, so this message reaches the server after any edit the attempts above sent */
    await nexus.send('Afterwards');

    await expect(nexus.message('Afterwards')).toBeVisible();
    await expect(nexus.message('Original').getByText('(edited)')).toHaveCount(0);
    await expect.poll(() => hs.sentEvents(room).map((e) => e.content.body)).toEqual(['Original', 'Afterwards']);
  });

  test('ignores an edit of my message sent by someone else', async ({ nexus, hs, page }) => {
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
    await expect(nexus.messages.first().getByText('(edited)')).toHaveCount(0);
  });

  test('ignores an edit of my thread reply sent by someone else', async ({ nexus, hs, page }) => {
    const room = hs.addRoom({ name: 'General', members: [BOB] });
    const root = hs.say(room, BOB, 'Who brings chairs?');
    const mine = hs.say(room, ME, 'I can bring 2', { 'm.relates_to': { rel_type: 'm.thread', event_id: root, is_falling_back: true } });
    await nexus.open();
    await nexus.openRoom('General');
    await nexus.messageWrapper('Who brings chairs?').getByRole('button', { name: '1 reply' }).click();
    const panel = page.getByTestId('thread-panel');
    await expect(panel.getByRole('article').last()).toContainText('I can bring 2');

    hs.say(room, BOB, '* I can bring 20', {
      'm.new_content': { msgtype: 'm.text', body: 'I can bring 20' },
      'm.relates_to': { rel_type: 'm.replace', event_id: mine },
    });
    hs.say(room, BOB, 'Noted');
    await expect(nexus.message('Noted')).toBeVisible();

    await expect(panel.getByRole('article').last()).toContainText('I can bring 2', { timeout: 3_000 });
    await expect(panel.getByRole('article').last()).not.toContainText('20');
  });

  test('deletes my own message after confirming', async ({ nexus, hs }) => {
    const room = hs.addRoom({ name: 'General' });
    await nexus.open();
    await nexus.openRoom('General');
    await nexus.send('Oops, wrong room');
    await expect.poll(() => hs.sentEvents(room).length).toBe(1);
    const [sent] = hs.sentEvents(room);

    await nexus.messageAction('Oops, wrong room', 'delete');
    await expect(nexus.log.getByText('Delete this message?')).toBeVisible();
    await nexus.log.getByRole('button', { name: 'Cancel' }).click();
    await expect(nexus.log.getByText('Delete this message?')).toHaveCount(0);
    expect(hs.requestsTo(/\/redact\//)).toHaveLength(0);

    await nexus.messageAction('Oops, wrong room', 'delete');
    await nexus.log.getByRole('button', { name: 'Delete', exact: true }).click();

    await expect(nexus.log.getByText('Message deleted.')).toBeVisible();
    await expect(nexus.log.getByText('Oops, wrong room')).toHaveCount(0);
    await expect.poll(() => hs.requestsTo(/\/redact\//, 'PUT').map((r) => r.path.match(/\/redact\/([^/]+)\//)?.[1])).toEqual([sent.event_id]);
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

    await expect(nexus.log.getByText('Message deleted.')).toHaveCount(2);
    await expect(nexus.log.getByText(/Deleted (before|while)/)).toHaveCount(0);
  });
});

test.describe('Reactions', () => {
  test('adds a reaction from the picker and removes it by clicking the badge', async ({ nexus, hs }) => {
    const room = hs.addRoom({ name: 'General', members: [BOB] });
    const target = hs.say(room, BOB, 'Shipped it!');
    await nexus.open();
    await nexus.openRoom('General');

    await nexus.messageAction('Shipped it!', 'react');
    await expect(nexus.reactionPicker.getByRole('button')).toHaveCount(15);
    await nexus.reactionPicker.getByRole('button', { name: 'React with 🎉' }).click();

    const badge = nexus.message('Shipped it!').getByRole('button', { name: /^🎉 reaction/ });
    await expect(badge).toHaveAccessibleName('🎉 reaction, 1 person, you reacted');
    await expect(nexus.reactionPicker).toHaveCount(0);
    await expect.poll(() => hs.sentEvents(room, 'm.reaction').map((e) => e.content)).toEqual([
      { 'm.relates_to': { rel_type: 'm.annotation', event_id: target, key: '🎉' } },
    ]);

    await badge.click();
    await expect(badge).toHaveCount(0);
    await expect.poll(() => hs.requestsTo(/\/redact\//, 'PUT')).toHaveLength(1);
  });

  test('reveals the actions on keyboard focus and reacts from the keyboard', async ({ nexus, hs, page }) => {
    const room = hs.addRoom({ name: 'General', members: [BOB] });
    hs.say(room, BOB, 'React to me');
    await nexus.open();
    await nexus.openRoom('General');
    const wrapper = nexus.messageWrapper('React to me');
    const trigger = wrapper.getByRole('button', { name: 'Add reaction' });

    await trigger.focus();
    await expect(wrapper.getByTestId('message-actions')).toHaveCSS('opacity', '1');
    await page.keyboard.press('Enter');
    await expect(nexus.reactionPicker.getByRole('button', { name: 'React with 😀' })).toBeFocused();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');

    await expect.poll(() => hs.sentEvents(room, 'm.reaction').map((e) => e.content['m.relates_to'].key)).toEqual(['😂']);
    await expect(nexus.reactionPicker).toHaveCount(0);
    await expect(trigger).toBeFocused();
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
    await expect(panel.getByRole('article')).toHaveCount(1);
    await expect(panel.getByRole('article').first()).toContainText('Release planning');
    await expect(panel.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();

    await panel.getByPlaceholder('Reply in thread…').fill('I can take the notes');
    await panel.getByPlaceholder('Reply in thread…').press('Enter');

    await expect(panel.getByRole('article')).toHaveCount(2);
    await expect(panel.getByRole('article').last()).toContainText('I can take the notes');
    await expect.poll(() => hs.sentEvents(room, 'm.room.message')[0]?.content).toEqual({
      msgtype: 'm.text',
      body: 'I can take the notes',
      'm.relates_to': { rel_type: 'm.thread', event_id: root, is_falling_back: true },
    });

    await page.getByRole('button', { name: 'Close thread' }).click();
    await expect(panel).toHaveCount(0);
    await expect(nexus.messageWrapper('Release planning').getByRole('button', { name: '1 reply' })).toBeVisible();
    await expect(nexus.message('I can take the notes')).toHaveCount(0);
  });

  test('shows thread replies from others under their root message', async ({ nexus, hs, page }) => {
    const room = hs.addRoom({ name: 'General', members: [BOB, CAROL] });
    const root = hs.say(room, BOB, 'Lunch options');
    const inThread = { 'm.relates_to': { rel_type: 'm.thread', event_id: root, is_falling_back: true } };
    hs.say(room, CAROL, 'Sushi', inThread);
    await nexus.open();
    await nexus.openRoom('General');

    const count = nexus.messageWrapper('Lunch options').getByRole('button', { name: /^\d+ repl(y|ies)$/ });
    await expect(count).toHaveText('1 reply');
    hs.say(room, BOB, 'Tacos', inThread);
    await expect(count).toHaveText('2 replies');

    await count.click();
    await expect(page.getByTestId('thread-panel').getByRole('article')).toHaveText([/Lunch options/, /Sushi/, /Tacos/]);
    await expect(nexus.messages).toHaveCount(1);
  });
});

test.describe('Encrypted rooms', () => {
  test('shows my edit and thread reply from encrypted history as such', async ({ nexus, hs, page }) => {
    const room = hs.addRoom({ name: 'Vault', encrypted: true, members: [BOB] });
    await nexus.open();
    await nexus.openRoom('Vault');
    await nexus.send('Meet at noon');
    await expect.poll(() => hs.sentEvents(room).length).toBe(1);
    await nexus.messageAction('Meet at noon', 'edit');
    await page.getByTestId('edit-input').fill('Meet at one');
    await page.getByTestId('edit-input').press('Enter');
    await nexus.messageAction('Meet at one', 'thread');
    await page.getByPlaceholder('Reply in thread…').fill('Bring the slides');
    await page.getByPlaceholder('Reply in thread…').press('Enter');
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
    await expect(mine.getByText('(edited)')).toBeVisible();
    await expect(mine.getByRole('button', { name: '1 reply' })).toBeVisible();
    await expect(nexus.log.getByText(/Unable to decrypt|Cannot decrypt/)).toHaveCount(0);
    await expect(nexus.messages).toHaveCount(26);
  });
});

test.describe('Keeping the view in place', () => {
  test('keeps the newest message in view when an image above it finishes loading', async ({ nexus, hs }) => {
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

  test('keeps following new messages in a room whose whole history fits on screen', async ({ nexus, hs }) => {
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

  test('keeps my place in older history while my newest message has failed to send', async ({ nexus, hs }) => {
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

  test('never shows older messages of the previous room in the room just opened', async ({ nexus, hs, page }) => {
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