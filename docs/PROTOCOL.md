# The Drover wire protocol

Version **1**. Authoritative constants: [`src/shared/protocol.js`](../src/shared/protocol.js).
A client mirrors that file; the two are changed together and `PROTOCOL_VERSION` is bumped.

Nothing in this document names a host application, and nothing in it may.

---

## 1. Shape

One WebSocket. The **server** is the local program; the **extension** is the client and dials
out. That direction is deliberate: an extension cannot listen on a port, and a server that
dials into a browser would need to know which browser and when.

Once the handshake completes, traffic is asymmetric:

| Direction | Frames |
| --- | --- |
| server → extension | `request` |
| extension → server | `response`, `event`, `ping` |

The extension never sends a `request`. **It is a target, not a principal** — it does not ask
the host to do anything, which is what lets a host grant its listener an empty capability
ceiling.

Every frame is a JSON object with a `type` field.

## 2. Transport requirements

A host implementing the server side **must**:

- bind `127.0.0.1` only, never `0.0.0.0`;
- reject any `Origin` that is not `chrome-extension://…` or `moz-extension://…`, **before**
  examining the token;
- accept exactly one extension connection at a time — a second is refused, not swapped in, so
  a connecting client cannot displace a working one;
- require a bearer token in `hello`.

**Residual risk, stated plainly.** Any local process can reach a loopback port, and the token
lives in the browser profile where anything with filesystem access can read it. Drover is not a
defence against a compromised machine. It is a large improvement on a CDP debug port, which
accepts any local client with no token at all.

## 3. Handshake

The extension sends `hello` first and sends nothing else until it is answered.

```json
{
  "type": "hello",
  "protocolVersion": 1,
  "domQuerySha256": "66c870ba…",
  "token": "<bearer>",
  "browser": "firefox",
  "extensionVersion": "0.1.0"
}
```

`browser` is one of `chrome`, `edge`, `brave`, `firefox`, `other` — a hint for logging and
capability decisions, **never** for authorisation. It is self-reported and trivially forged.

The server verifies in this order, and the order matters — each check is cheaper and less
trusting than the next:

1. `protocolVersion` — must equal the server's. No negotiation. A driver that half-speaks a
   protocol fails in the middle of a task, which is worse than not connecting.
2. `domQuerySha256` — must equal the digest of the server's vendored copy of
   `dom_query.js` (§6).
3. `token` — must be valid.
4. `Origin` — must be an extension scheme.

Accepted:

```json
{ "type": "welcome" }
```

Refused — connection closes immediately after:

```json
{ "type": "reject", "code": 1005, "reason": "protocol 2 != 1" }
```

A client that receives `reject` with `PROTOCOL_MISMATCH` (1005) or `HASH_MISMATCH` (1006)
**must stop retrying**. Both are permanent until a build changes; reconnecting achieves
nothing but log noise.

## 4. Requests and responses

```json
{ "type": "request", "id": 42, "method": "page.query", "params": { "filter": "interactive" } }
```

```json
{ "type": "response", "id": 42, "ok": true,  "result": { "elements": [] } }
{ "type": "response", "id": 42, "ok": false, "code": 1001, "message": "no active tab" }
```

**Every request gets exactly one response carrying its own `id`** — including unknown methods
and internal failures. A dropped reply hangs the caller forever, so a handler that throws is
converted to an error frame rather than allowed to escape.

**Target tab resolution**, for every `page.*` method: `params.tabId` if given; otherwise the
active tab; otherwise `NO_TAB` (1001) — never a silent no-op on some other tab.

### Methods

| Method | Params | Result |
| --- | --- | --- |
| `page.query` | `filter`, `openComboboxes` | `{ elements, url, viewport, validation_errors }` (§5) |
| `page.act` | `idx`, `action`, `value?` | `{ ok: true }` |
| `page.info` | — | `{ url, title, readyState, innerText }` |
| `page.goto` | `url`, `waitUntil?` | `{ url }` |
| `page.waitLoad` | `state?`, `timeout?` | `{ state }` |
| `page.screenshot` | — | `{ png: "<base64>" }` — **visible viewport only** (§7) |
| `tabs.list` | — | `{ tabs: [{ id, url, title, active, windowId }] }` |
| `tabs.activate` | `tabId` | `{ ok: true }` |
| `tabs.open` | `url`, `active?` | `{ tabId }` |
| `tabs.close` | `tabId` | `{ ok: true }` |

`page.act` actions: `click`, `fill`, `press`, `select`, `check`, `uncheck`.

### Error codes

| Code | Name | Meaning |
| --- | --- | --- |
| 1001 | `NO_TAB` | no `tabId` and no active tab |
| 1002 | `TIMEOUT` | operation exceeded its budget |
| 1003 | `INJECTION_BLOCKED` | page CSP or a privileged URL refused the content script |
| 1004 | `BAD_SELECTOR` | the index no longer resolves, or is malformed |
| 1005 | `PROTOCOL_MISMATCH` | handshake — versions disagree |
| 1006 | `HASH_MISMATCH` | handshake — `dom_query.js` copies disagree |
| 1007 | `UNAUTHORIZED` | bad token, or disallowed `Origin` |
| 1008 | `UNKNOWN_METHOD` | not implemented by this build |
| 1009 | `INTERNAL` | unhandled failure inside a handler |

Codes are numeric and stable. Branch on the code; matching on message text is how a client
breaks when someone improves an error message.

