/**
 * Bug 14: "X has joined the room" was posted on EVERY join, including re-joins.
 *
 * Agents get a fresh id each session and autonomous workers re-join every cycle
 * without leaving, so these notices were the largest single source of room
 * noise — 41% of messages in one active room. A join notice should mark a
 * genuine arrival, not a session reconnect.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { startServer } from "./helpers.js";

describe("Bug 14 – re-joins do not spam join notices", () => {
  let srv, base;
  const room = "rejoin-room";

  const join = (id, name) =>
    fetch(`${base}/api/join/${room}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: id, agentName: name, capabilities: {} }),
    });
  const joinNotices = async (name) => {
    const body = await (await fetch(`${base}/api/messages/${room}?limit=1000`)).json();
    return body.messages.filter(
      (m) => m.type === "system" && m.content === `${name} has joined the room`
    ).length;
  };

  before(async () => {
    // Window 0 so stale reap is deterministic; re-join detection is independent.
    srv = await startServer({ LIVE_AGENT_WINDOW_MS: "0" });
    base = `http://localhost:${srv.port}`;
  });
  after(async () => { await srv.stop(); });

  it("announces the first arrival exactly once, then stays quiet on re-joins", async () => {
    await join(randomUUID(), "worker");
    await join(randomUUID(), "worker");
    await join(randomUUID(), "worker");
    await join(randomUUID(), "worker");

    assert.equal(
      await joinNotices("worker"),
      1,
      "a re-joining agent must announce once, not once per session"
    );
  });

  it("still announces genuinely different agents", async () => {
    await join(randomUUID(), "alpha");
    await join(randomUUID(), "beta");
    assert.equal(await joinNotices("alpha"), 1, "alpha's first arrival is announced");
    assert.equal(await joinNotices("beta"), 1, "beta's first arrival is announced");
  });

  it("re-announces after the agent has actually left", async () => {
    const id1 = randomUUID();
    await join(id1, "cycler");
    assert.equal(await joinNotices("cycler"), 1);

    await fetch(`${base}/api/leave/${id1}`, { method: "POST" });
    // Now genuinely absent — a fresh join is a real arrival again.
    await join(randomUUID(), "cycler");
    assert.equal(
      await joinNotices("cycler"),
      2,
      "a join after a real departure should announce again"
    );
  });
});
