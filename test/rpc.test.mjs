/**
 * rpc.test.mjs — Task 5: dispatch, and the tab verbs.
 *
 * The properties here are all about one thing: **a request must always produce
 * exactly one response carrying its own id.** The server side has a pending-call
 * table keyed on that id. A dropped reply is not a failure the caller can see —
 * it is a call that hangs until its own timeout, with no reason attached, and a
 * pending slot that leaks until then.
 *
 * So: unknown methods answer. Throwing handlers answer. Rejected promises
 * answer. A missing tab answers, rather than quietly acting on some other tab —
 * which is the failure mode that submits a form in the wrong window.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { dispatch, RpcError } from "../src/background/rpc.js";
import { resolveTabId } from "../src/background/tabs.js";
import { RPC, ERR, FRAME } from "../src/shared/protocol.js";

// ─── A fake tabs API ─────────────────────────────────────────────────────

function fakeBrowser({ tabs = [], activeId = null } = {}) {
  const state = {
    tabs: tabs.map((t) => ({ ...t })),
    created: [],
    removed: [],
    updated: [],
  };
  const find = (id) => state.tabs.find((t) => t.id === id);
  return {
    state,
    api: {
      tabs: {
        async query(q) {
          if (q.active && q.currentWindow) {
            const t = activeId === null ? undefined : find(activeId);
            return t ? [t] : [];
          }
          return state.tabs;
        },
        async get(id) {
          const t = find(id);
          if (!t) throw new Error(`No tab with id: ${id}`);
          return t;
        },
        async update(id, props) {
          const t = find(id);
          if (!t) throw new Error(`No tab with id: ${id}`);
          state.updated.push({ id, props });
          return { ...t, ...props };
        },
        async create(props) {
          const t = { id: 900 + state.created.length, ...props };
          state.created.push(props);
          state.tabs.push(t);
          return t;
        },
        async remove(id) {
          if (!find(id)) throw new Error(`No tab with id: ${id}`);
          state.removed.push(id);
          state.tabs = state.tabs.filter((t) => t.id !== id);
        },
      },
    },
  };
}

// Real `tabs.query` returns far more than the protocol documents, and some of
// it is privacy-relevant: `incognito`, `cookieStoreId`, a favicon URL that
// identifies the site even when the tab url is redacted. The fakes carry those
// extras deliberately — without them, a handler that returned the raw browser
// objects would look identical to one that projected them, and the assertion
// below would be measuring nothing.
const TABS = [
  {
    id: 1, url: "https://example.invalid/a", title: "A", active: false, windowId: 10,
    favIconUrl: "https://example.invalid/favicon.ico", incognito: true,
    cookieStoreId: "firefox-container-3", status: "complete", pinned: false,
    audible: true, discarded: false, sessionId: "s-42",
  },
  {
    id: 2, url: "https://example.invalid/b", title: "B", active: true, windowId: 10,
    favIconUrl: "https://example.invalid/favicon2.ico", incognito: false,
    cookieStoreId: "firefox-default", status: "loading", pinned: true,
    audible: false, discarded: false, sessionId: "s-43",
  },
];

const req = (id, method, params = {}) => ({ type: FRAME.REQUEST, id, method, params });

// ─── The invariant ───────────────────────────────────────────────────────

test("an unknown method answers with the request's own id", async () => {
  const { api } = fakeBrowser();
  const res = await dispatch(req(7, "page.teleport"), { browser: api });
  assert.equal(res.type, FRAME.RESPONSE);
  assert.equal(res.id, 7, "the reply carried a different id — the caller's slot leaks");
  assert.equal(res.ok, false);
  assert.equal(res.code, ERR.UNKNOWN_METHOD);
  assert.match(res.message, /page\.teleport/, "the message does not name the method");
});

test("a throwing handler becomes an error frame, not an escaped exception", async () => {
  const handlers = {
    "page.boom": () => {
      throw new Error("kaboom");
    },
  };
  const res = await dispatch(req(11, "page.boom"), { browser: fakeBrowser().api }, handlers);
  assert.equal(res.id, 11);
  assert.equal(res.ok, false);
  assert.equal(res.code, ERR.INTERNAL);
  assert.match(res.message, /kaboom/);
});

test("a rejected promise becomes an error frame", async () => {
  const handlers = { "page.boom": async () => Promise.reject(new Error("async kaboom")) };
  const res = await dispatch(req(12, "page.boom"), { browser: fakeBrowser().api }, handlers);
  assert.equal(res.id, 12);
  assert.equal(res.ok, false);
  assert.equal(res.code, ERR.INTERNAL);
  assert.match(res.message, /async kaboom/);
});

test("an RpcError keeps its own code rather than collapsing to INTERNAL", async () => {
  const handlers = {
    "page.boom": () => {
      throw new RpcError(ERR.INJECTION_BLOCKED, "content script refused");
    },
  };
  const res = await dispatch(req(13, "page.boom"), { browser: fakeBrowser().api }, handlers);
  assert.equal(
    res.code, ERR.INJECTION_BLOCKED,
    "a handler's deliberate code was overwritten — the caller cannot tell a " +
      "blocked injection from a crash, and would retry something unretryable",
  );
});

test("dispatch never rejects, whatever the handler does", async () => {
  const nasty = {
    "a": () => { throw "a bare string"; },          // eslint-disable-line
    "b": () => { throw null; },                      // eslint-disable-line
    "c": async () => { throw new Error("later"); },
    "d": () => Promise.reject(undefined),
  };
  for (const method of Object.keys(nasty)) {
    const res = await dispatch(req(1, method), { browser: fakeBrowser().api }, nasty);
    assert.equal(res.ok, false, `${method}: no error frame`);
    assert.equal(res.id, 1);
    assert.ok(typeof res.message === "string", `${method}: message is not a string`);
  }
});

test("concurrent requests resolve to their own ids", async () => {
  const handlers = {
    slow: async () => { await new Promise((r) => setTimeout(r, 20)); return { which: "slow" }; },
    fast: async () => ({ which: "fast" }),
  };
  const ctx = { browser: fakeBrowser().api };
  const [a, b, c] = await Promise.all([
    dispatch(req(101, "slow"), ctx, handlers),
    dispatch(req(102, "fast"), ctx, handlers),
    dispatch(req(103, "slow"), ctx, handlers),
  ]);
  assert.deepEqual([a.id, b.id, c.id], [101, 102, 103]);
  assert.deepEqual([a.result.which, b.result.which, c.result.which], ["slow", "fast", "slow"]);
});

test("a malformed frame still answers when it has an id", async () => {
  const res = await dispatch({ type: FRAME.REQUEST, id: 5 }, { browser: fakeBrowser().api });
  assert.equal(res.id, 5);
  assert.equal(res.ok, false);
  assert.equal(res.code, ERR.UNKNOWN_METHOD);
});

// ─── Tab resolution ──────────────────────────────────────────────────────

test("with no tabId and no active tab the answer is NO_TAB, not a no-op", async () => {
  // Driven through a handler rather than a real page verb: the page verbs
  // arrive in Task 6, but the resolver they will all share exists now, and
  // this is the property that matters about it.
  const { api } = fakeBrowser({ tabs: TABS, activeId: null });
  const handlers = { "page.probe": async (params, ctx) => ({ tabId: await resolveTabId(params, ctx) }) };
  const res = await dispatch(req(20, "page.probe"), { browser: api }, handlers);
  assert.equal(res.ok, false);
  assert.equal(
    res.code, ERR.NO_TAB,
    "no active tab produced something other than NO_TAB. A silent success " +
      "here means the caller believes it acted on a page that was never there.",
  );
});

test("with no tabId the active tab is used", async () => {
  // The permitted path. A resolver that refused everything would pass the
  // test above and make the product useless.
  const { api } = fakeBrowser({ tabs: TABS, activeId: 2 });
  const handlers = { "page.probe": async (params, ctx) => ({ tabId: await resolveTabId(params, ctx) }) };
  const res = await dispatch(req(20, "page.probe"), { browser: api }, handlers);
  assert.equal(res.ok, true);
  assert.equal(res.result.tabId, 2);
});

test("an explicit tabId wins over the active tab, and is verified to exist", async () => {
  const { api } = fakeBrowser({ tabs: TABS, activeId: 2 });
  const handlers = { "page.probe": async (params, ctx) => ({ tabId: await resolveTabId(params, ctx) }) };

  const ok = await dispatch(req(21, "page.probe", { tabId: 1 }), { browser: api }, handlers);
  assert.equal(ok.result.tabId, 1);

  const gone = await dispatch(req(22, "page.probe", { tabId: 404 }), { browser: api }, handlers);
  assert.equal(gone.ok, false);
  assert.equal(
    gone.code, ERR.NO_TAB,
    "a tabId that no longer exists fell through to the active tab — the caller " +
      "would act on a page it never asked for",
  );
});

test("tabs.list returns exactly the fields the protocol documents", async () => {
  const { api } = fakeBrowser({ tabs: TABS, activeId: 2 });
  const res = await dispatch(req(21, RPC.TABS_LIST), { browser: api });
  assert.equal(res.ok, true);
  assert.equal(res.result.tabs.length, 2);
  for (const t of res.result.tabs) {
    assert.deepEqual(
      Object.keys(t).sort(),
      ["active", "id", "title", "url", "windowId"],
      "tabs.list leaked or dropped a field; PROTOCOL.md documents exactly these",
    );
  }
});

test("tabs.list does not leak the browser's private tab fields", async () => {
  const { api } = fakeBrowser({ tabs: TABS, activeId: 2 });
  const res = await dispatch(req(29, RPC.TABS_LIST), { browser: api });
  const serialised = JSON.stringify(res.result);
  for (const leaked of ["incognito", "cookieStoreId", "favIconUrl", "sessionId"]) {
    assert.ok(
      !serialised.includes(leaked),
      `tabs.list sent ${leaked} to the server. The projection is not cosmetic: ` +
        `a container id or a favicon URL identifies context the caller was never ` +
        `granted, and it crosses a process boundary the moment it is serialised.`,
    );
  }
});

test("tabs.activate targets the requested tab", async () => {
  const { api, state } = fakeBrowser({ tabs: TABS, activeId: 2 });
  const res = await dispatch(req(22, RPC.TABS_ACTIVATE, { tabId: 1 }), { browser: api });
  assert.equal(res.ok, true);
  assert.deepEqual(state.updated, [{ id: 1, props: { active: true } }]);
});

test("tabs.activate on a tab that is gone reports it", async () => {
  const { api } = fakeBrowser({ tabs: TABS, activeId: 2 });
  const res = await dispatch(req(23, RPC.TABS_ACTIVATE, { tabId: 999 }), { browser: api });
  assert.equal(res.ok, false);
  assert.equal(res.code, ERR.NO_TAB);
});

test("tabs.open returns the new tab's id", async () => {
  const { api, state } = fakeBrowser({ tabs: TABS, activeId: 2 });
  const res = await dispatch(
    req(24, RPC.TABS_OPEN, { url: "https://example.invalid/c" }), { browser: api });
  assert.equal(res.ok, true);
  assert.equal(typeof res.result.tabId, "number");
  assert.equal(state.created[0].url, "https://example.invalid/c");
});

test("tabs.open without a url is rejected rather than opening a blank tab", async () => {
  const { api, state } = fakeBrowser({ tabs: TABS, activeId: 2 });
  const res = await dispatch(req(25, RPC.TABS_OPEN, {}), { browser: api });
  assert.equal(res.ok, false);
  assert.equal(state.created.length, 0, "a tab was opened anyway");
});

test("tabs.close closes only the tab named", async () => {
  const { api, state } = fakeBrowser({ tabs: TABS, activeId: 2 });
  const res = await dispatch(req(26, RPC.TABS_CLOSE, { tabId: 1 }), { browser: api });
  assert.equal(res.ok, true);
  assert.deepEqual(state.removed, [1]);
});

test("tabs.close requires an explicit tabId", async () => {
  // Falling back to the active tab here would let a caller that forgot a
  // parameter close whatever the user happens to be reading.
  const { api, state } = fakeBrowser({ tabs: TABS, activeId: 2 });
  const res = await dispatch(req(27, RPC.TABS_CLOSE, {}), { browser: api });
  assert.equal(res.ok, false);
  assert.equal(state.removed.length, 0, "a tab was closed with no tabId given");
});

test("an explicit tabId is preferred over the active tab", async () => {
  const { api, state } = fakeBrowser({ tabs: TABS, activeId: 2 });
  await dispatch(req(28, RPC.TABS_ACTIVATE, { tabId: 1 }), { browser: api });
  assert.deepEqual(state.updated.map((u) => u.id), [1], "the active tab was used instead");
});

// ─── The method table is the protocol ────────────────────────────────────

test("every RPC name in the protocol has a handler or is explicitly pending", async () => {
  const { api } = fakeBrowser({ tabs: TABS, activeId: 2 });
  const names = Object.values(RPC);
  assert.ok(names.length >= 10, "the RPC table shrank unexpectedly");

  const unimplemented = [];
  for (const method of names) {
    const res = await dispatch(req(1, method, {}), { browser: api });
    if (res.code === ERR.UNKNOWN_METHOD) unimplemented.push(method);
  }
  // Task 6 and 7 add the page verbs. This asserts the gap is exactly the known
  // one, so a method silently disappearing from the table is caught.
  assert.deepEqual(
    unimplemented, [],
    "every method the protocol advertises now has a handler; a name that " +
      "disappears from the table shows up here",
  );
});
