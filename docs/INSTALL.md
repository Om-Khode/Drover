# Installing Drover

Drover drives the browser you already have open. There is nothing to configure in the
browser itself — no launch flags, no debug port, no separate shortcut.

Two steps: load the extension, then paste the token your local program gives you.

---

## Which browsers

| | Build | Notes |
| --- | --- | --- |
| **Chrome, Edge, Brave** | `dist/chromium` | Tested. |
| **Firefox** | `dist/firefox` | Tested. Needs **121 or newer** — see below. |
| Vivaldi, Opera, Arc, other Chromium forks | `dist/chromium` | Same APIs; not gating on releases. |
| LibreWolf, Waterfox, Zen, Floorp | `dist/firefox` | Same signed `.xpi`. |
| **DuckDuckGo browser** | — | **Not possible.** It has [no extension support at all](https://duckduckgo.com/duckduckgo-help-pages/get-duckduckgo/get-duckduckgo-browser-on-windows), and being WebView2-based it exposes no debug port either — so no automation tool can drive it, not just this one. |
| Safari | — | Out of scope. Safari Web Extensions need Xcode packaging and a paid Apple Developer account. |
| Tor Browser | — | Out of scope by intent. Automating it works against its threat model. |

**Firefox 121 is a hard floor, and the reason is easy to miss.** The manifest carries both
`background.service_worker` (which Chromium reads) and `background.scripts` (which Gecko
reads). Firefox 106–120 *refuses to start a background page at all* when `service_worker` is
also present. On those versions Drover installs cleanly, shows up in the add-ons list, and
does nothing whatsoever.

---

## Build

```bash
npm install
npm run build      # -> dist/chromium/ and dist/firefox/
npm test
```

---

## Load it — development

**Chrome / Edge / Brave**

1. Open `chrome://extensions` (`edge://extensions`, `brave://extensions`).
2. Turn on **Developer mode**.
3. **Load unpacked** → select `dist/chromium`.

**Firefox**

1. Open `about:debugging#/runtime/this-firefox`.
2. **Load Temporary Add-on** → select `dist/firefox/manifest.json`.

A temporary add-on is removed when Firefox restarts. For a permanent install, sign it.

---

## Sign it — permanent Firefox install

Firefox release and ESR builds refuse unsigned extensions outright; there is no override.
Developer Edition and Nightly allow `xpinstall.signatures.required=false`, but relying on
that means running a different browser than the one you use.

**AMO unlisted signing is free, needs no review, and does not publish anything.** Mozilla
signs the file and hands it back; it never appears in the add-ons directory.

1. Get an API key at <https://addons.mozilla.org/developers/addon/api/key/>.
2. Sign:

```bash
npx web-ext sign \
  --source-dir dist/firefox \
  --api-key "$AMO_JWT_ISSUER" \
  --api-secret "$AMO_JWT_SECRET" \
  --channel unlisted
```

3. The signed `.xpi` lands in `web-ext-artifacts/`. Install it via
   `about:addons` → gear icon → **Install Add-on From File**.

The extension id in `manifest.json` (`browser_specific_settings.gecko.id`) is what AMO
signs against. Signing fails without one, and it fails at the point where you are trying to
ship.

**Chromium browsers** load `dist/chromium` unpacked indefinitely — Chrome nags about
developer-mode extensions on each start but keeps working. A Chrome Web Store listing would
remove the nag and costs a one-time $5 developer fee; it is not needed for Drover to work.

---

## Connect

1. Ask your local program for the extension credential. In TENKA:
   *"set up the browser extension"*.
2. Click the Drover toolbar icon.
3. Check the server address (default `ws://127.0.0.1:8790/drover`) and paste the token.
4. **Connect**. The popup should say *Connected.*

The token only works from this machine — the popup refuses any address that is not
loopback — and it grants nothing except the ability to drive the browser. The listener it
opens has an empty capability ceiling: a stolen token cannot make the local program do
anything.

---

## When it does not connect

The popup shows the server's own reason. The ones worth recognising:

| Message | What happened |
| --- | --- |
| *This build and the server disagree* | Protocol or `dom_query.js` mismatch. The extension and the local program shipped different versions of the shared file. Rebuild both from matching sources; reconnecting cannot fix it, and the client deliberately stops retrying. |
| *Refused: another extension is already connected* | One connection at a time. The first keeps the socket — close the other browser's Drover or disconnect it from its popup. |
| *Refused: origin is not a browser extension* | Something that is not an extension reached the port. Not a problem with your install. |
| *Refused: bad token* | Re-run setup and paste the new token; the old one was replaced. |
| Stuck on *Disconnected. Retrying shortly.* | The local program is not listening. Check it is running and that the address matches. Open the extension's own console (`about:debugging` → **Inspect**) — every state change logs its reason. |
| Console says *can't establish a connection to `wss://…`* | Something rewrote `ws://` to `wss://`. Firefox's **default** MV3 CSP includes `upgrade-insecure-requests`; the manifest declares its own CSP to drop it. If you see this, the build is stale — rebuild and reload. |

**Disconnect** turns it off and keeps it off — the reconnect alarm respects it, so it will
not quietly come back a minute later. Press **Connect** to resume.

**After a browser restart**, Drover reconnects on its own — the token is stored locally and
the background worker re-dials. It does not need to be set up again.

---

## Remove it

*"undo the browser extension"* removes the stored credential; the extension can no longer
connect until you run setup again. Uninstalling the extension from the browser removes the
rest. Nothing else on your system was touched.