## 5. Element addressing

`page.query` runs `dom_query.js` in the page. It stamps every captured element with
**`data-drover-idx="N"`** and returns them in order.

`page.act` addresses an element by that index and nothing else. **A client never constructs
its own selector** — it acts on indices from the query it just ran.

Every element carries exactly these keys, and no others:

`aria_invalid`, `autocomplete`, `bounds`, `enabled`, `form_id`, `idx`, `in_dialog`, `name`,
`options`, `placeholder`, `role`, `tag`, `type`, `value`, `visible`

`bounds` is `[x, y, width, height]`. `options` is populated for native `<select>` only.

The result's `url` is read in the **same snapshot** as the elements. A caller that fetched it
in a separate round trip could compare a URL from one moment against elements from another —
and detecting that a page navigated is exactly that comparison.

**Hidden elements are reported with `visible: false`, not omitted.** "The button exists but
is hidden" and "there is no such button" call for different next moves, and a caller that
cannot tell them apart will keep re-querying for something it has already been told about.

`check` and `uncheck` are idempotent, and an element already in the wanted state is **not
clicked**. The state would end up the same either way; the click would not. A checkbox that
submits its form or reports to analytics has already done so by the time anyone notices.

An index that no longer resolves returns `BAD_SELECTOR` (1004). It does **not** fall back to a
best guess: between query and act the page may have navigated, and acting on whatever now sits
at that index is how an automated form submits the wrong thing.

The attribute name is protocol, not an implementation detail: the query stamps it and the
client selects on it, so a rename applied to one side leaves every element resolving to
nothing — and a page where nothing resolves looks exactly like a page with nothing on it.

## 6. `dom_query.js` is one artifact with two copies

Manifest V3's content-script CSP forbids evaluating JS that arrived over the wire, so the
extension cannot be handed the query at call time. It ships the file in its own bundle.

Rather than pretend there is one copy, the two are compared: the extension reports the SHA-256
of its copy in `hello`, and a mismatch refuses the connection with `HASH_MISMATCH`. A client
falls back to whatever driver it has (typically a bundled browser) and logs both digests.

**Windows.** `core.autocrlf` rewrites line endings on checkout, which changes the digest with
no code change involved. Both repositories mark the file `binary` in `.gitattributes`. One
side having the rule is not enough.

Current digest: `5ee77f4c1404c0db27c13c0b2025eb57a8e7c25e9579925729b3ed11409bf67c`.

## 7. Events

Pushed by the extension, unsolicited, after `welcome`.

```json
{ "type": "event", "event": "navigated", "ts": 1756468800000, "tabId": 7, "url": "…", "title": "…" }
```

| Event | Fires on |
| --- | --- |
| `tab_opened` | `tabs.onCreated` |
| `tab_closed` | `tabs.onRemoved` |
| `navigated` | `webNavigation.onCompleted`, **main frame only** |
| `download_started` | `downloads.onCreated` |
| `download_finished` | `downloads.onChanged` → state complete |

Names are neutral; a host may prefix them.

`navigated` is main-frame-only (`frameId === 0`) deliberately — `webNavigation.onCompleted`
fires for every sub-frame, so without the guard each ad iframe becomes an event.

Events emitted while the socket is down are **dropped**, not queued. A background worker is
evicted when idle, so an unbounded buffer is a leak that also loses its contents on eviction —
dropping is the honest behaviour, and a client that needs history should ask.

## 7.1 Keepalive

The extension sends `{ "type": "ping" }` every 20 seconds while the socket is open.
It carries nothing and expects no reply. The server ignores it.

It exists because **an open socket does not keep an MV3 background context alive** — only
traffic does, and a connection nobody is talking over is idle by definition. Without it the
extension is suspended after roughly thirty seconds, the socket drops, and it reconnects on
its alarm — leaving a window every minute where the browser is unreachable for no reason a
user could see.

A server that treats an unrecognised frame as a protocol violation will disconnect the
extension every twenty seconds. Ignore it, or answer it; do not refuse it.

## 8. Capability limits

Honest about what an extension cannot do, so a client does not plan around a capability that
is not there:

- **Screenshots are the visible viewport only.** `tabs.captureVisibleTab` has no full-page
  mode. A capture request naming a non-active tab returns an error rather than silently
  capturing the active one.
- **Browser-internal pages are unreachable** — `chrome://`, `about:`, the add-ons manager and
  the store pages all refuse content scripts. `INJECTION_BLOCKED` (1003).
- **A few sites with strict CSP block injection.** Rare, and the failure is explicit.
- **No traffic interception.** Not requested, not a goal (README).

## 9. Host neutrality

Drover is a driver. It carries no model, no planner and no task loop, and it is not the
extension belonging to any one program -- whatever opens the socket supplies the intelligence.

That is a constraint on this repository, not an aspiration:

- Nothing under `src/`, in `manifest.json`, or in this document may name a client. A test in
  `test/build.test.mjs` walks all three and fails on a match, and it asserts the walk visited
  files -- a sweep over an empty set passes forever.
- `README.md` and `docs/INSTALL.md` are exempt, deliberately. "Who uses this, and how" is what
  those documents are for, and a reference client is the fastest way to understand a protocol.
- The wire never carries a host name either: no frame field, error code or DOM attribute is
  derived from one. `data-drover-idx` is named after the protocol, not after a program.

A second implementer owes nothing to the first. Everything needed to write a server is in this
file.
