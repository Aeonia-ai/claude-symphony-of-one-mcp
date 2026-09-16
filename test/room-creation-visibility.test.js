/**
 * Silent room creation — a typo in a join string is indistinguishable from the
 * room you meant.
 *
 * RED: join-is-create is deliberate, but /api/join answered identically whether
 * it had joined an existing room or conjured an empty new one. A leading space
 * in a join string once produced a fresh room called "Group Space mind"; the
 * agent reported success, sat in it alone, and nothing anywhere said so.
 *
 * GREEN: the join response carries `createdRoom`, true only on the join that
 * actually brought the room into being.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { startServer } from "./helpers.js";

describe("Room creation visibility", () => {
  let srv, base;

  const join = (room, agentName) =>
    fetch(`${base}/api/join/${encodeURIComponent(room)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: randomUUID(), agentName, capabilities: {} }),
    }).then((r) => r.json());

  before(async () => {
    srv = await startServer();
    base = `http://localhost:${srv.port}`;
  });

  after(async () => {
    await srv?.stop?.();
  });

  it("reports createdRoom on the join that creates the room", async () => {
    const body = await join("rcv-" + randomUUID().slice(0, 6), "first-arrival");
    assert.equal(body.success, true);
    assert.equal(body.createdRoom, true);
  });

  it("does not report createdRoom when joining an existing room", async () => {
    const room = "rcv-" + randomUUID().slice(0, 6);

    const created = await join(room, "first-arrival");
    assert.equal(created.createdRoom, true);

    const second = await join(room, "second-arrival");
    assert.equal(second.success, true);
    assert.equal(second.createdRoom, false);
  });

  it("treats a typo'd room name as a distinct new room", async () => {
    const intended = "rcv-" + randomUUID().slice(0, 6);
    await join(intended, "first-arrival");

    // The "Group Space mind" case: a leading space is invisible in a log line.
    const typo = await join(" " + intended, "fat-fingered");
    assert.equal(typo.createdRoom, true, "a typo must not silently look like a join");
  });
});
