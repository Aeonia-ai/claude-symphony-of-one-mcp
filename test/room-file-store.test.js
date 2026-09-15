import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import sqlite3 from "sqlite3";
import { startServer } from "./helpers.js";

describe("room-scoped hub file store", () => {
  let srv, base;
  const room = `files-${randomUUID().slice(0, 8)}`;
  const auth = { "X-Auth-Token": "file-test-token" };
  const fileDir = path.join(os.tmpdir(), `symphony-files-${randomUUID()}`);

  before(async () => {
    srv = await startServer({ AUTH_TOKEN: "file-test-token", FILE_STORE_DIR: fileDir });
    base = `http://localhost:${srv.port}`;
    const joined = await fetch(`${base}/api/join/${room}`, {
      method: "POST", headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: randomUUID(), agentName: "file-tester" }),
    });
    assert.equal(joined.status, 200);
  });
  after(async () => { await srv.stop(); await fs.rm(fileDir, { recursive: true, force: true }); });

  const put = (name, content, headers = {}) => fetch(`${base}/api/rooms/${room}/files/${name}`, {
    method: "PUT", headers: { ...auth, "Content-Type": "text/plain", ...headers }, body: content,
  });

  it("creates, lists, and reads a room file with metadata", async () => {
    const created = await put("briefs/today.md", "hello team", { "If-None-Match": "*" });
    assert.equal(created.status, 201);
    const body = await created.json();
    assert.equal(body.file.version, 1);
    assert.equal(body.file.byteSize, 10);
    assert.match(body.file.sha256, /^[a-f0-9]{64}$/);

    const listed = await (await fetch(`${base}/api/rooms/${room}/files?prefix=briefs`, { headers: auth })).json();
    assert.deepEqual(listed.files.map((f) => f.path), ["briefs/today.md"]);

    const read = await (await fetch(`${base}/api/rooms/${room}/files/briefs/today.md`, { headers: { ...auth, Accept: "application/json" } })).json();
    assert.equal(read.content, "hello team");
    assert.equal(read.version, 1);
  });

  it("preserves JSON bytes instead of letting the global JSON middleware consume them", async () => {
    const content = JSON.stringify({ kind: "handoff", count: 2 });
    const created = await fetch(`${base}/api/rooms/${room}/files/briefs/state.json`, {
      method: "PUT",
      headers: { ...auth, "Content-Type": "application/json", "If-None-Match": "*" },
      body: content,
    });
    assert.equal(created.status, 201);
    const read = await (await fetch(`${base}/api/rooms/${room}/files/briefs/state.json`, { headers: { ...auth, Accept: "application/json" } })).json();
    assert.equal(read.content, content);
  });

  it("rejects traversal and stale writers without changing current content", async () => {
    const traversal = await put("..%2Fescape.txt", "no", { "If-None-Match": "*" });
    assert.equal(traversal.status, 400);
    assert.equal((await traversal.json()).code, "INVALID_PATH");

    const stale = await put("briefs/today.md", "stale", { "If-Match": "0" });
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).code, "CONFLICT");
    const read = await (await fetch(`${base}/api/rooms/${room}/files/briefs/today.md`, { headers: { ...auth, Accept: "application/json" } })).json();
    assert.equal(read.content, "hello team");
  });

  it("returns the documented JSON error for a body over the hard upload limit", async () => {
    const response = await fetch(`${base}/api/rooms/${room}/files/too-large.bin`, {
      method: "PUT",
      headers: { ...auth, "Content-Type": "application/octet-stream", "If-None-Match": "*" },
      body: Buffer.alloc(10 * 1024 * 1024 + 1),
    });
    assert.equal(response.status, 413);
    assert.equal((await response.json()).code, "PAYLOAD_TOO_LARGE");
  });

  it("updates only with the current version, audits revisions, and soft-deletes", async () => {
    const updated = await put("briefs/today.md", "newer", { "If-Match": "1" });
    assert.equal(updated.status, 200);
    assert.equal((await updated.json()).file.version, 2);

    const revisions = await (await fetch(`${base}/api/rooms/${room}/files/briefs/today.md/revisions`, { headers: auth })).json();
    assert.deepEqual(revisions.revisions.map((r) => r.operation), ["write", "create"]);

    const refused = await fetch(`${base}/api/rooms/${room}/files/briefs/today.md`, { method: "DELETE", headers: { ...auth, "If-Match": "2" } });
    assert.equal(refused.status, 400);
    const deleted = await fetch(`${base}/api/rooms/${room}/files/briefs/today.md`, { method: "DELETE", headers: { ...auth, "If-Match": "2", "X-Confirm-Delete": "true" } });
    assert.equal(deleted.status, 200);
    const gone = await fetch(`${base}/api/rooms/${room}/files/briefs/today.md`, { headers: auth });
    assert.equal(gone.status, 404);
  });

  it("does not expose new bytes when the metadata transaction fails", async () => {
    const name = "atomic.md";
    assert.equal((await put(name, "stable", { "If-None-Match": "*" })).status, 201);
    const dbRun = (sql) => new Promise((resolve, reject) => {
      const db = new sqlite3.Database(srv.dbPath);
      db.run(sql, (error) => db.close(() => error ? reject(error) : resolve()));
    });
    await dbRun("CREATE TRIGGER reject_file_revision BEFORE INSERT ON file_revisions WHEN NEW.operation = 'write' BEGIN SELECT RAISE(ABORT, 'forced test failure'); END");
    assert.equal((await put(name, "should-not-be-current", { "If-Match": "1" })).status, 500);
    const read = await (await fetch(`${base}/api/rooms/${room}/files/${name}`, { headers: { ...auth, Accept: "application/json" } })).json();
    assert.equal(read.version, 1);
    assert.equal(read.content, "stable");
  });
});
