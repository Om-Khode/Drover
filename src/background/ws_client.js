/**
 * ws_client.js — the socket, the handshake, and getting back after a wake.
 *
 * The extension dials out; the local program listens. An extension cannot hold
 * a listening port, and a server dialling into a browser would have to know
 * which browser and when.
 *
 * ## State
 *
 *   idle ──connect()──► connecting ──socket open──► handshaking
 *                                                        │
 *                          ┌──── welcome ────────────────┤
 *                          ▼                             ▼ reject
 *                        open                      permanent? ──yes──► stopped
 *                          │                             │ no
 *                          └──── close/drop ─────────────┴──► backoff ──┐
 *                                                                       │
 *                                            ▲──────── retry timer ─────┘
 *
 * `stopped` is terminal and needs an explicit `reset()`. It is entered only on
 * PROTOCOL_MISMATCH and HASH_MISMATCH, which are the two rejections that cannot
 * become true again without one side being rebuilt. Retrying them is an
 * infinite loop that logs forever and can never succeed, so the client stops
 * and lets the operator see a stopped client rather than a busy one.
 *
 * ## Surviving a wake
 *
 * Chromium evicts an idle service worker; Gecko suspends an idle event page.
 * On wake the background file is re-evaluated from the top, and **only the
 * listeners registered during that evaluation are re-attached.** Anything
 * registered inside an `async` function, a callback, or a conditional is
 * registered once and then silently never again.
 *
 * That is why this module registers nothing itself. It exports a client;
 * `index.js` wires it up synchronously at top level, where a wake will
 * re-run the wiring. Keeping the two apart is what makes the rule checkable —
 * `index.js` is small enough to read in one screen and a test sweeps it.
 *
 * An open WebSocket resets the idle timer on every message, so an active
 * connection keeps the worker alive on its own. The alarm in `index.js` is for
 * the other case: the socket is *down*, nothing is arriving to reset anything,
 * and the worker sleeps with no retry timer surviving. `setTimeout` does not
 * outlive an evicted worker; an alarm does.
 *
 * ## No jitter
 *
 * Backoff is deterministic. Jitter exists to stop many clients retrying in
 * lockstep against one server; here there is exactly one client and one local
 * server, so jitter would buy nothing and cost a reconnect delay nobody can
 * predict from a log.
 */

import { FRAME, ERR, PROTOCOL_VERSION } from "../shared/protocol.js";

export const BACKOFF = {
  baseMs: 1_000,
  factor: 2,
  maxMs: 30_000,
};

/**
 * How often to send a keepalive while the socket is open.
 *
 * An open socket does not keep an MV3 background context alive on its own --
 * only *traffic* resets the idle timer, and a connection nobody is talking over
 * is idle by definition. Observed the result directly: connect, then
 * `disconnected` roughly every thirty to sixty seconds, then a reconnect on the
 * one-minute alarm. Functional, and it left a window every minute where the
 * browser was unreachable and a tab command would have failed for no reason the
 * user could see.
 *
 * Twenty seconds is comfortably inside both engines' idle windows (~30s) and
 * costs one tiny frame each time.
 */
export const KEEPALIVE_MS = 20_000;

/** Delay before retry number `attempt` (0-based). Monotonic, capped. */
export function nextDelay(attempt) {
  const raw = BACKOFF.baseMs * BACKOFF.factor ** attempt;
  return Math.min(raw, BACKOFF.maxMs);
}

/**
 * Rejections that cannot become true again without a rebuild on one side.
 * Everything else — a bad token, a server not up yet — is worth retrying.
 */
const PERMANENT_REJECTS = new Set([ERR.PROTOCOL_MISMATCH, ERR.HASH_MISMATCH]);

