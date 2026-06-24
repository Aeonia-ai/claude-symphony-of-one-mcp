# Aeonia Symphony — Build Plan

**Repo:** `Aeonia-ai/aeonia-agent-hub` (fork of `ai-wes/claude-symphony-of-one-mcp`; local dir still `claude-symphony-of-one-mcp` to preserve MCP config paths)
**Status:** planning
**Author:** Jason + Companion (Claude)
**Last updated:** 2026-06-23

---

## 1. Purpose & the layered model

Stand up Aeonia's persistent multi-agent **org** — a small set of long-lived Claude agents, each in its own chat session, coordinating in real time. This fork is the **explicit coordination layer**. It sits in a deliberate three-layer model:

```
KOS / KB (git)        = durable shared memory + identity (IMPLICIT channel)
                        role threads, PM todos, goal contracts, North Star
        │  agents boot identity from here; durable decisions written back here
        ▼
Symphony (this fork)  = live coordination (EXPLICIT channel)
                        rooms/messages, task hand-off, presence, shared memory, roles
        │  messaging behind a transport ADAPTER (the swap seam)
        ▼
Transport             = Socket.IO hub  (v1, today)  →  Matrix  (v2, later)
```

**Principle:** the 12 MCP tools are the stable contract agents code against. Everything below them (transport, storage) is swappable without touching agents.

**The org (8 standing roles):** Companion, Coordinator, MU-PM, Wylding-PM, Platform-PM, Business-PM, Steward, Scribe. Each maps 1:1 to a KOS boot thread (`role/…` or `domains/<d>/<d>-pm`).

---

## 2. Architecture baseline (from the code read)

- **Seam is real:** `mcp-server.js` (agent-facing tools) has **zero DB imports**; it talks to the hub only via **8 REST endpoints + 4 Socket.IO events**.
- **Tool surface (keep stable):** `room_join`, `room_leave`, `send_message`, `get_messages`, `get_notifications`, `create_task`, `get_tasks`, `memory_store`, `memory_retrieve`, `file_read`, `file_write`, `file_list`.
- **Transport vs coordination:** rooms / messages / notifications / presence = *messaging* (→ Matrix in v2). tasks / memory / roles / files = *coordination* (stay in a store / local).
- **Friction:** no transport abstraction — `axios`/socket calls are inline in each of the 12 handlers. Fixing that (Phase 2) is what makes the Matrix swap a one-file job.

---

## 3. Milestones

| Milestone | Scope | Rough effort |
|---|---|---|
| **M1 — v1 running org** | Phases 0–6: hardened fork, adapter seam, Aeonia roles, auth, 2-agent loop over Tailscale | ~1–2 days |
| **M2 — KB integration** | Phase 7: tie Symphony to KOS (boot-from-thread, writeback doctrine) | ~0.5 day |
| **M3 — Matrix v2** | Phase 8: implement MatrixAdapter behind the same tools + stand up homeserver | ~2–3 weeks |

---

## 4. Phases (detailed)

### Phase 0 — Repo hygiene & baseline
**Goal:** clean base, working branch, green baseline before changes.
- [ ] Create working branch `aeonia/v1` off `main`.
- [ ] `.gitignore`: add `server.log`, `server.error.log`, `*.db` (or `data/*.db`), `.claude/settings.local.json`, generated `claude-config-*.json`. Untrack any already-tracked artifacts.
- [ ] Review the local uncommitted edit to `mcp-server-wrapper.js` — keep if it's a needed path fix, else revert.
- [ ] Add an `AEONIA.md` note at top of README: this is the Aeonia fork; upstream is ai-wes; point to this plan.
- [ ] **Baseline smoke:** `npm run setup` → `npm run server` → connect one MCP agent → confirm it joins a room and sends a message. Record the baseline works before we change anything.
**Acceptance:** branch exists, artifacts ignored, hub runs, one agent connects.

