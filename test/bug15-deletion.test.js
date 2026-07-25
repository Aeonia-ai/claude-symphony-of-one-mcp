/**
 * Room deletion / message purge endpoints (CLI-only feature; no MCP tool).
 * These are irreversible, so the guardrails are the point: a confirm flag for
 * message purge, and confirm + matching room name for a full room delete.
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { startServer } from "./helpers.js";

describe("Bug 15 – message purge and room deletion", () => {
  let srv, base;

  const join = (room, id, name) =>
    fetch(`${base}/api/join/${room}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: id, agentName: name, capabilities: {} }),
    });
  const send = (id, content) =>
    fetch(`${base}/api/send`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId, content }),
    });
  const count = async (room) =>
    (await (await fetch(`${base}/api/messages/${room}?limit=1000`)).json()).matched;

  let agentId;
  before(async () => { srv = await startServer(); base = `http://localhost:${srv.port}`; });
  after(async () => { await srv.stop(); });

  it("refuses to purge without confirmation", async () => {
    const room = "np-" + randomUUID().slice(0, 6);
    agentId = randomUUID();
    await join(room, agentId, "a");
    await send(agentId, "keep me");
    const res = await fetch(`${base}/api/messages/${room}`, { method: "DELETE" });
    assert.equal(res.status, 400);
    assert.equal(await count(room) >= 1, true, "nothing deleted without confirm");
  });

  it("purges all messages with confirm=true", async () => {
    const room = "pa-" + randomUUID().slice(0, 6);
    agentId = randomUUID();
    await join(room, agentId, "a");
    await send(agentId, "one");
    await send(agentId, "two");
    const n0 = await count(room);
    assert.ok(n0 >= 2);
    const res = await fetch(`${base}/api/messages/${room}?confirm=true`, { method: "DELETE" });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.deleted, n0);
    assert.equal(await count(room), 0, "room is empty after purge");
  });

  it("selectively purges by type (e.g. join notices), keeping real messages", async () => {
    const room = "pt-" + randomUUID().slice(0, 6);
    agentId = randomUUID();
    await join(room, agentId, "a");        // creates a 'system' join notice
    await send(agentId, "real message");   // 'message'
    const res = await fetch(`${base}/api/messages/${room}?confirm=true&type=system`, { method: "DELETE" });
    assert.equal(res.status, 200);
    const body = await (await fetch(`${base}/api/messages/${room}?limit=1000`)).json();
    const contents = body.messages.map((m) => m.content);
    assert.ok(contents.includes("real message"), "real message kept");
    assert.ok(!contents.some((c) => c.includes("has joined")), "join notices removed");
  });

  it("selectively purges by age (before a cursor)", async () => {
    const room = "pb-" + randomUUID().slice(0, 6);
    agentId = randomUUID();
    await join(room, agentId, "a");
    await send(agentId, "old");
    await new Promise((r) => setTimeout(r, 10));
    await send(agentId, "new");
    // Cursor = the NEWEST message's timestamp; deleting strictly-before it
    // removes "old" (and the join notice) while keeping "new".
    const cursor = (await (await fetch(`${base}/api/messages/${room}`)).json()).messages.at(-1).timestamp;
    const res = await fetch(`${base}/api/messages/${room}?confirm=true&before=${encodeURIComponent(cursor)}`, { method: "DELETE" });
    assert.equal(res.status, 200);
    const contents = (await (await fetch(`${base}/api/messages/${room}?limit=1000`)).json()).messages.map((m) => m.content);
    assert.ok(contents.includes("new"), "newer message kept");
    assert.ok(!contents.includes("old"), "older message removed");
  });

  it("refuses room delete without confirm + matching name", async () => {
    const room = "dr-" + randomUUID().slice(0, 6);
    agentId = randomUUID();
    await join(room, agentId, "a");
    // wrong: no confirm
    let res = await fetch(`${base}/api/rooms/${room}`, { method: "DELETE" });
    assert.equal(res.status, 400);
    // wrong: confirm but mismatched name
    res = await fetch(`${base}/api/rooms/${room}?confirm=true&confirmName=nope`, { method: "DELETE" });
    assert.equal(res.status, 400);
    // room still exists
    const rooms = (await (await fetch(`${base}/api/rooms`)).json()).rooms.map((r) => r.name);
    assert.ok(rooms.includes(room), "room survives an unconfirmed delete");
  });

  it("deletes a room and all its data with full confirmation", async () => {
    const room = "dx-" + randomUUID().slice(0, 6);
    agentId = randomUUID();
    await join(room, agentId, "a");
    await send(agentId, "doomed");
    await fetch(`${base}/api/tasks`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ roomName: room, title: "t", description: "d", creator: agentId }),
    });

    const res = await fetch(
      `${base}/api/rooms/${room}?confirm=true&confirmName=${room}`,
      { method: "DELETE" }
    );
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.ok(body.deleted.messages >= 2, `messages deleted: ${JSON.stringify(body.deleted)}`);
    assert.equal(body.deleted.room, 1, "room record deleted");

    const rooms = (await (await fetch(`${base}/api/rooms`)).json()).rooms.map((r) => r.name);
    assert.ok(!rooms.includes(room), "room is gone from the live list");
    const tasks = (await (await fetch(`${base}/api/tasks/${room}`)).json()).tasks;
    assert.equal(tasks.length, 0, "tasks gone");
  });
});
