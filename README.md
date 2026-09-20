# Nexus

![CI](https://github.com/ErikM9/Nexus/actions/workflows/ci.yml/badge.svg)

A Matrix protocol chat client built with Next.js 14 and matrix-js-sdk. Supports end-to-end encrypted messaging, device verification, and encrypted file uploads.

## Tech Stack

- **Framework** — Next.js 14 (App Router)
- **Matrix SDK** — matrix-js-sdk 38.4.0 with the Rust crypto backend (matrix-sdk-crypto-wasm)
- **UI** — React 18, Tailwind CSS, shadcn/ui, Radix UI primitives
- **Testing** — Vitest + Testing Library (unit), Playwright (E2E)

## Features

- End-to-end encrypted messaging via the Rust crypto backend (`initRustCrypto`)
- Device verification with emoji comparison (SAS)
- Recovery key generation, storage, and restore
- Encrypted image and file uploads
- Message reactions, edits, deletions, and threaded replies
- Room creation, joining, and invite management
- Member moderation (kick, ban)
- Dark / light theme with persistence across sessions
- Session management — forget device, wipe crypto stores

## Requirements

- Node.js 18+
- A Matrix homeserver (defaults to matrix.org)

## Setup

```bash
npm install
cp .env.example .env   # edit with your homeserver URL if not using matrix.org
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Environment Variables

```
NEXT_PUBLIC_MATRIX_HOMESERVER=https://matrix.org
MATRIX_HOMESERVER=https://matrix.org
```

Both are required. `NEXT_PUBLIC_MATRIX_HOMESERVER` is read client-side by the SDK; `MATRIX_HOMESERVER` is read server-side by the Next.js API routes (`/api/login`, `/api/logout`). To point at a self-hosted homeserver, set both to the same URL.

## Testing

```bash
# Unit tests (Vitest + jsdom)
npm test

# Unit tests with coverage report
npm run test:coverage

# E2E tests — starts the dev server automatically
npm run test:e2e

# E2E tests in a headed browser
npm run test:e2e:headed
```

Unit tests live in `tests/unit/` and are organised by layer: `matrix/` for SDK utilities, `utils/` for helpers, and `components/` for React components. E2E tests live in `tests/e2e/` and run against a locally served build.

The suite currently comprises **653 unit tests** across 24 files and **111 E2E tests** across 9 spec files (764 total).

| Layer | Files | Tests |
|---|---|---|
| Matrix utilities (`matrix/`) | 8 | 229 |
| UI utilities (`utils/`) | 3 | 98 |
| React components (`components/`) | 13 | 326 |
| E2E specs (`e2e/`) | 9 | 111 |

## Project Structure

```
src/
├── app/
│   ├── api/
│   │   ├── login/route.ts        # Server-side login proxy
│   │   └── logout/route.ts       # Server-side logout proxy
│   ├── app-components/           # Chat UI components
│   │   ├── AppHeader.tsx
│   │   ├── ChatHeader.tsx
│   │   ├── ChatList.tsx
│   │   ├── ChatWindow.tsx
│   │   ├── ErrorBoundary.tsx
│   │   ├── MemberOverlay.tsx
│   │   ├── MessageInput.tsx
│   │   ├── RoomInviteOverlay.tsx
│   │   └── SessionOverlay.tsx
│   ├── auth/
│   │   └── page.tsx              # Login page
│   ├── utils/
│   │   ├── matrix/               # Matrix client subsystem
│   │   │   ├── client.ts         # Client init, refresh, logout
│   │   │   ├── crypto.ts         # Crypto helpers, store wipe
│   │   │   ├── devices.ts        # Device verification checks
│   │   │   ├── events.ts         # Window event emitters
│   │   │   ├── recovery.ts       # Key backup and recovery
│   │   │   ├── state.ts          # Module-level singletons
│   │   │   ├── storage.ts        # Secret storage key persistence
│   │   │   ├── types.ts          # Shared types
│   │   │   └── verification.ts   # SAS verification flows
│   │   ├── matrix.ts             # Public barrel re-export
│   │   ├── helpers.ts            # Base64, file utils, reset helpers
│   │   ├── global.ts             # Global polyfills, console filter
│   │   └── ClientShell.tsx       # App chrome (header, overlays)
│   ├── client-init.tsx           # MatrixInit render-nothing component
│   ├── globals.css               # Tailwind base, glass utilities, tokens
│   ├── layout.tsx                # Root layout
│   └── page.tsx                  # Chat page
├── components/ui/                # shadcn/ui primitives
│   ├── button.tsx
│   ├── card.tsx
│   ├── dropdown-menu.tsx
│   ├── input.tsx
│   ├── label.tsx
│   ├── scroll-area.tsx
│   ├── select.tsx
│   └── theme-provider.tsx
├── lib/
│   └── utils.ts                  # cn() Tailwind merge utility
└── types/
    └── global.d.ts               # Window interface augmentations (__matrix_ready, __cryptoReady)

tests/
├── setup.ts                      # jsdom mocks (localStorage, crypto, IndexedDB)
├── __mocks__/
│   └── matrix-js-sdk.ts          # Manual SDK mock (MockMatrixClient, MockRoom, …)
├── unit/
│   ├── matrix/                   # Matrix utility tests (client, crypto, devices, …)
│   ├── utils/                    # Helper and utility tests
│   └── components/               # React component tests
└── e2e/                          # Playwright specs
    ├── fixtures.ts               # Shared session setup helper
    ├── auth.spec.ts
    ├── chat.spec.ts
    ├── encryption.spec.ts
    ├── file-uploads.spec.ts
    ├── keyboard.spec.ts
    ├── message-flow.spec.ts
    ├── network.spec.ts
    ├── room-management.spec.ts
    └── theme.spec.ts
```

## CI

GitHub Actions runs on every push and PR to `main`:

1. **Lint** — ESLint
2. **Unit tests** — Vitest with V8 coverage; coverage report uploaded as artifact
3. **E2E tests** — Playwright on Chromium against the production build; traces and screenshots uploaded on failure

## Notes

The Rust crypto backend stores its IndexedDB databases under names that differ from the legacy JS crypto backend. If you switch backends or need to debug encryption issues, look for `matrix-sdk-crypto` in the browser's IndexedDB panel rather than `matrix-js-sdk`.

Recovery keys are stored base64-encoded in `localStorage` (`mx_ssk_private_key_b64`) for session persistence. "Forget this session" clears them along with all local crypto stores.

Webpack is configured with `asyncWebAssembly: true` (in `next.config.mjs`) for the crypto WASM module.

The E2E specs have a known limitation: most chat interaction tests (sending messages, verifying room state) are crash guards rather than full behavioural assertions because they require a running Matrix homeserver. Adding `page.route()` intercepts for Matrix API calls would allow the SDK to initialise and make those tests real.

## License

MIT