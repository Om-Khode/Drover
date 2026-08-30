# Building Drover

Step-by-step instructions producing an **exact copy** of the published extension.

Written for a store reviewer, who needs to reproduce the submitted package byte for byte, but
it is the same procedure for anyone else.

## Requirements

| | |
| --- | --- |
| Operating system | Any that Node.js runs on. Developed on Windows 11; the build has no platform-specific steps and writes only into `dist/`. |
| Node.js | **20 or newer.** Built and tested with 24. Install from <https://nodejs.org> (LTS is fine). |
| npm | Ships with Node. No global packages are needed. |
| Network | Only for `npm install`. The build itself is offline. |

One dependency does the work — `esbuild`, pinned in `package-lock.json`. Nothing is fetched at
build time and no install scripts run.

## Build

```bash
npm install        # exact versions from package-lock.json
npm run build      # -> dist/chromium/ and dist/firefox/
```

`dist/firefox/` **is** the submitted package: same files, same bytes.

To reproduce the uploaded archives as well:

```bash
npm run package
#   dist/artifacts/drover-<version>.zip     the extension, via web-ext
#   dist/artifacts/drover-source.zip        this repository, via git archive
```

`npm test` runs 146 tests. No browser required.

## What the build does

`build/build.mjs`, about 120 lines, and worth reading rather than trusting:

1. **Bundles two entry points** with esbuild — `src/background/index.js` and
   `src/popup/popup.js` — as IIFE classic scripts, ES2022, **not minified**. Comments are kept
   (`legalComments: "inline"`).
2. **Copies `src/shared/dom_query.js` verbatim.** Never bundled, never transpiled, never
   reformatted. Its SHA-256 is compared against the connecting program's own copy during the
   handshake, so a single altered byte refuses every connection — which is exactly the point,
   and also why `.gitattributes` marks the file `binary` so `core.autocrlf` cannot rewrite its
   line endings on checkout.
3. **Generates `dom_query.entry.js`**, wrapping those identical bytes in an assignment so the
   file can be injected by `scripting.executeScript`. It ends on `true;` deliberately: the
   completion value of an injected script is structured-cloned, and a function is not
   clonable, so ending on the assignment makes Firefox refuse the whole injection.
4. **Writes one manifest per target** from the single `manifest.json`, keeping **both**
   background keys. Chromium reads `service_worker` and ignores `scripts`; Gecko does the
   reverse. `strict_min_version` is `121.0` because Firefox 106–120 refuses to start a
   background page when `service_worker` is also present — a manifest carrying both would
   install and silently do nothing.
5. **Copies the icons** at four sizes.

No template engine, no code generator, no minifier, no post-processing. Every file under
`src/` is hand-written and readable as shipped.

## Verifying a build matches a submission

```bash
npm run build
# compare dist/firefox/ against the uploaded package
```

Byte-identical output for a given commit, on any platform. If it differs, the likeliest cause
is line-ending normalisation on checkout — check that `.gitattributes` was honoured, in
particular for `src/shared/dom_query.js`.
