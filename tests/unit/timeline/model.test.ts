import { describe, it, expect } from 'vitest';
import { EventStatus, type Room } from 'matrix-js-sdk';
import { deriveTimeline, sendStateOf, type RelationMemory, type TimelineView } from '@/app/app-components/timeline/model';
import {
  BOB,
  CAROL,
  ME,
  addLive,
  decrypt,
  editOf,
  encryptedEvent,
  event,
  localEcho,
  makeRoom,
  reactionTo,
  redactionOf,
  settle,
  textEvent,
} from './sdk-fixtures';

const derive = (room: Room, memory: RelationMemory = new Map()): TimelineView =>
  deriveTimeline(room.getLiveTimeline().getEvents(), memory, ME);

const bodies = (view: TimelineView) => view.messages.map((m) => m.body);

describe('deriveTimeline', () => {
  it('lists messages oldest first with their senders', async () => {
    const room = makeRoom();
    await addLive(room, [textEvent('First'), textEvent('Second', { sender: ME })]);

    const view = derive(room);

    expect(view.messages.map((m) => [m.sender, m.body])).toEqual([
      [BOB, 'First'],
      [ME, 'Second'],
    ]);
  });

  it('shows the latest edit from the author and hides the edit events', async () => {
    const room = makeRoom();
    const original = textEvent('Meet at the cafe');
    await addLive(room, [original, editOf(original, 'Meet at the library'), editOf(original, 'Meet at the park')]);
    await settle();

    const view = derive(room);

    expect(bodies(view)).toEqual(['Meet at the park']);
    expect(view.messages[0].edited).toBe(true);
  });

  it('ignores an edit sent by someone other than the author', async () => {
    const room = makeRoom();
    const mine = textEvent('I owe Bob £5', { sender: ME });
    await addLive(room, [mine, editOf(mine, 'I owe Bob £500', { sender: BOB })]);
    await settle();

    const view = derive(room);

    expect(bodies(view)).toEqual(['I owe Bob £5']);
    expect(view.messages[0].edited).toBe(false);
  });

  it('ignores an edit sent by someone else to a thread reply', async () => {
    const room = makeRoom();
    const root = textEvent('Who brings chairs?');
    const mine = textEvent('I can bring 2', { sender: ME }, { 'm.relates_to': { rel_type: 'm.thread', event_id: root.getId(), is_falling_back: true } });
    await addLive(room, [root, mine, editOf(mine, 'I can bring 20', { sender: BOB })]);
    await settle();

    const view = derive(room);

    expect(view.threads[root.getId()!].map((m) => m.body)).toEqual(['I can bring 2']);
  });

  it('keeps the quote of a reply after the reply is edited', async () => {
    const room = makeRoom();
    const question = textEvent('Pizza tonight?');
    const answer = textEvent('Count me in', { sender: ME }, { 'm.relates_to': { 'm.in_reply_to': { event_id: question.getId() } } });
    await addLive(room, [question, answer, editOf(answer, 'Count me in, with garlic bread', { sender: ME })]);
    await settle();

    const reply = derive(room).messages[1];

    expect(reply).toMatchObject({ body: 'Count me in, with garlic bread', replyToSender: BOB, replyToBody: 'Pizza tonight?' });
  });

  it('quotes a deleted message as deleted, never with its old text', async () => {
    const room = makeRoom();
    const secret = textEvent('My door code is 4321');
    await addLive(room, [secret, textEvent('Got it', { sender: CAROL }, { 'm.relates_to': { 'm.in_reply_to': { event_id: secret.getId() } } })]);

    await addLive(room, [redactionOf(secret)]);
    const view = derive(room);

    expect(view.messages.map((m) => [m.deleted, m.body])).toEqual([
      [true, 'Message deleted.'],
      [false, 'Got it'],
    ]);
    expect(view.messages[1].replyToBody).toBe('(deleted)');
  });

  it('shows a message as deleted while my redaction is on its way and restores it when the redaction fails', () => {
    const target = textEvent('Oops', { sender: ME });
    const redaction = redactionOf(target, { sender: ME });
    redaction.setStatus(EventStatus.SENDING);

    expect(deriveTimeline([target, redaction], new Map(), ME).messages[0].deleted).toBe(true);

    redaction.setStatus(EventStatus.NOT_SENT);

    expect(deriveTimeline([target, redaction], new Map(), ME).messages[0].deleted).toBe(false);
  });

  it('keeps a thread reply deleted after it was seen in its thread', async () => {
    const room = makeRoom();
    const memory: RelationMemory = new Map();
    const root = textEvent('Lunch options');
    const reply = textEvent('Sushi', { sender: CAROL }, { 'm.relates_to': { rel_type: 'm.thread', event_id: root.getId(), is_falling_back: true } });
    await addLive(room, [root, reply]);
    derive(room, memory);

    await addLive(room, [redactionOf(reply, { sender: CAROL })]);
    const view = derive(room, memory);

    expect(bodies(view)).toEqual(['Lunch options']);
    expect(view.threads[root.getId()!].map((m) => [m.deleted, m.body])).toEqual([[true, 'Message deleted.']]);
  });

  it('counts reactions once per person and remembers my own', async () => {
    const room = makeRoom();
    const target = textEvent('New logo is up');
    const mine = reactionTo(target, '👍', { sender: ME });
    const withdrawn = reactionTo(target, '🎉', { sender: CAROL });
    await addLive(room, [target, reactionTo(target, '👍'), reactionTo(target, '👍', { sender: CAROL }), mine, withdrawn]);
    await addLive(room, [redactionOf(withdrawn, { sender: CAROL })]);

    const groups = derive(room).reactions[target.getId()!];

    expect(groups).toEqual([{ key: '👍', count: 3, mine }]);
  });

  it('leaves out a reaction that failed to send', () => {
    const target = textEvent('Shipped it!');
    const failed = reactionTo(target, '🎉', { sender: ME });
    failed.setStatus(EventStatus.NOT_SENT);

    expect(deriveTimeline([target, failed], new Map(), ME).reactions).toEqual({});
  });

  it('keeps one row for a local echo and the server copy that replaces it', () => {
    const echo = localEcho('Hello', 'txn1');
    const before = deriveTimeline([echo], new Map(), ME).messages[0];

    echo.handleRemoteEcho({ ...echo.event, event_id: '$server', unsigned: { transaction_id: 'txn1' } });
    const after = deriveTimeline([echo], new Map(), ME).messages[0];

    expect([before.key, before.hasServerId, before.sendState]).toEqual(['txn1', false, 'sending']);
    expect([after.key, after.hasServerId, after.sendState, after.eventId]).toEqual(['txn1', true, 'sent', '$server']);
  });

  it('drops the fallback reply target of a thread reply', () => {
    const root = textEvent('Root');
    const fallback = textEvent('In thread', {}, { 'm.relates_to': { rel_type: 'm.thread', event_id: root.getId(), is_falling_back: true, 'm.in_reply_to': { event_id: root.getId() } } });

    const view = deriveTimeline([root, fallback], new Map(), ME);

    expect(view.threads[root.getId()!][0].replyToEventId).toBeUndefined();
  });

  it('classifies media kinds and only treats text-like messages as editable text', () => {
    const view = deriveTimeline(
      [
        event({ content: { msgtype: 'm.image', body: 'a.png', url: 'mxc://hs.test/a' } }),
        event({ content: { msgtype: 'm.file', body: 'b.png', url: 'mxc://hs.test/b', info: { mimetype: 'image/png' } } }),
        event({ content: { msgtype: 'm.file', body: 'c.pdf', url: 'mxc://hs.test/c', info: { mimetype: 'application/pdf' } } }),
        event({ content: { msgtype: 'm.audio', body: 'd.ogg', url: 'mxc://hs.test/d' } }),
        event({ content: { msgtype: 'm.video', body: 'e.mp4', url: 'mxc://hs.test/e' } }),
        event({ content: { msgtype: 'm.notice', body: 'f' } }),
        event({ content: { msgtype: 'm.location', body: 'g', geo_uri: 'geo:0,0' } }),
      ],
      new Map(),
      ME
    );

    expect(view.messages.map((m) => [m.kind, m.textual])).toEqual([
      ['image', false],
      ['image', false],
      ['file', false],
      ['audio', false],
      ['video', false],
      ['text', true],
      ['text', false],
    ]);
  });
});

