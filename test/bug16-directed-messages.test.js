/**
 * "Get exactly the (new) messages directed to me": get_messages with a
 * `mentioning` filter (directedToMe in MCP). Returns only messages that
 * @mention the agent — full content — and composes with the cursor (new only)
 * and limit:0 (count only), so a busy room costs almost nothing to poll for
 * "anything for me?".
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { startServer } from "./helpers.js";

describe("Bug 16 – server-side `mentioning` filter", () => {
  let srv, base;
  const room = "directed-room";
  const sender = randomUUID();

  const join = (id, name) =>
    fetch(`${base}/api/join/${room}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: id, agentName: name, capabilities: {} }),
    });
  const send = (content) =>
    fetch(`${base}/api/send`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: sender, content }),
    });
  const get = (qs) =>
    fetch(`${base}/api/messages/${room}?${qs}`).then((r) => r.json());

  before(async () => {
    srv = await startServer();
    base = `http://localhost:${srv.port}`;
    await join(sender, "sender");
    await join(randomUUID(), "target");
    await join(randomUUID(), "other");
  });
  after(async () => { await srv.stop(); });

  it("returns only messages that mention the name, full content", async () => {
    await send("nothing for anyone here");
    await send("@target this one is for you");
    await send("@other not for target");
    await send("@target and @other, both");

    const body = await get("mentioning=target&limit=1000");
    const contents = body.messages.map((m) => m.content);
    assert.ok(contents.includes("@target this one is for you"));
    assert.ok(contents.includes("@target and @other, both"));
    assert.ok(!contents.includes("nothing for anyone here"), "unaddressed message excluded");
    assert.ok(!contents.includes("@other not for target"), "message for someone else excluded");
    // Full content, not a preview.
    assert.ok(contents.some((c) => c.length > 20));
  });

  it("is case-insensitive on the name", async () => {
    const body = await get("mentioning=TARGET&limit=1000");
    assert.ok(body.messages.length >= 2, "case-insensitive match");
  });

  it("composes with `since` — only NEW directed messages", async () => {
    const cursor = (await get("mentioning=target&limit=1000")).messages.at(-1).timestamp;
    await send("@target a fresh one after the cursor");
    await send("@other noise not for target");

    const body = await get(`mentioning=target&since=${encodeURIComponent(cursor)}&limit=1000`);
    const contents = body.messages.map((m) => m.content);
    assert.deepEqual(
      contents, ["@target a fresh one after the cursor"],
      `only the new directed message should return; got ${JSON.stringify(contents)}`
    );
  });

  it("composes with limit:0 — counts directed messages, no bodies", async () => {
    const body = await get("mentioning=target&limit=0");
    assert.equal(body.returned, 0, "no bodies");
    assert.ok(body.matched >= 3, `counts the directed messages, got ${body.matched}`);
  });
});

describe("Bug 16 – directedToMe over MCP", () => {
  let srv;
  let client, transport;
  const room = `dm-${randomUUID().slice(0, 6)}`;
  const textOf = (r) => (r.content || []).map((c) => c.text || "").join("\n");

  before(async () => {
    srv = await startServer();
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
    const MCP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../mcp-server.js");
    transport = new StdioClientTransport({
      command: process.execPath, args: [MCP],
      env: { ...process.env, CHAT_SERVER_URL: `http://localhost:${srv.port}`, AGENT_NAME: "me-agent", AUTH_TOKEN: "" },
    });
    client = new Client({ name: "t", version: "1.0.0" });
    await client.connect(transport);
    await client.callTool({ name: "room_join", arguments: { roomName: room } });
  });
  after(async () => {
    try { await client.close(); } catch {}
    await srv.stop();
  });

  it("returns only messages that mention this agent", async () => {
    // A peer posts one for me and one for someone else.
    const peer = randomUUID();
    await fetch(`http://localhost:${srv.port}/api/join/${room}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: peer, agentName: "peer", capabilities: {} }),
    });
    for (const c of ["@me-agent please review this", "@someone-else not for me", "general chatter"]) {
      await fetch(`http://localhost:${srv.port}/api/send`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: peer, content: c }),
      });
    }

    const res = await client.callTool({
      name: "get_messages", arguments: { directedToMe: true },
    });
    const text = textOf(res);
    assert.match(text, /please review this/, "my message is returned");
    assert.ok(!/not for me/.test(text), "another agent's message is excluded");
    assert.ok(!/general chatter/.test(text), "unaddressed chatter is excluded");
  });

  it("directedToMe + limit:0 counts only what's for me", async () => {
    const res = await client.callTool({
      name: "get_messages", arguments: { directedToMe: true, limit: 0 },
    });
    const text = textOf(res);
    assert.match(text, /count only, none fetched/, `got: ${text}`);
    assert.ok(!/please review this/.test(text), "no bodies on a count");
  });
});
