/**
 * Bug 10: failed writes reported as success
 *
 * Every data write used fire-and-forget `db.run(sql, params)` with no
 * callback. sqlite3 swallows the error entirely in that form — no throw, no
 * log — and the routes never waited on the result. In /api/send the ordering
 * was:
 *
 *     push to in-memory array
 *     db.run(INSERT ...)        <- unchecked
 *     io.emit('message', ...)   <- every agent already saw it
 *     res.json({success: true}) <- sender told it worked
 *
 * so a failed INSERT meant the message was broadcast to the whole room,
 * acknowledged to the sender, and absent from disk — vanishing at the next
 * restart with nothing logged anywhere. The realistic trigger is SQLITE_BUSY
 * under concurrent writes, not disk-full.
 *
 * Writes are made to fail here by dropping the target table out from under
 * the running server, which is the least invasive way to provoke a genuine
 * sqlite3 error through the real code path.
 *
 * RED: 200 {success: true} and a silent loss.
 * GREEN: 500 with an explicit error, and the message is not broadcast.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import sqlite3 from "sqlite3";
import { startServer } from "./helpers.js";

describe("Bug 10 – write failures surface as failures", () => {
  let srv;
  let base;
  const room = "write-fail-room";
  const agentId = randomUUID();

  before(async () => {
    srv = await startServer();
    base = `http://localhost:${srv.port}`;
    await fetch(`${base}/api/join/${room}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId, agentName: "WriteBot", capabilities: {} }),
    });
  });

  after(async () => {
    await srv.stop();
  });

  // Drop a table via a second connection to the same file, so the server's
  // next write against it genuinely errors.
  const dropTable = (table) =>
    new Promise((resolve, reject) => {
      const db = new sqlite3.Database(srv.dbPath);
      db.run(`DROP TABLE IF EXISTS ${table}`, (err) =>
        db.close(() => (err ? reject(err) : resolve()))
      );
    });

  it("sending a message succeeds normally first (control)", async () => {
    const res = await fetch(`${base}/api/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId, content: "control message" }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
  });

  it("a failed message write returns 500 instead of a false success", async () => {
    await dropTable("messages");

    const res = await fetch(`${base}/api/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId, content: "should not be acknowledged" }),
    });

    assert.equal(
      res.status,
      500,
      "a message that could not be persisted must not be reported as sent"
    );
    const body = await res.json();
    assert.equal(body.success, false);
    assert.match(body.error, /persist/i);
  });

  it("a failed message write is not added to the served history", async () => {
    const res = await fetch(`${base}/api/messages/${room}`);
    const body = await res.json();
    const contents = body.messages.map((m) => m.content);
    assert.ok(
      !contents.includes("should not be acknowledged"),
      "an unpersisted message must not appear in room history"
    );
  });

  it("a failed task write returns 500 instead of a false success", async () => {
    await dropTable("tasks");

    const res = await fetch(`${base}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        roomName: room,
        title: "doomed task",
        description: "the tasks table is gone",
        creator: agentId,
        priority: "low",
      }),
    });

    assert.equal(
      res.status,
      500,
      "a task that could not be persisted must not be reported as created"
    );
    const body = await res.json();
    assert.equal(body.success, false);
  });

  it("a failed memory write returns 500 instead of a false success", async () => {
    await dropTable("agent_memory");

    const res = await fetch(`${base}/api/memory/${agentId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "doomed", value: "gone", type: "note" }),
    });

    assert.equal(
      res.status,
      500,
      '"stored" must mean stored — a failed memory write cannot return success'
    );
    const body = await res.json();
    assert.equal(body.success, false);
  });
});
