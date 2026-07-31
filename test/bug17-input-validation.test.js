/**
 * Bug 17 — untyped request bodies were accepted, and one of them killed the hub.
 *
 * RED: /api/send took `content` of any type. A non-string that stringified to
 * something containing an @mention reached `message.content.substring()` inside
 * a db.run callback — a TypeError with nothing to catch it, i.e. an uncaught
 * exception, i.e. process exit. One malformed send from one buggy agent took
 * the whole hub down for everyone. Missing `agentId` on /api/join registered an
 * agent under the key `undefined` and answered 200. A task with no roomName was
 * stored where no listing could ever return it.
 *
 * GREEN: each of these is a 400 with INVALID_ARGUMENT naming the field, and the
 * server stays up.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { startServer } from "./helpers.js";

describe("Bug 17 – request validation and crash-resistance", () => {
  let srv, base;
  const room = "v17-" + randomUUID().slice(0, 6);
  const agentId = randomUUID();

  const post = (p, body) =>
    fetch(`${base}${p}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  before(async () => {
    srv = await startServer();
    base = `http://localhost:${srv.port}`;
    await post(`/api/join/${room}`, {
      agentId,
      agentName: "validator",
      capabilities: {},
    });
  });
  after(async () => {
    await srv.stop();
  });

  it("rejects non-string content instead of crashing the process", async () => {
    // The array case is the killer: String(["@validator hi"]) contains a
    // mention, so the old code reached .substring() on an Array.
    for (const content of [["@validator hi"], { text: "@validator hi" }, 42, null]) {
      const res = await post("/api/send", { agentId, content });
      const body = await res.json();
      assert.equal(res.status, 400, `content=${JSON.stringify(content)}`);
      assert.equal(body.code, "INVALID_ARGUMENT");
      assert.match(body.error, /'content'/);
    }

    // The point of the test: the hub is still serving.
    const alive = await fetch(`${base}/api/rooms`);
    assert.equal(alive.status, 200, "server survived every malformed send");
  });

  it("rejects empty and whitespace-only content", async () => {
    for (const content of ["", "   ", "\n\t"]) {
      const res = await post("/api/send", { agentId, content });
      assert.equal(res.status, 400);
      assert.match((await res.json()).error, /must not be empty/);
    }
  });

  it("does not record a message for a rejected send", async () => {
    const probe = "v17b-" + randomUUID().slice(0, 6);
    const id = randomUUID();
    await post(`/api/join/${probe}`, { agentId: id, agentName: "a", capabilities: {} });
    const before = (await (await fetch(`${base}/api/messages/${probe}?limit=500`)).json()).matched;
    await post("/api/send", { agentId: id, content: { bad: true } });
    const after = (await (await fetch(`${base}/api/messages/${probe}?limit=500`)).json()).matched;
    assert.equal(after, before, "a 400 must not leave a message behind");
  });

  it("rejects a join with a missing or non-string agentId", async () => {
    for (const body of [
      { agentName: "no-id" },
      { agentId: 123, agentName: "num-id" },
      { agentId: "  ", agentName: "blank-id" },
    ]) {
      const res = await post(`/api/join/${room}`, body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.match((await res.json()).error, /'agentId'/);
    }
  });

  it("rejects a join with a missing agentName", async () => {
    const res = await post(`/api/join/${room}`, { agentId: randomUUID() });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /'agentName'/);
  });

  it("does not register a ghost agent from a rejected join", async () => {
    await post(`/api/join/${room}`, { agentName: "ghost" });
    const { agents } = await (await fetch(`${base}/api/agents/${room}`)).json();
    assert.equal(
      agents.some((a) => a && a.name === "ghost"),
      false,
      "a rejected join must not appear in the roster"
    );
    assert.equal(
      agents.every((a) => typeof a?.id === "string" && a.id.length > 0),
      true,
      "no agent registered under an undefined id"
    );
  });

  it("rejects a task with no roomName or no title", async () => {
    let res = await post("/api/tasks", { title: "orphan", creator: "x" });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /'roomName'/);

    res = await post("/api/tasks", { roomName: room, creator: "x" });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /'title'/);
  });

  it("a rejected task is not stored anywhere", async () => {
    const statsBefore = await (await fetch(`${base}/api/stats`)).json();
    await post("/api/tasks", { title: "orphan2", creator: "x" });
    const statsAfter = await (await fetch(`${base}/api/stats`)).json();
    assert.equal(
      statsAfter.totalTasks,
      statsBefore.totalTasks,
      "a task that cannot be listed must not be created"
    );
  });

  it("still accepts well-formed requests", async () => {
    const res = await post("/api/send", { agentId, content: "a normal message" });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).success, true);

    const t = await post("/api/tasks", {
      roomName: room,
      title: "a real task",
      creator: "validator",
    });
    assert.equal(t.status, 200);
    const { tasks } = await (await fetch(`${base}/api/tasks/${room}`)).json();
    assert.equal(
      tasks.some((x) => x.title === "a real task"),
      true,
      "a created task is listed by its room"
    );
  });
});
