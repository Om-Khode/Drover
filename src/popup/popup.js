/**
 * popup.js — the thin wiring. All decisions live in popup_logic.js.
 *
 * ## It polls
 *
 * The background cannot push to a popup that is closed, and a popup that reads
 * the state once at open time is wrong the moment anything changes -- which is
 * exactly what happened: the socket reconnected, the popup still said
 * "Retrying shortly", and the only way to see the truth was to close it and
 * open it again.
 *
 * One second is well under human patience and the message costs nothing.
 *
 * ## Two shapes
 *
 * Connected: no token field (the credential is stored and showing it again
 * leaves it on screen for whoever looks next), and the button disconnects.
 * Not connected: the token field, and the button connects.
 */

import browser from "webextension-polyfill";
import { submitToken, describeState, isLive } from "./popup_logic.js";
import { getServerUrl } from "../background/settings.js";

const POLL_MS = 1000;

const $ = (id) => document.getElementById(id);
const deps = { browser, sendMessage: (m) => browser.runtime.sendMessage(m) };

let pollTimer = null;
let busy = false;   // a click is in flight; the poll must not fight its message

function paint({ state, detail, paused, error }) {
  const status = $("status");
  const button = $("connect");
  const tokenRow = $("token-row");

  if (error) {
    status.textContent = error;
    status.className = "err";
    return;
  }

  const live = isLive(state);
  status.textContent = paused && !live
    ? "Disconnected. It will stay off until you connect."
    : describeState(state, detail);
  status.className = state === "stopped" ? "err" : "";

  tokenRow.hidden = live;
  button.textContent = live ? "Disconnect" : "Connect";
  button.className = live ? "danger" : "";
}

async function refresh() {
  if (busy) return;
  try {
    paint(await deps.sendMessage({ kind: "drover:getState" }));
  } catch (e) {
    paint({ error: `Cannot reach the extension's background page: ${e?.message ?? e}` });
  }
}

$("connect").addEventListener("click", async () => {
  busy = true;
  try {
    const live = isLive($("connect").textContent === "Disconnect" ? "open" : "");
    if (live) {
      paint(await deps.sendMessage({ kind: "drover:disconnect" }));
      return;
    }
    paint({ state: "connecting" });
    const out = await submitToken({ token: $("token").value, url: $("url").value.trim() }, deps);
    $("token").value = "";
    if (out.ok) paint({ state: out.state });
    else paint({ error: out.error });
  } finally {
    busy = false;
  }
});

// Initial paint, then keep it honest. Failing to reach the background is worth
// showing: a popup stuck on "Checking…" tells the user nothing.
(async () => {
  try {
    $("url").value = await getServerUrl(deps);
  } catch {
    // The default in the markup stands.
  }
  await refresh();
  pollTimer = setInterval(refresh, POLL_MS);
})();

// Popups are torn down without ceremony, but clearing up after ourselves keeps
// the interval from outliving the document in browsers that keep it around.
window.addEventListener("pagehide", () => {
  if (pollTimer !== null) clearInterval(pollTimer);
});
