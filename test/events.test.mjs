/**
 * events.test.mjs — Task 8: pushing browser events out.
 *
 * Three properties, each describing a specific way this goes wrong quietly:
 *
 *  - `webNavigation.onCompleted` fires for EVERY frame. Without a main-frame
 *    guard, one page load with four ad iframes becomes five `navigated` events,
 *    and a monitor watching for "she opened the bank site" fires on the
 *    tracker embedded in it.
 *  - Events emitted while the socket is down are dropped, not queued without
 *    bound. An unbounded buffer in a worker that gets evicted is a leak that
 *    also loses its contents — the worst of both.
 *  - Every listener registration stays in the background entry point, so a
 *    wake re-registers it. `wake.test.mjs` enforces that; this file checks the
 *    handlers those registrations call.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { createEventPusher, MAX_BUFFERED } from "../src/background/events.js";
import { EVENTS, FRAME } from "../src/shared/protocol.js";

function pusher({ connected = true } = {}) {
  const sent = [];
  let open = connected;
  const p = createEventPusher({
    send: (frame) => {
      if (!open) return false;
      sent.push(frame);
      return true;
    },
    now: () => 1_700_000_000_000,
  });
  return { p, sent, setOpen: (v) => { open = v; } };
}

// ─── Shape ───────────────────────────────────────────────────────────────

test("an event frame carries type, event, ts and its payload", () => {
  const { p, sent } = pusher();
  p.emit(EVENTS.TAB_OPENED, { tabId: 3, url: "https://example.invalid/" });
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], {
    type: FRAME.EVENT,
    event: EVENTS.TAB_OPENED,
    ts: 1_700_000_000_000,
    tabId: 3,
    url: "https://example.invalid/",
  });
});

test("every documented event name can be emitted", () => {
  const { p, sent } = pusher();
  const names = Object.values(EVENTS);
  assert.ok(names.length >= 5, "the event table shrank unexpectedly");
  for (const name of names) p.emit(name, {});
  assert.deepEqual(sent.map((f) => f.event), names);
});

// ─── Main frame only ─────────────────────────────────────────────────────

test("navigation in a sub-frame produces no event", () => {
  const { p, sent } = pusher();
  p.onNavigationCompleted({ tabId: 5, frameId: 1, url: "https://ads.invalid/pixel" });
  assert.equal(
    sent.length, 0,
    "a sub-frame navigation was reported. One page load with four ad iframes " +
      "would become five events, and a monitor watching for a site would fire " +
      "on a tracker embedded in it.",
  );
});

test("navigation in the main frame produces exactly one event", () => {
  // The permitted path. A guard that dropped everything would pass the test
  // above and emit nothing at all.
  const { p, sent } = pusher();
  p.onNavigationCompleted({ tabId: 5, frameId: 0, url: "https://example.invalid/page" });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].event, EVENTS.NAVIGATED);
  assert.equal(sent[0].tabId, 5);
  assert.equal(sent[0].url, "https://example.invalid/page");
});

// ─── Downloads ───────────────────────────────────────────────────────────

test("a created download reports started", () => {
  const { p, sent } = pusher();
  p.onDownloadCreated({ id: 9, url: "https://example.invalid/f.zip", filename: "f.zip" });
  assert.equal(sent[0].event, EVENTS.DOWNLOAD_STARTED);
  assert.equal(sent[0].downloadId, 9);
});

test("a download reports finished only when it actually completes", () => {
  const { p, sent } = pusher();
  p.onDownloadChanged({ id: 9, state: { current: "in_progress" } });
  assert.equal(sent.length, 0, "an in-progress change was reported as finished");
  p.onDownloadChanged({ id: 9, state: { current: "interrupted" } });
  assert.equal(sent.length, 0, "an interrupted download was reported as finished");
  p.onDownloadChanged({ id: 9, state: { current: "complete" } });
  assert.deepEqual(sent.map((f) => f.event), [EVENTS.DOWNLOAD_FINISHED]);
});

test("a change with no state transition is ignored", () => {
  const { p, sent } = pusher();
  p.onDownloadChanged({ id: 9, filename: { current: "renamed.zip" } });
  assert.equal(sent.length, 0);
});

// ─── While the socket is down ────────────────────────────────────────────

test("events emitted while disconnected are dropped, not queued unbounded", () => {
  const { p, sent, setOpen } = pusher();
  setOpen(false);
  for (let i = 0; i < MAX_BUFFERED * 5; i++) p.emit(EVENTS.TAB_OPENED, { tabId: i });
  assert.equal(sent.length, 0);
  assert.ok(
    p.bufferedCount() <= MAX_BUFFERED,
    `buffered ${p.bufferedCount()} events with a cap of ${MAX_BUFFERED}. An ` +
      `unbounded buffer in a worker that gets evicted is a leak that also ` +
      `loses its contents.`,
  );
});

test("the buffer keeps the newest events, not the oldest", () => {
  // If anything is kept at all, it should be what just happened. A FIFO that
  // drops new arrivals delivers a stale burst on reconnect and hides the
  // event the caller was actually waiting for.
  const { p, setOpen } = pusher();
  setOpen(false);
  for (let i = 0; i < MAX_BUFFERED + 10; i++) p.emit(EVENTS.TAB_OPENED, { tabId: i });
  const kept = p.peekBuffered().map((f) => f.tabId);
  assert.equal(kept.at(-1), MAX_BUFFERED + 9, "the newest event was dropped");
});

test("reconnecting flushes what was buffered, once", () => {
  const { p, sent, setOpen } = pusher();
  setOpen(false);
  p.emit(EVENTS.TAB_OPENED, { tabId: 1 });
  p.emit(EVENTS.TAB_CLOSED, { tabId: 1 });
  assert.equal(sent.length, 0);

  setOpen(true);
  p.flush();
  assert.deepEqual(sent.map((f) => f.event), [EVENTS.TAB_OPENED, EVENTS.TAB_CLOSED]);

  p.flush();
  assert.equal(sent.length, 2, "a second flush re-sent events the server already had");
});

test("a failed send does not silently discard the event", () => {
  const { p, setOpen } = pusher();
  setOpen(false);
  p.emit(EVENTS.NAVIGATED, { tabId: 1 });
  assert.equal(p.bufferedCount(), 1, "the event vanished instead of being buffered");
});
