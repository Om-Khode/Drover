<p align="center">
  <img src="icons/icon-128.png" width="112" alt="Drover">
</p>

<h1 align="center">Drover</h1>

<p align="center">
  <b>Drive the browser you already have open, from a local program, over a WebSocket.</b>
</p>

<p align="center">
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-Apache--2.0-blue"></a>
  <img alt="Manifest V3" src="https://img.shields.io/badge/manifest-v3-informational">
  <img alt="Firefox 121+" src="https://img.shields.io/badge/firefox-121%2B-orange">
  <img alt="Chromium" src="https://img.shields.io/badge/chrome%20%7C%20edge%20%7C%20brave-supported-brightgreen">
</p>

---

Every browser-automation tool starts a browser. Drover drives **yours** -- the window already
open, already signed in, with your cookies and your extensions. No launch flags, no debug
port, no separate profile, no relaunch.

It is a **driver, not an agent**. It exposes browser primitives over a loopback WebSocket and
holds no model, no planner, no task loop. Whatever connects to it supplies the intelligence.

```
your program  ---- ws://127.0.0.1 ---->  Drover  ---->  the tab you are looking at
```

## Why not CDP or WebDriver?

| | Chrome DevTools Protocol | WebDriver BiDi | Drover |
| --- | --- | --- | --- |
| Works in Firefox | no | yes | yes |
| Needs a relaunch with a flag | yes | yes | **no** |
| Uses your existing profile and logins | only after relaunch | only after relaunch | **yes** |
| Push events (tabs, navigation, downloads) | no, poll only | no | **yes** |
| Full-page screenshots | yes | yes | no, viewport only |

The flag is the whole point. A browser you must restart to automate is a browser you are not
logged into -- so "log in first" comes back, on every site, every time.

## Supported browsers

| | Build | |
| --- | --- | --- |
| **Firefox** | `dist/firefox` | 121+ -- [INSTALL.md](docs/INSTALL.md) explains why that floor is hard |
| **Chrome, Edge, Brave** | `dist/chromium` | |
| Vivaldi, Opera, Arc, other Chromium forks | `dist/chromium` | same APIs, not release-gated |
| LibreWolf, Waterfox, Zen, Floorp | `dist/firefox` | same signed `.xpi` |
| DuckDuckGo browser | -- | impossible: [no extension support](https://duckduckgo.com/duckduckgo-help-pages/get-duckduckgo/get-duckduckgo-browser-on-windows), and no debug port either |
| Safari | -- | needs Xcode packaging and a paid Apple developer account |

## Quick start

```bash
npm install
npm run build      # -> dist/chromium/ and dist/firefox/
npm test
```

Load it: Chrome `chrome://extensions` -> Developer mode -> **Load unpacked** -> `dist/chromium`.
Firefox `about:debugging` -> **Load Temporary Add-on** -> `dist/firefox/manifest.json`.

Paste the token your program minted, press Connect. Full walkthrough, permanent Firefox
installs, and what each refusal means: **[docs/INSTALL.md](docs/INSTALL.md)**.

**Nothing to connect it to yet?**

```bash
npm run demo
```

`examples/test-server.mjs` is a loopback server in Node built-ins alone -- no dependencies,
nothing to install. It prints a token, accepts the handshake, reads the active tab, and then
gives you a prompt: `query`, `click 4`, `fill 2 hello`, `goto <url>`. It is a demonstration,
not a library -- but it is a hundred lines, and reading it is the fastest way to understand
what writing a client involves.

## What it can do

| Verb | |
| --- | --- |
| `page.query` | every interactive element, with roles, labels, bounds and validation state |
| `page.act` | click, fill, press, select, check, uncheck -- addressed by index, never by a selector you invented |
| `page.info` | url, title, ready state, visible text |
| `page.goto`, `page.waitLoad` | navigate and wait; `http`/`https` only |
| `page.screenshot` | visible viewport of the active tab |
| `tabs.list`, `activate`, `open`, `close` | |
| events | `tab_opened`, `tab_closed`, `navigated`, `download_started`, `download_finished` |

The wire protocol is written for a second implementer: **[docs/PROTOCOL.md](docs/PROTOCOL.md)**.

## Security

Drover hands a local program control of a browser you are logged into. That is the feature, so
the limits are worth stating plainly.

- **Loopback only.** The server binds `127.0.0.1`; nothing on your network reaches it.
- **Extensions only.** Any `Origin` that is not `chrome-extension://` or `moz-extension://` is
  refused -- and refused *before* the token is examined, so the socket cannot be used to test
  token guesses.
- **One connection.** A second client is refused and the first keeps serving. A dead one is
  evicted only after it fails to answer a probe.
- **A bearer token**, minted by your program, pasted in once.
- **Integrity checked.** The extension reports the SHA-256 of the `dom_query.js` it shipped;
  a mismatch with the server's copy refuses the connection, because the two must run identical
  bytes.

**What Drover does not protect against:** anything already running as you. A local process can
read the token out of the browser profile and can reach a loopback port. This is a large
improvement on a CDP debug port -- which accepts *any* local client with *no* token -- and it
is not a sandbox.

It requests `<all_urls>` because the page you want driven is not known in advance, and
`scripting` because reading a page means running the query inside it. It does **not** request
`webRequest` or `declarativeNetRequest`: it never intercepts, blocks or rewrites traffic.
Every permission is justified line by line in [docs/INSTALL.md](docs/INSTALL.md).

## Writing a client

Anything that speaks WebSocket. The server side owes four things -- bind loopback, check the
`Origin` before the token, allow one connection, compare the `dom_query.js` digest -- all
specified in [docs/PROTOCOL.md](docs/PROTOCOL.md).

The reference client is [**TENKA**](https://github.com/Om-Khode/TENKA), a local voice
assistant, which uses Drover as its browser-automation tier. Nothing under `src/` mentions it,
and a test enforces that: Drover is not TENKA's extension, it is an extension TENKA happens to
use first.

## Contributing

```bash
npm test              # 127 tests, no browser required
npm run build         # both targets
```

Conventions, and why they are what they are:

- **Conventional Commits**, no trailers, no git hooks -- the checks are `npm test` and CI.
- **No host identifiers.** Nothing in `src/`, `manifest.json` or `docs/PROTOCOL.md` may name a
  specific client. A test asserts it; it is a constraint, not an aspiration.
- **`src/shared/dom_query.js` is byte-shared.** Clients vendor a copy and the two are compared
  by SHA-256 at every handshake. Editing it means re-pinning the digest on both sides -- and
  `.gitattributes` marks it `binary`, because `core.autocrlf` would otherwise change the hash
  on checkout and refuse every connection for a reason nobody would think to look for.

## Licence

[Apache-2.0](LICENSE).
