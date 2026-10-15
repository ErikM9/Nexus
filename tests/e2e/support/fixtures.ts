import { test as base, expect } from '@playwright/test';
import { FakeHomeserver } from './homeserver';
import { NexusPage } from './nexus-page';

type Fixtures = {
  hs: FakeHomeserver;
  nexus: NexusPage;
};

/* Every spec gets its own fake homeserver and page model, and fails if the app tried to reach anything outside the test */
export const test = base.extend<Fixtures>({
  hs: async ({ page, baseURL }, use) => {
    const hs = new FakeHomeserver();
    await hs.install(page, new URL(baseURL ?? 'http://localhost:3000').origin);
    await use(hs);
    hs.close();
    expect(hs.escapedRequests, 'requests that left the test').toEqual([]);
  },

  nexus: async ({ page, hs }, use) => {
    await use(new NexusPage(page, hs));
  },
});

export { expect };