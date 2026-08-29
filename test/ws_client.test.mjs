/**
 * ws_client.test.mjs — Task 4: connect, handshake, auth, reconnect.
 *
 * Properties pinned here, and the failure each one describes:
 *
 *  - `hello` goes out first and NOTHING else goes out until `welcome` arrives.
 *    A client that starts answering requests mid-handshake is acting on a
 *    connection the server has not yet agreed to.
 *  - A `reject` does not trigger an immediate retry, and a PROTOCOL_MISMATCH or
 *    HASH_MISMATCH reject stops retrying *entirely*. Both are permanent until
 *    one side is rebuilt; reconnecting achieves nothing but log noise, forever.
 *  - Backoff grows monotonically and is capped.
 *  - `disconnect()` during backoff cancels the pending timer. A zombie
 *    reconnect firing after the worker was told to stop is how an "idle"
 *    extension keeps a socket open.
 *  - The digest sent in `hello` is read at connect time, not captured once. The
 *    extension hashes the file it actually shipped; a value frozen at module
 *    load would keep reporting a digest for bytes that are no longer there.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { createClient, nextDelay, BACKOFF, KEEPALIVE_MS } from "../src/background/ws_client.js";
import { FRAME, ERR, PROTOCOL_VERSION } from "../src/shared/protocol.js";

// ─── Fakes ───────────────────────────────────────────────────────────────

class FakeSocket {
  constructor(url) {
    this.url = url;
    this.sent = [];
    this.closed = false;
    FakeSocket.instances.push(this);
  }
  send(data) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.closed = true;
    queueMicrotask(() => this.onclose?.({ code: 1000, reason: "" }));
  }
  // — test drivers —
  accept() {
    this.onopen?.();
  }
  deliver(frame) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  drop(code = 1006) {
    this.onclose?.({ code, reason: "" });
  }
}
FakeSocket.instances = [];

/** A timer table the test drives by hand. */
function fakeTimers() {
  let seq = 0;
  const pending = new Map();
  return {
    scheduled: [],
    setTimeout(fn, ms) {
      const id = ++seq;
      pending.set(id, fn);
      this.scheduled.push({ id, ms });
      return id;
    },
    clearTimeout(id) {
      pending.delete(id);
    },
    /** Fire the most recently scheduled timer, if it is still live. */
    fireLast() {
      const last = this.scheduled[this.scheduled.length - 1];
      const fn = pending.get(last.id);
      if (!fn) return false;
      pending.delete(last.id);
      fn();
      return true;
    },
    liveCount() {
      return pending.size;
    },
  };
}

function makeClient(overrides = {}) {
  FakeSocket.instances = [];
  const timers = fakeTimers();
  const states = [];
  const frames = [];
  const client = createClient({
    // ASYNC, like the real one: `getServerUrl` reads storage.local.
    // The first version of this fake returned a plain string, so
    // `new WebSocket(getUrl())` was handed a Promise in production and a
    // valid URL in every test -- the socket never opened and fourteen
    // tests stayed green.
    getUrl: async () => "ws://127.0.0.1:8790/drover",
    getToken: async () => "tok-abc",
    getDomQueryDigest: async () => "deadbeef",
    browserName: "firefox",
    extensionVersion: "0.1.0",
    onFrame: (f) => frames.push(f),
    onStateChange: (s) => states.push(s),
    deps: {
      WebSocket: FakeSocket,
      setTimeout: (fn, ms) => timers.setTimeout(fn, ms),
      clearTimeout: (id) => timers.clearTimeout(id),
    },
    ...overrides,
  });
  return { client, timers, states, frames, sockets: FakeSocket.instances };
}

/** Let queued microtasks (the async handshake) settle. */
const settle = () => new Promise((r) => setTimeout(r, 0));

// ─── Handshake ───────────────────────────────────────────────────────────

