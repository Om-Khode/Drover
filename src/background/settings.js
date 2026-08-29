/**
 * settings.js — the bearer token and the server URL, in extension storage.
 *
 * `storage.local` only, and never `storage.sync`. Sync replicates to every
 * machine the user is signed into on this browser, and a loopback bearer token
 * is meaningful only on the machine that minted it — copying it elsewhere
 * spreads a credential to hosts that can never use it and might leak it.
 */

/**
 * The extension APIs, injectable. Production passes nothing and gets whichever
 * global this browser provides; tests pass a fake.
 *
 * Deliberately NOT `import browser from "webextension-polyfill"`. That module
 * throws on import outside an extension page, which would make this file
 * untestable in Node — and the one assertion that matters here, that a token
 * never reaches `storage.sync`, is invisible without a fake to observe. Both
 * engines expose promise-based `storage` on one of these two globals, so the
 * polyfill buys nothing at this level.
 */
const apiOf = (deps) => deps?.browser ?? globalThis.browser ?? globalThis.chrome;

const KEY_TOKEN = "token";
const KEY_URL = "serverUrl";

/**
 * The default port is the fourth listener offset of a host's API base, and is
 * only a default: the popup can point Drover anywhere on loopback.
 */
export const DEFAULT_SERVER_URL = "ws://127.0.0.1:8790/drover";

export async function getToken(deps) {
  const stored = await apiOf(deps).storage.local.get(KEY_TOKEN);
  return stored?.[KEY_TOKEN] ?? "";
}

export async function setToken(token, deps) {
  await apiOf(deps).storage.local.set({ [KEY_TOKEN]: token });
}

export async function clearToken(deps) {
  await apiOf(deps).storage.local.remove(KEY_TOKEN);
}

/**
 * Paths this extension used to serve on, and no longer does.
 *
 * A stored URL survives an update, so an extension installed before a rename
 * keeps dialling the old path forever -- the server has no route there, the
 * socket is refused at the HTTP layer, and the popup can only report that
 * nothing answered. The user is then asked to notice, and to know, that a
 * path they never typed has changed underneath them.
 *
 * Retiring the old path here costs one comparison and removes that entirely.
 * Add to this list on the next rename; do not remove entries, because someone
 * out there has an old install that has not opened its popup yet.
 */
const RETIRED_PATHS = ["/latch"];

export async function getServerUrl(deps) {
  const stored = await apiOf(deps).storage.local.get(KEY_URL);
  const url = stored?.[KEY_URL];
  if (!url) return DEFAULT_SERVER_URL;

  if (RETIRED_PATHS.some((path) => url.endsWith(path))) {
    // Rewritten, not just ignored: the popup shows this value, and a field
    // showing a dead address the user cannot be expected to fix is worse than
    // no field at all.
    const migrated = DEFAULT_SERVER_URL;
    try {
      await apiOf(deps).storage.local.set({ [KEY_URL]: migrated });
    } catch {
      // The in-memory answer is still correct; it just will not persist.
    }
    return migrated;
  }
  return url;
}

export async function setServerUrl(url, deps) {
  await apiOf(deps).storage.local.set({ [KEY_URL]: url });
}
