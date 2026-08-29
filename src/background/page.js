/**
 * page.js — the page verbs, driven through `scripting.executeScript`.
 *
 * Two injections per query, and the reason is structural rather than lazy:
 * `dom_query.js` is a bare arrow-function expression, so injecting the file
 * evaluates it and throws the value away. The build emits `dom_query.entry.js`
 * — the identical bytes with an assignment around them — which defines the
 * function on the page; a second call then invokes it and returns the result.
 * MV3 forbids `eval` and `new Function`, so re-hydrating from text is not an
 * option, and the unwrapped file has to keep shipping unmodified because that
 * is the copy the handshake hashes.
 *
 * Functions passed as `func` are serialised to source by the browser. They
 * cannot close over anything in this bundle, which is why every value they need
 * arrives through `args` and why they live in `content/bridge.js` written in
 * that self-contained style.
 */

import { ERR, IDX_ATTR, ACTIONS } from "../shared/protocol.js";
import { RpcError } from "./rpc.js";
import { resolveTabId } from "./tabs.js";
import { PAGE_QUERY_GLOBAL, queryInPage, actInPage, infoInPage } from "../content/bridge.js";

const QUERY_ENTRY_FILE = "dom_query.entry.js";

/**
 * Run one injection and unwrap the single frame's result.
 *
 * An injection that returns nothing means the content script never ran — a
 * privileged URL, a page whose CSP refused it, or a tab that navigated
 * mid-call. That is INJECTION_BLOCKED, a distinct answer from "the page had no
 * such element", and a caller must be able to tell them apart: one is worth
 * retrying elsewhere, the other is not.
 */
async function inject(ctx, tabId, injection) {
  let frames;
  try {
    frames = await ctx.browser.scripting.executeScript({
      target: { tabId },
      ...injection,
    });
  } catch (e) {
    throw new RpcError(
      ERR.INJECTION_BLOCKED,
      `cannot run in tab ${tabId}: ${e && e.message ? e.message : String(e)}`,
    );
  }
  if (!Array.isArray(frames) || frames.length === 0) {
    throw new RpcError(ERR.INJECTION_BLOCKED, `no injection result from tab ${tabId}`);
  }
  return frames[0].result;
}

export async function pageQuery(params, ctx) {
  const tabId = await resolveTabId(params, ctx);

  await inject(ctx, tabId, { files: [QUERY_ENTRY_FILE] });

  const cfg = {
    filter: params.filter ?? "interactive",
    openComboboxes: Boolean(params.openComboboxes),
  };
  const result = await inject(ctx, tabId, {
    func: queryInPage,
    args: [PAGE_QUERY_GLOBAL, cfg],
  });

  if (result && result.__droverError) {
    throw new RpcError(ERR.INJECTION_BLOCKED, result.__droverError);
  }
  if (!result || !Array.isArray(result.elements)) {
    // An empty tree and a broken query look identical downstream, and the
    // downstream answer is a confident "there is nothing to click".
    throw new RpcError(ERR.INTERNAL, "the query returned no element list");
  }
  return result;
}

export async function pageAct(params, ctx) {
  const tabId = await resolveTabId(params, ctx);

  const idx = params.idx;
  if (typeof idx !== "number" || !Number.isInteger(idx) || idx < 0) {
    throw new RpcError(ERR.BAD_SELECTOR, `idx must be a non-negative integer, got ${JSON.stringify(idx)}`);
  }
  if (!ACTIONS.includes(params.action)) {
    // Checked before injection so the message names the real problem. An
    // unknown action reaching the page would come back as a generic failure.
    throw new RpcError(ERR.BAD_SELECTOR, `unknown action ${JSON.stringify(params.action)}`);
  }

  const out = await inject(ctx, tabId, {
    func: actInPage,
    args: [IDX_ATTR, idx, params.action, params.value ?? null],
  });

  if (!out || out.ok !== true) {
    throw new RpcError(ERR.BAD_SELECTOR, (out && out.error) || "the action reported no result");
  }
  return { ok: true };
}

export async function pageInfo(params, ctx) {
  const tabId = await resolveTabId(params, ctx);
  const out = await inject(ctx, tabId, { func: infoInPage, args: [] });
  if (!out) throw new RpcError(ERR.INJECTION_BLOCKED, `no page info from tab ${tabId}`);
  return out;
}

