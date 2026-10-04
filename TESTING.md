# Testing Nexus

This document describes how Nexus is tested: what each level of the suite covers, how to run it, and the conventions every test follows.

## At a glance

| Level | Tool | Where | Count | Runs against |
|---|---|---|---|---|
| Unit | Vitest | `tests/unit/{matrix,utils,api,timeline}` | 422 | Pure logic, route handlers, and the Matrix modules, with real SDK objects or SDK-shaped doubles and no network |
| Component | Vitest + Testing Library (jsdom) | `tests/unit/components` | 355 | React components in jsdom, fed real `MatrixClient`/`Room`/`MatrixEvent` instances wherever they read Matrix state |
| End-to-end | Playwright (Chromium) | `tests/e2e` | 206 | The production build and the real SDK, including Rust crypto, against a fake homeserver answering through `page.route` |

## Running the tests

```bash
npm test                      # unit and component tests
npm run test:coverage         # the same, with V8 coverage and the enforced thresholds
npm run test:e2e              # builds the app, serves it on :3000 and runs every Playwright spec
npm run test:e2e:smoke        # the critical journeys only (about a minute)
npm run test:e2e:regression   # edge cases and failure paths beyond the critical journeys
npm run test:e2e:a11y         # the WCAG 2.1 AA scans
npm run verify                # lint, type check, unit and E2E, the same gates as CI
```

Useful filters:

```bash
npx playwright test room-management   # one E2E spec
npx vitest run -t "token refresh"     # every unit or component test whose name matches
npx playwright test --ui              # Playwright's UI mode, for debugging
```

The E2E suite needs no Matrix server and no network access. `playwright.config.ts` builds the app with placeholder homeserver URLs, and every request the app makes to `/_matrix/…` or `/api/…` is intercepted in the browser and answered by the fake homeserver, which runs in the Playwright test process.

## The test pyramid

### Unit tests

