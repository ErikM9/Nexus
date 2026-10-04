import { expect, type Locator, type Page } from '@playwright/test';
import { ACCESS_TOKEN, DEVICE_ID, HS_URL, ME, type FakeHomeserver } from './homeserver';

type MessageAction = 'react' | 'reply' | 'thread' | 'edit' | 'delete';

/* Page model for Nexus, holding the selectors and user journeys while every assertion stays in the specs */
export class NexusPage {
  readonly header: Locator;
  readonly sidebar: Locator;
  readonly roomList: Locator;
  readonly rooms: Locator;
  readonly chatWindow: Locator;
  readonly log: Locator;
  readonly messages: Locator;
  readonly roomTitle: Locator;
  readonly emptyState: Locator;
  readonly username: Locator;
  readonly password: Locator;
  readonly signInButton: Locator;
  readonly createToggle: Locator;
  readonly joinToggle: Locator;
  readonly newRoomName: Locator;
  readonly roomType: Locator;
  readonly createButton: Locator;
  readonly joinSearch: Locator;
  readonly joinButton: Locator;
  readonly joinResults: Locator;
  readonly messageInput: Locator;
  readonly sendButton: Locator;
  readonly dialog: Locator;

  constructor(readonly page: Page, readonly hs: FakeHomeserver) {
    this.header = page.locator('header').first();
    this.sidebar = page.getByRole('complementary', { name: 'Chat rooms' });
    this.roomList = page.getByTestId('room-list');
    this.rooms = page.getByTestId('room-item');
    this.chatWindow = page.getByTestId('chat-window');
    this.log = page.getByRole('log', { name: 'Chat messages' });
    this.messages = this.log.getByRole('article');
    this.roomTitle = page.getByTestId('room-name');
    this.emptyState = page.getByText('Select a chat to start messaging');
    this.username = page.getByLabel('Username:');
    this.password = page.getByLabel('Password:');
    this.signInButton = page.locator('button[type="submit"][form="login-form"]');
    /* The mode toggle and the form's submit button share a label, so the toggle is the first match and the submit the last */
    this.createToggle = this.sidebar.getByRole('button', { name: 'Create', exact: true }).first();
    this.joinToggle = this.sidebar.getByRole('button', { name: 'Join', exact: true }).first();
    this.newRoomName = page.getByPlaceholder('Choose room name');
    this.roomType = this.sidebar.getByRole('combobox');
    this.createButton = this.sidebar.getByRole('button', { name: 'Create', exact: true }).last();
    this.joinSearch = page.getByPlaceholder('Search by name or enter ID');
    this.joinButton = this.sidebar.getByRole('button', { name: 'Join', exact: true }).last();
    /* Directory search results, each a button holding the room's name and ID */
    this.joinResults = this.sidebar.getByRole('list', { name: 'Matching public rooms' }).getByRole('button');
    this.messageInput = page.getByRole('region', { name: 'Chat area' }).getByRole('textbox').last();
    this.sendButton = page.getByRole('region', { name: 'Chat area' }).getByRole('button', { name: 'Send', exact: true }).last();
    this.dialog = page.getByTestId('member-overlay');
  }

  /* Fills the sign-in form and submits it with the button, as a first-time visitor would */
  async signIn(user: string, password: string): Promise<void> {
    await this.username.fill(user);
    await this.password.fill(password);
    await this.signInButton.click();
  }

  /* Reads a localStorage entry, parsing JSON values so specs can compare them as objects */
  async stored(key: string): Promise<unknown> {
    const raw = await this.page.evaluate((k) => localStorage.getItem(k), key);
    if (raw === null) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }

  /* Lists every localStorage key, so specs can check that nothing of a session is left behind */
  async storedKeys(): Promise<string[]> {
    return this.page.evaluate(() => Object.keys(localStorage).sort());
  }

  /* Lists the IndexedDB databases of the app's origin, which is where the Rust crypto stores live */
  async databaseNames(): Promise<string[]> {
    return this.page.evaluate(async () => (await indexedDB.databases()).map((db) => db.name ?? '').sort());
  }

  /* Seeds the stored session a previous sign-in would have left, once per tab so a reload after logout stays logged out */
  async seedSession(opts: { refreshToken?: string } = {}): Promise<void> {
    await this.page.addInitScript(
      ({ session }) => {
        if (sessionStorage.getItem('nexus-e2e-seeded')) return;
        sessionStorage.setItem('nexus-e2e-seeded', '1');
        localStorage.setItem('mx_session', JSON.stringify(session));
        localStorage.setItem('mx_access_token', session.accessToken);
        localStorage.setItem('mx_user_id', session.userId);
        localStorage.setItem('mx_device_id', session.deviceId);
        if (session.refreshToken) localStorage.setItem('mx_refresh_token', session.refreshToken);
      },
      {
        session: {
          accessToken: ACCESS_TOKEN,
          userId: ME,
          deviceId: DEVICE_ID,
          baseUrl: HS_URL,
          refreshToken: opts.refreshToken,
        },
      }
    );
  }

