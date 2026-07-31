/**
 * Bug 19 — a poll that returned nothing also returned no cursor.
 *
 * RED: the cursor was derived client-side from the messages in the returned
 * page, so an empty page produced no "Next poll: since=..." line at all. An
 * empty page is the NORMAL result in a normally-paced room, and it is exactly
 * when the agent most needs its cursor echoed back. Having lost it, the agent
 * fell back to a no-`since` poll, which re-reads the whole room tail with no
 * way to tell which messages are new — reported as "clients have a hard time
 * finding new messages sometimes", where "sometimes" meant "after any quiet
 * poll". The count-only (limit=0) path returned no cursor either, so using
 * limit:0 to check for new messages lost your place on every check.
 *
 * GREEN: the server returns `nextSince` on every read. It is authoritative —
 * the server owns the clock that stamps messages, so a client substituting its
 * own Date.now() would skip messages whenever its clock ran ahead of the hub's.
 * It never advances past messages the caller has not actually received.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { startServer } from "./helpers.js";

describe("Bug 19 – every poll returns a usable cursor", () => {
  let srv, base;

  const post = (p, b) =>
    fetch(`${base}${p}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(b),
    });
  const read = async (room, params = {}) => {
    const qs = new URLSearchParams(params);
    return (await (await fetch(`${base}/api/messages/${room}?${qs}`)).json());
  };
  const newRoom = async (name) => {
    const room = name + "-" + randomUUID().slice(0, 6);
    const id = randomUUID();
    await post(`/api/join/${room}`, { agentId: id, agentName: "poller", capabilities: {} });
    return { room, id };
  };

  before(async () => {
    srv = await startServer();
    base = `http://localhost:${srv.port}`;
  });
  after(async () => {
    await srv.stop();
  });

  it("echoes the cursor back unchanged when nothing is new", async () => {
    const { room, id } = await newRoom("q");
    await post("/api/send", { agentId: id, content: "hello" });

    const first = await read(room, { limit: "50" });
    assert.ok(first.nextSince, "a normal poll returns a cursor");

    const quiet = await read(room, { since: first.nextSince, limit: "50" });
    assert.equal(quiet.returned, 0, "nothing new");
    assert.equal(
      quiet.nextSince,
      first.nextSince,
      "an empty poll must hand the same cursor back, not drop it"
    );
  });

  it("a cursor from a quiet poll still finds the next message", async () => {
    const { room, id } = await newRoom("c");
    await post("/api/send", { agentId: id, content: "one" });
    const p1 = await read(room, { limit: "50" });
    const p2 = await read(room, { since: p1.nextSince, limit: "50" }); // quiet
    assert.equal(p2.returned, 0);

    await post("/api/send", { agentId: id, content: "the new one" });
    const p3 = await read(room, { since: p2.nextSince, limit: "50" });

    assert.equal(p3.matched, 1, "exactly the new message, not the whole room");
    assert.equal(p3.messages[0].content, "the new one");
  });

  it("does not advance the cursor past messages the caller never received", async () => {
    // Count-only: the caller learns how many are new but gets no bodies, so the
    // cursor must stay where it was or those messages are skipped forever.
    const { room, id } = await newRoom("co");
    await post("/api/send", { agentId: id, content: "first" });
    const p1 = await read(room, { limit: "50" });

    await post("/api/send", { agentId: id, content: "unseen A" });
    await post("/api/send", { agentId: id, content: "unseen B" });

    const countOnly = await read(room, { since: p1.nextSince, limit: "0" });
    assert.equal(countOnly.matched, 2, "two new messages counted");
    assert.equal(countOnly.returned, 0, "no bodies transferred");
    assert.equal(
      countOnly.nextSince,
      p1.nextSince,
      "a count-only poll must not advance the cursor"
    );

    const fetched = await read(room, { since: countOnly.nextSince, limit: "50" });
    assert.deepEqual(
      fetched.messages.map((m) => m.content),
      ["unseen A", "unseen B"],
      "both counted messages are still retrievable"
    );
  });

  it("omits the cursor rather than skipping a backlog it never showed", async () => {
    // Count-only with NO since over a non-empty room: any cursor would sit
    // after messages the caller has not seen, so none is offered.
    const { room, id } = await newRoom("nb");
    await post("/api/send", { agentId: id, content: "backlog" });
    const res = await read(room, { limit: "0" });
    assert.ok(res.matched >= 1);
    assert.equal(
      res.nextSince,
      undefined,
      "no cursor is safer than one that skips the backlog"
    );
  });

  it("gives an empty room a starting cursor", async () => {
    const room = "empty-" + randomUUID().slice(0, 6);
    const res = await read(room, { limit: "50" });
    assert.equal(res.matched, 0);
    assert.ok(res.nextSince, "an empty room still yields a cursor to start from");
    assert.ok(
      Number.isFinite(new Date(res.nextSince).getTime()),
      "and it parses as a timestamp"
    );
  });

  it("never hands back a cursor that outruns an in-flight write", async () => {
    // The "start watching from now" fallback fires when a poll matches nothing
    // and carries no `since` — e.g. a `mentioning` poll in a busy room. If it
    // ignored the in-flight write watermark it would return `now`, which sits
    // AFTER a message whose timestamp is reserved but whose row has not landed
    // yet — skipping it permanently once it settles.
    const room = "wm-" + randomUUID().slice(0, 6);
    const me = randomUUID();
    const other = randomUUID();
    await post(`/api/join/${room}`, { agentId: me, agentName: "me", capabilities: {} });
    await post(`/api/join/${room}`, { agentId: other, agentName: "other", capabilities: {} });

    // Fire a burst of mentions WITHOUT awaiting, so writes are in flight while
    // the directed poll runs, then take the cursor that poll hands back.
    const inFlight = Array.from({ length: 30 }, (_, i) =>
      post("/api/send", { agentId: other, content: `@me burst ${i}` })
    );
    const during = await read(room, { mentioning: "me", limit: "50" });
    const cursor = during.nextSince;
    await Promise.all(inFlight);

    if (cursor) {
      const after = await read(room, { since: cursor, mentioning: "me", limit: "100" });
      const seen = new Set([
        ...during.messages.map((m) => m.content),
        ...after.messages.map((m) => m.content),
      ]);
      const missing = Array.from({ length: 30 }, (_, i) => `@me burst ${i}`).filter(
        (c) => !seen.has(c)
      );
      assert.deepEqual(missing, [], "no mention may fall behind the handed-back cursor");
    }
  });

  it("keeps the cursor when a directed poll finds no mentions", async () => {
    const room = "dm-" + randomUUID().slice(0, 6);
    const me = randomUUID();
    const other = randomUUID();
    await post(`/api/join/${room}`, { agentId: me, agentName: "me", capabilities: {} });
    await post(`/api/join/${room}`, { agentId: other, agentName: "other", capabilities: {} });

    await post("/api/send", { agentId: other, content: "@me ping" });
    const d1 = await read(room, { mentioning: "me", limit: "50" });
    assert.equal(d1.returned, 1);

    // Traffic that is NOT addressed to me — the directed poll comes back empty.
    await post("/api/send", { agentId: other, content: "chatter" });
    const d2 = await read(room, { since: d1.nextSince, mentioning: "me", limit: "50" });
    assert.equal(d2.returned, 0);
    assert.equal(d2.nextSince, d1.nextSince, "directed polls keep their cursor too");

    await post("/api/send", { agentId: other, content: "@me second ping" });
    const d3 = await read(room, { since: d2.nextSince, mentioning: "me", limit: "50" });
    assert.equal(d3.returned, 1, "the next mention is still found");
    assert.equal(d3.messages[0].content, "@me second ping");
  });

  it("walks a truncated backlog contiguously via the cursor", async () => {
    const { room, id } = await newRoom("pg");
    const start = await read(room, { limit: "50" });
    for (let i = 0; i < 12; i++) {
      await post("/api/send", { agentId: id, content: `m${i}` });
    }

    const seen = [];
    let cursor = start.nextSince;
    for (let page = 0; page < 10; page++) {
      const res = await read(room, { since: cursor, limit: "5" });
      seen.push(...res.messages.map((m) => m.content));
      cursor = res.nextSince;
      if (!res.hasMore) break;
    }

    assert.deepEqual(
      seen,
      Array.from({ length: 12 }, (_, i) => `m${i}`),
      "every message seen exactly once, in order, with no gaps"
    );
  });
});
