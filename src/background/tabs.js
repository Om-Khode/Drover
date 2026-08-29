/**
 * tabs.js — tab resolution and the tab verbs.
 *
 * ## Resolution, and the one rule
 *
 * Every `page.*` verb needs a tab. The order is: an explicit `params.tabId`,
 * then the active tab, then **an error** — never a silent fallback.
 *
 * The failure this prevents is specific. A caller that omits `tabId` by mistake,
 * or names a tab the user closed a second ago, must not quietly get whatever tab
 * happens to be in front right now. That is how an automated form fills and
 * submits in a window nobody was looking at. An error is recoverable; acting on
 * the wrong page is not.
 *
 * An explicit `tabId` is verified to still exist rather than trusted, and a
 * `tabId` that has gone away is NO_TAB — it does **not** fall through to the
 * active tab, for the same reason.
 */

import { ERR } from "../shared/protocol.js";
import { RpcError } from "./rpc.js";

/** Only the fields PROTOCOL.md documents. Everything else stays in the browser. */
function publicTab(t) {
  return {
    id: t.id,
    url: t.url ?? "",
    title: t.title ?? "",
    active: Boolean(t.active),
    windowId: t.windowId ?? -1,
  };
}

export async function resolveTabId(params, ctx) {
  const { browser } = ctx;

  if (params?.tabId !== undefined && params.tabId !== null) {
    try {
      const tab = await browser.tabs.get(params.tabId);
      return tab.id;
    } catch {
      throw new RpcError(
        ERR.NO_TAB,
        `tab ${params.tabId} no longer exists. Not falling back to the active ` +
          `tab: acting on a page the caller did not ask for is worse than failing.`,
      );
    }
  }

  const [active] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!active) {
    throw new RpcError(ERR.NO_TAB, "no tabId given and no active tab in the current window");
  }
  return active.id;
}

// ─── Verbs ────────────────────────────────────────────────────────────────

export async function tabsList(_params, ctx) {
  const tabs = await ctx.browser.tabs.query({});
  return { tabs: tabs.map(publicTab) };
}

export async function tabsActivate(params, ctx) {
  const tabId = await requireTabId(params);
  try {
    await ctx.browser.tabs.update(tabId, { active: true });
  } catch {
    throw new RpcError(ERR.NO_TAB, `tab ${tabId} no longer exists`);
  }
  return { ok: true };
}

export async function tabsOpen(params, ctx) {
  const url = params?.url;
  if (typeof url !== "string" || url === "") {
    // Opening about:blank because a parameter was missing is a side effect the
    // caller did not ask for and cannot undo without noticing it happened.
    throw new RpcError(ERR.BAD_SELECTOR, "tabs.open requires a url");
  }
  const tab = await ctx.browser.tabs.create({
    url,
    active: params.active !== undefined ? Boolean(params.active) : true,
  });
  return { tabId: tab.id };
}

export async function tabsClose(params, ctx) {
  // Deliberately NOT resolveTabId. Falling back to the active tab would let a
  // caller that forgot a parameter close whatever the user is reading.
  const tabId = await requireTabId(params);
  try {
    await ctx.browser.tabs.remove(tabId);
  } catch {
    throw new RpcError(ERR.NO_TAB, `tab ${tabId} no longer exists`);
  }
  return { ok: true };
}

async function requireTabId(params) {
  const tabId = params?.tabId;
  if (typeof tabId !== "number") {
    throw new RpcError(ERR.NO_TAB, "this method requires an explicit tabId");
  }
  return tabId;
}
