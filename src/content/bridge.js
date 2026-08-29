/**
 * bridge.js — what runs inside the page.
 *
 * ## No content script, no messaging
 *
 * These functions are handed to `scripting.executeScript({ func })`, which
 * serialises them to source and evaluates them in the page. That means they
 * must be **entirely self-contained**: no imports, no closure over anything in
 * this bundle, no shared constants. Every value they need arrives as an
 * argument. It reads worse than a module and it is the only shape that works.
 *
 * The alternative — a declared content script with a `runtime.onMessage`
 * listener — was rejected. It would put an `addListener` outside the background
 * entry point, which is the one rule `test/wake.test.mjs` exists to keep
 * checkable, and it would add a message round trip to every DOM operation for
 * no gain.
 *
 * ## Why `dom_query.js` cannot simply be injected
 *
 * The shared file is a bare arrow-function *expression*. `executeScript({ files })`
 * evaluates it and throws the value away, and MV3's CSP forbids `eval` and
 * `new Function`, so it cannot be re-hydrated from text either. The build emits
 * `dom_query.entry.js` — the identical bytes with an assignment wrapped around
 * them — which is injected first to define the function on the page, and then
 * called. The unwrapped file still ships alongside, because that is the copy
 * the handshake hashes.
 *
 * ## Events, not assignment
 *
 * `fill` dispatches bubbling `input` and `change` events after setting the
 * value. A framework-controlled input whose value is assigned directly looks
 * filled to a person and empty to the framework, which then submits the old
 * value. Asserting on `.value` alone cannot tell the two apart.
 */

/** The global the injected entry file defines. Kept in one place. */
export const PAGE_QUERY_GLOBAL = "__drover_query";

/**
 * Run the shared query, already defined on the page by the entry file.
 * Self-contained: serialised into the page by `executeScript`.
 */
export function queryInPage(globalName, cfg) {
  const fn = globalThis[globalName];
  if (typeof fn !== "function") {
    return { __droverError: `${globalName} is not defined; the query file was not injected` };
  }
  return fn(cfg);
}

/**
 * Perform one action on the element carrying `idxAttr="idx"`.
 * Returns `{ ok }` or `{ ok: false, error }` — never throws, because a throw
 * inside an injected function surfaces as an opaque frame-level failure.
 *
 * `doc`/`win` default to the page's globals; the tests pass a jsdom pair.
 */
export function actInPage(idxAttr, idx, action, value, doc, win) {
  const d = doc || globalThis.document;
  const w = win || globalThis;

  const el = d.querySelector(`[${idxAttr}='${idx}']`);
  if (!el) {
    return {
      ok: false,
      error:
        `no element with ${idxAttr}='${idx}'. The page changed since the query ` +
        `that produced this index; re-query rather than acting on whatever is ` +
        `there now.`,
    };
  }

  const fire = (type) => {
    el.dispatchEvent(new w.Event(type, { bubbles: true }));
  };

  try {
    switch (action) {
      case "click":
        el.click();
        return { ok: true };

      case "fill": {
        el.focus?.();
        el.value = value == null ? "" : String(value);
        fire("input");
        fire("change");
        return { ok: true };
      }

      case "press": {
        const key = value == null ? "" : String(value);
        el.focus?.();
        for (const type of ["keydown", "keypress", "keyup"]) {
          el.dispatchEvent(new w.KeyboardEvent(type, { key, bubbles: true }));
        }
        return { ok: true };
      }

      case "select": {
        const wanted = value == null ? "" : String(value);
        const options = Array.from(el.options || []);
        // Label first, matching how a person reads the control; value second,
        // for a caller that had the underlying value to hand.
        const match =
          options.find((o) => (o.text || "").trim() === wanted) ||
          options.find((o) => o.value === wanted);
        if (!match) {
          return {
            ok: false,
            error: `no option matching ${JSON.stringify(wanted)} by label or value`,
          };
        }
        el.value = match.value;
        fire("input");
        fire("change");
        return { ok: true };
      }

      case "check":
      case "uncheck": {
        const want = action === "check";
        if (el.checked === want) return { ok: true }; // idempotent, and never toggles
        el.click();
        if (el.checked !== want) {
          el.checked = want;
          fire("input");
          fire("change");
        }
        return { ok: true };
      }

      default:
        return { ok: false, error: `unknown action ${JSON.stringify(action)}` };
    }
  } catch (e) {
    return { ok: false, error: `${action} failed: ${e && e.message ? e.message : String(e)}` };
  }
}

/** The page's identity and visible text. Self-contained. */
export function infoInPage(doc, win) {
  const d = doc || globalThis.document;
  const w = win || globalThis;
  return {
    url: (w.location && w.location.href) || "",
    title: d.title || "",
    readyState: d.readyState || "",
    innerText: (d.body && (d.body.innerText || d.body.textContent)) || "",
  };
}
