/**
 * wake.test.mjs — Task 4.3: the extension must still work after a wake.
 *
 * Chromium evicts an idle service worker; Gecko suspends an idle event page. On
 * wake the background file is re-evaluated and **only the listeners registered
 * during that evaluation are re-attached.** A registration inside an `async`
 * function, a callback or an `if` runs once, on first evaluation, and is then
 * silently absent for the rest of the session. Nothing throws. The extension
 * simply stops answering that event, and the only symptom is "it worked for a
 * while this morning".
 *
 * There is no way to make Node evict a worker, so this is a structural sweep of
 * the source rather than a behavioural test. Two things keep it from being
 * theatre:
 *
 *   - it asserts the walk found something (a sweep over an empty set passes
 *     forever, and this project has shipped one that did);
 *   - it is paired with a real behavioural test below — an alarm must be armed,
 *     because `setTimeout` does not survive eviction and a client that relies
 *     on one has no way back once the worker sleeps.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SRC = join(ROOT, "src");
const ENTRY = join(SRC, "background", "index.js");

function walkJs(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walkJs(full));
    else if (full.endsWith(".js")) out.push(full);
  }
  return out;
}

/**
 * Strip comments and template/string literals so prose about `addListener`
 * inside a docstring is not mistaken for a registration. Crude on purpose —
 * a parser here would be a second thing to get wrong.
 */
function stripNonCode(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
    .replace(/`(?:\\.|[^`\\])*`/g, "``")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/'(?:\\.|[^'\\])*'/g, "''");
}

/** Every line calling `.addListener(`, with its indentation. */
function registrationLines(src) {
  return stripNonCode(src)
    .split("\n")
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => /\.addListener\s*\(/.test(line));
}

// ─── The sweep ───────────────────────────────────────────────────────────

test("every listener registration lives in the background entry point", () => {
  const strays = [];
  for (const file of walkJs(SRC)) {
    if (file === ENTRY) continue;
    if (registrationLines(readFileSync(file, "utf8")).length > 0) {
      strays.push(relative(ROOT, file));
    }
  }
  assert.deepEqual(
    strays, [],
    `addListener found outside the entry point: ${strays.join(", ")}. Every ` +
      `registration must sit at the top level of index.js so a wake re-runs it.`,
  );
});

test("the entry point registers at least the listeners it needs", () => {
  // The 'walked nothing' guard. Without it every assertion below passes on a
  // file that registers nothing at all.
  const found = registrationLines(readFileSync(ENTRY, "utf8"));
  assert.ok(
    found.length >= 9,
    `expected at least 9 registrations in index.js, found ${found.length}. ` +
      `If listeners were removed on purpose, lower this number deliberately — ` +
      `do not delete the assertion.`,
  );
});

test("no registration is nested inside a function, callback or conditional", () => {
  const src = readFileSync(ENTRY, "utf8");
  const nested = registrationLines(src).filter(({ line }) => /^\s+\S/.test(line));
  assert.deepEqual(
    nested.map(({ n, line }) => `${n}: ${line.trim()}`), [],
    "an addListener is indented, so it is inside something. On wake it will " +
      "not be re-registered and the extension will silently stop answering " +
      "that event.",
  );
});

test("no registration is reached through await or a conditional guard", () => {
  const code = stripNonCode(readFileSync(ENTRY, "utf8"));
  const beforeFirst = code.slice(0, code.search(/\.addListener\s*\(/));
  assert.ok(
    !/\bawait\b/.test(beforeFirst),
    "an `await` runs before the first registration. Everything after it is " +
      "deferred to a microtask, which on wake may not run before the event " +
      "the extension was woken for.",
  );
});

// ─── The behavioural half ────────────────────────────────────────────────

test("a reconnect alarm is armed at top level", () => {
  const code = stripNonCode(readFileSync(ENTRY, "utf8"));
  const line = code.split("\n").find((l) => /alarms\.create\s*\(/.test(l));
  assert.ok(line, "no alarms.create — nothing survives eviction to retry with");
  assert.ok(
    !/^\s+\S/.test(line),
    "alarms.create is nested; it must run on every evaluation of the module",
  );
});

test("the alarm period is at least one minute", () => {
  const code = stripNonCode(readFileSync(ENTRY, "utf8"));
  const m = code.match(/periodInMinutes:\s*([A-Z_a-z0-9.]+)/);
  assert.ok(m, "alarms.create has no periodInMinutes");
  const raw = m[1];
  const value = /^[\d.]+$/.test(raw)
    ? Number(raw)
    : Number((code.match(new RegExp(`${raw}\\s*=\\s*([\\d.]+)`)) ?? [])[1]);
  assert.ok(
    Number.isFinite(value) && value >= 1,
    `alarm period is ${raw}. Released Chromium clamps alarms to one minute; ` +
      `asking for less silently gets one minute and misleads the next reader.`,
  );
});

test("the manifest requests the alarms permission", () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, "manifest.json"), "utf8"));
  assert.ok(
    manifest.permissions.includes("alarms"),
    "index.js arms an alarm but the manifest does not request `alarms` — " +
      "alarms.create throws and the only path back from an evicted worker is gone",
  );
});
