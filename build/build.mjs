/**
 * build.mjs — emit dist/chromium and dist/firefox from one source tree.
 *
 * Two outputs, one manifest source. `background` carries BOTH `service_worker`
 * (Chromium) and `scripts` (Gecko); each browser reads its own key and ignores
 * the other, so there is nothing to strip per target and no second manifest to
 * keep in sync. The two directories differ only because each browser wants its
 * own folder to load from.
 *
 * Bundled as IIFE, not ESM, on purpose. Module background scripts would add a
 * second per-browser version floor on top of the one that already exists
 * (Firefox 121, below which a background page is not started at all when
 * `service_worker` is present). A classic script has no such floor and
 * `scripting.executeScript({ files })` requires one anyway.
 *
 * `dom_query.js` is COPIED, never bundled or transpiled. It is compared against
 * a client's vendored copy by SHA-256 at handshake, so a single reformatted byte
 * refuses every connection.
 */

import * as esbuild from "esbuild";
import { readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TARGETS = ["chromium", "firefox"];

const src = (...p) => join(ROOT, "src", ...p);
const dist = (t, ...p) => join(ROOT, "dist", t, ...p);

/**
 * Entry points bundled per target. Each becomes one classic script.
 *
 * `content/bridge.js` is deliberately NOT here. It is imported by
 * `background/page.js` and inlined into `background.js`, because its functions
 * are handed to `executeScript({func})` rather than loaded as a file. Bundling
 * it a second time shipped an unreferenced `content.js` to every user and to
 * every store reviewer -- no manifest key named it, nothing injected it, and
 * nothing but a reachability check would ever have noticed.
 */
const BUNDLES = [
  { entry: src("background", "index.js"), out: "background.js" },
  { entry: src("popup", "popup.js"), out: "popup/popup.js" },
];

/** The global `dom_query.entry.js` defines. Must match `content/bridge.js`. */
const PAGE_QUERY_GLOBAL = "__drover_query";

/** Files copied verbatim. `dom_query.js` MUST be here, never in BUNDLES. */
const COPIES = [
  { from: src("shared", "dom_query.js"), to: "dom_query.js" },
  { from: src("popup", "index.html"), to: "popup/index.html" },
];

async function buildTarget(target) {
  rmSync(dist(target), { recursive: true, force: true });
  mkdirSync(dist(target, "popup"), { recursive: true });

  for (const { entry, out } of BUNDLES) {
    if (!existsSync(entry)) continue; // later tasks add these
    await esbuild.build({
      entryPoints: [entry],
      outfile: dist(target, out),
      bundle: true,
      format: "iife",
      target: "es2022",
      platform: "browser",
      legalComments: "inline",
      logLevel: "warning",
    });
  }

  // Icons, copied as-is. Declared in the manifest at four sizes because 16 is
  // the toolbar and 128 is the store listing, and a browser that has to
  // downscale 128 to 16 produces mush.
  mkdirSync(dist(target, "icons"), { recursive: true });
  for (const name of ["icon-16.png", "icon-32.png", "icon-48.png", "icon-128.png"]) {
    copyFileSync(join(ROOT, "icons", name), dist(target, "icons", name));
  }

  for (const { from, to } of COPIES) {
    if (!existsSync(from)) continue;
    copyFileSync(from, dist(target, to));
  }

  // The shared query is a bare arrow-function EXPRESSION, so injecting the file
  // evaluates it and discards the value; and MV3 forbids eval and new Function,
  // so it cannot be re-hydrated from text either. Emit a second file holding the
  // identical bytes with an assignment wrapped around them: that one is injected
  // to define the function on the page, then called. The unwrapped file still
  // ships, because that is the copy the handshake hashes -- generating one from
  // the other keeps them from ever disagreeing.
  const rawQuery = readFileSync(src("shared", "dom_query.js"), "utf8");
  writeFileSync(
    dist(target, "dom_query.entry.js"),
    // The trailing `true;` is load-bearing, not decoration.
    //
    // `executeScript` returns the injected script's COMPLETION VALUE, and the
    // browser structured-clones it across the process boundary. Ending on the
    // assignment makes that value the function itself, and functions are not
    // structured-clonable -- Firefox refuses the whole injection with
    // "result is non-structured-clonable data" and every query fails. Ending
    // on a boolean gives it something it can carry, and gives the caller a
    // signal that the file ran.
    `globalThis[${JSON.stringify(PAGE_QUERY_GLOBAL)}] = (
${rawQuery}
);
true;
`,
    "utf8",
  );

  // The manifest is emitted with LF and no trailing reformatting so a diff
  // between the two targets is empty rather than noisy.
  const manifest = readFileSync(join(ROOT, "manifest.json"), "utf8");
  writeFileSync(dist(target, "manifest.json"), manifest, "utf8");
}

for (const target of TARGETS) {
  await buildTarget(target);
}

const digest = createHash("sha256")
  .update(readFileSync(src("shared", "dom_query.js")))
  .digest("hex");

console.log(`built: ${TARGETS.map((t) => `dist/${t}`).join(", ")}`);
console.log(`dom_query.js sha256: ${digest}`);