  /* Opens the app with a restored session and waits until the room list reflects the first sync */
  async open(): Promise<void> {
    await this.seedSession();
    await this.page.goto('/');
    await this.waitUntilReady();
  }

  async waitUntilReady(): Promise<void> {
    await expect(this.page.getByText('Your chats')).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => this.page.evaluate(() => window.__matrix_ready === true), { timeout: 30_000 }).toBe(true);
    await expect(this.roomList).toBeVisible();
  }

  /* The sidebar button that opens a room, whose accessible name is the room name with ", encrypted" appended for encrypted rooms */
  room(name: string): Locator {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return this.roomList.getByRole('button', { name: new RegExp(`^${escaped}(, encrypted)?$`) });
  }

  async openRoom(name: string): Promise<void> {
    await this.room(name).first().click();
    await expect(this.roomTitle).toHaveText(name);
    await expect(this.chatWindow).toBeVisible();
  }

  /* Opens a room's ⋮ menu in the sidebar and picks one of its items */
  async roomMenu(name: string, item: 'Send Invite' | 'Copy Room ID' | 'Leave Room'): Promise<void> {
    await this.page.getByRole('button', { name: `Open menu for ${name}` }).click();
    await this.page.getByRole('menu', { name: `Actions for ${name}` }).getByRole('menuitem', { name: item }).click();
  }

  /* Creates a room through the sidebar form, choosing the type by its visible option label */
  async createRoom(name: string, type?: string): Promise<void> {
    await this.createToggle.click();
    await this.newRoomName.fill(name);
    if (type) {
      await this.roomType.click();
      await this.page.getByRole('option', { name: type, exact: true }).click();
    }
    await this.createButton.click();
  }

  message(text: string | RegExp): Locator {
    return this.messages.filter({ hasText: text });
  }

  async send(text: string): Promise<void> {
    await this.messageInput.fill(text);
    await this.messageInput.press('Enter');
  }

  /* Hovering a message reveals its action bar, which is where react, reply, thread, edit and delete live */
  async messageAction(text: string | RegExp, action: MessageAction): Promise<void> {
    const wrapper = this.messageWrapper(text);
    await wrapper.hover();
    await wrapper.getByTestId(`action-${action}`).click();
  }

  /* The element around a message bubble that also holds its action bar, thread count and edit or delete forms */
  messageWrapper(text: string | RegExp): Locator {
    return this.log.locator('[data-message-id]').filter({ has: this.page.getByRole('article').filter({ hasText: text }) }).last();
  }

  async openSettingsMenu(): Promise<Locator> {
    await this.page.getByRole('button', { name: 'Settings', exact: true }).click();
    const menu = this.page.getByRole('menu', { name: 'Settings menu' });
    await expect(menu).toBeVisible();
    return menu;
  }

  /* Opens a session panel from the Settings menu and returns the overlay that carries the given heading */
  async openSessionPanel(item: string, heading: string): Promise<Locator> {
    await this.openSettingsMenu();
    await this.page.getByRole('menuitem', { name: item }).click();
    const panel = this.page.locator('div.fixed.inset-0').filter({ has: this.page.getByText(heading, { exact: true }) });
    await expect(panel).toBeVisible();
    return panel;
  }

  /* Opens the room header's Members dropdown and returns it */
  async openMembers(): Promise<Locator> {
    await this.page.getByRole('button', { name: 'Members' }).click();
    const menu = this.page.getByRole('menu');
    await expect(menu).toBeVisible();
    return menu;
  }

  async openRoomSettings(): Promise<Locator> {
    await this.page.getByRole('button', { name: 'Room settings' }).click();
    const menu = this.page.getByRole('menu');
    await expect(menu.getByText('Room Settings', { exact: true })).toBeVisible();
    return menu;
  }

  /* Switches the app to dark mode through the header's theme menu, as a user would */
  async switchToDarkTheme(): Promise<void> {
    await this.page.getByRole('button', { name: 'Toggle theme' }).click();
    await this.page.getByRole('button', { name: 'Dark Mode' }).click();
    await expect(this.page.locator('html')).toHaveClass(/\bdark\b/);
    await this.page.keyboard.press('Escape');
  }

  /* Scrolls the timeline to its top, which is what asks the app for older history */
  async scrollToTop(): Promise<void> {
    await this.log.evaluate((el) => {
      el.scrollTop = 0;
      el.dispatchEvent(new Event('scroll'));
    });
  }
}