/**
 * Three fixes found by production coordination use and the stress harness:
 *
 *   #1 Duplicate agent rows corrupt mention classification. findAgentByName
 *      returned the first row for a name, so an agent in several rooms could be
 *      reported "not in this room" when a mention DID reach them. Rejoins also
 *      never reaped the old row, inflating presence.
 *   #2 The in-memory MESSAGE_HISTORY_LIMIT horizon silently truncated `since`
 *      queries reaching further back than the loaded tail, with no DB fallback.
 *   #3 A live poll could miss a message mid-burst because a timestamp is
 *      reserved before the message is visible; the watermark holds a cursor
 *      back until in-flight writes settle.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import sqlite3 from "sqlite3";
import { startServer } from "./helpers.js";

describe("Bug 12a – mention classification across rooms + reaping", () => {
  let srv, base;
  const roomA = "cls-a";
  const roomB = "cls-b";

  const join = (room, id, name) =>
    fetch(`${base}/api/join/${room}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: id, agentName: name, capabilities: {} }),
    });
  const send = (id, content) =>
    fetch(`${base}/api/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: id, content }),
    }).then((r) => r.json());

  before(async () => {
    // Window 0 => nothing counts as "live", so reaping is aggressive and
    // deterministic for these classification/reap assertions.
    srv = await startServer({ LIVE_AGENT_WINDOW_MS: "0" });
    base = `http://localhost:${srv.port}`;
  });
  after(async () => {
    await srv.stop();
  });

  it("classifies an agent present in THIS room as notified even if also elsewhere", async () => {
    const sender = randomUUID();
    await join(roomB, sender, "sender");
    // "coord" joins roomA FIRST (older row), then roomB.
    await join(roomA, randomUUID(), "coord");
    await join(roomB, randomUUID(), "coord");

    const r = await send(sender, "@coord ping");
    assert.deepEqual(r.notified, ["coord"], `coord is in this room; got ${JSON.stringify(r)}`);
    assert.ok(!r.unknown, "a present agent must not be unknown");
  });

  it("still flags a real agent who is only in another room", async () => {
    const sender = randomUUID();
    await join(roomB, sender, "sender2");
    await join(roomA, randomUUID(), "away-only");

    const r = await send(sender, "@away-only there?");
    assert.equal(r.notified.length, 0);
    assert.ok(r.elsewhere?.some((e) => e.name === "away-only"), `got ${JSON.stringify(r)}`);
  });

  it("still flags a nonexistent agent as nobody-notified", async () => {
    const sender = randomUUID();
    await join(roomB, sender, "sender3");
    const r = await send(sender, "@no-such-agent hi");
    assert.deepEqual(r.unknown, ["no-such-agent"]);
  });

  it("reaps the prior row when an agent rejoins the same room", async () => {
    const room = "reap-room";
    await join(room, randomUUID(), "rejoiner");
    await join(room, randomUUID(), "rejoiner");
    await join(room, randomUUID(), "rejoiner");
    const body = await (await fetch(`${base}/api/agents/${room}`)).json();
    const count = body.agents.filter((a) => a.name === "rejoiner").length;
    assert.equal(count, 1, `expected 1 rejoiner row, got ${count}`);
  });
});

describe("Bug 12d – reaping never drops a live session; drops are self-describing", () => {
  let srv, base;
  const room = "live-room";

  const join = (id, name) =>
    fetch(`${base}/api/join/${room}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: id, agentName: name, capabilities: {} }),
    });
  const send = (id, content) =>
    fetch(`${base}/api/send`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: id, content }),
    });

  before(async () => {
    // Default (large) live window so a just-active session counts as live.
    srv = await startServer({ LIVE_AGENT_WINDOW_MS: "120000" });
    base = `http://localhost:${srv.port}`;
  });
  after(async () => { await srv.stop(); });

  it("a same-name rejoin does NOT evict a still-active older session", async () => {
    const older = randomUUID();
    await join(older, "worker");
    // The older session is active: it just sent.
    const s1 = await send(older, "older still working");
    assert.equal(s1.status, 200);

    // A new session joins under the SAME name+room (fresh id).
    await join(randomUUID(), "worker");

    // The older session must still be registered — not silently dropped.
    const s2 = await send(older, "older still alive after the rejoin");
    assert.equal(
      s2.status, 200,
      "a live older session must survive a same-name rejoin, not get reaped"
    );
  });

  it("a genuinely unregistered send gets an actionable, coded error", async () => {
    const res = await send(randomUUID(), "who am i");
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.code, "AGENT_NOT_REGISTERED", `got ${JSON.stringify(body)}`);
    assert.match(body.error, /room_join/, "must tell the agent how to recover");
  });
});

describe("Bug 12b – DB fallback past the memory horizon", () => {
  const SERVER_JS = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../server.js"
  );
  const randomPort = () => Math.floor(Math.random() * (65535 - 49152 + 1)) + 49152;
  const dbPath = path.join(os.tmpdir(), `bug12b-${randomUUID()}.db`);
  const room = "horizon-room";
  const agentId = randomUUID();
  let child, port, cursor;

  const waitReady = async (p) => {
    // Generous: this suite spawns servers WITH restarts, and under the full
    // parallel `npm test` run it competes for CPU with every other file.
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      try { if ((await fetch(`http://localhost:${p}/api/rooms`)).ok) return; } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("not ready");
  };
  const spawnHub = (p, limit) =>
    spawn(process.execPath, [SERVER_JS], {
      env: {
        ...process.env, PORT: String(p), DB_PATH: dbPath,
        SHARED_DIR: path.join(os.tmpdir(), `sh-${randomUUID()}`),
        DATA_DIR: os.tmpdir(), MESSAGE_HISTORY_LIMIT: String(limit),
      },
      stdio: "pipe",
    });
  const send = (p, c) =>
    fetch(`http://localhost:${p}/api/send`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId, content: c }),
    });

  before(async () => {
    // Boot with a generous limit, post 30 messages, capture an early cursor.
    port = randomPort();
    child = spawnHub(port, 500);
    child.stdout.resume(); child.stderr.resume();
    await waitReady(port);
    await fetch(`http://localhost:${port}/api/join/${room}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId, agentName: "horizonbot", capabilities: {} }),
    });
    await send(port, "before-cursor");
    const early = await (await fetch(`http://localhost:${port}/api/messages/${room}`)).json();
    cursor = early.messages.at(-1).timestamp;
    for (let i = 0; i < 30; i++) await send(port, `msg-${i}`);
    // Restart with a TINY history limit so most of the backlog is out of memory.
    child.kill("SIGTERM");
    await new Promise((r) => { child.once("exit", r); setTimeout(r, 5000); });
    port = randomPort();
    child = spawnHub(port, 5);
    child.stdout.resume(); child.stderr.resume();
    await waitReady(port);
  });
  after(async () => {
    child.kill("SIGTERM");
    await new Promise((r) => { child.once("exit", r); setTimeout(r, 5000); });
    try { await fs.unlink(dbPath); } catch {}
  });

  it("in-memory holds only the small tail after restart", async () => {
    const all = await (await fetch(`http://localhost:${port}/api/messages/${room}?limit=1000`)).json();
    // No `since` → served from the (tiny) memory tail.
    assert.ok(all.returned <= 5, `memory tail should be small, got ${all.returned}`);
  });

  it("a `since` past the horizon still returns the full backlog via the DB", async () => {
    const res = await (await fetch(
      `http://localhost:${port}/api/messages/${room}?since=${encodeURIComponent(cursor)}&limit=1000`
    )).json();
    const contents = res.messages.map((m) => m.content);
    for (let i = 0; i < 30; i++) {
      assert.ok(contents.includes(`msg-${i}`), `msg-${i} missing — horizon truncated the window`);
    }
    assert.equal(res.matched, 30, `expected 30 matched, got ${res.matched}`);
  });

  it("count-only past the horizon reports the true total, not the tail", async () => {
    const res = await (await fetch(
      `http://localhost:${port}/api/messages/${room}?since=${encodeURIComponent(cursor)}&limit=0`
    )).json();
    assert.equal(res.returned, 0, "count-only sends no bodies");
    assert.equal(res.matched, 30, `count must reflect the DB, got ${res.matched}`);
  });
});

describe("Bug 12c – no message lost to a live poll during a burst", () => {
  // This is the invariant the watermark protects. We can't force the race
  // deterministically over HTTP, so we assert the property statistically: a
  // live poller draining WHILE a burst is written must, at the end, have seen
  // every acknowledged message with no gap — with zero reliance on a later
  // recovery drain.
  let srv, base;
  const room = "burst-room";
  before(async () => { srv = await startServer(); base = `http://localhost:${srv.port}`; });
  after(async () => { await srv.stop(); });

  it("a concurrent poller sees every acknowledged message, no recovery drain", async () => {
    const sender = randomUUID();
    await fetch(`${base}/api/join/${room}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: sender, agentName: "burst", capabilities: {} }),
    });
    const start = await (await fetch(`${base}/api/messages/${room}`)).json();
    let cursor = start.messages.at(-1)?.timestamp;

    const TOTAL = 150;
    const acked = new Set();
    const seen = new Set();
    let polling = true;

    const poller = (async () => {
      while (polling || seen.size < acked.size) {
        const url = `${base}/api/messages/${room}?limit=20` +
          (cursor ? `&since=${encodeURIComponent(cursor)}` : "");
        const body = await (await fetch(url)).json();
        for (const m of body.messages) seen.add(m.content);
        if (body.messages.length) cursor = body.messages.at(-1).timestamp;
        if (!polling && seen.size >= acked.size) break;
        await new Promise((r) => setTimeout(r, 5));
      }
    })();

    await Promise.all(
      Array.from({ length: TOTAL }, (_, i) =>
        fetch(`${base}/api/send`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ agentId: sender, content: `b-${i}` }),
        }).then((r) => { if (r.status === 200) acked.add(`b-${i}`); })
      )
    );
    // Give the poller a moment to catch up to the watermark, then stop.
    await new Promise((r) => setTimeout(r, 500));
    polling = false;
    await poller;

    const missing = [...acked].filter((c) => !seen.has(c));
    assert.equal(
      missing.length, 0,
      `live poller missed ${missing.length}/${acked.size} with no recovery drain: ${missing.slice(0, 5).join(", ")}`
    );
  });
});