### Phase 1 — Bug fixes (correctness)
**Goal:** the room + task + notification loop actually works and survives restart.
- [ ] **Bug 1 — `room_leave` 404** (`mcp-server.js:199`): change `axios.post('/api/leave', {agentId})` → `axios.post('/api/leave/' + currentAgentId)` to match the server's `:agentId` param.
- [ ] **Bug 2 — message-cache cross-room leak** (`mcp-server.js:136`): on `room_join`, after setting `currentRoom`, clear `messageHistory = []; notifications = [];`.
- [ ] **Bug 3 — task persistence (the big one)** (`server.js` create-task handler ~line 561): tasks are written to an in-memory Map but never to the `tasks` SQL table. Add `INSERT` on create + `UPDATE` on status change; load tasks from DB on startup and in `GET /api/tasks/:room`. Verify tasks survive a hub restart.
- [ ] **Bug 4 — missing CLI task routes** (`cli.js:1266` `GET /api/tasks/:room/:taskId`, `cli.js:1284` `PUT …`): server only has `GET /api/tasks/:room` + `POST /api/tasks/:taskId/update`. Either add the two server routes or repoint the CLI to existing routes. Align CLI ↔ server.
- [ ] **Bug 5 — dead `task_assigned` event**: `mcp-server.js:95` listens for `task_assigned` but `server.js` never emits it. Emit `task_assigned` from the create/assign handler so agents get a push notification.
**Acceptance:** create task in room → assignee gets a notification → task visible via `get_tasks` → survives hub restart; `room_leave` returns 200; switching rooms shows only that room's messages.

### Phase 2 — Transport adapter extraction (the Matrix seam)
**Goal:** all transport behind one module so v2 is a single-file swap.
- [ ] Define `transport/Transport.js` interface: `connect(agentId, room)`, `disconnect()`, `joinRoom(room)`, `leaveRoom()`, `sendMessage(msg)`, `getMessages(room, since)`, `onMessage(cb)`, `onNotification(cb)`, `createTask(room, task)`, `getTasks(room, filter)`, `updateTask(id, patch)`, `storeMemory(agentId, kv)`, `retrieveMemory(agentId, q)`. (Messaging + task/memory grouped now; v2 may split.)
- [ ] Implement `transport/SocketIoHubTransport.js` = current behavior (the 8 axios calls + socket events moved here verbatim).
- [ ] Refactor `mcp-server.js`: each of the 12 tool handlers calls the adapter, not `axios`/`socket` directly. Tool signatures unchanged.
- [ ] Select transport via env (`SYMPHONY_TRANSPORT=hub|matrix`), default `hub`.
**Acceptance:** all v1 behavior identical, but `mcp-server.js` has no direct `axios`/socket calls — only adapter calls; a `MatrixTransport` stub implementing the interface compiles.

### Phase 3 — Role re-skin → the Aeonia org
**Goal:** Symphony roles ARE our KOS agents, booting from their KOS threads.
- [ ] Replace `AGENT_ROLES` in `role-templates.js` with the 8 roles. Each: `name`, `description`, `capabilities[]`, `defaultTasks[]`, `priority`, and a `prompt` that **boots from the KOS thread**, e.g.:
  > "You are the MU-PM. Load `users/jason@aeonia.ai/kos/sessions/threads/domains/mu/mu-pm.md` as your identity (or run `/boot mu-pm`), then join your Symphony room(s) and check tasks. Hold your boundaries: write only your L2 todos; propose, don't dispatch."
- [ ] Update `TASK_TEMPLATES` / `QUICK_ASSIGNMENTS` + `cli.js` category labels to the Aeonia set.
- [ ] **Room topology (decide — see §6):** default proposal — one `#org` room (all agents, broadcasts) + a `#<domain>` room per PM + Coordinator↔PM via tasks/DMs. Steward/Scribe in `#org`.
**Acceptance:** `/roles` lists the 8 Aeonia roles; assigning a role sends a boot prompt that points the agent at its KOS thread; agents land in the right rooms.

### Phase 4 — Minimal auth
**Goal:** close the "anyone on the port = any agent" hole.
- [ ] Shared secret: hub requires `AUTH_TOKEN` (env) on every REST call + socket `register`; reject otherwise. Agents send it via MCP env.
- [ ] Bind hub to localhost/Tailscale interface, not `0.0.0.0` publicly.
**Acceptance:** requests without the token are rejected; agents with it work.

### Phase 5 — Cross-machine (Tailscale)
**Goal:** the org spans machines.
- [ ] Run the hub on the control-plane host (Weymouth?). Expose over Tailscale only.
- [ ] Agents on other machines set `CHAT_SERVER_URL` to the Tailscale address + `AUTH_TOKEN`.
- [ ] Document in `SETUP_GUIDE` (Aeonia section).
**Acceptance:** an agent on a second machine joins a room on the hub and exchanges a message + task.

