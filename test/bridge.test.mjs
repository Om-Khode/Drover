/**
 * bridge.test.mjs — Task 6: the DOM verbs, run against a real DOM.
 *
 * `dom_query.js` runs here for real, in jsdom, against fixture pages. That
 * matters: the file is byte-shared with every client, and the one thing two
 * codebases must agree on field by field is what an element looks like.
 *
 * Both sides assert against `ELEMENT_KEYS` in the protocol rather than against
 * each other's output. A snapshot test comparing two implementations passes
 * happily when both are wrong the same way, and goes red for reasons that have
 * nothing to do with the contract.
 *
 * The act verbs are tested through the same functions the extension ships to
 * `scripting.executeScript({ func })` — not through re-implementations. A test
 * that exercises a copy of the logic proves the copy works.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

import { ELEMENT_KEYS, QUERY_RESULT_KEYS, IDX_ATTR } from "../src/shared/protocol.js";
import { actInPage, infoInPage } from "../src/content/bridge.js";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const QUERY_SRC = readFileSync(join(ROOT, "src", "shared", "dom_query.js"), "utf8");

/**
 * Evaluate the shared query in a jsdom window and return its result.
 *
 * Node has no CSP, so `new Function` is available here. The extension cannot
 * use it — MV3 forbids it — which is exactly why the build emits a wrapper
 * (`dom_query.entry.js`) instead. Both paths evaluate the identical bytes.
 *
 * The interpolated string is a repository file that ships in the bundle and is
 * hashed at every handshake — not input, and not reachable from a page. This is
 * a test harness; nothing in `src/` evaluates a string.
 */
function runQuery(html, cfg = { filter: "interactive", openComboboxes: false }) {
  const dom = new JSDOM(html, {
    url: "https://example.invalid/form",
    pretendToBeVisual: true,
    runScripts: "outside-only",
  });
  const { window } = dom;

  // jsdom lays nothing out, so every rect is zero and the query's visibility
  // test would drop the whole page. Give elements a plausible box.
  //
  // The ancestor walk is not incidental. A real browser returns an all-zero
  // rect for any element inside a `display: none` subtree, even though that
  // element's own computed style is perfectly ordinary. A stub that only
  // inspected the element itself would report hidden controls as visible, and
  // the "hidden elements are excluded" test would then be measuring the stub
  // rather than the query.
  const ZERO = { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 };
  const BOX = { x: 10, y: 20, width: 120, height: 30, top: 20, left: 10, right: 130, bottom: 50 };
  window.Element.prototype.getBoundingClientRect = function () {
    for (let node = this; node && node.nodeType === 1; node = node.parentElement) {
      if (node.hasAttribute?.("hidden")) return ZERO;
      const style = window.getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden") return ZERO;
    }
    return BOX;
  };

  // window.eval, not new Function: a Function built from the outer realm
  // closes over Node's globals, so `document` inside the query resolves to
  // nothing. eval runs it inside the jsdom realm, which is what the browser
  // does too.
  const fn = window.eval(`(${QUERY_SRC})`);
  return { result: fn(cfg), window, document: window.document };
}

const FORM = `<!doctype html><html><body>
  <form id="signup">
    <label for="email">Email address</label>
    <input id="email" name="email" type="email" placeholder="you@example.com" autocomplete="email">
    <label for="country">Country</label>
    <select id="country" name="country">
      <option value="in">India</option>
      <option value="jp">Japan</option>
    </select>
    <input id="terms" type="checkbox" name="terms">
    <label for="terms">Accept terms</label>
    <textarea id="notes" placeholder="Anything else?"></textarea>
    <button type="submit">Create account</button>
  </form>
  <div hidden><button>Hidden action</button></div>
</body></html>`;

// ─── The element schema ──────────────────────────────────────────────────

test("the query returns the documented top-level keys", () => {
  const { result } = runQuery(FORM);
  assert.deepEqual(Object.keys(result).sort(), [...QUERY_RESULT_KEYS].sort());
});

test("the query finds the form's interactive elements", () => {
  // The 'walked nothing' guard. Every schema assertion below is vacuous if the
  // query returns an empty list, and an empty list is exactly what a broken
  // query produces — silently, and indistinguishably from an empty page.
  const { result } = runQuery(FORM);
  assert.ok(
    result.elements.length >= 5,
    `expected at least 5 interactive elements, got ${result.elements.length}`,
  );
});

