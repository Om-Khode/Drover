#!/usr/bin/env node
/**
 * test-server.mjs — the smallest thing that can drive Drover.
 *
 * Drover is a driver, not an agent: with nothing connected to it the extension
 * does nothing at all, and its popup says "Disconnected" forever. That makes it
 * awkward to evaluate — a reviewer, or anyone deciding whether this is worth
 * using, has no way to see a single feature work. This file exists so that
 * takes one command and no install.
 *
 *     node examples/test-server.mjs
 *
 * No dependencies. Node built-ins only, because asking someone to `npm install`
 * before they can watch the thing work is most of the reason they will not.
 * That means the WebSocket server is implemented here by hand — RFC 6455 is
 * about ninety lines of the file below, and all of it is the boring half.
 *
 * It is a DEMONSTRATION, not a reference implementation and not a library.
 * A real client should read docs/PROTOCOL.md. Two differences in particular:
 *
 *   - it accepts one connection and exits when that connection closes;
 *   - it prints the token to the terminal, because the point is to paste it.
 *
 * What it does enforce is the part a client must never get wrong: bind loopback
 * only, refuse a non-extension Origin BEFORE looking at the token, and check
 * the protocol version and the dom_query.js digest before saying welcome.
 */

import http from "node:http";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOST = "127.0.0.1";
const PORT = Number(process.env.PORT ?? 8790);

/** Must match `src/shared/protocol.js`. */
const PROTOCOL_VERSION = 1;
const ERR = { PROTOCOL_MISMATCH: 1005, HASH_MISMATCH: 1006, UNAUTHORIZED: 1007 };

/**
 * The digest the extension's copy of dom_query.js must match.
 *
 * Read from source rather than hardcoded: a pinned constant in an example is a
 * thing that goes stale silently and then refuses every connection with a
 * message about integrity, which is the least debuggable failure this protocol
 * has.
 */
const DOM_QUERY_SHA256 = crypto
  .createHash("sha256")
  .update(readFileSync(join(HERE, "..", "src", "shared", "dom_query.js")))
  .digest("hex");

/** Printed once, pasted into the popup. A real client mints this properly. */
const TOKEN = crypto.randomBytes(16).toString("hex");

// ─── RFC 6455, the boring half ───────────────────────────────────────────
//
// Nothing below is Drover-specific. It exists because Node has a WebSocket
// client built in but no server, and adding a dependency would defeat the
// purpose of the file.

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** Server->client frames are never masked. Text only; that is all we send. */
function encodeFrame(text) {
  const payload = Buffer.from(text, "utf8");
  const n = payload.length;
  let header;
  if (n < 126) {
    header = Buffer.from([0x81, n]);
  } else if (n < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(n, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(n), 2);
  }
  return Buffer.concat([header, payload]);
}

/**
 * Incremental frame reader.
 *
 * TCP delivers bytes, not messages: a frame can arrive split across chunks and
 * several frames can arrive in one. Decoding whatever happens to be in hand is
 * the classic way to write a server that works on localhost until a payload
 * crosses an MTU boundary.
 */
function createFrameReader(onMessage, onClose) {
  let buf = Buffer.alloc(0);
  let fragments = [];

  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);

    for (;;) {
      if (buf.length < 2) return;
      const fin = (buf[0] & 0x80) !== 0;
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let offset = 2;

      if (len === 126) {
        if (buf.length < offset + 2) return;
        len = buf.readUInt16BE(offset);
        offset += 2;
      } else if (len === 127) {
        if (buf.length < offset + 8) return;
        len = Number(buf.readBigUInt64BE(offset));
        offset += 8;
      }

      let mask = null;
      if (masked) {
        if (buf.length < offset + 4) return;
        mask = buf.subarray(offset, offset + 4);
        offset += 4;
      }
      if (buf.length < offset + len) return;

      const payload = Buffer.from(buf.subarray(offset, offset + len));
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      buf = buf.subarray(offset + len);

      if (opcode === 0x8) return onClose();
      if (opcode === 0x9 || opcode === 0xa) continue; // control frames: ignored
      fragments.push(payload);
      if (!fin) continue;
      const message = Buffer.concat(fragments).toString("utf8");
      fragments = [];
      onMessage(message);
    }
  };
}

// ─── The Drover side ─────────────────────────────────────────────────────

let socket = null;
let nextId = 1;
const pending = new Map();

