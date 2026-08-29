/**
 * popup_logic.js — what the popup does, separated from what it looks like.
 *
 * Split out so it can be tested without a DOM. `popup.js` is the thin wiring
 * that reads the fields and paints the result.
 */

import { setToken, setServerUrl, clearToken } from "../background/settings.js";

/**
 * Hostnames that mean "this machine".
 *
 * An allowlist. Drover drives the browser on behalf of a program running here;
 * pointing it at a remote host would stream the contents of the user's pages
 * somewhere they did not choose, and the popup is the one place that address
 * can be typed. A blocklist would have to anticipate every way of spelling a
 * remote address — `[::ffff:8.8.8.8]` spells a public IPv4 in IPv6 clothing.
 */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

export function isLoopbackUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "ws:" && u.protocol !== "wss:") return false;
  return LOOPBACK_HOSTS.has(u.hostname);
}

const STATE_TEXT = {
  idle: "Not connected.",
  connecting: "Opening a connection…",
  handshaking: "Connected, verifying…",
  open: "Connected.",
  backoff: "Disconnected. Retrying shortly.",
  stopped: "Stopped. This build and the server disagree — reconnecting cannot help.",
};

/**
 * Never returns undefined: an unlabelled state renders as itself, not as a gap.
 *
 * `detail` carries the server's own reason, and it is shown wherever there is
 * one. "Disconnected, retrying" is not an answer when the server said
 * "another extension is already connected" — the user can act on the second
 * and can only wait on the first.
 */
export function describeState(state, detail) {
  const base = STATE_TEXT[state] ?? `Unknown state: ${String(state)}`;
  const reason = detail && (detail.reason || detail.code !== undefined
    ? detail.reason || `code ${detail.code}`
    : null);
  if (!reason) return base;
  if (state === "stopped") return `${base}
(${reason})`;
  return `${base} — ${reason}`;
}

/** True while the socket is usable. Drives which controls the popup shows. */
export function isLive(state) {
  return state === "open";
}

/**
 * Store the credential and ask the background to connect.
 *
 * Nothing is stored until it passes validation, and a token the server
 * rejected is removed again — leaving it behind would make every later
 * reconnect retry a credential already known to be wrong, on a one-minute
 * alarm, indefinitely.
 */
export async function submitToken({ token, url }, deps) {
  const trimmed = String(token ?? "").trim();
  if (trimmed === "") {
    return { ok: false, error: "Enter the token the local program gave you." };
  }
  if (!isLoopbackUrl(url)) {
    return {
      ok: false,
      error:
        "The server address must be a loopback WebSocket URL " +
        "(ws://127.0.0.1:…). Drover only talks to a program on this machine.",
    };
  }

  await setServerUrl(url, deps);
  await setToken(trimmed, deps);

  const reply = await deps.sendMessage({ kind: "drover:connect" });

  if (reply?.state === "stopped") {
    await clearToken(deps);
    const reason = reply?.detail?.reason ?? "the server refused the handshake";
    return { ok: false, error: `Refused: ${reason}` };
  }
  return { ok: true, state: reply?.state ?? "connecting" };
}