test("the url is awaited before the socket is constructed", async () => {
  // `new WebSocket(aPromise)` stringifies to "[object Promise]" and throws
  // SyntaxError: "An invalid or illegal string was specified". The client then
  // backs off forever, retrying a URL it never resolved.
  const { client, sockets } = makeClient();
  client.connect();
  await settle();
  assert.equal(sockets.length, 1, "no socket was constructed");
  assert.equal(
    sockets[0].url, "ws://127.0.0.1:8790/drover",
    `the socket was constructed with ${sockets[0].url} -- an unawaited promise ` +
      `reaches the WebSocket constructor as a string and throws`,
  );
  assert.ok(
    !String(sockets[0].url).includes("Promise"),
    "a Promise reached the WebSocket constructor",
  );
});

test("a plain (non-promise) url still works", async () => {
  // Both shapes are accepted: a host that hands over a constant should not
  // have to wrap it.
  const { client, sockets } = makeClient({ getUrl: () => "ws://127.0.0.1:9999/drover" });
  client.connect();
  await settle();
  assert.equal(sockets[0].url, "ws://127.0.0.1:9999/drover");
});

test("a url that cannot be resolved backs off rather than throwing", async () => {
  const { client, timers } = makeClient({
    getUrl: async () => { throw new Error("storage unavailable"); },
  });
  client.connect();
  await settle();
  assert.equal(client.state, "backoff");
  assert.ok(timers.scheduled.length >= 1);
});

test("hello is the first frame, and carries the full identity", async () => {
  const { client, sockets } = makeClient();
  client.connect();
  await settle();
  sockets[0].accept();
  await settle();

  assert.equal(sockets[0].sent.length, 1, "something was sent besides hello");
  assert.deepEqual(sockets[0].sent[0], {
    type: FRAME.HELLO,
    protocolVersion: PROTOCOL_VERSION,
    domQuerySha256: "deadbeef",
    token: "tok-abc",
    browser: "firefox",
    extensionVersion: "0.1.0",
  });
});

test("nothing is sent until welcome arrives", async () => {
  const { client, sockets } = makeClient();
  client.connect();
  await settle();
  sockets[0].accept();
  await settle();

  const rejected = client.send({ type: FRAME.RESPONSE, id: 1, ok: true, result: {} });
  assert.equal(rejected, false, "send() reported success while still handshaking");
  assert.equal(sockets[0].sent.length, 1, "a frame escaped before welcome");

  sockets[0].deliver({ type: FRAME.WELCOME });
  await settle();
  assert.equal(client.state, "open");
  assert.equal(client.send({ type: FRAME.RESPONSE, id: 1, ok: true, result: {} }), true);
  assert.equal(sockets[0].sent.length, 2);
});

test("the digest is read at connect time, not captured once", async () => {
  let digest = "first";
  const { client, sockets } = makeClient({ getDomQueryDigest: async () => digest });

  client.connect();
  await settle();
  sockets[0].accept();
  await settle();
  assert.equal(sockets[0].sent[0].domQuerySha256, "first");

  digest = "second";
  sockets[0].deliver({ type: FRAME.WELCOME });
  await settle();
  client.disconnect();
  await settle();

  client.connect();
  await settle();
  sockets[1].accept();
  await settle();
  assert.equal(
    sockets[1].sent[0].domQuerySha256, "second",
    "the digest was frozen at construction — the extension would keep reporting " +
      "a hash for bytes it no longer ships",
  );
});

test("frames after welcome reach onFrame; handshake frames do not", async () => {
  const { client, sockets, frames } = makeClient();
  client.connect();
  await settle();
  sockets[0].accept();
  await settle();
  sockets[0].deliver({ type: FRAME.WELCOME });
  await settle();
  sockets[0].deliver({ type: FRAME.REQUEST, id: 9, method: "tabs.list", params: {} });
  await settle();

  assert.deepEqual(frames.map((f) => f.type), [FRAME.REQUEST]);
});

// ─── Reject handling ─────────────────────────────────────────────────────

