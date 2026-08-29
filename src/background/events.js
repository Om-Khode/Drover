/**
 * events.js — pushing what the browser does out to the server.
 *
 * The extension is a target, not a principal: it never asks the server to do
 * anything. Events are the one thing it says unprompted, and they are reports,
 * not requests.
 *
 * ## Main frame only
 *
 * `webNavigation.onCompleted` fires for every frame on the page. Without the
 * `frameId === 0` guard, one page load with four ad iframes becomes five
 * `navigated` events, and a monitor watching for "the bank site opened" fires
 * on a tracker embedded in it instead. The guard is one line and it is the
 * difference between a usable signal and noise.
 *
 * ## Dropping is the honest behaviour
 *
 * While the socket is down there is nowhere to put events. An unbounded buffer
 * in a background worker is a leak — and worse, an evicted worker loses the
 * buffer anyway, so the leak buys nothing. A small bounded ring is kept so a
 * brief reconnect does not lose the last few seconds, and it keeps the NEWEST
 * events rather than the oldest: if anything survives, it should be what just
 * happened, not a stale burst that hides the event the caller was waiting for.
 *
 * A client that needs history should ask for it, not assume the extension
 * remembered.
 */

import { EVENTS, FRAME } from "../shared/protocol.js";

/**
 * How many events survive a disconnection. Small on purpose: this is a
 * courtesy for a reconnect that takes a second, not a durable queue.
 */
export const MAX_BUFFERED = 50;

export function createEventPusher({ send, now = () => Date.now() }) {
  /** Newest-last ring. Overflow drops from the FRONT, keeping recent events. */
  const buffer = [];

  function emit(event, payload) {
    const frame = { type: FRAME.EVENT, event, ts: now(), ...payload };
    if (send(frame)) return true;

    buffer.push(frame);
    while (buffer.length > MAX_BUFFERED) buffer.shift();
    return false;
  }

  /** Send whatever survived a disconnection. Each frame leaves the buffer as
   *  it goes, so a second flush cannot duplicate what the server already has. */
  function flush() {
    while (buffer.length > 0) {
      if (!send(buffer[0])) return;
      buffer.shift();
    }
  }

  // ─── Browser event adapters ─────────────────────────────────────────────
  // Called by the listeners registered in index.js. Kept here so the entry
  // point stays a wiring file that can be read in one screen.

  function onTabCreated(tab) {
    emit(EVENTS.TAB_OPENED, { tabId: tab?.id, url: tab?.url ?? "", title: tab?.title ?? "" });
  }

  function onTabRemoved(tabId) {
    emit(EVENTS.TAB_CLOSED, { tabId });
  }

  function onNavigationCompleted(details) {
    if (details?.frameId !== 0) return; // sub-frame: an ad, not a navigation
    emit(EVENTS.NAVIGATED, { tabId: details.tabId, url: details.url ?? "" });
  }

  function onDownloadCreated(item) {
    emit(EVENTS.DOWNLOAD_STARTED, {
      downloadId: item?.id,
      url: item?.url ?? "",
      filename: item?.filename ?? "",
    });
  }

  function onDownloadChanged(delta) {
    // `onDownloadChanged` fires for every field that changes -- filename,
    // byte count, danger flag. Only a transition INTO the complete state is a
    // finish; "interrupted" and "in_progress" are not, and reporting them as
    // one would tell a caller a file is ready when it is not.
    if (delta?.state?.current !== "complete") return;
    emit(EVENTS.DOWNLOAD_FINISHED, { downloadId: delta.id });
  }

  return {
    emit,
    flush,
    onTabCreated,
    onTabRemoved,
    onNavigationCompleted,
    onDownloadCreated,
    onDownloadChanged,
    bufferedCount: () => buffer.length,
    peekBuffered: () => buffer.slice(),
  };
}