// ─── Navigation and capture ───────────────────────────────────────────────

/**
 * Schemes `page.goto` will navigate to.
 *
 * An allowlist, not a blocklist. `javascript:` and `data:` turn a navigation
 * verb into an arbitrary-execution verb — the caller supplies the script and
 * the page runs it with the origin's privileges. `file:` reaches the user's
 * disk. `chrome://` and `about:` reach browser settings. None of that is what
 * a navigation verb advertises, and a blocklist would have to keep up with
 * every scheme a browser invents.
 */
const NAVIGABLE_SCHEMES = new Set(["http:", "https:"]);

export async function pageGoto(params, ctx) {
  const tabId = await resolveTabId(params, ctx);

  const raw = params?.url;
  if (typeof raw !== "string" || raw === "") {
    throw new RpcError(ERR.BAD_SELECTOR, "page.goto requires a url");
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new RpcError(ERR.BAD_SELECTOR, `not a url: ${JSON.stringify(raw)}`);
  }
  if (!NAVIGABLE_SCHEMES.has(parsed.protocol)) {
    throw new RpcError(
      ERR.BAD_SELECTOR,
      `scheme ${parsed.protocol} is not navigable; only http and https are`,
    );
  }

  await ctx.browser.tabs.update(tabId, { url: parsed.href });
  return { url: parsed.href };
}

/**
 * Poll `document.readyState` until it reaches the wanted state, or give up.
 *
 * Polling rather than listening because `webNavigation` events are per-frame
 * and fire on their own schedule; the caller asked about this document. The
 * timeout is not optional: a verb that waits forever leaves the caller's own
 * timeout to fire with no reason attached, and its pending slot to leak until
 * then.
 */
export async function pageWaitLoad(params, ctx) {
  const tabId = await resolveTabId(params, ctx);
  const wanted = params?.state === "interactive" ? "interactive" : "complete";
  const budgetMs = Number.isFinite(params?.timeout) ? Number(params.timeout) : 15_000;
  const deadline = Date.now() + budgetMs;

  const ranks = { loading: 0, interactive: 1, complete: 2 };
  let last = "unknown";

  for (;;) {
    const info = await inject(ctx, tabId, { func: () => ({ readyState: document.readyState }), args: [] });
    last = info?.readyState ?? "unknown";
    if ((ranks[last] ?? -1) >= ranks[wanted]) return { state: last };
    if (Date.now() >= deadline) {
      throw new RpcError(
        ERR.TIMEOUT,
        `document was still ${JSON.stringify(last)} after ${budgetMs}ms, wanted ${wanted}`,
      );
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

/**
 * Capture the visible viewport.
 *
 * `tabs.captureVisibleTab` captures the ACTIVE tab of a window. There is no
 * full-page mode and no way to name a different tab. So a request for a
 * non-active tab is refused rather than served with a picture of whatever the
 * user is looking at — and it is emphatically not worked around by activating
 * the tab first, which would move the user's focus to satisfy a read.
 *
 * This is the one capability where Drover is worse than a CDP debug port. It is
 * documented in PROTOCOL.md rather than papered over.
 */
export async function pageScreenshot(params, ctx) {
  const [active] = await ctx.browser.tabs.query({ active: true, currentWindow: true });
  if (!active) throw new RpcError(ERR.NO_TAB, "no active tab to capture");

  if (params?.tabId !== undefined && params.tabId !== null && params.tabId !== active.id) {
    throw new RpcError(
      ERR.BAD_SELECTOR,
      `can only capture the active tab (${active.id}); ${params.tabId} is not active. ` +
        `captureVisibleTab has no way to name a tab, and activating one to take a ` +
        `screenshot would move the user's focus to satisfy a read.`,
    );
  }

  const dataUrl = await ctx.browser.tabs.captureVisibleTab(active.windowId, { format: "png" });
  if (typeof dataUrl !== "string" || dataUrl === "") {
    throw new RpcError(ERR.INJECTION_BLOCKED, "the capture returned nothing");
  }
  const comma = dataUrl.indexOf(",");
  return { png: comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl };
}