### Phase 6 — Smoke test: the 2-agent loop
**Goal:** prove the org loop end-to-end before scaling.
- [ ] Boot **Coordinator** (session A) + **MU-PM** (session B), both `room_join`.
- [ ] A sends a message → B sees it; B replies → A sees it.
- [ ] A `create_task` for B → B gets `task_assigned` notification → `get_tasks` shows it → B updates status → A sees update.
- [ ] `memory_store`/`memory_retrieve` round-trips.
- [ ] Restart hub → task still present.
- [ ] `room_leave` clean.
**Acceptance:** all above pass; checklist recorded.

### Phase 7 — KB integration (tie to KOS)
**Goal:** Symphony (live) + KB (durable) cohere; no double-source-of-truth.
- [ ] Doctrine: **durable decisions/state → KB** (role threads, `_meta/current-todos`, goal contracts); **Symphony carries the nudge/dispatch + ephemeral coordination**. Every consequential Symphony exchange leaves a KB trace (writeback).
- [ ] Role prompts boot from KOS threads (done in Phase 3); confirm the loop: boot identity (KB) → coordinate (Symphony) → write outcomes (KB).
- [ ] Add a short note in the KB (`kos/architecture/agent-communication-and-coordination.md`) recording that the explicit channel is now Symphony-the-fork (was "Phase 8, design only"), with the adapter→Matrix path.
**Acceptance:** the comms doc reflects reality; a task closed in Symphony results in a KB writeback by the owning agent.

### Phase 8 — Matrix swap (v2, later)
**Goal:** robust/federated transport behind the same tools.
- [ ] Stand up a homeserver (Conduit lightweight, or Synapse) on the control plane.
- [ ] Implement `transport/MatrixTransport.js` against the Phase-2 interface (matrix-js-sdk or matrix-nio): join→`/join`, send→`m.room.message`, getMessages→`/messages`, onMessage→`/sync`, presence, read receipts = ack.
- [ ] Move tasks/memory to a side store (Matrix `account_data`/state, or Postgres/Redis) — decide.
- [ ] Flip `SYMPHONY_TRANSPORT=matrix`. **No agent-facing change.**
**Acceptance:** the full 2-agent loop passes on Matrix with the 12 tools unchanged.

---

## 5. Risks & mitigations
- **No upstream license** → fine for internal use + GitHub forking; ask ai-wes for a license before any product/external use. *(open)*
- **Centralized hub = single point of failure** → acceptable for v1 personal org; Matrix federates in v2.
- **Buggy/early upstream** → we own the fork; Phase 1 fixes the known holes; add tests as we touch code.
- **Token cost of N concurrent agents** → start with 2, scale only when value is proven (web research's main caution).
- **Global per-process state in `mcp-server.js`** → one agent per process is by design; fine.
- **No tests on the hub** → add minimal integration tests around tasks + auth as we fix them.

---

## 6. Resolved decisions (2026-06-23)
1. **Repo name:** renamed to **`aeonia-agent-hub`** (local dir kept as `claude-symphony-of-one-mcp` so MCP config paths don't break).
2. **Room topology:** **one `#org` room (all agents, broadcasts) + a `#<domain>` room per PM**; Coordinator↔PM mostly via tasks; Steward/Scribe in `#org`.
3. **Hub host:** **Weymouth (control plane), exposed over Tailscale only.** (Localhost acceptable for the very first smoke test, then move to Weymouth.)
4. **Role prompts boot from KOS threads** — yes (unifies the two systems: KOS = identity, Symphony = live coordination).
5. **Auth:** shared `AUTH_TOKEN` for v1 (per-agent tokens deferred).
6. **License outreach to ai-wes:** deferred — internal use only for now; revisit before any external/product use.

---

## 7. Definition of done (v1 / M1)
Two agents (Coordinator + MU-PM), each booting its identity from its KOS thread, running in separate chat sessions on (at least one) machine, coordinate over the Aeonia Symphony fork: exchange messages, hand off a task that persists across a hub restart, share memory, all behind an auth token and a transport adapter that a Matrix implementation can later drop into — with the 12 MCP tools unchanged.
