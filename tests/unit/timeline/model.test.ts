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
    const first = textEvent('First');
    const second = textEvent('Second', { sender: ME });
    await addLive(room, [second, first]);

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

  it('leaves out a deleted edit instead of showing another deleted message', async () => {
    const room = makeRoom();
    const memory: RelationMemory = new Map();
    const original = textEvent('Meet at the cafe');
    const edit = editOf(original, 'Meet at the park');
    await addLive(room, [original, edit]);
    await settle();
    derive(room, memory);

    await addLive(room, [redactionOf(edit)]);
    const view = derive(room, memory);

    expect(view.messages.map((m) => m.deleted)).toEqual([false]);
  });

  it('leaves out a deleted event that never was a message', async () => {
    const room = makeRoom();
    const topic = event({ type: 'm.room.topic', state_key: '', content: { topic: 'Q3 planning' } });
    await addLive(room, [topic]);

    await addLive(room, [redactionOf(topic)]);

    expect(derive(room).messages).toEqual([]);
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

  it('stops counting my reaction while its removal is on its way', () => {
    const target = textEvent('New logo is up');
    const mine = reactionTo(target, '👍', { sender: ME });
    const removal = redactionOf(mine, { sender: ME });
    removal.setStatus(EventStatus.SENDING);

    expect(deriveTimeline([target, mine, removal], new Map(), ME).reactions).toEqual({});
  });

  it('ignores a reaction that names no emoji', () => {
    const target = textEvent('New logo is up');
    const keyless = event({ type: 'm.reaction', content: { 'm.relates_to': { rel_type: 'm.annotation', event_id: target.getId() } } });

    expect(deriveTimeline([target, keyless], new Map(), ME).reactions).toEqual({});
  });

  it('keeps one row for a local echo and the server copy that replaces it', () => {
    const echo = localEcho('Hello', 'txn1');
    const before = deriveTimeline([echo], new Map(), ME).messages[0];

    echo.handleRemoteEcho({ ...echo.event, event_id: '$server', unsigned: { transaction_id: 'txn1' } });
    const after = deriveTimeline([echo], new Map(), ME).messages[0];

    expect([before.key, before.hasServerId, before.sendState]).toEqual(['txn1', false, 'sending']);
    expect([after.key, after.hasServerId, after.sendState, after.eventId]).toEqual(['txn1', true, 'sent', '$server']);
  });

  it('keeps the row key of my message when its server copy arrives as an event of its own', () => {
    const echo = localEcho('Hello', 'txn1');
    const serverCopy = textEvent('Hello', { sender: ME, unsigned: { transaction_id: 'txn1' } });

    const before = deriveTimeline([echo], new Map(), ME).messages[0];
    const after = deriveTimeline([serverCopy], new Map(), ME).messages[0];

    expect(after.key).toBe(before.key);
  });

  it('drops the fallback reply target of a thread reply', () => {
    const root = textEvent('Root');
    const fallback = textEvent('In thread', {}, { 'm.relates_to': { rel_type: 'm.thread', event_id: root.getId(), is_falling_back: true, 'm.in_reply_to': { event_id: root.getId() } } });

    const view = deriveTimeline([root, fallback], new Map(), ME);

    expect(view.threads[root.getId()!][0].replyToEventId).toBeUndefined();
  });

  it('quotes the thread reply that a real reply inside the thread answers', () => {
    const root = textEvent('Release planning');
    const offer = textEvent('I can take notes', { sender: CAROL }, { 'm.relates_to': { rel_type: 'm.thread', event_id: root.getId(), is_falling_back: true } });
    const answer = textEvent('Thanks Carol', { sender: ME }, { 'm.relates_to': { rel_type: 'm.thread', event_id: root.getId(), is_falling_back: false, 'm.in_reply_to': { event_id: offer.getId() } } });

    const view = deriveTimeline([root, offer, answer], new Map(), ME);

    expect(view.threads[root.getId()!][1]).toMatchObject({ replyToSender: CAROL, replyToBody: 'I can take notes' });
  });

  it('lists thread replies oldest first', () => {
    const root = textEvent('Lunch options');
    const inThread = { 'm.relates_to': { rel_type: 'm.thread', event_id: root.getId(), is_falling_back: true } };
    const sushi = textEvent('Sushi', { sender: CAROL }, inThread);
    const pizza = textEvent('Pizza', { sender: ME }, inThread);

    const view = deriveTimeline([root, pizza, sushi], new Map(), ME);

    expect(view.threads[root.getId()!].map((m) => m.body)).toEqual(['Sushi', 'Pizza']);
  });

  it('keeps the file name, size and media type of an attachment', () => {
    const report = event({
      content: { msgtype: 'm.file', body: 'Quarterly report', filename: 'q3.pdf', url: 'mxc://hs.test/q3', info: { mimetype: 'application/pdf', size: 52_431 } },
    });

    const [message] = deriveTimeline([report], new Map(), ME).messages;

    expect(message).toMatchObject({ filename: 'q3.pdf', size: 52_431, mimetype: 'application/pdf', mxcUrl: 'mxc://hs.test/q3' });
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
        event({ content: { msgtype: 'm.emote', body: 'waves' } }),
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
      ['text', true],
      ['text', false],
    ]);
  });
});