test("every element carries exactly the protocol's keys", () => {
  const { result } = runQuery(FORM);
  const expected = [...ELEMENT_KEYS].sort();
  for (const el of result.elements) {
    assert.deepEqual(
      Object.keys(el).sort(), expected,
      `element ${el.idx} (${el.tag}) does not match ELEMENT_KEYS. A key added ` +
        `on one side of this protocol and not the other is how a client reads ` +
        `undefined and treats it as absent.`,
    );
  }
});

test("bounds is a four-number tuple", () => {
  const { result } = runQuery(FORM);
  for (const el of result.elements) {
    assert.ok(Array.isArray(el.bounds), `element ${el.idx}: bounds is not an array`);
    assert.equal(el.bounds.length, 4, `element ${el.idx}: bounds is not length 4`);
    for (const n of el.bounds) assert.equal(typeof n, "number");
  }
});

test("indices are unique and sequential from zero", () => {
  const { result } = runQuery(FORM);
  const idxs = result.elements.map((e) => e.idx);
  assert.deepEqual(idxs, idxs.map((_, i) => i), "indices are not 0..n-1 in order");
});

test("a native select reports its options", () => {
  const { result } = runQuery(FORM);
  const select = result.elements.find((e) => e.tag === "select");
  assert.ok(select, "the select was not captured");
  // Array.from, because the query built this array inside the jsdom realm and
  // deepEqual compares constructors across realms.
  assert.deepEqual(Array.from(select.options), ["India", "Japan"]);
});

test("a label is used as the element's name", () => {
  const { result } = runQuery(FORM);
  const email = result.elements.find((e) => e.type === "email");
  assert.ok(email, "the email input was not captured");
  assert.match(email.name, /Email address/i);
});

test("hidden elements are reported as not visible, not dropped", () => {
  // The query reports; the consumer decides. Dropping a hidden control would
  // collapse two different answers into one — "the button exists but is
  // hidden" and "there is no such button" call for different next moves, and
  // a planner that cannot tell them apart will keep re-querying for something
  // it has already been told about.
  const { result } = runQuery(FORM);
  const hidden = result.elements.find((e) => /Hidden action/i.test(e.name));
  assert.ok(hidden, "the hidden control was dropped instead of reported");
  assert.equal(hidden.visible, false, "a control in a hidden subtree was marked visible");
  assert.deepEqual(Array.from(hidden.bounds), [0, 0, 0, 0]);
});

test("visible controls are marked visible", () => {
  // The other half. A query that marked everything invisible would pass the
  // test above and make every page look empty.
  const { result } = runQuery(FORM);
  const submit = result.elements.find((e) => /Create account/i.test(e.name));
  assert.ok(submit, "the submit button was not captured");
  assert.equal(submit.visible, true);
});

// ─── The index attribute ─────────────────────────────────────────────────

test("the query stamps the index attribute on every captured element", () => {
  const { result, document } = runQuery(FORM);
  for (const el of result.elements) {
    const found = document.querySelector(`[${IDX_ATTR}='${el.idx}']`);
    assert.ok(found, `no element in the DOM carries ${IDX_ATTR}='${el.idx}'`);
  }
});

test("the stamped attribute is the one the protocol names", () => {
  const { document } = runQuery(FORM);
  assert.ok(
    document.querySelector(`[${IDX_ATTR}]`),
    `nothing was stamped with ${IDX_ATTR}. The query and every client select on ` +
      `this exact name; a rename on one side alone resolves nothing and looks ` +
      `like an empty page.`,
  );
});

// ─── page.act ────────────────────────────────────────────────────────────

function prepared(html = FORM) {
  const ctx = runQuery(html);
  return ctx;
}

test("click reaches the element at that index", () => {
  const { result, window, document } = prepared();
  const button = result.elements.find((e) => e.tag === "button");
  let clicked = 0;
  document.querySelector(`[${IDX_ATTR}='${button.idx}']`).addEventListener("click", () => clicked++);

  const out = actInPage(IDX_ATTR, button.idx, "click", undefined, document, window);
  assert.equal(out.ok, true, out.error);
  assert.equal(clicked, 1);
});

test("fill dispatches the events a framework listens for", () => {
  // Asserted on events observed, not on .value. Setting .value directly leaves
  // a React/Vue-controlled input looking filled to a human and empty to the
  // framework, which then submits the old value.
  const { result, window, document } = prepared();
  const email = result.elements.find((e) => e.type === "email");
  const node = document.querySelector(`[${IDX_ATTR}='${email.idx}']`);
  const seen = [];
  for (const type of ["input", "change"]) {
    node.addEventListener(type, (e) => seen.push([type, e.bubbles]));
  }

  const out = actInPage(IDX_ATTR, email.idx, "fill", "someone@example.invalid", document, window);
  assert.equal(out.ok, true, out.error);
  assert.equal(node.value, "someone@example.invalid");
  assert.deepEqual(
    seen, [["input", true], ["change", true]],
    "fill did not dispatch bubbling input and change events — a controlled " +
      "input would keep its old value and submit it",
  );
});

