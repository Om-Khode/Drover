/**
 * example_server.test.mjs — examples/test-server.mjs actually works.
 *
 * The example exists so that a reviewer, or anyone evaluating Drover, can watch
 * it work in one command. An example that does not run is worse than no example
 * at all: it is the first thing a stranger tries and the first impression they
 * get, and nobody reports it because they assume the fault is theirs.
 *
 * No browser here. The extension's side of the handshake is a few dozen bytes,
 * so the test speaks it directly over a raw socket — including a deliberately
 * independent WebSocket frame codec, because a test that reuses the encoder it
 * is checking agrees with itself no matter what either one does.
 *
 * What is pinned, and why each one is a security property rather than a
 * convenience:
 *
 *   - a non-extension Origin is refused, and refused BEFORE the token is read,
 *     so the socket cannot be used to test token guesses from a web page;
 *   - a second connection is refused rather than swapped in, so a connecting
 *     client cannot displace a working one;
 *   - protocol version and dom_query.js digest are checked before `welcome`;
 *   - `ping` is ignored rather than treated as a violation. A server that
 *     refuses it disconnects the extension every twenty seconds, which presents
 *     as an unstable connection and not as a protocol bug.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SERVER = join(ROOT, "examples", "test-server.mjs");
const PROTOCOL_VERSION = 1;

const DIGEST = crypto
  .createHash("sha256")
  .update(readFileSync(join(ROOT, "src", "shared", "dom_query.js")))
  .digest("hex");

// ─── A WebSocket client, written independently of the server's codec ─────

/** Client frames MUST be masked (RFC 6455 §5.3). */
function clientFrame(text) {
  const payload = Buffer.from(text, "utf8");
  const mask = crypto.randomBytes(4);
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];

  let head;
  if (payload.length < 126) {
    head = Buffer.from([0x81, 0x80 | payload.length]);
  } else {
    head = Buffer.alloc(4);
    head[0] = 0x81;
    head[1] = 0x80 | 126;
    head.writeUInt16BE(payload.length, 2);
  }
  return Buffer.concat([head, mask, masked]);
}

/** Server frames are never masked, so this only has to handle that case. */
function decodeServerFrames(buf) {
  const out = [];
  let i = 0;
  while (i + 2 <= buf.length) {
    const opcode = buf[i] & 0x0f;
    let len = buf[i + 1] & 0x7f;
    let off = i + 2;
    if (len === 126) {
      len = buf.readUInt16BE(off);
      off += 2;
    } else if (len === 127) {
      len = Number(buf.readBigUInt64BE(off));
      off += 8;
    }
    if (off + len > buf.length) break;
    if (opcode === 0x1) out.push(buf.subarray(off, off + len).toString("utf8"));
    i = off + len;
  }
  return out;
}