const send = (obj) => socket?.write(encodeFrame(JSON.stringify(obj)));

/** Send an RPC request and resolve when its `id` comes back. */
function call(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    send({ type: "request", id, method, params });
  });
}

function refuse(code, reason) {
  console.log(`\n  REFUSED  ${code}  ${reason}`);
  if (code === ERR.UNAUTHORIZED) {
    // Overwhelmingly the first-run case: the extension still holds a token from
    // whatever it was paired with before, and reconnects with it on its own
    // before anyone has touched the popup. Saying so beats making the reader
    // guess which of the four handshake checks failed.
    console.log(`  The extension sent a different token. Open its popup, replace the
  token with the one above, and press Connect.`);
  }
  send({ type: "reject", code, reason });
  socket?.end();
}

/**
 * The handshake, in the order docs/PROTOCOL.md §3 specifies: each check is
 * cheaper and less trusting than the one after it.
 */
function onHello(hello) {
  console.log(`\n  hello from ${hello.browser}, extension ${hello.extensionVersion}`);

  if (hello.protocolVersion !== PROTOCOL_VERSION) {
    return refuse(ERR.PROTOCOL_MISMATCH, `protocol ${hello.protocolVersion} != ${PROTOCOL_VERSION}`);
  }
  if (hello.domQuerySha256 !== DOM_QUERY_SHA256) {
    return refuse(
      ERR.HASH_MISMATCH,
      `dom_query.js ${String(hello.domQuerySha256).slice(0, 12)} != ${DOM_QUERY_SHA256.slice(0, 12)}`,
    );
  }
  if (hello.token !== TOKEN) return refuse(ERR.UNAUTHORIZED, "bad token");

  send({ type: "welcome" });
  console.log("  connected.\n");
  demo();
}

/** Read-only calls, so a first look cannot navigate anything unexpectedly. */
async function demo() {
  const info = await call("page.info");
  if (info.ok) {
    console.log(`  active tab : ${info.result.title}`);
    console.log(`               ${info.result.url}`);
  } else {
    console.log(`  page.info failed: ${info.code} ${info.message}`);
  }

  const tabs = await call("tabs.list");
  if (tabs.ok) {
    console.log(`  ${tabs.result.tabs.length} tab(s) open:`);
    for (const t of tabs.result.tabs.slice(0, 8)) {
      console.log(`    [${t.id}]${t.active ? " *" : "  "} ${String(t.title).slice(0, 60)}`);
    }
  }

  const q = await call("page.query", { filter: "interactive" });
  if (q.ok) {
    console.log(`  ${q.result.elements.length} interactive element(s). First few:`);
    for (const e of q.result.elements.slice(0, 8)) {
      console.log(`    idx=${e.idx} ${e.role}/${e.tag} ${JSON.stringify(e.name ?? "")}`);
    }
  } else {
    console.log(`  page.query failed: ${q.code} ${q.message}`);
  }

  console.log(`
  Type a command, or 'help'. Nothing here changes a page unless you ask.
`);
  prompt();
}

const HELP = `
  info                     url, title, ready state of the active tab
  tabs                     list open tabs
  query                    interactive elements of the active tab
  goto <url>               navigate the active tab
  click <idx>              click the element with that idx (query first)
  fill <idx> <text>        type into that element
  activate <tabId>         focus a tab
  raw <method> <json>      any method in docs/PROTOCOL.md
  quit
`;

let rl = null;

function prompt() {
  // Once only. Reconnects run the demo again, and a second readline on the same
  // stdin makes every keystroke arrive twice.
  if (rl) return rl.prompt();
  rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "> " });
  rl.prompt();
  rl.on("line", async (line) => {
    const [cmd, ...rest] = line.trim().split(/\s+/);
    const arg = rest.join(" ");
    try {
      let r;
      switch (cmd) {
        case "": break;
        case "help": console.log(HELP); break;
        case "quit": process.exit(0); break;
        case "info": r = await call("page.info"); break;
        case "tabs": r = await call("tabs.list"); break;
        case "query": r = await call("page.query", { filter: "interactive" }); break;
        case "goto": r = await call("page.goto", { url: arg }); break;
        case "click": r = await call("page.act", { idx: Number(rest[0]), action: "click" }); break;
        case "fill":
          r = await call("page.act", { idx: Number(rest[0]), action: "fill", value: rest.slice(1).join(" ") });
          break;
        case "activate": r = await call("tabs.activate", { tabId: Number(rest[0]) }); break;
        case "raw": r = await call(rest[0], JSON.parse(rest.slice(1).join(" ") || "{}")); break;
        default: console.log(`  unknown command: ${cmd}. Try 'help'.`);
      }
      if (r) console.log("  " + JSON.stringify(r.ok ? r.result : r, null, 2).slice(0, 4000));
    } catch (e) {
      console.log(`  ${e.message}`);
    }
    rl.prompt();
  });
}

