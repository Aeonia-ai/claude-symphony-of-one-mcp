# Changelog

All notable changes in this fork relative to upstream (`ai-wes/claude-symphony-of-one-mcp`).

## [Fork] 2026-07-31

### Bug fixes

Two more instances of this codebase's characteristic defect — *a partial or
failed operation reported as success* — plus the crash that was hiding inside
one of them. Covered by 15 tests in `test/bug17-input-validation.test.js` and
`test/bug18-unpersisted-messages.test.js`.

1. **Untyped request bodies** (`bug17-input-validation`) — `/api/send`,
   `/api/join`, `/api/tasks` and `/api/broadcast` accepted any type for their
   required fields and answered `200`. Three consequences, all silent:
   - **A malformed message killed the hub.** A non-string `content` that
     stringified to something containing an `@mention` (e.g. `["@alice hi"]`)
     reached `message.content.substring()` inside a `db.run` callback. That
     TypeError had nothing to catch it, so it was an uncaught exception and the
     process exited — one bad send from one buggy agent took the whole
     coordination fabric down for every agent.
   - A join with no `agentId` registered an agent under the key `undefined`, so
     every client with the same bug then posted as one shared ghost agent.
   - A task with no `roomName` was stored where `GET /api/tasks/:room` could
     never return it — created, counted in `/api/stats`, listed by nothing.

   All four endpoints now validate up front and return `400` with
   `code: "INVALID_ARGUMENT"` naming the offending field.

2. **Messages emitted but never persisted** (`bug18-unpersisted-messages`) —
   sends and join notices were written to the `messages` table; broadcasts,
   leave notices and file-change events were not. They existed only in the
   in-memory buffer, so they vanished on restart *and* were missing from the
   DB-fallback read path (a `since` reaching past the in-memory horizon queries
   SQLite directly). The result was a hole in the middle of history that reads
   exactly like a quiet period — a caller cannot distinguish "nothing was said"
   from "no record was kept". Additionally, `/api/broadcast` to a room that did
   not yet exist in memory found no buffer, dropped the message entirely, and
   still returned `{success: true, messageId}` for a message that existed
   nowhere. Broadcasts now create the room, all three message kinds are written
   through a single `persistMessage()` helper, the broadcast `200` is gated on
   that write, and leave/file-change events are stamped with `nextTimestamp()`
   so they cannot land behind a poller's cursor.

3. **Empty polls returned no cursor** (`bug19-poll-cursor`) — diagnosed from the
   report *"clients seem to be having a hard time finding new messages
   sometimes"*. The `since` cursor was derived client-side from the messages in
   the returned page, so a page with no messages produced no
   `Next poll: since=...` line at all. An empty page is the **normal** result in
   a normally-paced room, and it is precisely when an agent most needs its
   cursor handed back. Having lost it, the agent fell back to a no-`since` poll,
   which re-reads the whole room tail with no way to tell which messages are
   new — so "sometimes" meant "after any quiet poll". The count-only (`limit:0`)
   path returned no cursor either, so using `limit:0` to check whether anything
   was new lost your place on every check.

   `GET /api/messages/:room` now returns `nextSince` on every read, and the MCP
   client prefers it over deriving its own. It is computed server-side because
   the server owns the clock that stamps messages — a client substituting its
   own `Date.now()` would skip messages whenever its clock ran ahead of the
   hub's. The cursor never advances past messages the caller did not actually
   receive: an empty page echoes the incoming cursor back unchanged, a
   count-only page holds the cursor still, and a count-only page over an unseen
   backlog omits the cursor entirely rather than skipping it. `get_messages`
   also now reports "No new messages" plainly instead of rendering
   `Retrieved 0 messages:` followed by nothing.

   The cursor also respects the in-flight write watermark. Its "start watching
   from now" fallback would otherwise sit *after* a message whose timestamp is
   reserved but whose row has not yet committed, skipping it permanently once
   it landed — the same watermark bug fixed in `bug12`, reachable through a new
   path.

`recordMessage()` no longer drops a message silently when a room buffer is
missing — it logs an error naming the message and room.

### Known issue (pre-existing, not introduced here)

Every room installs its own `chokidar` watcher on the *same* `SHARED_DIR`, so a
single file change produces one message per room — currently 46 rooms, i.e. 46
rows and 46 socket emits per change. This is dormant because `SHARED_DIR` is
empty, but persisting file-change events now makes the amplification hit disk
as well as memory. A single shared watcher fanned out to all rooms would fix it.

### Upgrading

The `nextSince` field is additive and backward compatible — an older client
simply ignores it and falls back to deriving the cursor itself. But the polling
fix only takes effect once **both** sides are updated: `mcp-server.js` runs
inside each agent's own process, so restarting the hub does not update it.
Every agent must restart its MCP connection to pick up the fix.

## [Fork] 2026-06

### Bug fixes

Five coordination bugs fixed, each covered by a dedicated regression test in `test/`:

1. **Room leave** (`bug1-room-leave`) — agents were not reliably removed from the room roster on disconnect; the leave endpoint now atomically removes the agent and broadcasts a presence update.
2. **Cache invalidation** (`bug2-cache-clear`) — stale message-cache entries survived room transitions, causing agents to receive messages from rooms they had already left.
3. **Task persistence** (`bug3-task-persistence`) — tasks created via the API were held only in memory and lost on server restart; tasks are now written to SQLite and reloaded on boot.
4. **CLI routes** (`bug4-cli-routes`) — several CLI orchestrator routes (`/rooms`, `/agents`, `/tasks`) returned 404 due to missing Express registrations.
5. **Task assignment broadcast** (`bug5-task-assigned`) — the `task_assigned` Socket.IO event was emitted before the task was committed, so clients occasionally received the notification before the task was readable via GET.

### New capabilities

- **Automated test suite** — `node --test` suite in `test/`; 39 tests across bugs, auth, transport, and role config. Run with `npm test`.
- **Optional token auth** — shared-secret authentication via `AUTH_TOKEN` env var. REST endpoints check `x-auth-token` header or `Authorization: Bearer <token>`; Socket.IO checks the handshake `auth.token`. Auth is a no-op when `AUTH_TOKEN` is unset (development mode).
- **Pluggable transport adapter** — the `transport/` module defines a `Transport` base class with a 14-method contract. `createTransport()` selects the backend via `SYMPHONY_TRANSPORT`. Ships with `SocketIoHubTransport` (default) and `MatrixTransport` (stub, ready for implementation). See [docs/transports.md](docs/transports.md).
- **Config-loadable roles** (`ROLES_CONFIG`) — agent roles, task templates, and quick assignments are loaded from an external JSON file at startup. Generic Symphony defaults are used when the env var is unset. Any of the three top-level keys can be omitted to fall back to the default for that key. See [docs/configuration.md](docs/configuration.md).
- **Dynamic role categories** — `getCategories()` derives the category list from whichever role set is active (default or custom), so custom rosters can introduce new categories without code changes.
