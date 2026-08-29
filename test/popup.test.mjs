/**
 * popup.test.mjs — Task 9: the pairing UI's logic.
 *
 * The one property that is a security property rather than a usability one:
 * the token goes to `storage.local` and never to `storage.sync`. Sync
 * replicates to every machine the user is signed into on this browser, and a
 * loopback bearer token is meaningful only on the machine that minted it —
 * copying it elsewhere spreads a credential to hosts that can never use it and
 * might leak it.
 *
 * The rest is about not lying to the person looking at the popup: a failed
 * exchange stores nothing and says why.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

import { submitToken, describeState, isLive } from "../src/popup/popup_logic.js";

function fakeStorage() {
  const local = {};
  const sync = {};
  return {
    local, sync,
    api: {
      storage: {
        local: {
          async get(k) { return k in local ? { [k]: local[k] } : {}; },
          async set(o) { Object.assign(local, o); },
          async remove(k) { delete local[k]; },
        },
        sync: {
          async get(k) { return k in sync ? { [k]: sync[k] } : {}; },
          async set(o) { Object.assign(sync, o); },
        },
      },
    },
  };
}

function harness({ reply = { state: "open" } } = {}) {
  const s = fakeStorage();
  const sent = [];
  return {
    storage: s,
    sent,
    deps: {
      browser: s.api,
      sendMessage: async (m) => { sent.push(m); return reply; },
    },
  };
}

test("a submitted token is stored locally and the client is asked to connect", async () => {
  const h = harness();
  const out = await submitToken({ token: "tok-abc", url: "ws://127.0.0.1:8790/drover" }, h.deps);
  assert.equal(out.ok, true, out.error);
  assert.equal(h.storage.local.token, "tok-abc");
  assert.equal(h.storage.local.serverUrl, "ws://127.0.0.1:8790/drover");
  assert.deepEqual(h.sent.map((m) => m.kind), ["drover:connect"]);
});

test("the token never reaches sync storage", async () => {
  const h = harness();
  await submitToken({ token: "tok-abc", url: "ws://127.0.0.1:8790/drover" }, h.deps);
  assert.deepEqual(
    Object.keys(h.storage.sync), [],
    "something was written to storage.sync. It replicates to every machine " +
      "this browser is signed into, and a loopback token is useless anywhere " +
      "but the machine that minted it — so syncing it spreads a credential " +
      "and buys nothing.",
  );
});

test("an empty token is refused and stores nothing", async () => {
  const h = harness();
  const out = await submitToken({ token: "   ", url: "ws://127.0.0.1:8790/drover" }, h.deps);
  assert.equal(out.ok, false);
  assert.match(out.error, /token/i);
  assert.deepEqual(Object.keys(h.storage.local), [], "an empty token was stored");
  assert.equal(h.sent.length, 0, "it tried to connect with no token");
});

test("a non-loopback server url is refused", async () => {
  // Drover talks to a program on this machine. Pointing it at a remote host
  // would send the page's contents somewhere the user did not choose, and the
  // popup is the one place that address can be typed.
  const h = harness();
  for (const url of [
    "ws://example.invalid/drover",
    "wss://evil.invalid/drover",
    "ws://10.0.0.5:8790/drover",
    "ws://[::ffff:8.8.8.8]:8790/drover",
  ]) {
    const out = await submitToken({ token: "tok", url }, h.deps);
    assert.equal(out.ok, false, `${url} was accepted`);
    assert.match(out.error, /loopback/i, `${url} gave the wrong reason`);
  }
  assert.deepEqual(Object.keys(h.storage.local), [], "a refused url was stored anyway");
});

test("loopback urls are accepted", async () => {
  // The permitted path. A check that refused every url would pass the test
  // above and make the popup unusable.
  for (const url of [
    "ws://127.0.0.1:8790/drover",
    "ws://localhost:8790/drover",
    "ws://[::1]:8790/drover",
  ]) {
    const h = harness();
    const out = await submitToken({ token: "tok", url }, h.deps);
    assert.equal(out.ok, true, `${url} was refused: ${out.error}`);
  }
});

test("a rejected connection surfaces the reason and keeps no token", async () => {
  const h = harness({ reply: { state: "stopped", detail: { reason: "protocol 2 != 1" } } });
  const out = await submitToken({ token: "tok", url: "ws://127.0.0.1:8790/drover" }, h.deps);
  assert.equal(out.ok, false);
  assert.match(out.error, /protocol 2 != 1/);
  assert.equal(
    h.storage.local.token, undefined,
    "a token the server refused was left in storage, so every later reconnect " +
      "retries a credential already known to be wrong",
  );
});

test("every client state has a human description", () => {
  for (const state of ["idle", "connecting", "handshaking", "open", "backoff", "stopped"]) {
    const text = describeState(state);
    assert.equal(typeof text, "string");
    assert.ok(text.length > 0, `${state} has no description`);
    assert.ok(!/undefined/.test(text), `${state} description leaks undefined`);
  }
});

test("an unknown state does not render as undefined", () => {
  assert.ok(!/undefined/.test(describeState("something-new")));
});


// ─── What the popup shows ────────────────────────────────────────────────
//
// Four things the popup got wrong, all of which look like the extension being
// broken rather than the popup being stale.


test("a refusal reason reaches the user, not just the state", () => {
  // The server says "another extension is already connected". The popup said
  // "Disconnected. Retrying shortly." -- which is not an answer: one of those
  // the user can act on, the other they can only wait on.
  const text = describeState("backoff", { code: 1007, reason: "another extension is already connected" });
  assert.match(text, /another extension is already connected/);
});

test("a stopped state puts its reason on its own line", () => {
  const text = describeState("stopped", { code: 1006, reason: "dom_query.js digest a != b" });
  assert.match(text, /reconnecting cannot help/);
  assert.match(text, /digest a != b/);
  assert.equal(text.split(/\r?\n/).length, 2, "the reason is crammed onto the headline");
});

test("a state with no reason reads exactly as before", () => {
  assert.equal(describeState("open"), "Connected.");
  assert.equal(describeState("open", null), "Connected.");
  assert.equal(describeState("backoff", {}), "Disconnected. Retrying shortly.");
});

test("a reason with no text falls back to the code rather than showing nothing", () => {
  assert.match(describeState("backoff", { code: 1007 }), /1007/);
});

test("isLive is true only when the socket is usable", () => {
  assert.equal(isLive("open"), true);
  for (const state of ["idle", "connecting", "handshaking", "backoff", "stopped"]) {
    assert.equal(isLive(state), false, `${state} was treated as live`);
  }
});


// ─── Disconnect has to mean it ───────────────────────────────────────────


test("the entry point pauses reconnects when the user disconnects", () => {
  // Without this the one-minute alarm puts the socket back and the button is
  // a lie. The flag lives in storage, not memory, because the background
  // context is evicted when idle -- and a decision the user made must not be
  // forgotten by a suspension they never saw.
  const src = readFileSync(join(ROOT, "src", "background", "index.js"), "utf8");

  const disconnect = src.slice(src.indexOf('drover:disconnect'));
  assert.match(
    disconnect.slice(0, 200), /setPaused\(true\)/,
    "disconnect does not record that the user asked for it",
  );

  const alarm = src.slice(src.indexOf("alarms.onAlarm"), src.indexOf("alarms.onAlarm") + 400);
  assert.match(alarm, /isPaused/, "the reconnect alarm ignores the pause");

  const connect = src.slice(src.indexOf('drover:connect'));
  assert.match(
    connect.slice(0, 200), /setPaused\(false\)/,
    "connect does not clear the pause, so the button works once",
  );
});

test("startup does not undo a pause", () => {
  // `client.connect()` at the bottom of the entry point runs on every
  // evaluation -- which is what makes the extension survive eviction, and
  // which would also reconnect a socket the user turned off.
  const src = readFileSync(join(ROOT, "src", "background", "index.js"), "utf8");
  const tail = src.slice(src.lastIndexOf("alarms.create"));
  assert.match(tail, /isPaused\(\)/, "the startup connect ignores the pause");
});


// ─── The popup keeps itself honest ───────────────────────────────────────


test("the popup polls rather than reading the state once", () => {
  // Read once at open time, it is wrong the moment anything changes -- which
  // is what happened: the socket reconnected, the popup still said "Retrying
  // shortly", and the only way to see the truth was to close and reopen it.
  const src = readFileSync(join(ROOT, "src", "popup", "popup.js"), "utf8");
  assert.match(src, /setInterval/, "the popup never refreshes itself");
  const m = src.match(/POLL_MS\s*=\s*(\d+)/);
  assert.ok(m, "no poll interval is declared");
  assert.ok(Number(m[1]) <= 2000, `polling every ${m[1]}ms is slower than a person waits`);
});

test("the token field is hidden while connected", () => {
  // The credential is already stored; showing it again leaves it on screen for
  // whoever looks at the machine next.
  const src = readFileSync(join(ROOT, "src", "popup", "popup.js"), "utf8");
  assert.match(src, /tokenRow\.hidden = live/);
});

test("the button becomes a red Disconnect while connected", () => {
  const src = readFileSync(join(ROOT, "src", "popup", "popup.js"), "utf8");
  assert.match(src, /live \? "Disconnect" : "Connect"/);
  assert.match(src, /live \? "danger" : ""/);

  const css = readFileSync(join(ROOT, "src", "popup", "index.html"), "utf8");
  assert.match(css, /button\.danger/, "the danger style is not defined");
});

test("the markup has the row the popup hides", () => {
  const html = readFileSync(join(ROOT, "src", "popup", "index.html"), "utf8");
  assert.match(html, /id="token-row"/, "popup.js hides an element that does not exist");
});


// ─── A renamed path must not strand an installed extension ───────────────


test("a stored url pointing at a retired path is migrated", async () => {
  // The /latch -> /drover rename. A stored URL survives an update, so without
  // this the extension dials a path the server no longer routes, forever, and
  // the popup can only report that nothing answered.
  const { getServerUrl } = await import("../src/background/settings.js");
  const s = fakeStorage();
  s.local.serverUrl = "ws://127.0.0.1:8790/latch";

  const url = await getServerUrl({ browser: s.api });

  assert.ok(!url.endsWith("/latch"), `still pointing at the retired path: ${url}`);
  assert.ok(url.endsWith("/drover"), url);
  assert.equal(
    s.local.serverUrl, url,
    "the migrated value was returned but not written back, so the popup shows " +
      "one address and the next read finds the dead one again",
  );
});

test("a url the user chose is left alone", async () => {
  // The other half. A migration that rewrote every stored URL would silently
  // undo a deliberate change of port or host.
  const { getServerUrl } = await import("../src/background/settings.js");
  const s = fakeStorage();
  s.local.serverUrl = "ws://127.0.0.1:9999/drover";
  assert.equal(await getServerUrl({ browser: s.api }), "ws://127.0.0.1:9999/drover");
});

test("no stored url falls back to the default", async () => {
  const { getServerUrl } = await import("../src/background/settings.js");
  const s = fakeStorage();
  assert.match(await getServerUrl({ browser: s.api }), /\/drover$/);
});
