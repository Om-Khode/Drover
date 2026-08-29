/**
 * digest.js — the SHA-256 of the dom_query.js this build actually ships.
 *
 * Hashed at runtime from the packaged file rather than baked in at build time,
 * deliberately. A baked constant reports what the build *believed* it shipped;
 * hashing the packaged bytes reports what is really there, which also catches a
 * corrupted or partially-applied install. The server compares this against its
 * own vendored copy and refuses the connection on a mismatch.
 *
 * Cached after the first successful read: the file cannot change while the
 * extension is running, and a failed read is not cached so a transient failure
 * does not poison every later handshake.
 */

import browser from "webextension-polyfill";

let cached = null;

export async function domQueryDigest() {
  if (cached) return cached;
  const url = browser.runtime.getURL("dom_query.js");
  const bytes = await (await fetch(url)).arrayBuffer();
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  cached = [...new Uint8Array(hash)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return cached;
}

/** Test seam. Never called in production. */
export function _resetDigestCache() {
  cached = null;
}