export function createClient({
  getUrl,
  getToken,
  getDomQueryDigest,
  browserName,
  extensionVersion,
  onFrame,
  onStateChange,
  deps = {},
}) {
  const WS = deps.WebSocket ?? globalThis.WebSocket;
  const setT = deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
  const clearT = deps.clearTimeout ?? ((id) => clearTimeout(id));

  let socket = null;
  let state = "idle";
  let attempt = 0;
  let retryTimer = null;
  let keepaliveTimer = null;
  /** Incremented on every connect and teardown so a late callback from a
   *  superseded socket cannot act on the current one. */
  let generation = 0;

  function setState(next, detail) {
    if (state === next) return;
    state = next;
    try {
      onStateChange?.(next, detail);
    } catch {
      // A misbehaving observer must not take the transport down with it.
    }
  }

  function clearKeepalive() {
    if (keepaliveTimer !== null) {
      clearT(keepaliveTimer);
      keepaliveTimer = null;
    }
  }

  function scheduleKeepalive() {
    clearKeepalive();
    keepaliveTimer = setT(() => {
      keepaliveTimer = null;
      if (state !== "open" || !socket) return;
      try {
        socket.send(JSON.stringify({ type: FRAME.PING }));
      } catch {
        // The socket is going away; `onclose` handles it.
        return;
      }
      scheduleKeepalive();
    }, KEEPALIVE_MS);
  }

  function clearRetry() {
    if (retryTimer !== null) {
      clearT(retryTimer);
      retryTimer = null;
    }
  }

  function teardownSocket() {
    clearKeepalive();
    if (!socket) return;
    const s = socket;
    socket = null;
    s.onopen = s.onmessage = s.onclose = s.onerror = null;
    try {
      s.close();
    } catch {
      // Already closing or dead. Nothing to do.
    }
  }

  function scheduleRetry(reason) {
    clearRetry();
    const delay = nextDelay(attempt);
    attempt += 1;
    setState("backoff", { reason, delay });
    retryTimer = setT(() => {
      retryTimer = null;
      connect();
    }, delay);
  }

  function onClosed(reason) {
    teardownSocket();
    if (state === "stopped" || state === "idle") return;
    scheduleRetry(reason);
  }

  function handleHandshakeFrame(frame) {
    if (frame.type === FRAME.WELCOME) {
      // Reset here, not on socket-open: a server that accepts the TCP
      // connection and then rejects every handshake is not a healthy server,
      // and treating it as one would retry at the base delay forever.
      attempt = 0;
      setState("open");
      scheduleKeepalive();
      return;
    }
    if (frame.type === FRAME.REJECT) {
      const permanent = PERMANENT_REJECTS.has(frame.code);
      teardownSocket();
      clearRetry();
      if (permanent) {
        setState("stopped", { code: frame.code, reason: frame.reason });
      } else {
        scheduleRetry(`reject ${frame.code}`);
      }
      return;
    }
    // Anything else before welcome is a protocol violation by the server.
    teardownSocket();
    clearRetry();
    scheduleRetry(`unexpected ${frame.type} during handshake`);
  }

  function connect() {
    if (state === "stopped") return;
    if (state === "connecting" || state === "handshaking" || state === "open") return;

    clearRetry();
    const myGeneration = ++generation;
    setState("connecting");

    // `getUrl` may be async -- the real one reads `storage.local` -- so it is
    // awaited before the constructor sees it. `new WebSocket(aPromise)`
    // stringifies its argument to "[object Promise]" and throws
    // `SyntaxError: An invalid or illegal string was specified`, and the client
    // then backs off forever against a URL it never resolved. It looks exactly
    // like a server that is not listening.
    //
    // A plain string is still accepted; `await` on a non-promise is a no-op.
    void (async () => {
      let url;
      try {
        url = await getUrl();
      } catch (e) {
        if (generation !== myGeneration) return;
        scheduleRetry(`url lookup failed: ${e}`);
        return;
      }
      if (generation !== myGeneration) return;
      if (typeof url !== "string" || url === "") {
        scheduleRetry(`url is not a string: ${JSON.stringify(url)}`);
        return;
      }
      openSocket(url, myGeneration);
    })();
  }

  function openSocket(url, myGeneration) {
    let s;
    try {
      s = new WS(url);
    } catch (e) {
      scheduleRetry(`construct failed: ${e}`);
      return;
    }
    socket = s;

    s.onopen = async () => {
      if (generation !== myGeneration) return;
      let hello;
      try {
        // Read both at connect time. The digest is of the file this build
        // actually ships; a value captured once would keep reporting a hash
        // for bytes that may have been replaced by an update.
        const [token, domQuerySha256] = await Promise.all([
          getToken(),
          getDomQueryDigest(),
        ]);
        hello = {
          type: FRAME.HELLO,
          protocolVersion: PROTOCOL_VERSION,
          domQuerySha256,
          token,
          browser: browserName,
          extensionVersion,
        };
      } catch (e) {
        if (generation !== myGeneration) return;
        onClosed(`hello build failed: ${e}`);
        return;
      }
      if (generation !== myGeneration || socket !== s) return;
      setState("handshaking");
      try {
        s.send(JSON.stringify(hello));
      } catch (e) {
        onClosed(`hello send failed: ${e}`);
      }
    };

    s.onmessage = (ev) => {
      if (generation !== myGeneration) return;
      let frame;
      try {
        frame = JSON.parse(ev.data);
      } catch {
        return; // Unparseable input is not worth tearing a session down for.
      }
      if (state === "open") {
        try {
          onFrame?.(frame);
        } catch {
          // A throwing handler must not kill the socket; the RPC layer
          // converts its own failures into error frames.
        }
        return;
      }
      handleHandshakeFrame(frame);
    };

    s.onclose = (ev) => {
      if (generation !== myGeneration) return;
      onClosed(`closed ${ev?.code ?? "?"}`);
    };

    s.onerror = () => {
      // `onclose` always follows `onerror`; retrying here too would double the
      // backoff advance for a single failure.
    };
  }

  function disconnect() {
    generation += 1;
    clearRetry();
    teardownSocket();
    if (state !== "stopped") setState("idle");
  }

  /** Re-arm a client that stopped permanently. For an operator action or a
   *  fresh install — never called automatically, or `stopped` would mean
   *  nothing. */
  function reset() {
    attempt = 0;
    setState("idle");
  }

  /**
   * Send a frame. Returns false when the socket is not open, and does NOT
   * queue: a response to a request from a session that has since dropped is
   * answering a question nobody is still asking.
   */
  function send(frame) {
    if (state !== "open" || !socket) return false;
    try {
      socket.send(JSON.stringify(frame));
      return true;
    } catch {
      return false;
    }
  }

  return {
    connect,
    disconnect,
    reset,
    send,
    get state() {
      return state;
    },
  };
}
