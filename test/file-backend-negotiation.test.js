import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startServer } from "./helpers.js";

const MCP_SERVER_JS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../mcp-server.js");
const textOf = (response) => response.content.map((item) => item.text || "").join("\n");

// Spawns the MCP client against a given hub URL, with no file-backend variable
// set unless a case asks for one, so the choice comes from negotiation alone.
async function connectClient({ hubUrl, sharedDir, token = "", extraEnv = {} }) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [MCP_SERVER_JS],
    env: {
      ...process.env,
      CHAT_SERVER_URL: hubUrl,
      AUTH_TOKEN: token,
      AGENT_NAME: `negotiation-${randomUUID().slice(0, 6)}`,
      SHARED_DIR: sharedDir,
      SYMPHONY_FILE_BACKEND: "",
      ...extraEnv,
    },
  });
  const client = new Client({ name: "negotiation-test", version: "1" });
  await client.connect(transport);
  return client;
}

async function stubHub(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    stop: () => new Promise((resolve) => server.close(resolve)),
  };
}

describe("file backend negotiation", () => {
  let srv, storeDir;
  const token = "negotiation-token";

  before(async () => {
    storeDir = path.join(os.tmpdir(), `negotiation-store-${randomUUID()}`);
    srv = await startServer({ AUTH_TOKEN: token, FILE_STORE_DIR: storeDir });
  });
  after(async () => {
    await srv.stop();
    await fs.rm(storeDir, { recursive: true, force: true });
  });

  it("uses the hub store against a capable hub with nothing configured", async () => {
    const clientDir = path.join(os.tmpdir(), `never-created-${randomUUID()}`);
    const client = await connectClient({ hubUrl: `http://localhost:${srv.port}`, sharedDir: clientDir, token });
    try {
      const room = `negotiated-${randomUUID().slice(0, 8)}`;
      assert.ok(!(await client.callTool({ name: "room_join", arguments: { roomName: room } })).isError);

      const written = await client.callTool({ name: "file_write", arguments: { filename: "negotiated.md", content: "chosen by the hub" } });
      assert.ok(!written.isError, textOf(written));

      const listed = await client.callTool({ name: "file_list", arguments: {} });
      assert.match(textOf(listed), /negotiated\.md/);
      assert.match(textOf(listed), /hub store/, "listing should name the store it read");

      // The decisive proof: nothing touched this machine's disk.
      await assert.rejects(fs.access(clientDir), "local shared dir must not be created in hub mode");
    } finally {
      await client.close();
    }
  });

  it("falls back to local disk against an older hub with no capabilities endpoint", async () => {
    const hub = await stubHub((req, res) => { res.statusCode = 404; res.end("Cannot GET"); });
    const clientDir = path.join(os.tmpdir(), `legacy-local-${randomUUID()}`);
    const client = await connectClient({ hubUrl: hub.url, sharedDir: clientDir });
    try {
      const listed = await client.callTool({ name: "file_list", arguments: {} });
      assert.ok(!listed.isError, textOf(listed));
      assert.match(textOf(listed), /local to this machine/, "listing should say it fell back to local disk");
    } finally {
      await client.close();
      await hub.stop();
      await fs.rm(clientDir, { recursive: true, force: true });
    }
  });

  it("falls back to local disk when the hub is unreachable", async () => {
    const dead = await stubHub(() => {});
    const url = dead.url;
    await dead.stop();
    const clientDir = path.join(os.tmpdir(), `offline-local-${randomUUID()}`);
    const client = await connectClient({ hubUrl: url, sharedDir: clientDir });
    try {
      const listed = await client.callTool({ name: "file_list", arguments: {} });
      assert.ok(!listed.isError, textOf(listed));
      assert.match(textOf(listed), /local to this machine/);
    } finally {
      await client.close();
      await fs.rm(clientDir, { recursive: true, force: true });
    }
  });

  it("honours an explicit local override even against a capable hub", async () => {
    const clientDir = path.join(os.tmpdir(), `override-local-${randomUUID()}`);
    const client = await connectClient({
      hubUrl: `http://localhost:${srv.port}`, sharedDir: clientDir, token,
      extraEnv: { SYMPHONY_FILE_BACKEND: "local" },
    });
    try {
      const room = `override-${randomUUID().slice(0, 8)}`;
      await client.callTool({ name: "room_join", arguments: { roomName: room } });
      const listed = await client.callTool({ name: "file_list", arguments: {} });
      assert.match(textOf(listed), /local to this machine/, "override must win over the hub's advertisement");
    } finally {
      await client.close();
      await fs.rm(clientDir, { recursive: true, force: true });
    }
  });
});

describe("hub capability advertisement", () => {
  let srv, base;
  before(async () => {
    srv = await startServer({ AUTH_TOKEN: "cap-test-token" });
    base = `http://localhost:${srv.port}`;
  });
  after(async () => { await srv.stop(); });

  it("advertises the room file store with its limits", async () => {
    const res = await fetch(`${base}/api/capabilities`, { headers: { "X-Auth-Token": "cap-test-token" } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.protocolVersion, 1);
    assert.equal(body.capabilities.roomFileStore.enabled, true);
    assert.ok(body.capabilities.roomFileStore.maxTextBytes > 0);
    assert.ok(body.capabilities.roomFileStore.maxBinaryBytes > 0);
  });

  it("requires the shared token like every other api route", async () => {
    const res = await fetch(`${base}/api/capabilities`);
    assert.equal(res.status, 401);
  });
});
