import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startServer } from "./helpers.js";

const MCP_SERVER_JS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../mcp-server.js");
const textOf = (response) => response.content.map((item) => item.text || "").join("\n");

describe("MCP remote file backend", () => {
  let srv, client, transport;
  const room = `remote-files-${randomUUID().slice(0, 8)}`;
  const absentClientDir = path.join(os.tmpdir(), `should-not-exist-${randomUUID()}`);

  before(async () => {
    srv = await startServer({ AUTH_TOKEN: "remote-file-token", FILE_STORE_DIR: path.join(os.tmpdir(), `remote-store-${randomUUID()}`) });
    transport = new StdioClientTransport({
      command: process.execPath, args: [MCP_SERVER_JS],
      env: { ...process.env, CHAT_SERVER_URL: `http://localhost:${srv.port}`, AUTH_TOKEN: "remote-file-token", AGENT_NAME: "remote-mcp-test", SYMPHONY_FILE_BACKEND: "remote", SHARED_DIR: absentClientDir },
    });
    client = new Client({ name: "remote-file-test", version: "1" });
    await client.connect(transport);
    const join = await client.callTool({ name: "room_join", arguments: { roomName: room } });
    assert.ok(!join.isError, textOf(join));
  });
  after(async () => { try { await client.close(); } catch {} await srv.stop(); await fs.rm(absentClientDir, { recursive: true, force: true }); });

  it("shares files through the hub without creating the local SHARED_DIR", async () => {
    const written = await client.callTool({ name: "file_write", arguments: { filename: "handoff.md", content: "from remote MCP" } });
    assert.ok(!written.isError, textOf(written));
    assert.match(textOf(written), /v1/);
    const listed = await client.callTool({ name: "file_list", arguments: {} });
    assert.ok(!listed.isError, textOf(listed));
    assert.match(textOf(listed), /handoff\.md/);
    const read = await client.callTool({ name: "file_read", arguments: { filename: "handoff.md" } });
    assert.ok(!read.isError, textOf(read));
    assert.match(textOf(read), /from remote MCP/);
    await assert.rejects(fs.access(absentClientDir));
  });
});
