/**
 * protocol.js — the Drover wire protocol, in one place.
 *
 * Drover is a browser driver, not an agent: it exposes primitives over a local
 * WebSocket and holds no model, no planner and no task loop. Anything in this
 * file is part of the contract a client depends on. Mirrored on the Python side
 * by `automation/browser/protocol.py`; the two must be changed together and
 * `PROTOCOL_VERSION` bumped.
 *
 * Nothing here may name a host application. See docs/PROTOCOL.md §9.
 */

/**
 * Bumped on ANY breaking change to a frame shape, a method name, or the element
 * schema. The server compares it in the `hello` frame and refuses a mismatch
 * outright rather than negotiating down — a driver that half-speaks a protocol
 * fails in the middle of a task, which is worse than not connecting.
 */
export const PROTOCOL_VERSION = 1;

/**
 * The attribute the query stamps on every captured element, and the only way a
 * client addresses one afterwards. Clients never construct their own selectors;
 * they act on indices returned by the query they just ran.
 *
 * `IDX_ATTR` is the CSS/attribute spelling; `IDX_DATASET` is the same name as
 * `HTMLElement.dataset` exposes it. Both are here because `dom_query.js` writes
 * via `dataset` and reads back via an attribute selector, and a rename that
 * updated one and not the other would stamp one name while selecting another —
 * every element resolves to nothing and the page looks empty rather than broken.
 */
export const IDX_ATTR = "data-drover-idx";
export const IDX_DATASET = "droverIdx";

/**
 * Every key `page.query` puts on an element, and the complete set — a client
 * parses exactly these and no more.
 *
 * Declared here rather than left implicit in `dom_query.js` because it is the
 * one part of this protocol two codebases must agree on field by field. Each
 * side asserts against this list rather than against the other's output: a
 * snapshot test comparing two implementations passes happily when both are
 * wrong in the same way, and drifts for reasons that have nothing to do with
 * the contract.
 *
 * A key added here without being produced, or produced without being listed,
 * fails on both sides.
 */
export const ELEMENT_KEYS = Object.freeze([
  "aria_invalid",
  "autocomplete",
  "bounds",
  "enabled",
  "form_id",
  "idx",
  "in_dialog",
  "name",
  "options",
  "placeholder",
  "role",
  "tag",
  "type",
  "value",
  "visible",
]);

/** Top-level keys of a `page.query` result. */
export const QUERY_RESULT_KEYS = Object.freeze(["elements", "url", "validation_errors", "viewport"]);

/** Actions `page.act` accepts. */
export const ACTIONS = Object.freeze(["click", "fill", "press", "select", "check", "uncheck"]);

/** RPC method names. Namespaced by target so a reader can tell what a call touches. */
export const RPC = {
  // Page-level, all operate on one tab.
  GOTO: "page.goto",
  QUERY: "page.query",
  ACT: "page.act",
  SCREENSHOT: "page.screenshot",
  INFO: "page.info",
  WAIT_LOAD: "page.waitLoad",
  // Tab-level.
  TABS_LIST: "tabs.list",
  TABS_ACTIVATE: "tabs.activate",
  TABS_OPEN: "tabs.open",
  TABS_CLOSE: "tabs.close",
};

/**
 * Error codes. Numeric and stable: a client branches on these, and matching on
 * message text is how a driver breaks when someone improves an error message.
 */
export const ERR = {
  NO_TAB: 1001,              // no tabId given and no active tab to fall back to
  TIMEOUT: 1002,             // the operation did not complete in its budget
  INJECTION_BLOCKED: 1003,   // page CSP or a privileged URL refused the content script
  BAD_SELECTOR: 1004,        // an index that no longer resolves, or a malformed one
  PROTOCOL_MISMATCH: 1005,   // hello.protocolVersion disagrees with the server
  HASH_MISMATCH: 1006,       // hello.domQuerySha256 disagrees with the server's copy
  UNAUTHORIZED: 1007,        // bad token, or a disallowed Origin
  UNKNOWN_METHOD: 1008,      // a method name this build does not implement
  INTERNAL: 1009,            // an unhandled failure inside a handler
};

/** Event names pushed from the extension. Neutral — a host may prefix them. */
export const EVENTS = {
  TAB_OPENED: "tab_opened",
  TAB_CLOSED: "tab_closed",
  NAVIGATED: "navigated",
  DOWNLOAD_STARTED: "download_started",
  DOWNLOAD_FINISHED: "download_finished",
};

/** Frame `type` values. Every frame on the wire carries one. */
export const FRAME = {
  HELLO: "hello",       // client -> server, always first
  WELCOME: "welcome",   // server -> client, handshake accepted
  REJECT: "reject",     // server -> client, handshake refused; carries an ERR code
  REQUEST: "request",   // server -> client, an RPC call
  RESPONSE: "response", // client -> server, the reply to one `id`
  EVENT: "event",       // client -> server, unsolicited
  // Client -> server, periodically, while the socket is open. Carries
  // nothing and expects no reply. An open socket does not keep an MV3
  // background context alive -- only traffic does -- so without this the
  // extension is suspended after ~30s idle and the connection drops.
  PING: "ping",
};

/** Build an error response. Always carries the request's own `id`. */
export function errorResponse(id, code, message) {
  return { type: FRAME.RESPONSE, id, ok: false, code, message: String(message) };
}

/** Build a success response. */
export function okResponse(id, result) {
  return { type: FRAME.RESPONSE, id, ok: true, result };
}
