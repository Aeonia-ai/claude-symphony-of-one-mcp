# Transport Adapters

The hub's messaging layer is decoupled from the rest of the server via a transport adapter. This lets the protocol underneath (Socket.IO today, Matrix tomorrow) be swapped without touching MCP tools or business logic.

## The contract

Every transport extends `transport/transport.js` and must implement these 14 methods:

| Method | Description |
|---|---|
| `connect(agentId, room)` | Connect to the hub and join `room`. |
| `disconnect()` | Disconnect and release all resources. |
| `joinRoom(room)` | Join (or re-join) a room after initial connect. |
| `leaveRoom(agentId)` | Leave the current room. |
| `sendMessage(content, metadata)` | Broadcast a message to the current room. |
| `getMessages(room, since, limit)` | Fetch messages from `room`, optionally since an ISO timestamp. |
| `onMessage(cb)` | Register a callback for incoming message events. |
| `onNotification(cb)` | Register a callback for incoming notification events. |
| `createTask(room, task)` | Create a task in `room`. `task` is `{ title, description, assignee, priority, creator }`. |
| `getTasks(room, filter)` | Fetch tasks from `room`. `filter` is `{ status, assignee, priority }`. |
| `updateTask(taskId, patch)` | Apply `patch` to an existing task. |
| `storeMemory(agentId, kv)` | Store a key/value pair for `agentId`. `kv` is `{ key, value, type, expiresIn }`. |
| `retrieveMemory(agentId, query)` | Retrieve memories for `agentId`. `query` is `{ key, type }`. |

All methods are `async` and must either resolve with the expected value or throw.

## Selecting a backend

Set `SYMPHONY_TRANSPORT` before starting the MCP client:

```bash
SYMPHONY_TRANSPORT=hub node mcp-server.js      # default — SocketIoHubTransport
SYMPHONY_TRANSPORT=matrix node mcp-server.js   # MatrixTransport (stub)
```

When `SYMPHONY_TRANSPORT` is unset or set to `hub`, `createTransport()` returns a `SocketIoHubTransport`. The factory reads the env var at call time, so you can override it in tests without reimporting the module.

## Included adapters

### `SocketIoHubTransport` (default)

Talks to `server.js` over HTTP REST + Socket.IO. This is the production-ready adapter.

- REST calls carry `x-auth-token` when `AUTH_TOKEN` is set.
- Real-time events (`message`, `notification`) are delivered via the Socket.IO connection established in `connect()`.

### `MatrixTransport` (stub)

`transport/matrix-transport.js` — extends `Transport` but throws `Error('not implemented')` on every method. It exists as a slot: implement the Matrix Client-Server API calls inside each method to bring up a Matrix backend without changing any upstream code.

## Adding a new transport

1. Create `transport/my-transport.js` extending `Transport`.
2. Implement all 14 contract methods.
3. Add an import and branch in `transport/index.js`:

```js
import MyTransport from './my-transport.js';

export function createTransport(config = {}) {
  const backend = process.env.SYMPHONY_TRANSPORT || 'hub';
  if (backend === 'my')    return new MyTransport(config);
  if (backend === 'matrix') return new MatrixTransport(config);
  return new SocketIoHubTransport(config);
}
```

4. Add a test in `test/transport.test.js` asserting your transport implements all contract methods.

## Matrix rooms through the Weymouth hub — approved scope, 2026-11-11

Jason selected the same Symphony tools for native and Matrix rooms, a shared
Matrix account with named messages, and a central connection on Weymouth.
He explicitly withdrew automatic coding dispatch. Incoming messages are messages;
this integration does not launch models, commands or agents.

Ownership: the existing HTTP/Socket.IO client transport stays in place.
`server.js` routes Matrix-prefixed rooms to `matrix-backend.js`; Matrix owns their
history, membership and event identifiers. Symphony retains agent sessions,
notifications, tasks, memory and room files. The existing client-side
`transport/matrix-transport.js` stub selects an entire backend and includes
non-messaging methods, so filling it would distribute credentials and would not
serve both room types at once. The September substrate decision remains valid;
this adds a room backend instead of replacing Symphony.

The hub loads the existing activated credential from the local Embassy container
without printing it or copying it to client machines. Room names use
`matrix:!room-id:server`; existing native names retain their meaning. Listing
includes joined Matrix rooms. Joining subscribes a Symphony session; leaving does
not remove the shared Matrix account. Outgoing messages show the agent name and
retain structured attribution. History cursors are opaque and room-bound for
Matrix, preserving same-timestamp events. Errors are explicit, never empty success.

The hub uses a durable Matrix sync cursor for real-time delivery; history remains
read-through from Matrix. No second message ledger or automatic coding worker is
introduced. Retry/restart may re-emit an event with the same Matrix event ID;
clients must treat that identity as stable. Sending succeeds only after Matrix
returns its event ID; ambiguous failures must not be blindly retried with a new
transaction ID. Thread relationships and origin information survive normalization.

Component acceptance: focused fake-server tests cover attribution, authorization,
pagination, cursor boundaries, errors and native-room coexistence. Joined
acceptance: use the actual Symphony tool entry point against Weymouth, exchange a
message in a temporary bot-owned Matrix room, read it back, restart Symphony and
read it again, and verify native rooms still work. Test-room cleanup must leave
no automatic dispatcher. Account-per-agent identities and automatic mirroring of
native rooms are outside this change. Rollback: restore the prior Symphony
revision/service configuration; Embassy and native room data remain intact.

Implementation notes: choose the canonical Matrix room ID shown by list_rooms;
alias joins are explicitly rejected. Matrix cursors are opaque strings, unlike
native ISO timestamp cursors. ISO history requests remain supported but can scan
older history; use the returned event cursor for subsequent reads. Initial bounded
history reads mark their match count as a lower bound when applicable. A room
with no visible events has no event cursor yet. Matrix outages return native
room listings plus a warning; updated clients display that warning. Existing
clients can still list, join, send and read canonical Matrix rooms without
configuration changes. Updated client code adds display names, warning rendering,
and optional thread/retry metadata to the same tools. Edits/redactions are reflected
in subsequent Matrix history reads; live edit/redaction UI updates are not added.