test("a transient reject backs off rather than retrying immediately", async () => {
  const { client, sockets, timers } = makeClient();
  client.connect();
  await settle();
  sockets[0].accept();
  await settle();
  sockets[0].deliver({ type: FRAME.REJECT, code: ERR.UNAUTHORIZED, reason: "bad token" });
  await settle();

  assert.equal(client.state, "backoff");
  assert.equal(sockets.length, 1, "a second socket was opened with no delay");
  assert.ok(timers.scheduled.length >= 1, "no retry was scheduled at all");
});

for (const [name, code] of [
  ["PROTOCOL_MISMATCH", ERR.PROTOCOL_MISMATCH],
  ["HASH_MISMATCH", ERR.HASH_MISMATCH],
]) {
  test(`a ${name} reject stops retrying entirely`, async () => {
    const { client, sockets, timers } = makeClient();
    client.connect();
    await settle();
    sockets[0].accept();
    await settle();
    sockets[0].deliver({ type: FRAME.REJECT, code, reason: "permanent" });
    await settle();

    assert.equal(
      client.state, "stopped",
      `${name} is permanent until a build changes. Retrying it loops forever ` +
        `and cannot ever succeed.`,
    );
    assert.equal(timers.liveCount(), 0, "a retry timer was left armed");
    assert.equal(sockets.length, 1);
  });
}

test("a stopped client ignores connect() until reset", async () => {
  const { client, sockets } = makeClient();
  client.connect();
  await settle();
  sockets[0].accept();
  await settle();
  sockets[0].deliver({ type: FRAME.REJECT, code: ERR.PROTOCOL_MISMATCH, reason: "" });
  await settle();

  client.connect();
  await settle();
  assert.equal(sockets.length, 1, "connect() reopened a permanently stopped client");

  client.reset();
  client.connect();
  await settle();
  assert.equal(sockets.length, 2, "reset() did not re-arm the client");
});

// ─── Backoff ─────────────────────────────────────────────────────────────

test("backoff grows monotonically and is capped", () => {
  const delays = [];
  for (let attempt = 0; attempt < 12; attempt++) delays.push(nextDelay(attempt));

  for (let i = 1; i < delays.length; i++) {
    assert.ok(delays[i] >= delays[i - 1], `delay went backwards at attempt ${i}`);
  }
  assert.equal(delays[0], BACKOFF.baseMs);
  assert.equal(delays.at(-1), BACKOFF.maxMs);
  assert.ok(delays.every((d) => d <= BACKOFF.maxMs), "a delay exceeded the cap");
});

test("a dropped connection reconnects after the scheduled delay", async () => {
  const { client, sockets, timers } = makeClient();
  client.connect();
  await settle();
  sockets[0].accept();
  await settle();
  sockets[0].deliver({ type: FRAME.WELCOME });
  await settle();

  sockets[0].drop();
  await settle();
  assert.equal(client.state, "backoff");

  timers.fireLast();
  await settle();
  assert.equal(sockets.length, 2, "the scheduled retry did not open a socket");
});

test("a successful handshake resets the backoff", async () => {
  const { client, sockets, timers } = makeClient();
  client.connect();
  await settle();
  sockets[0].accept();
  await settle();
  sockets[0].deliver({ type: FRAME.WELCOME });
  await settle();
  sockets[0].drop();
  await settle();
  const firstRetry = timers.scheduled.at(-1).ms;

  timers.fireLast();
  await settle();
  sockets[1].accept();
  await settle();
  sockets[1].deliver({ type: FRAME.WELCOME });
  await settle();
  sockets[1].drop();
  await settle();

  assert.equal(
    timers.scheduled.at(-1).ms, firstRetry,
    "backoff kept climbing across a successful session — a client that " +
      "reconnects fine every hour would drift to the cap and stay there",
  );
});

