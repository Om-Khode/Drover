/**
 * detect.js — which browser this is, for logging only.
 *
 * The value travels in `hello` and is a HINT. It is self-reported by an
 * extension the server did not write, so it must never gate authorisation —
 * only what a log line says and, at most, which known quirk to expect.
 *
 * Detection is by capability and user agent, in that order, because Chromium
 * forks are deliberately hard to tell apart and all of them are the same build
 * anyway. Getting it wrong costs a wrong word in a log.
 */

export function detectBrowser(ua = globalThis.navigator?.userAgent ?? "") {
  if (typeof globalThis.browser !== "undefined" && /Firefox\//.test(ua)) return "firefox";
  if (/Firefox\//.test(ua)) return "firefox";
  if (/Edg\//.test(ua)) return "edge";
  if (/OPR\//.test(ua)) return "opera";
  if (globalThis.navigator?.brave) return "brave";
  if (/Chrome\//.test(ua)) return "chrome";
  return "other";
}
