/**
 * Bug 18 — messages that were emitted but never written to the messages table.
 *
 * RED: /api/send and the join notice were persisted; broadcasts, leave notices
 * and file-change events were not. They lived only in the in-memory buffer, so
 * they were gone after a restart AND missing from the DB-fallback read path
 * (a `since` reaching past the in-memory horizon queries SQLite directly).
 * That leaves a hole in the middle of history which reads exactly like a quiet
 * period — a caller cannot tell "nothing was said" from "no record was kept".
 *
 * Worse, /api/broadcast to a room that did not exist in memory found no buffer,
 * dropped the message entirely, and still answered {success: true, messageId}.
 *
 * GREEN: every message an agent can read back is written to the table, the
 * broadcast 200 is gated on that write, and broadcasting creates the room.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startServer } from "./helpers.js";

describe("Bug 18 – broadcasts and system notices must be persisted", () => {
  let srv, base;

  const post = (p, body) =>
    fetch(`${base}${p}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  const join = (room, id, name) =>
    post(`/api/join/${room}`, { agentId: id, agentName: name, capabilities: {} });

  // Force the DB-fallback read path: a `since` older than anything in memory.
  const fromDb = async (room) => {
    const since = new Date(Date.now() - 86400000).toISOString();
    const res = await fetch(`${base}/api/messages/${room}?since=${since}&limit=500`);
    return (await res.json()).messages;
  };

  before(async () => {
    srv = await startServer();
    base = `http://localhost:${srv.port}`;
  });
  after(async () => {
    await srv.stop();
  });

  it("broadcasting to a room that does not exist yet actually delivers", async () => {
    const ghost = "ghost-" + randomUUID().slice(0, 6);
    const res = await post(`/api/broadcast/${ghost}`, {
      content: "anyone there?",
      from: "Orchestrator",
    });
    assert.equal(res.status, 200);
    const { messageId } = await res.json();
    assert.ok(messageId);

    const read = await (await fetch(`${base}/api/messages/${ghost}?limit=100`)).json();
    assert.equal(
      read.matched,
      1,
      "a broadcast reported as sent must be readable, not silently dropped"
    );
    assert.match(read.messages[0].content, /anyone there\?/);
  });

  it("persists broadcasts so they survive the DB-fallback read path", async () => {
    const room = "bc-" + randomUUID().slice(0, 6);
    await join(room, randomUUID(), "listener");
    await post(`/api/broadcast/${room}`, { content: "orchestrator says hi" });

    const rows = await fromDb(room);
    assert.equal(
      rows.some((m) => m.type === "broadcast" && /orchestrator says hi/.test(m.content)),
      true,
      "broadcast is absent from the table — history has a hole"
    );
  });

  it("persists leave notices, not just join notices", async () => {
    const room = "lv-" + randomUUID().slice(0, 6);
    const id = randomUUID();
    await join(room, id, "departing");
    await fetch(`${base}/api/leave/${id}`, { method: "POST" });

    const rows = await fromDb(room);
    assert.equal(
      rows.some((m) => /departing has joined/.test(m.content || "")),
      true,
      "join notice persisted"
    );
    assert.equal(
      rows.some((m) => /departing has left/.test(m.content || "")),
      true,
      "leave notice must persist too, or a restart resurrects departed agents"
    );
  });

  it("stamps the leave notice on the room's cursor sequence", async () => {
    // Wall-clock timestamps can land BEHIND the room's cursor counter under
    // burst, and a notice behind a poller's cursor is never delivered to it.
    const room = "lc-" + randomUUID().slice(0, 6);
    const a = randomUUID();
    const b = randomUUID();
    await join(room, a, "stayer");
    await join(room, b, "goer");

    // Burst to push the room's issued-timestamp counter ahead of wall-clock.
    await Promise.all(
      Array.from({ length: 25 }, (_, i) => post("/api/send", { agentId: a, content: `m${i}` }))
    );

    const before = await (await fetch(`${base}/api/messages/${room}?limit=500`)).json();
    const cursor = before.messages.at(-1).timestamp;

    await fetch(`${base}/api/leave/${b}`, { method: "POST" });

    const after = await (
      await fetch(`${base}/api/messages/${room}?since=${encodeURIComponent(cursor)}&limit=500`)
    ).json();
    assert.equal(
      after.messages.some((m) => /goer has left/.test(m.content || "")),
      true,
      "leave notice must be visible to a poller sitting at the latest cursor"
    );
  });

  it("broadcast validates content rather than sending '[from] undefined'", async () => {
    const room = "bv-" + randomUUID().slice(0, 6);
    for (const body of [{}, { content: "" }, { content: 42 }]) {
      const res = await post(`/api/broadcast/${room}`, body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.equal((await res.json()).code, "INVALID_ARGUMENT");
    }
    const read = await (await fetch(`${base}/api/messages/${room}?limit=100`)).json();
    assert.equal(read.matched, 0, "no rejected broadcast left a message behind");
  });

  it("broadcast history survives a restart", async () => {
    // Self-contained: srv.stop() deletes its own DB file, so this test runs its
    // own pair of servers over a copy of the database taken while the first is
    // still up (the broadcast 200 is gated on the commit, so it is already
    // durable by the time the POST returns).
    const room = "rs-" + randomUUID().slice(0, 6);
    const first = await startServer();
    const firstBase = `http://localhost:${first.port}`;
    const res = await fetch(`${firstBase}/api/broadcast/${room}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "before the restart" }),
    });
    assert.equal(res.status, 200);

    const copyPath = path.join(os.tmpdir(), `bug18-restart-${randomUUID()}.db`);
    await fs.copyFile(first.dbPath, copyPath);
    await first.stop();

    const second = await startServer({ DB_PATH: copyPath });
    try {
      const read = await (
        await fetch(`http://localhost:${second.port}/api/messages/${room}?limit=100`)
      ).json();
      assert.equal(
        read.messages.some((m) => /before the restart/.test(m.content || "")),
        true,
        "a broadcast must still be there after a restart"
      );
    } finally {
      await second.stop();
      try { await fs.unlink(copyPath); } catch {}
    }
  });
});