/** Start the example on an ephemeral port and recover the token it prints. */
async function startServer() {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const proc = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(port) },
    stdio: ["pipe", "pipe", "pipe"],
  });

  // Kept for the whole run, not just the handshake: a test needs to assert how
  // the server TREATED a frame, and surviving one is all a liveness check sees.
  let out = "";
  proc.stdout.on("data", (d) => (out += d.toString()));

  const token = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server never printed a token:\n${out}`)), 10_000);
    const poll = setInterval(() => {
      const m = out.match(/Token:\s+([0-9a-f]{32})/);
      if (!m) return;
      clearTimeout(timer);
      clearInterval(poll);
      resolve(m[1]);
    }, 20);
    proc.on("exit", (c) => reject(new Error(`server exited (${c}):\n${out}`)));
  });

  return { proc, port, token, output: () => out, stop: () => proc.kill() };
}

/** Open a socket and perform the HTTP upgrade with a chosen Origin. */
function connect(port, origin) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, "127.0.0.1");
    const key = crypto.randomBytes(16).toString("base64");
    let head = "";
    let body = Buffer.alloc(0);
    const frames = [];
    const waiters = [];

    sock.on("connect", () => {
      sock.write(
        `GET /drover HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n` +
          `Upgrade: websocket\r\nConnection: Upgrade\r\n` +
          `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n` +
          (origin ? `Origin: ${origin}\r\n` : "") +
          `\r\n`,
      );
    });

    let upgraded = false;
    sock.on("data", (chunk) => {
      if (!upgraded) {
        head += chunk.toString("latin1");
        const end = head.indexOf("\r\n\r\n");
        if (end === -1) return;
        const status = head.slice(0, head.indexOf("\r\n"));
        upgraded = true;
        const rest = Buffer.from(head.slice(end + 4), "latin1");
        head = status;
        if (!/101/.test(status)) return resolve({ status, sock, frames, next: null });
        body = rest;
      } else {
        body = Buffer.concat([body, chunk]);
      }
      for (const f of decodeServerFrames(body)) {
        const parsed = JSON.parse(f);
        const w = waiters.shift();
        if (w) w(parsed);
        else frames.push(parsed);
      }
      body = Buffer.alloc(0);
      if (upgraded && head.includes("101")) {
        resolve({
          status: head,
          sock,
          frames,
          next: () =>
            new Promise((res) => (frames.length ? res(frames.shift()) : waiters.push(res))),
          send: (o) => sock.write(clientFrame(JSON.stringify(o))),
        });
      }
    });

    sock.on("error", reject);
    setTimeout(() => reject(new Error("upgrade timed out")), 10_000);
  });
}

const hello = (over = {}) => ({
  type: "hello",
  protocolVersion: PROTOCOL_VERSION,
  domQuerySha256: DIGEST,
  token: "unset",
  browser: "firefox",
  extensionVersion: "0.1.0",
  ...over,
});

// ─── The happy path ──────────────────────────────────────────────────────

test("a correct handshake is welcomed", async () => {
  // If this fails, the example a stranger runs first does not work.
  const s = await startServer();
  try {
    const c = await connect(s.port, "moz-extension://abc");
    assert.match(c.status, /101/, `no upgrade: ${c.status}`);
    c.send(hello({ token: s.token }));
    const reply = await c.next();
    assert.equal(reply.type, "welcome", `refused a valid handshake: ${JSON.stringify(reply)}`);
    c.sock.destroy();
  } finally {
    s.stop();
  }
});

test("the digest the example computes matches the shipped file", async () => {
  // The example derives it from source rather than hardcoding it. A pinned
  // constant would go stale silently and then refuse every connection with a
  // message about integrity -- the least debuggable failure this protocol has.
  const src = readFileSync(join(ROOT, "examples", "test-server.mjs"), "utf8");
  assert.ok(
    !/[0-9a-f]{64}/.test(src),
    "a 64-hex-character literal in the example: the digest is hardcoded, and it " +
      "will outlive the file it describes",
  );
  assert.match(src, /createHash\("sha256"\)/);
});

// ─── The refusals ────────────────────────────────────────────────────────

test("a non-extension Origin is refused before the token is read", async () => {
  // The token is not consulted, so the socket cannot be used to test guesses
  // from an ordinary web page.
  const s = await startServer();
  try {
    const c = await connect(s.port, "https://example.invalid");
    assert.ok(!/101/.test(c.status), `an ordinary web origin was upgraded: ${c.status}`);
    assert.match(c.status, /403/);
  } finally {
    s.stop();
  }
});

test("a missing Origin is refused too", async () => {
  const s = await startServer();
  try {
    const c = await connect(s.port, null);
    assert.ok(!/101/.test(c.status), `no Origin at all was upgraded: ${c.status}`);
  } finally {
    s.stop();
  }
});

test("a bad token is rejected", async () => {
  const s = await startServer();
  try {
    const c = await connect(s.port, "moz-extension://abc");
    c.send(hello({ token: "wrong" }));
    const reply = await c.next();
    assert.equal(reply.type, "reject");
    assert.equal(reply.code, 1007);
  } finally {
    s.stop();
  }
});

test("a protocol mismatch is rejected before the token", async () => {
  const s = await startServer();
  try {
    const c = await connect(s.port, "moz-extension://abc");
    c.send(hello({ protocolVersion: 99, token: "wrong" }));
    const reply = await c.next();
    assert.equal(reply.code, 1005, `expected PROTOCOL_MISMATCH, got ${JSON.stringify(reply)}`);
  } finally {
    s.stop();
  }
});

test("a dom_query digest mismatch is rejected", async () => {
  const s = await startServer();
  try {
    const c = await connect(s.port, "moz-extension://abc");
    c.send(hello({ domQuerySha256: "0".repeat(64), token: s.token }));
    const reply = await c.next();
    assert.equal(reply.code, 1006, `expected HASH_MISMATCH, got ${JSON.stringify(reply)}`);
  } finally {
    s.stop();
  }
});

test("a second connection is refused, and the first keeps working", async () => {
  const s = await startServer();
  try {
    const first = await connect(s.port, "moz-extension://abc");
    first.send(hello({ token: s.token }));
    assert.equal((await first.next()).type, "welcome");

    const second = await connect(s.port, "moz-extension://def");
    assert.ok(!/101/.test(second.status), `a second client was let in: ${second.status}`);

    // The point of refusing rather than swapping: the working one is untouched.
    first.send({ type: "ping" });
    assert.equal(first.sock.destroyed, false, "the first connection was dropped");
    first.sock.destroy();
  } finally {
    s.stop();
  }
});

// ─── Keepalive ───────────────────────────────────────────────────────────

test("ping is ignored, not treated as a violation", async () => {
  // A server that refuses an unrecognised frame disconnects the extension every
  // twenty seconds. That presents as a flaky connection, not as a protocol bug,
  // so it is the kind of thing that gets blamed on the browser for weeks.
  const s = await startServer();
  try {
    const c = await connect(s.port, "moz-extension://abc");
    c.send(hello({ token: s.token }));
    assert.equal((await c.next()).type, "welcome");

    for (let i = 0; i < 3; i++) c.send({ type: "ping" });
    await new Promise((r) => setTimeout(r, 400));

    assert.equal(c.sock.destroyed, false, "the server hung up on a keepalive frame");
    // Surviving is not the same as handling. A server with no `ping` branch
    // falls through to the unknown-frame path, and that is precisely the state
    // that becomes a disconnect the moment someone makes unknown frames fatal.
    // Liveness alone cannot tell the two apart, so assert on what it reported.
    assert.ok(
      !/unexpected frame|unparseable/i.test(s.output()),
      `the keepalive was handled as an unknown frame:\n${s.output()}`,
    );
    c.sock.destroy();
  } finally {
    s.stop();
  }
});

// ─── It binds where it says it does ──────────────────────────────────────

test("the example binds loopback only", () => {
  const src = readFileSync(join(ROOT, "examples", "test-server.mjs"), "utf8");
  assert.match(src, /const HOST = "127\.0\.0\.1"/);
  assert.ok(
    !/0\.0\.0\.0/.test(src),
    "the example binds a wildcard address, exposing a browser-driving socket to " +
      "the local network",
  );
  assert.match(src, /server\.listen\(PORT, HOST/, "listen() does not pass the host");
});
