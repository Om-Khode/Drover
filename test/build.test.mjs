/**
 * build.test.mjs — Task 3: the build emits two loadable extensions.
 *
 * Properties pinned here, and why each one:
 *
 *  - One manifest source, two outputs, and each keeps BOTH background keys.
 *    Chromium reads `service_worker` and ignores `scripts`; Gecko does the
 *    reverse. Stripping the other browser's key per target is the obvious
 *    optimisation and it is wrong — it doubles the manifest source for no gain.
 *  - Gecko needs an explicit extension id. AMO signing fails without one, and
 *    it fails at the point where you are trying to ship.
 *  - `strict_min_version` is 121.0 or higher. Before Firefox 121 a background
 *    page is NOT started when `service_worker` is also present, so a manifest
 *    carrying both keys silently has no background at all on 106-120. That is
 *    the exact configuration this build produces.
 *  - `dom_query.js` reaches both outputs byte-identical to `src/shared/`. It is
 *    compared against a client's vendored copy by SHA-256 at handshake; a build
 *    step that reformatted or transpiled it would break every connection.
 *  - No output file names a host application. Host-agnosticism is a constraint
 *    (PROTOCOL.md §9), so it is asserted rather than trusted.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TARGETS = ["chromium", "firefox"];

const dist = (t, ...p) => join(ROOT, "dist", t, ...p);
const manifestOf = (t) => JSON.parse(readFileSync(dist(t, "manifest.json"), "utf8"));

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

// ─── The build ran at all ────────────────────────────────────────────────

test("both targets are emitted", () => {
  for (const t of TARGETS) {
    assert.ok(existsSync(dist(t)), `dist/${t} missing — run \`npm run build\``);
    assert.ok(existsSync(dist(t, "manifest.json")), `dist/${t}/manifest.json missing`);
    assert.ok(existsSync(dist(t, "background.js")), `dist/${t}/background.js missing`);
    assert.ok(existsSync(dist(t, "dom_query.js")), `dist/${t}/dom_query.js missing`);
  }
});

// ─── Manifest ────────────────────────────────────────────────────────────

test("both manifests are MV3", () => {
  for (const t of TARGETS) assert.equal(manifestOf(t).manifest_version, 3);
});

test("both manifests keep both background keys", () => {
  for (const t of TARGETS) {
    const bg = manifestOf(t).background;
    assert.equal(bg.service_worker, "background.js", `${t}: no service_worker`);
    assert.deepEqual(bg.scripts, ["background.js"], `${t}: no scripts array`);
  }
});

test("gecko id is present — AMO signing fails without it", () => {
  for (const t of TARGETS) {
    const id = manifestOf(t).browser_specific_settings?.gecko?.id;
    assert.ok(id, `${t}: browser_specific_settings.gecko.id missing`);
  }
});

test("strict_min_version is at least 121 — below it the background page never starts", () => {
  for (const t of TARGETS) {
    const v = manifestOf(t).browser_specific_settings?.gecko?.strict_min_version;
    assert.ok(v, `${t}: strict_min_version missing`);
    assert.ok(
      parseInt(v, 10) >= 121,
      `${t}: strict_min_version is ${v}. Firefox 106-120 refuses to start a ` +
        `background page when service_worker is also present, and this manifest ` +
        `carries both keys — the extension would install and do nothing.`,
    );
  }
});

test("data collection is declared — AMO rejects the upload without it", () => {
  // Not a warning: addons.mozilla.org fails the upload outright with
  // `The "data_collection_permissions" property is missing.` It is required of
  // every new Firefox extension, and the failure arrives at submission time --
  // weeks after whoever dropped the key has stopped thinking about it.
  //
  // "none" is the honest answer, not an evasion: the only network destination
  // is a loopback address the user types in, and AMO holds the add-on to the
  // claim. Anything that later sends data off the machine must change this key
  // in the same commit.
  for (const t of TARGETS) {
    const d = manifestOf(t).browser_specific_settings?.gecko?.data_collection_permissions;
    assert.ok(d, `${t}: data_collection_permissions missing — AMO will reject this build`);
    assert.ok(Array.isArray(d.required) && d.required.length > 0, `${t}: no required array`);
  }
});

test("the gecko id is not a placeholder", () => {
  // Permanent once AMO publishes it. Shipping `@localhost` means either living
  // with it forever or re-listing as a different add-on and losing every
  // install, and nothing downstream of submission can undo it.
  for (const t of TARGETS) {
    const id = manifestOf(t).browser_specific_settings.gecko.id;
    assert.ok(
      !/localhost|example|test|todo|changeme/i.test(id),
      `${t}: gecko id is ${id} — a placeholder that cannot be changed after publishing`,
    );
  }
});

test("the version floor stays below the data-collection key's own floor", () => {
  // data_collection_permissions arrived in Firefox 140, so web-ext warns that
  // 121-139 ignore it. That is the intended trade: an unknown manifest key is
  // ignored, not fatal, and raising the floor to 140 would drop nineteen
  // releases of working browsers to silence a lint line.
  for (const t of TARGETS) {
    const v = parseInt(manifestOf(t).browser_specific_settings.gecko.strict_min_version, 10);
    assert.ok(v < 140, `${t}: floor raised to ${v}, dropping Firefox ${v > 121 ? "121-" + (v - 1) : ""} for a warning`);
  }
});

test("the CSP does not upgrade insecure requests", () => {
  // Firefox's DEFAULT MV3 CSP for extension pages includes
  // `upgrade-insecure-requests`, which rewrites `ws://` to `wss://` before the
  // socket is opened. The server is plain ws on loopback, so every connection
  // failed with "Firefox can't establish a connection to the server at
  // wss://127.0.0.1:8790/drover" -- a scheme nobody in this codebase ever asked
  // for. Declaring our own CSP is what drops that directive.
  for (const t of TARGETS) {
    const csp = manifestOf(t).content_security_policy?.extension_pages;
    assert.ok(csp, `${t}: no explicit extension_pages CSP -- Firefox's default applies`);
    assert.ok(
      !/upgrade-insecure-requests/i.test(csp),
      `${t}: the CSP upgrades insecure requests, so ws:// becomes wss:// and ` +
        `the loopback socket can never open`,
    );
  }
});

test("the CSP allows a loopback websocket", () => {
  // The other half. A CSP that dropped the upgrade but forbade the connection
  // would satisfy the test above and fail identically in practice.
  for (const t of TARGETS) {
    const csp = manifestOf(t).content_security_policy.extension_pages;
    assert.match(csp, /connect-src[^;]*ws:\/\/127\.0\.0\.1/, `${t}: ${csp}`);
  }
});

test("the CSP still pins script-src to self", () => {
  // MV3 requires it, and it is what keeps a page from pulling in remote code.
  // Writing our own CSP means we own this line too.
  for (const t of TARGETS) {
    const csp = manifestOf(t).content_security_policy.extension_pages;
    assert.match(csp, /script-src\s+'self'/, `${t}: ${csp}`);
  }
});

test("both targets declare the identical permission set", () => {
  const [a, b] = TARGETS.map(manifestOf);
  assert.deepEqual([...a.permissions].sort(), [...b.permissions].sort());
  assert.deepEqual(a.host_permissions, b.host_permissions);
});

test("no traffic-interception permission is requested", () => {
  // Chrome MV3 removed blocking webRequest while Firefox MV3 kept it, so an
  // interception feature would be two implementations pretending to be one.
  // Declared a non-goal; asserted so it cannot arrive by accident.
  for (const t of TARGETS) {
    const perms = manifestOf(t).permissions;
    for (const banned of ["webRequest", "webRequestBlocking", "declarativeNetRequest"]) {
      assert.ok(!perms.includes(banned), `${t}: unexpected permission ${banned}`);
    }
  }
});

// ─── The shared artifact ─────────────────────────────────────────────────

test("dom_query.js reaches both outputs byte-identical to src/shared", () => {
  const src = readFileSync(join(ROOT, "src", "shared", "dom_query.js"));
  for (const t of TARGETS) {
    const out = readFileSync(dist(t, "dom_query.js"));
    assert.ok(
      src.equals(out),
      `${t}: dom_query.js was modified by the build. It is compared to a ` +
        `client's vendored copy by SHA-256 at handshake — any reformatting, ` +
        `minification or line-ending change refuses every connection.`,
    );
  }
});

test("the injectable entry file wraps the shared bytes verbatim", () => {
  // The extension cannot inject the shared file directly: it is a bare arrow
  // EXPRESSION, so evaluating the file discards the value, and MV3 forbids eval
  // and new Function. The build wraps an assignment around the identical bytes.
  // Generated rather than hand-maintained, so the two cannot drift; asserted
  // here because if they ever did, the handshake would still pass (it hashes
  // the unwrapped copy) while the page ran different code.
  const src = readFileSync(join(ROOT, "src", "shared", "dom_query.js"), "utf8");
  for (const t of TARGETS) {
    const entry = readFileSync(dist(t, "dom_query.entry.js"), "utf8");
    assert.ok(
      entry.includes(src),
      `${t}: dom_query.entry.js does not contain the shared bytes verbatim — ` +
        `the page would run something the handshake never verified`,
    );
    assert.match(
      entry, /globalThis\["__drover_query"\]\s*=/,
      `${t}: the entry file does not define the global page.js calls`,
    );
  }
});

test("the entry file ends on a structured-clonable value", () => {
  // `executeScript` returns the script's completion value and the browser
  // structured-clones it. Ending on the assignment makes that value the
  // function, functions are not clonable, and Firefox refuses the entire
  // injection -- "result is non-structured-clonable data". Every query then
  // fails and the tier falls back to the vision loop, which looks like the
  // extension working and the planner being bad at forms.
  for (const t of TARGETS) {
    const entry = readFileSync(dist(t, "dom_query.entry.js"), "utf8").trimEnd();
    const lastStatement = entry.slice(entry.length - 5);
    assert.equal(
      lastStatement, "true;",
      `${t}: the entry file ends on ${JSON.stringify(lastStatement)}, not a ` +
        `clonable literal -- the injection's completion value would then be ` +
        `the function itself, which cannot cross the process boundary`,
    );
  }
});

test("the unwrapped shared file still ships beside the entry file", () => {
  // It is the copy the handshake hashes. Replacing it with the wrapper would
  // change the digest and refuse every connection.
  for (const t of TARGETS) {
    assert.ok(existsSync(dist(t, "dom_query.js")), `${t}: dom_query.js missing`);
    assert.ok(existsSync(dist(t, "dom_query.entry.js")), `${t}: dom_query.entry.js missing`);
  }
});

test("dom_query.js is LF-only", () => {
  const src = readFileSync(join(ROOT, "src", "shared", "dom_query.js"));
  assert.ok(
    !src.includes("\r\n"),
    "CRLF in dom_query.js — git's autocrlf rewrote it on checkout, which " +
      "changes the SHA-256 and breaks the handshake. .gitattributes must mark " +
      "it binary.",
  );
});

test("the digest documented in PROTOCOL.md matches the file", () => {
  const src = readFileSync(join(ROOT, "src", "shared", "dom_query.js"));
  const actual = createHash("sha256").update(src).digest("hex");
  const doc = readFileSync(join(ROOT, "docs", "PROTOCOL.md"), "utf8");
  assert.ok(
    doc.includes(actual),
    `PROTOCOL.md does not document the current digest ${actual}. A client ` +
      `implementer reading a stale digest cannot connect.`,
  );
});

// ─── Host agnosticism ────────────────────────────────────────────────────

test("no build output names a host application", () => {
  const offenders = [];
  for (const t of TARGETS) {
    for (const file of walk(dist(t))) {
      const text = readFileSync(file, "utf8");
      if (/tenka/i.test(text)) offenders.push(relative(ROOT, file));
    }
  }
  assert.deepEqual(
    offenders, [],
    `host identifier found in build output: ${offenders.join(", ")}. Drover is ` +
      `host-agnostic (PROTOCOL.md §9) — it must not name any client that uses it.`,
  );
});

test("no source file or protocol doc names a host application", () => {
  // dist/ is checked above; this checks what dist/ is built from, plus the
  // protocol document a second implementer would read. The boundary is drawn
  // here deliberately: README and INSTALL DO name a client, because
  // "who uses this and how" is exactly what those documents are for.
  const roots = [join(ROOT, "src")];
  const files = roots.flatMap(walk).concat([
    join(ROOT, "manifest.json"),
    join(ROOT, "docs", "PROTOCOL.md"),
  ]);
  assert.ok(files.length > 5, "the audit walked almost nothing");

  const offenders = files.filter((f) => /tenka/i.test(readFileSync(f, "utf8")));
  assert.deepEqual(
    offenders.map((f) => relative(ROOT, f)), [],
    "a host identifier reached a file that must stay host-agnostic (PROTOCOL.md §9)",
  );
});

test("the walk actually visited files", () => {
  // A structural sweep over an empty set passes forever. Every assertion above
  // that iterates dist/ depends on this being non-zero.
  for (const t of TARGETS) {
    assert.ok(walk(dist(t)).length >= 3, `dist/${t} has almost nothing in it`);
  }
});