// ─── Server ──────────────────────────────────────────────────────────────

const server = http.createServer((_, res) => {
  res.writeHead(426, { "Content-Type": "text/plain" });
  res.end("This endpoint speaks WebSocket only.\n");
});

server.on("upgrade", (req, sock) => {
  // Origin is checked BEFORE the token, so the socket cannot be used to test
  // token guesses from an ordinary web page. PROTOCOL.md §2.
  const origin = req.headers.origin ?? "";
  if (!/^(moz|chrome)-extension:\/\//.test(origin)) {
    console.log(`  refused a non-extension Origin: ${origin || "(none)"}`);
    sock.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    return;
  }
  // Evict a dead holder before refusing anyone. Events alone are not enough:
  // see the `end` handler below for why a departed peer can leave this slot
  // occupied indefinitely. Liveness is checked here, at the only moment it
  // matters, so a stale holder costs one refused connection rather than every
  // future one.
  if (socket && (socket.destroyed || socket.readable === false)) {
    console.log("  evicted a dead connection.");
    socket.destroy();
    socket = null;
  }
  if (socket) {
    // One connection at a time: a second is refused, never swapped in, so a
    // connecting client cannot displace a working one.
    console.log("  refused a second connection; one is already open.");
    sock.end("HTTP/1.1 409 Conflict\r\n\r\n");
    return;
  }

  const accept = crypto
    .createHash("sha1")
    .update(req.headers["sec-websocket-key"] + WS_GUID)
    .digest("base64");
  sock.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\nConnection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );

  socket = sock;
  sock.setNoDelay(true);

  const read = createFrameReader(
    (text) => {
      let frame;
      try {
        frame = JSON.parse(text);
      } catch {
        return console.log(`  unparseable frame: ${text.slice(0, 120)}`);
      }
      switch (frame.type) {
        case "hello":
          return onHello(frame);
        case "ping":
          // Keepalive. PROTOCOL.md §7.1: ignore it, or answer it, but never
          // treat it as a violation -- refusing disconnects the extension
          // every twenty seconds, which looks like an unstable connection.
          return;
        case "response": {
          const resolve = pending.get(frame.id);
          pending.delete(frame.id);
          return resolve?.(frame);
        }
        case "event":
          return console.log(`\n  event: ${frame.event} ${JSON.stringify(frame.data ?? {})}`);
        default:
          return console.log(`  unexpected frame type: ${frame.type}`);
      }
    },
    () => sock.end(),
  );

  sock.on("data", read);
  sock.on("error", () => {});

  // A socket handed over by an HTTP upgrade is HALF-OPEN. When the peer goes
  // away, Node emits `end` and flips `readable` to false, but the socket stays
  // writable and `close` NEVER fires until this side ends it too. A server that
  // frees the slot on `close` alone therefore holds it forever, and every later
  // connection is refused as "one is already open" by a peer that is long gone.
  sock.on("end", () => sock.end());

  // Free the slot and keep listening, rather than exiting.
  //
  // Exiting here made the first run unusable. The extension reconnects on its
  // own, using whatever token it still had stored, so it dials in and is
  // refused before anyone has opened the popup -- and the server that was meant
  // to be waiting for a paste had already quit. Restarting it printed a NEW
  // token, the extension retried with the OLD one, and the loop closed.
  sock.on("close", () => {
    if (socket === sock) socket = null;
    pending.clear();
    console.log("\n  disconnected. Still listening -- press Connect again.");
  });
});

server.listen(PORT, HOST, () => {
  console.log(`
  Drover test server

  1. Load the extension:
       Firefox  about:debugging -> Load Temporary Add-on -> dist/firefox/manifest.json
       Chromium chrome://extensions -> Developer mode -> Load unpacked -> dist/chromium
  2. Click the Drover toolbar icon.
  3. Server:  ws://${HOST}:${PORT}/drover
     Token:   ${TOKEN}
  4. Press Connect.

  Waiting for the extension...`);
});