describe('deriveTimeline with encrypted events', () => {
  it('waits for an encrypted event to be decrypted before showing anything for it', () => {
    const pending = encryptedEvent();

    expect(deriveTimeline([pending], new Map(), ME)).toEqual({ messages: [], threads: {}, reactions: {} });
  });

  it('counts a decrypted reaction as a reaction, not a message', async () => {
    const target = textEvent('Shipped it!');
    const reaction = encryptedEvent({}, { rel_type: 'm.annotation', event_id: target.getId(), key: '🎉' });
    await decrypt(reaction, { type: 'm.reaction', content: { 'm.relates_to': { rel_type: 'm.annotation', event_id: target.getId(), key: '🎉' } } });

    const view = deriveTimeline([target, reaction], new Map(), ME);

    expect(bodies(view)).toEqual(['Shipped it!']);
    expect(view.reactions[target.getId()!]).toEqual([{ key: '🎉', count: 1, mine: undefined }]);
  });

  it('puts a decrypted thread reply in its thread', async () => {
    const root = textEvent('Release planning');
    const relation = { rel_type: 'm.thread', event_id: root.getId(), is_falling_back: true };
    const reply = encryptedEvent({}, relation);
    await decrypt(reply, { type: 'm.room.message', content: { msgtype: 'm.text', body: 'I can take notes' } });

    const view = deriveTimeline([root, reply], new Map(), ME);

    expect(bodies(view)).toEqual(['Release planning']);
    expect(view.threads[root.getId()!].map((m) => m.body)).toEqual(['I can take notes']);
  });

  it('ignores decrypted events that are not messages', async () => {
    const verification = encryptedEvent();
    await decrypt(verification, { type: 'm.key.verification.ready', content: { methods: ['m.sas.v1'] } });

    expect(deriveTimeline([verification], new Map(), ME).messages).toEqual([]);
  });

  it('shows a message that cannot be decrypted as such', async () => {
    const undecryptable = encryptedEvent();
    await decrypt(undecryptable, new Error('No room key'));

    const [message] = deriveTimeline([undecryptable], new Map(), ME).messages;

    expect(message).toMatchObject({ decryptionFailure: true, body: '🔒 Unable to decrypt', textual: false });
  });

  it('hides an undecryptable reaction or edit rather than showing it as a message', async () => {
    const target = textEvent('Shipped it!');
    const reaction = encryptedEvent({}, { rel_type: 'm.annotation', event_id: target.getId(), key: '🎉' });
    const edit = encryptedEvent({}, { rel_type: 'm.replace', event_id: target.getId() });
    await decrypt(reaction, new Error('No room key'));
    await decrypt(edit, new Error('No room key'));

    expect(bodies(deriveTimeline([target, reaction, edit], new Map(), ME))).toEqual(['Shipped it!']);
  });
});

describe('sendStateOf', () => {
  it('maps every SDK send status explicitly', () => {
    const statuses = [null, EventStatus.ENCRYPTING, EventStatus.QUEUED, EventStatus.SENDING, EventStatus.SENT, EventStatus.NOT_SENT, EventStatus.CANCELLED];

    const states = statuses.map((status) => {
      const echo = localEcho('Hi', `txn-${status}`);
      echo.setStatus(status);
      return sendStateOf(echo);
    });

    expect(states).toEqual(['sent', 'sending', 'sending', 'sending', 'sent', 'failed', 'cancelled']);
  });
});