describe('deriveTimeline with encrypted events', () => {
  /* An attachment's file object shaped like the spec's EncryptedFile, with a v2 AES-CTR key */
  const ENCRYPTED_FILE = {
    url: 'mxc://hs.test/encrypted-cat',
    key: { kty: 'oct', key_ops: ['encrypt', 'decrypt'], alg: 'A256CTR', k: 'qcHVMSgYg-71CauWBezXI5qkaRb0LuIy-Wx5kIaHMIA', ext: true },
    iv: 'X85+XgHN+HEAAAAAAAAAAA',
    hashes: { sha256: 'qWvx1yvbIHTxwhH9IrfPaJhxOR4jI0YbJzT5cSuvZjQ' },
    v: 'v2',
  };

  const decryptedImage = async (file: Record<string, unknown>) => {
    const image = encryptedEvent();
    await decrypt(image, { type: 'm.room.message', content: { msgtype: 'm.image', body: 'cat.png', file, info: { mimetype: 'image/png' } } });
    return deriveTimeline([image], new Map(), ME).messages[0];
  };

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

  it('hides an undecryptable reaction, edit or reference rather than showing it as a message', async () => {
    const target = textEvent('Shipped it!');
    const reaction = encryptedEvent({}, { rel_type: 'm.annotation', event_id: target.getId(), key: '🎉' });
    const edit = encryptedEvent({}, { rel_type: 'm.replace', event_id: target.getId() });
    const reference = encryptedEvent({}, { rel_type: 'm.reference', event_id: target.getId() });
    await decrypt(reaction, new Error('No room key'));
    await decrypt(edit, new Error('No room key'));
    await decrypt(reference, new Error('No room key'));

    expect(bodies(deriveTimeline([target, reaction, edit, reference], new Map(), ME))).toEqual(['Shipped it!']);
  });

  it('quotes a message that cannot be decrypted without its placeholder text', async () => {
    const secret = encryptedEvent();
    await decrypt(secret, new Error('No room key'));
    const reply = textEvent('What did you say?', { sender: CAROL }, { 'm.relates_to': { 'm.in_reply_to': { event_id: secret.getId() } } });

    const view = deriveTimeline([secret, reply], new Map(), ME);

    expect(view.messages[1].replyToBody).toBe('(encrypted)');
  });

  it('shows a deleted encrypted message as deleted', async () => {
    const room = makeRoom();
    const secret = encryptedEvent();
    await addLive(room, [secret]);

    await addLive(room, [redactionOf(secret)]);

    expect(derive(room).messages.map((m) => [m.deleted, m.body])).toEqual([[true, 'Message deleted.']]);
  });

  it("takes an encrypted attachment's URL and keys from its file object", async () => {
    const message = await decryptedImage(ENCRYPTED_FILE);

    expect(message).toMatchObject({ kind: 'image', mxcUrl: ENCRYPTED_FILE.url, encryptedFile: ENCRYPTED_FILE });
  });

  it.each(['key', 'iv', 'hashes'])('never hands on a file object without its %s for decryption', async (missing) => {
    const incomplete = Object.fromEntries(Object.entries(ENCRYPTED_FILE).filter(([field]) => field !== missing));

    const message = await decryptedImage(incomplete);

    expect(message.encryptedFile).toBeUndefined();
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