test("select chooses by visible label, then by value", () => {
  const { result, window, document } = prepared();
  const select = result.elements.find((e) => e.tag === "select");
  const node = document.querySelector(`[${IDX_ATTR}='${select.idx}']`);

  assert.equal(actInPage(IDX_ATTR, select.idx, "select", "Japan", document, window).ok, true);
  assert.equal(node.value, "jp");

  assert.equal(actInPage(IDX_ATTR, select.idx, "select", "in", document, window).ok, true);
  assert.equal(node.value, "in", "selecting by option value did not work");
});

test("select reports failure for an option that is not there", () => {
  const { result, window, document } = prepared();
  const select = result.elements.find((e) => e.tag === "select");
  const out = actInPage(IDX_ATTR, select.idx, "select", "Atlantis", document, window);
  assert.equal(out.ok, false);
  assert.match(out.error, /Atlantis/);
});

test("check and uncheck are idempotent and report the final state", () => {
  const { result, window, document } = prepared();
  const box = result.elements.find((e) => e.type === "checkbox");
  const node = document.querySelector(`[${IDX_ATTR}='${box.idx}']`);

  actInPage(IDX_ATTR, box.idx, "check", undefined, document, window);
  assert.equal(node.checked, true);
  actInPage(IDX_ATTR, box.idx, "check", undefined, document, window);
  assert.equal(node.checked, true, "a second check toggled it off");
  actInPage(IDX_ATTR, box.idx, "uncheck", undefined, document, window);
  assert.equal(node.checked, false);
});

test("check on an already-checked box fires no click at all", () => {
  // The repair step below the guard resets `.checked`, so removing the guard
  // still leaves the box in the right state — which is why asserting on
  // `.checked` alone cannot see the bug. What it cannot undo is the click
  // itself: a checkbox that submits its form, or reports to analytics, has
  // already done so by then.
  const { result, window, document } = prepared();
  const box = result.elements.find((e) => e.type === "checkbox");
  const node = document.querySelector(`[${IDX_ATTR}='${box.idx}']`);

  actInPage(IDX_ATTR, box.idx, "check", undefined, document, window);
  assert.equal(node.checked, true);

  let clicks = 0;
  node.addEventListener("click", () => clicks++);
  actInPage(IDX_ATTR, box.idx, "check", undefined, document, window);

  assert.equal(node.checked, true);
  assert.equal(
    clicks, 0,
    "check clicked a box that was already checked. The state ends up right, " +
      "but the page's click handler ran — and a handler that submitted a form " +
      "cannot be un-run.",
  );
});

test("uncheck on an already-unchecked box fires no click at all", () => {
  const { result, window, document } = prepared();
  const box = result.elements.find((e) => e.type === "checkbox");
  const node = document.querySelector(`[${IDX_ATTR}='${box.idx}']`);
  assert.equal(node.checked, false);

  let clicks = 0;
  node.addEventListener("click", () => clicks++);
  actInPage(IDX_ATTR, box.idx, "uncheck", undefined, document, window);

  assert.equal(node.checked, false);
  assert.equal(clicks, 0, "uncheck clicked a box that was already unchecked");
});

test("an index that no longer resolves is an error, not a guess", () => {
  const { window, document } = prepared();
  const out = actInPage(IDX_ATTR, 9999, "click", undefined, document, window);
  assert.equal(
    out.ok, false,
    "acting on a missing index succeeded. Between query and act the page may " +
      "have navigated; acting on whatever now sits at that index is how a form " +
      "submits the wrong thing.",
  );
  assert.match(out.error, /9999/);
});

test("an unknown action is refused rather than ignored", () => {
  const { result, window, document } = prepared();
  const button = result.elements.find((e) => e.tag === "button");
  const out = actInPage(IDX_ATTR, button.idx, "levitate", undefined, document, window);
  assert.equal(out.ok, false);
  assert.match(out.error, /levitate/);
});

// ─── page.info ───────────────────────────────────────────────────────────

test("info reports the page's identity and text", () => {
  const { window, document } = prepared();
  const out = infoInPage(document, window);
  assert.deepEqual(Object.keys(out).sort(), ["innerText", "readyState", "title", "url"]);
  assert.equal(out.url, "https://example.invalid/form");
  assert.match(out.innerText, /Create account/);
});
