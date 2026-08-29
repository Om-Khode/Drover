/**
 * rpc.js — one request in, exactly one response out.
 *
 * ## The invariant
 *
 * **Every request produces exactly one response carrying its own `id`.** The
 * server keeps a pending-call table keyed on that id. A dropped reply is not a
 * failure a caller can see — it is a call that hangs until its own timeout,
 * with no reason attached and a pending slot leaking until then. So `dispatch`
 * never throws and never rejects, whatever a handler does: unknown methods
 * answer, throwing handlers answer, rejected promises answer, and a handler
 * that throws a bare string or `null` still answers.
 *
 * `RpcError` exists so a handler can name its own code. Collapsing everything
 * to INTERNAL would leave a caller unable to tell a blocked injection from a
 * crash — and it would retry the one thing that can never succeed.
 */

import { ERR, FRAME, RPC } from "../shared/protocol.js";

export class RpcError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "RpcError";
    this.code = code;
  }
}

/** Whatever was thrown, rendered as a string. Handlers are not all well-behaved. */
function describe(thrown) {
  if (thrown instanceof Error) return thrown.message || thrown.name;
  if (thrown === null) return "null";
  if (thrown === undefined) return "undefined";
  try {
    return typeof thrown === "string" ? thrown : JSON.stringify(thrown);
  } catch {
    return String(thrown);
  }
}

export async function dispatch(frame, ctx, handlers = HANDLERS) {
  const id = frame?.id;
  const method = frame?.method;

  const handler = typeof method === "string" ? handlers[method] : undefined;
  if (!handler) {
    return {
      type: FRAME.RESPONSE,
      id,
      ok: false,
      code: ERR.UNKNOWN_METHOD,
      message: `unknown method ${JSON.stringify(method ?? null)}`,
    };
  }

  try {
    const result = await handler(frame.params ?? {}, ctx);
    return { type: FRAME.RESPONSE, id, ok: true, result: result ?? {} };
  } catch (thrown) {
    const code = thrown instanceof RpcError ? thrown.code : ERR.INTERNAL;
    return { type: FRAME.RESPONSE, id, ok: false, code, message: describe(thrown) };
  }
}

// ─── The method table ─────────────────────────────────────────────────────
// Page verbs arrive in Tasks 6 and 7. A method absent from here answers
// UNKNOWN_METHOD, which is a reply — not a dropped frame.

import { tabsList, tabsActivate, tabsOpen, tabsClose } from "./tabs.js";
import { pageQuery, pageAct, pageInfo, pageGoto, pageWaitLoad, pageScreenshot } from "./page.js";

export const HANDLERS = {
  [RPC.QUERY]: pageQuery,
  [RPC.ACT]: pageAct,
  [RPC.INFO]: pageInfo,
  [RPC.GOTO]: pageGoto,
  [RPC.WAIT_LOAD]: pageWaitLoad,
  [RPC.SCREENSHOT]: pageScreenshot,
  [RPC.TABS_LIST]: tabsList,
  [RPC.TABS_ACTIVATE]: tabsActivate,
  [RPC.TABS_OPEN]: tabsOpen,
  [RPC.TABS_CLOSE]: tabsClose,
};
