import { expect, vi, type Mock } from 'vitest';

export type FetchMock = Mock<typeof fetch>;

/* Replaces global fetch with a mock that plays the Matrix homeserver for the route handler under test */
export const stubHomeserverFetch = (): FetchMock => {
  const fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
};

/* Builds a homeserver reply with a JSON body, which is how Matrix homeservers answer both successes and errors */
export const jsonReply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/* Builds a non-JSON reply like the HTML error page a reverse proxy serves when the homeserver behind it is down */
export const htmlReply = (status: number) =>
  new Response('<html><body><h1>502 Bad Gateway</h1></body></html>', {
    status,
    headers: { 'Content-Type': 'text/html' },
  });

/* Behaves like real fetch against a homeserver that never answers, rejecting with the signal's AbortError once the route aborts */
export const neverAnswerUntilAborted = (_input: RequestInfo | URL, init?: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
  });

/* Returns the URL and options of the one request the route sent to the homeserver */
export const sentRequest = (fetchMock: FetchMock) => {
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [input, init] = fetchMock.mock.calls[0];
  return { url: String(input), init: init ?? {} };
};

/* Yields real macrotasks until the handler has parsed its body and called fetch, so faked setTimeout only starts counting from there */
export const waitForFetchCall = async (fetchMock: FetchMock) => {
  for (let i = 0; i < 50 && fetchMock.mock.calls.length === 0; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  expect(fetchMock).toHaveBeenCalledTimes(1);
};