// ─── Keepalive ───────────────────────────────────────────────────────────
//
// Added after the fact, which is the point: the keepalive shipped with no test
// at all, so "is it firing?" could only be answered by reading a log and
// counting seconds between disconnects. It happened to work. It did not have
// to.


test("a keepalive is scheduled once the handshake completes", async () => {
  const { client, sockets, timers } = makeClient();
  client.connect();
  await settle();
  sockets[0].accept();
  await settle();

  assert.ok(
    !timers.scheduled.some((t) => t.ms === KEEPALIVE_MS),
    "a keepalive was armed before welcome; nothing may be sent mid-handshake",
  );

  sockets[0].deliver({ type: FRAME.WELCOME });
  await settle();
  assert.ok(
    timers.scheduled.some((t) => t.ms === KEEPALIVE_MS),
    `no timer at ${KEEPALIVE_MS}ms after welcome — the background context is ` +
      `suspended after ~30s idle and the socket drops`,
  );
});

test("firing the keepalive sends a ping and arms the next one", async () => {
  const { client, sockets, timers } = makeClient();
  client.connect();
  await settle();
  sockets[0].accept();
  await settle();
  sockets[0].deliver({ type: FRAME.WELCOME });
  await settle();

  const before = timers.scheduled.length;
  timers.fireLast();
  await settle();

  assert.equal(sockets[0].sent.at(-1).type, FRAME.PING, "no ping was sent");
  assert.ok(
    timers.scheduled.length > before,
    "the keepalive did not re-arm, so it fires once and the socket drops on " +
      "the next idle window",
  );
});

test("the keepalive interval is inside both engines' idle windows", () => {
  // Chromium evicts an idle service worker at ~30s; Gecko suspends an idle
  // event page on a similar timer. A keepalive at or above that is not a
  // keepalive.
  assert.ok(KEEPALIVE_MS < 30_000, `${KEEPALIVE_MS}ms is not inside the idle window`);
  assert.ok(KEEPALIVE_MS >= 5_000, `${KEEPALIVE_MS}ms is needless chatter`);
});

test("disconnecting stops the keepalive", async () => {
  const { client, sockets, timers } = makeClient();
  client.connect();
  await settle();
  sockets[0].accept();
  await settle();
  sockets[0].deliver({ type: FRAME.WELCOME });
  await settle();

  client.disconnect();
  assert.equal(
    timers.liveCount(), 0,
    "a keepalive timer survived disconnect(), so a stopped client keeps " +
      "waking itself up to talk to a socket it closed",
  );
});


// ─── Shutdown ────────────────────────────────────────────────────────────

test("disconnect() during backoff cancels the pending retry", async () => {
  const { client, sockets, timers } = makeClient();
  client.connect();
  await settle();
  sockets[0].accept();
  await settle();
  sockets[0].deliver({ type: FRAME.WELCOME });
  await settle();
  sockets[0].drop();
  await settle();
  assert.equal(timers.liveCount(), 1);

  client.disconnect();
  assert.equal(timers.liveCount(), 0, "a zombie reconnect survived disconnect()");
  assert.equal(client.state, "idle");

  assert.equal(timers.fireLast(), false, "the cancelled timer still ran");
  await settle();
  assert.equal(sockets.length, 1);
});

test("disconnect() while open closes the socket", async () => {
  const { client, sockets } = makeClient();
  client.connect();
  await settle();
  sockets[0].accept();
  await settle();
  sockets[0].deliver({ type: FRAME.WELCOME });
  await settle();

  client.disconnect();
  assert.equal(sockets[0].closed, true);
  assert.equal(client.state, "idle");
});

test("connect() while already open does not open a second socket", async () => {
  const { client, sockets } = makeClient();
  client.connect();
  await settle();
  sockets[0].accept();
  await settle();
  sockets[0].deliver({ type: FRAME.WELCOME });
  await settle();

  client.connect();
  await settle();
  assert.equal(sockets.length, 1, "a duplicate socket was opened");
});
