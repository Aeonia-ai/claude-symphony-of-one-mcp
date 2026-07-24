/**
 * Bug 13: runtime memory growth + storage-table leaks.
 *
 *  - MESSAGE_HISTORY_LIMIT was applied only at boot; the in-memory buffer grew
 *    without bound at runtime. Trimmed messages must still be reachable via the
 *    DB fallback.
 *  - Expired agent_memory rows were hidden on read but never deleted.
 *  - Read notifications were never pruned; unread ones must be kept regardless.
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

describe("Bug 13a – runtime memory buffer is bounded", () => {
  let srv, base;
  const room = "mem-bound-room";
  const agentId = randomUUID();

  before(async () => {
    // Tiny limit so a handful of messages overflows it.
    srv = await startServer({ MESSAGE_HISTORY_LIMIT: "10" });
    base = `http://localhost:${srv.port}`;
    await fetch(`${base}/api/join/${room}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId, agentName: "membot", capabilities: {} }),
    });
  });
  after(async () => { await srv.stop(); });

  it("holds at most the limit in memory, but keeps older messages on disk", async () => {
    let cursor;
    const first = await (await fetch(`${base}/api/messages/${room}`)).json();
    cursor = first.messages.at(-1)?.timestamp;

    for (let i = 0; i < 40; i++) {
      await fetch(`${base}/api/send`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId, content: `m-${i}` }),
      });
    }

    // No `since` → served from the in-memory buffer, which must be bounded.
    const recent = await (await fetch(`${base}/api/messages/${room}?limit=1000`)).json();
    assert.ok(
      recent.returned <= 10,
      `in-memory buffer must stay bounded to the limit, got ${recent.returned}`
    );

    // A `since` from before → DB fallback must still return all 40, proving the
    // trimmed messages were persisted, not lost.
    const all = await (await fetch(
      `${base}/api/messages/${room}?since=${encodeURIComponent(cursor)}&limit=1000`
    )).json();
    const contents = all.messages.map((m) => m.content);
    for (let i = 0; i < 40; i++) {
      assert.ok(contents.includes(`m-${i}`), `m-${i} lost — trim dropped it from disk too`);
    }
  });
});

describe("Bug 13b – expired memory and old read notifications are pruned", () => {
  const SERVER_JS = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../server.js"
  );
  const dbPath = path.join(os.tmpdir(), `bug13b-${randomUUID()}.db`);
  const randomPort = () => Math.floor(Math.random() * (65535 - 49152 + 1)) + 49152;

  const waitReady = async (p) => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      try { if ((await fetch(`http://localhost:${p}/api/rooms`)).ok) return; } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("not ready");
  };
  const spawnHub = (p) => {
    const c = spawn(process.execPath, [SERVER_JS], {
      env: {
        ...process.env, PORT: String(p), DB_PATH: dbPath,
        SHARED_DIR: path.join(os.tmpdir(), `sh-${randomUUID()}`), DATA_DIR: os.tmpdir(),
      },
      stdio: "pipe",
    });
    c.stdout.resume(); c.stderr.resume();
    return c;
  };
  const stop = async (c) => {
    c.kill("SIGTERM");
    await new Promise((r) => { c.once("exit", r); setTimeout(r, 5000); });
  };
  const dbRunP = (sql, params = []) =>
    new Promise((resolve, reject) => {
      const db = new sqlite3.Database(dbPath);
      db.run(sql, params, (e) => db.close(() => (e ? reject(e) : resolve())));
    });
  const dbCount = (sql, params = []) =>
    new Promise((resolve, reject) => {
      const db = new sqlite3.Database(dbPath);
      db.get(sql, params, (e, r) => db.close(() => (e ? reject(e) : resolve(r ? r.n : -1))));
    });

  let child = null;
  after(async () => {
    if (child) await stop(child);
    try { await fs.unlink(dbPath); } catch {}
  });

  it("boot prune deletes expired memory + old read notifications, keeps live/unread", async () => {
    // First boot creates the schema, then stop it.
    const p1 = randomPort();
    child = spawnHub(p1);
    await waitReady(p1);
    await stop(child);
    child = null;

    // Seed the DB directly: expired vs live memory, old-read vs old-unread notif.
    await dbRunP(
      "INSERT INTO agent_memory (id, agent_id, room, key, value, type, created_at, expires_at) VALUES (?,?,?,?,?,?,datetime('now'),datetime('now','-1 hour'))",
      [randomUUID(), "a1", "r", "stale", "x", "note"]
    );
    await dbRunP(
      "INSERT INTO agent_memory (id, agent_id, room, key, value, type, created_at, expires_at) VALUES (?,?,?,?,?,?,datetime('now'),datetime('now','+1 day'))",
      [randomUUID(), "a1", "r", "live", "y", "note"]
    );
    await dbRunP(
      "INSERT INTO notifications (id, agent_id, agent_name, room, message, type, is_read, created_at) VALUES (?,?,?,?,?,?,1,datetime('now','-30 days'))",
      [randomUUID(), "a1", "bot", "r", "old read", "mention"]
    );
    await dbRunP(
      "INSERT INTO notifications (id, agent_id, agent_name, room, message, type, is_read, created_at) VALUES (?,?,?,?,?,?,0,datetime('now','-30 days'))",
      [randomUUID(), "a1", "bot", "r", "old unread", "mention"]
    );

    // Boot again — pruneExpiredData runs on listen.
    const p2 = randomPort();
    child = spawnHub(p2);
    await waitReady(p2);
    await new Promise((r) => setTimeout(r, 300)); // let the fire-and-forget deletes land

    assert.equal(await dbCount("SELECT COUNT(*) AS n FROM agent_memory WHERE key='stale'"), 0, "expired memory pruned");
    assert.equal(await dbCount("SELECT COUNT(*) AS n FROM agent_memory WHERE key='live'"), 1, "live memory kept");
    assert.equal(await dbCount("SELECT COUNT(*) AS n FROM notifications WHERE message='old read'"), 0, "old read notification pruned");
    assert.equal(await dbCount("SELECT COUNT(*) AS n FROM notifications WHERE message='old unread'"), 1, "old unread notification kept — it is the signal");
  });
});