Pure functions and modules with clear inputs and outputs: date arithmetic (`utils/dates.ts`), the media-type allow-list and image upload plan (`utils/media.ts`), the upload retry (`utils/upload.ts`), power-level rules (`matrix/permissions.ts`), the session store, recovery-key handling, verification state, the tab lock, and the two Next.js route handlers (`/api/login`, `/api/logout`, run in Vitest's Node environment with a stubbed `fetch`).

Wherever code reads Matrix state, the tests use **real SDK objects**. `tests/unit/support/matrixRoom.ts` and `tests/unit/timeline/sdk-fixtures.ts` build a real `MatrixClient` with an in-memory store and real `Room` and `MatrixEvent` instances fed the way sync feeds them, so the SDK's own logic (power levels, edits, redactions, relations, send status) runs in the test. Doubles stand in only at the network boundary (`sendEvent`, `uploadContent`, `fetch`), for the client lifecycle (`client.test.ts` drives an SDK-shaped fake through start-up and sign-out), for the Matrix layer in the session-panel and header component tests, and for browser APIs jsdom doesn't have (IndexedDB, Web Crypto, Web Locks).

### Component tests

React components rendered with Testing Library and driven with `user-event`, asserting what a user sees and does: roles, labels, text, focus. They cover interaction logic that is hard to reach end to end, such as IME composition, focus trapping in dialogs, stale search responses, and invitations across a sign-out.

### End-to-end tests

Playwright drives the **production build** (`next build` + `next start`) in Chromium. The app's real code, including `matrix-js-sdk` and its Rust crypto WebAssembly, talks to a fake Matrix homeserver implemented in `tests/e2e/support/homeserver.ts` and installed with `page.route`:

- **Stateful:** rooms, membership, state events, a sync stream with long-polling and limited ("gappy") syncs, `/messages` pagination, redactions, media upload and download (plain and authenticated endpoints), key backup versions, device keys (properly ed25519-signed for other users' devices), to-device messages, the room directory, and refresh tokens with expiry and rotation.
- **Fault injection:** `failNext()` answers a matching request with an error, `delay()` holds a request, `setReachable(false)` makes the server unreachable, and `expireAccessTokens()` expires every access token.
- **Isolated:** each test gets its own fake (`tests/e2e/support/fixtures.ts`), seeded through its API (`addRoom`, `say`, `inviteMe`, `addDevice`…). No state is shared between tests.
- **Hermetic:** a catch-all route aborts any request to another origin, and the fixture fails the test if the app tried to reach one.
- **Observable:** every request is recorded, so tests can assert what reached the server (`requestsTo()`, `sentEvents()`), for example that an encrypted upload carries no file name.

User journeys and locators live in one page object, `tests/e2e/support/nexus-page.ts`, so specs read as behaviour and a UI change is fixed in one place.

The specs are organised by feature:

| Spec | Covers |
|---|---|
| `auth.spec.ts` | Sign-in, stored sessions, token refresh, logout, switching accounts |
| `connection.spec.ts` | Slow and unreachable homeservers, start-up races, the crypto WASM download |
| `session.spec.ts` | Recovery keys, key backup restore, session verification, multi-tab use, forgetting a session |
| `message-flow.spec.ts` | Reading, sending, replies, edits, deletion, reactions, threads, dates, scrolling, gappy syncs |
| `file-uploads.spec.ts` | Picking, validating, compressing, encrypting and receiving attachments |
| `room-management.spec.ts` | Room list, creating, joining, the room menu, invitations sent, leaving |
| `room-settings.spec.ts` | Renaming, privacy, encryption, members, roles, moderation, device verification |
| `invites.spec.ts` | Invitations received |
| `app-shell.spec.ts` | Theme, keyboard access to the header, the phone layout, WCAG scans |

## Tags

| Tag | Meaning | Count |
|---|---|---|
| `@smoke` | The critical journeys: sign in, read and send messages, send an encrypted image, create and join rooms, accept an invitation, create a recovery key, log out. CI runs these first so a broken build fails fast. | 12 |
| `@regression` | The detailed behaviour beyond the critical journeys: edge cases, races, failure handling, security rules and keyboard paths. | 93 |
| `@a11y` | WCAG 2.1 A/AA scans with axe-core, in light and dark mode. | 4 |

## Conventions

1. **One behaviour per test, described from the user's side.** Titles are present tense and say what happens ("keeps the open chat when another room is left"), never "should…" and never implementation details.
2. **Arrange, act, assert,** separated by blank lines. Everything a test needs is seeded through the fake homeserver or component props. Tests never depend on each other or on execution order.
3. **Accessible locators first.** `getByRole`, `getByLabel` and `getByText` come before `getByTestId`, and CSS selectors are used only where nothing accessible exists (the axe scopes, which only accept CSS).
4. **No arbitrary sleeps.** Waiting is done with web-first assertions (`toBeVisible`, `toHaveText`) and `expect.poll`. Time-dependent behaviour uses Playwright's clock (`page.clock`) or Vitest's fake timers.
5. **Doubles must match reality.** A test double returns what the real SDK or server returns (real `MatrixError`/`ConnectionError` classes, real enum values, real `Device` objects). A test that only passes because of an impossible mock is rewritten or deleted.
6. **Security tests are defensive.** They assert the safe outcome (for example "a received HTML file becomes an `application/octet-stream` blob") with harmless content. No test contains a working exploit.
7. **Quiet output.** Expected console output is asserted with a spy rather than printed, and the SDK's diagnostic logger is silenced in `tests/setup.ts`.

## Accessibility testing

- `app-shell.spec.ts` runs axe-core with the `wcag2a`, `wcag2aa`, `wcag21a` and `wcag21aa` rules over the sign-in page and the chat screen, in both themes (`useTheme()` from `tests/e2e/support/contrast.ts` starts a page in either theme).
- The `color-contrast` rule is disabled in those scans: the palette is a design decision and is not held to the AA ratios. The NEXUS wordmark is excluded as well, as WCAG 1.4.3 sets no contrast requirement for logotypes.
- Keyboard journeys (opening rooms, room menus, reactions, header menus, member actions) are tested with the keyboard alone, asserting where focus goes.

## Coverage

`npm run test:coverage` measures the unit and component tests over `src/`, and CI fails when coverage drops below the thresholds in `vitest.config.ts` (80% of lines and statements, 78% of branches, 72% of functions, a few points under the current figures). Generated shadcn/ui primitives, the page shells and the client bootstrap are excluded, because they only wire components together and the E2E suite covers them end to end.

## Continuous integration

`.github/workflows/ci.yml` runs on every push and pull request to `main`:

1. **Lint and type check:** ESLint and `tsc --noEmit`.
2. **Unit and component tests** with coverage thresholds. The coverage report is uploaded as an artifact.
3. **End-to-end tests:** a production build, the `@smoke` tests first, then the full suite on one worker with two retries. The HTML report, traces, screenshots and videos are uploaded when anything fails, and failures are annotated on the pull request.

## Known limits

- **One browser engine.** The suite runs on Chromium, the engine the fake homeserver and the Rust crypto WASM were validated on. Firefox and WebKit projects can be added to `playwright.config.ts`.
- **A fake homeserver, not Synapse.** The fake implements the parts of the client-server API the app uses and was built against the Matrix spec, but a nightly run against a real homeserver in a container would catch protocol drift.
- **Input methods.** Playwright can't drive a real IME, so composition handling is covered by component tests that dispatch composing keyboard events.
- **Server-side route.** `/api/login` runs on the Next.js server, which a browser route can't intercept, so its behaviour is covered by route-handler unit tests. The E2E suite stands in for it with `mockAppApi()`.