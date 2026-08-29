/**
 * nav.test.mjs — Task 7: screenshot, goto, waitLoad.
 *
 * The screenshot verb is the one place Drover is strictly worse than the CDP
 * path it replaces, and the tests are mostly about making that honest rather
 * than quiet. `tabs.captureVisibleTab` captures the visible viewport of the
 * ACTIVE tab in a window — there is no full-page mode and no way to name a
 * different tab. A capture request for a non-active tab must therefore fail,
 * not return a picture of whatever the user happens to be looking at.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { dispatch } from "../src/background/rpc.js";
import { RPC, ERR, FRAME } from "../src/shared/protocol.js";

const req = (id, method, params = {}) => ({ type: FRAME.REQUEST, id, method, params });

function fakeBrowser({ activeId = 2, tabs = null } = {}) {
  const state = { captured: [], updated: [], injections: [] };
  const all = tabs ?? [
    { id: 1, url: "https://example.invalid/a", title: "A", active: false, windowId: 10 },
    { id: 2, url: "https://example.invalid/b", title: "B", active: true, windowId: 10 },
  ];
  return {
    state,
    api: {
      tabs: {
        async query(q) {
          if (q.active && q.currentWindow) {
            const t = all.find((x) => x.id === activeId);
            return t ? [t] : [];
          }
          return all;
        },
        async get(id) {
          const t = all.find((x) => x.id === id);
          if (!t) throw new Error("no tab");
          return t;
        },
        async update(id, props) {
          state.updated.push({ id, props });
          return { ...all.find((x) => x.id === id), ...props };
        },
        async captureVisibleTab(windowId) {
          state.captured.push(windowId);
          return "data:image/png;base64,iVBORw0KGgo=";
        },
      },
      scripting: {
        async executeScript(injection) {
          state.injections.push(injection);
          return [{ result: { readyState: "complete" } }];
        },
      },
    },
  };
}

// ─── screenshot ──────────────────────────────────────────────────────────

test("screenshot captures the active tab and returns base64 png", async () => {
  const { api, state } = fakeBrowser({ activeId: 2 });
  const res = await dispatch(req(1, RPC.SCREENSHOT), { browser: api });
  assert.equal(res.ok, true, res.message);
  assert.equal(typeof res.result.png, "string");
  assert.ok(!res.result.png.startsWith("data:"), "the data: prefix was not stripped");
  assert.equal(state.captured.length, 1);
});

test("screenshot of a non-active tab is refused, not silently redirected", async () => {
  // captureVisibleTab has no way to name a tab. Falling back to the active one
  // would hand the caller a picture of a page it did not ask about, and it
  // would look entirely successful.
  const { api, state } = fakeBrowser({ activeId: 2 });
  const res = await dispatch(req(2, RPC.SCREENSHOT, { tabId: 1 }), { browser: api });
  assert.equal(res.ok, false);
  assert.equal(res.code, ERR.BAD_SELECTOR);
  assert.match(res.message, /active/i);
  assert.equal(state.captured.length, 0, "it captured something anyway");
  assert.equal(state.updated.length, 0, "it activated the tab to work around the limit");
});

test("screenshot naming the active tab explicitly is allowed", async () => {
  // The permitted path. A verb that refused every tabId would pass the test
  // above while being useless.
  const { api, state } = fakeBrowser({ activeId: 2 });
  const res = await dispatch(req(3, RPC.SCREENSHOT, { tabId: 2 }), { browser: api });
  assert.equal(res.ok, true, res.message);
  assert.equal(state.captured.length, 1);
});

// ─── goto ────────────────────────────────────────────────────────────────

test("goto navigates the resolved tab", async () => {
  const { api, state } = fakeBrowser();
  const res = await dispatch(req(4, RPC.GOTO, { url: "https://example.invalid/c" }), { browser: api });
  assert.equal(res.ok, true, res.message);
  assert.deepEqual(state.updated, [{ id: 2, props: { url: "https://example.invalid/c" } }]);
});

test("goto refuses a non-http scheme", async () => {
  // javascript: and data: URLs navigate the page into script the caller wrote,
  // which turns a navigation verb into an arbitrary-execution verb. file:
  // reaches the user's disk. None of that is what `goto` advertises.
  const { api, state } = fakeBrowser();
  for (const url of [
    "javascript:alert(1)",
    "data:text/html,<script>1</script>",
    "file:///C:/Windows/win.ini",
    "chrome://settings",
    "about:config",
  ]) {
    const res = await dispatch(req(5, RPC.GOTO, { url }), { browser: api });
    assert.equal(res.ok, false, `${url} was accepted`);
    assert.equal(res.code, ERR.BAD_SELECTOR, `${url} gave the wrong code`);
  }
  assert.equal(state.updated.length, 0, "a refused url navigated anyway");
});

test("goto accepts http and https", async () => {
  const { api, state } = fakeBrowser();
  for (const url of ["http://example.invalid/x", "https://example.invalid/y"]) {
    const res = await dispatch(req(6, RPC.GOTO, { url }), { browser: api });
    assert.equal(res.ok, true, `${url} was refused: ${res.message}`);
  }
  assert.equal(state.updated.length, 2);
});

test("goto without a url is refused", async () => {
  const { api, state } = fakeBrowser();
  const res = await dispatch(req(7, RPC.GOTO, {}), { browser: api });
  assert.equal(res.ok, false);
  assert.equal(state.updated.length, 0);
});

// ─── waitLoad ────────────────────────────────────────────────────────────

test("waitLoad reports the document's ready state", async () => {
  const { api } = fakeBrowser();
  const res = await dispatch(req(8, RPC.WAIT_LOAD), { browser: api });
  assert.equal(res.ok, true, res.message);
  assert.equal(res.result.state, "complete");
});

test("waitLoad gives up rather than hanging", async () => {
  // A verb that waits forever is worse than one that fails: the caller's own
  // timeout fires with no reason attached, and the pending slot leaks until then.
  const { api } = fakeBrowser();
  api.scripting.executeScript = async () => [{ result: { readyState: "loading" } }];
  const res = await dispatch(req(9, RPC.WAIT_LOAD, { timeout: 30 }), { browser: api });
  assert.equal(res.ok, false);
  assert.equal(res.code, ERR.TIMEOUT);
});
