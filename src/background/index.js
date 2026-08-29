/**
 * index.js — background entry point. Wiring only, and all of it at top level.
 *
 * ## The one rule this file exists to keep checkable
 *
 * Chromium evicts an idle service worker; Gecko suspends an idle event page. On
 * wake the file is re-evaluated from the top, and **only the listeners
 * registered during that evaluation are re-attached.** A listener registered
 * inside an `async` function, a callback, or an `if` runs once — on the first
 * evaluation — and is then silently absent for the rest of the browser session.
 * Nothing errors. The extension simply stops responding to that event.
 *
 * So every `addListener` in this extension lives here, unconditionally, at the
 * top level of the module body. `test/wake.test.mjs` sweeps this file and fails
 * on a registration at any deeper nesting. Keeping the wiring separate from the
 * transport is what lets that sweep be simple enough to trust.
 *
 * ## Why an alarm as well as the socket
 *
 * An open WebSocket resets the idle timer on every message, so a live
 * connection keeps the worker awake by itself. The alarm covers the opposite
 * case: the socket is *down*, so nothing is arriving to reset anything, and the
 * worker sleeps. `setTimeout` does not survive eviction — the pending reconnect
 * dies with the worker and nothing ever wakes it. An alarm does survive, and
 * re-entering this file re-runs `client.connect()` below.
 *
 * One minute is the floor Chromium enforces on `alarms` in released builds;
 * asking for less silently gets one minute anyway.
 */

import browser from "webextension-polyfill";
import { createClient } from "./ws_client.js";
import { getToken, getServerUrl } from "./settings.js";
import { domQueryDigest } from "./digest.js";
import { detectBrowser } from "./detect.js";
import { dispatch } from "./rpc.js";
import { createEventPusher } from "./events.js";
import { FRAME } from "../shared/protocol.js";

const RECONNECT_ALARM = "drover-reconnect";

/** The last state the client reported, and why. Read by the popup. */
let lastState = { state: "idle", detail: null };

/**
 * Set when the user presses Disconnect, cleared when they press Connect.
 *
 * Without it the reconnect alarm would put the socket back within the minute
 * and the button would be a lie. Kept in storage rather than memory because
 * the background context is evicted when idle, and a decision the user made
 * must not be forgotten by a suspension they never saw.
 */
const KEY_PAUSED = "pausedByUser";

const client = createClient({
  getUrl: getServerUrl,
  getToken,
  getDomQueryDigest: domQueryDigest,
  browserName: detectBrowser(),
  extensionVersion: browser.runtime.getManifest().version,
  onFrame: (frame) => {
    if (frame?.type !== FRAME.REQUEST) return;
    // `dispatch` never rejects, so this promise always settles into a frame.
    // Not awaited: requests run concurrently and each answers on its own id.
    dispatch(frame, { browser }).then((response) => client.send(response));
  },
  onStateChange: (state, detail) => {
    // Remembered so the popup can ask. The popup is not always open, and the
    // background cannot push to one that is closed -- so the state and the
    // reason for it are kept here and polled.
    lastState = { state, detail: detail ?? null };
    console.log(`[drover] ${state}`, detail ?? "");
    // Anything buffered while the socket was down goes out once it is up
    // again. Not on every state change -- only on the one that means the
    // server is listening.
    if (state === "open") events.flush();
  },
});

const events = createEventPusher({ send: (frame) => client.send(frame) });

// ─── Listener registrations. Top level, unconditional, no exceptions. ─────

browser.runtime.onStartup.addListener(() => {
  client.connect();
});

browser.runtime.onInstalled.addListener(() => {
  client.connect();
});

browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== RECONNECT_ALARM) return;
  // Registered synchronously; the async check happens inside, which is fine --
  // the listener itself is what has to exist at wake time, not its body.
  isPaused().then((paused) => {
    if (paused) return;
    client.connect(); // no-op unless the client is idle or backing off
  });
});

browser.tabs.onCreated.addListener((tab) => {
  events.onTabCreated(tab);
});

browser.tabs.onRemoved.addListener((tabId) => {
  events.onTabRemoved(tabId);
});

browser.webNavigation.onCompleted.addListener((details) => {
  events.onNavigationCompleted(details);
});

browser.downloads.onCreated.addListener((item) => {
  events.onDownloadCreated(item);
});

browser.downloads.onChanged.addListener((delta) => {
  events.onDownloadChanged(delta);
});

browser.runtime.onMessage.addListener((message) => {
  // The popup asks for state and asks to (re)connect. Returning a promise is
  // the polyfill's contract for an async reply.
  if (message?.kind === "drover:getState") {
    // The live state wins; `lastState.detail` carries the reason, which the
    // client itself does not keep. A popup that says "Stopped" without saying
    // why sends the user to a log they should not have to read.
    return isPaused().then((paused) => ({
      state: client.state,
      detail: lastState.detail,
      paused,
    }));
  }
  if (message?.kind === "drover:connect") {
    return setPaused(false).then(() => {
      client.reset();
      client.connect();
      return { state: client.state, detail: null, paused: false };
    });
  }
  if (message?.kind === "drover:disconnect") {
    return setPaused(true).then(() => {
      client.disconnect();
      return { state: client.state, detail: null, paused: true };
    });
  }
  return undefined;
});

// ─── Helpers ─────────────────────────────────────────────────────────────
//
// Declared BELOW the registrations on purpose. Function declarations hoist, so
// the listeners above can call them -- and `test/wake.test.mjs` refuses any
// `await` in the text before the first `addListener`. That guard is worth
// keeping absolutely strict: it cannot tell a function body from code that
// runs, and the failure it exists to catch (a listener registered after an
// await, so a wake never re-registers it) is silent.

async function isPaused() {
  try {
    const stored = await browser.storage.local.get(KEY_PAUSED);
    return Boolean(stored?.[KEY_PAUSED]);
  } catch {
    // Storage unreadable: treat as not paused. The alarm reconnecting is a
    // smaller surprise than a client that never comes back and cannot say why.
    return false;
  }
}

async function setPaused(value) {
  try {
    await browser.storage.local.set({ [KEY_PAUSED]: Boolean(value) });
  } catch {
    // Nothing useful to do; the in-memory disconnect still took effect.
  }
}
const RECONNECT_PERIOD_MINUTES = 1;


// ─── Startup. Also runs on every wake, which is the point. ───────────────

browser.alarms.create(RECONNECT_ALARM, { periodInMinutes: RECONNECT_PERIOD_MINUTES });

// Not on a wake the user paused. `connect()` here runs on every evaluation of
// this file, which is what makes the extension survive eviction -- and which
// would also undo a Disconnect the moment the worker was suspended.
isPaused().then((paused) => {
  if (!paused) client.connect();
});

export { client };
