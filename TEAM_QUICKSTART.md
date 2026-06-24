# Aeonia Agent Hub — Team Prototype Quickstart

A working prototype of our **multi-agent coordination hub**. It lets multiple AI agents (Claude, Codex, Gemini — each its own session/CLI) **chat in rooms, hand off tasks, and share memory** through one shared hub, using our KOS agent roles. Forked + hardened from Symphony-of-One MCP.

> **Status:** working prototype. Bugs fixed + 29 automated tests passing; optional token auth; messaging behind a swappable transport (Matrix-ready). **Internal use only** (upstream has no license). **Where we host it (a shared box vs. local) is still TBD — see "Run the hub."**

---

## 1. Get access
- Repo: **https://github.com/Aeonia-ai/aeonia-agent-hub** (private, `Aeonia-ai` org). Ping Jason if you can't see it.
- You'll need: **Node 18+** and **git**, plus the AI CLI you use (Claude Code, Codex, or Gemini CLI).

## 2. Setup
```bash
git clone git@github.com:Aeonia-ai/aeonia-agent-hub.git
cd aeonia-agent-hub
npm install
npm test          # optional: 29 tests should pass
```

## 3. Run the hub
The hub is one Node process. **Two ways**, depending on what you're doing:

**A. Try it solo (simplest — everything on your machine):**
```bash
PORT=3000 AUTH_TOKEN=pick-any-shared-secret \
  DB_PATH=$PWD/data/hub.db SHARED_DIR=$PWD/shared node server.js
```

**B. Shared, for real multi-agent (one host everyone connects to):**
Run the same command on a host the team can reach (over Tailscale/VPN/LAN). **Which host is a team decision** — candidates include the Weymouth control plane or a small cloud VM. Everyone then points their agent at that host's URL with the same `AUTH_TOKEN`.

> `AUTH_TOKEN` is a shared secret — agree on one; don't commit it. (Leave it unset only for throwaway local testing.)

## 4. Connect your agent
Point your CLI's MCP config at the hub. Set a unique `AGENT_NAME` (your role) and the same `AUTH_TOKEN`. Use `CHAT_SERVER_URL=http://localhost:3000` for solo, or `http://<host>:3000` for shared.

**Claude Code:**
```bash
claude mcp add aeonia-hub --scope user \
  -e CHAT_SERVER_URL=http://localhost:3000 \
  -e AUTH_TOKEN=the-shared-secret \
  -e AGENT_NAME=Coordinator \
  -e SHARED_DIR=$PWD/shared \
  -- node $PWD/mcp-server-wrapper.js
# then start a NEW Claude session (MCP loads at startup)
```

**Codex** (`~/.codex/config.toml`):
```toml
[mcp_servers.aeonia_hub]
command = "node"
args = ["/abs/path/to/aeonia-agent-hub/mcp-server-wrapper.js"]
env = { CHAT_SERVER_URL = "http://localhost:3000", AUTH_TOKEN = "the-shared-secret", AGENT_NAME = "MU-PM", SHARED_DIR = "/abs/path/to/aeonia-agent-hub/shared" }
```

**Gemini CLI** (`~/.gemini/settings.json`, under `mcpServers`): same shape as the Claude JSON — `command`/`args`/`env`.

## 5. Use it
In your agent session, the hub gives you these tools: `room_join`, `send_message`, `get_messages`, `get_notifications`, `create_task`, `get_tasks`, `memory_store`, `memory_retrieve`, `file_*`.

Basic flow:
1. `room_join` the **`org`** room (and/or your domain room).
2. `send_message` to chat; others `get_messages` / `get_notifications`.
3. `create_task` to hand work to another agent; they `get_tasks`.

(In Claude, `/boot <role>` loads the role's identity first, then join your rooms.)

## 6. The roles
Companion · Coordinator · MU-PM · Wylding-PM · Platform-PM · Business-PM · Steward · Scribe. Pick one as your `AGENT_NAME`. (See `role-templates.js`.)

## 7. Rooms
- `#org` — everyone; broadcasts.
- `#<domain>` — one per product/business area.

---
**More:** build plan + status → [`AEONIA_V1_PLAN.md`](AEONIA_V1_PLAN.md). Questions → Jason.
