# Room-scoped shared file store

## Decision

Add a hub-hosted file store for small, live collaboration artifacts. Files belong
to a Symphony room, are persisted beside the hub's durable data, and are exposed
through authenticated HTTP endpoints and the existing MCP `file_*` tools.

This replaces the misleading current behaviour in which every MCP client reads
and writes its own local `SHARED_DIR`. It does **not** replace Git for source
code, review, or build artifacts.

## Goals

- Agents in the same room can list, read, write, and delete the same files from
  different machines.
- A human can inspect the same room files through a future room viewer or the
  CLI/API.
- Files are room-scoped, durable across restarts, auditable, bounded in size,
  and safe from path traversal.
- Writes are conflict-aware; a late writer must not silently overwrite a newer
  version.

## Non-goals

- A general network drive or access to the hub host filesystem.
- Large-media hosting, source control, collaborative document editing, or a
  replacement for Git/LFS/object storage.
- Pretending the present single shared bearer token provides per-user security.

## Storage model

Add `FILE_STORE_DIR`, defaulting to `${DATA_DIR}/files`. Production uses a
dedicated hub-managed directory, for example
`/home/jasbahr/symphony-hub-data/files`; it must never point at the repository,
home directory, or an arbitrary client path.

The authoritative content layout is private implementation detail:

```text
FILE_STORE_DIR/
  objects/<opaque-file-id>/v<version>
```

SQLite stores the logical room path, current version, and metadata. Each file
version is immutable, so a failed metadata transaction can leave only an
unreferenced object; it cannot replace bytes served by the prior version. Do
not derive a host path from a client-supplied filename. Logical paths are normalized POSIX relative paths:
no absolute paths, `..`, empty components, NULs, or backslashes. The canonical
identity is `(room_id, logical_path)`.

### SQLite records

`files`: `id`, `room_id`, `logical_path`, `content_type`, `byte_size`, `sha256`,
`version`, `created_at`, `created_by`, `updated_at`, `updated_by`, `deleted_at`.

`file_revisions`: immutable snapshot metadata for every successful write or
delete, including `file_id`, `version`, `sha256`, `byte_size`, `actor_id`,
`timestamp`, and `operation`. Keep the initial release to the current content
plus metadata/history; retain binary revision blobs only when a configurable
retention policy permits it.

`file_audit`: append-only request record: actor, room, operation, path, result,
request id, timestamp, and safe metadata. Never log file bodies or auth tokens.

## Access model

The current hub has one shared bearer token and allows an authenticated caller
to join arbitrary rooms. That is adequate only for a consciously trusted,
single-team pilot; it cannot enforce room privacy. Make that limitation explicit
with `FILES_AUTHZ_MODE=trusted-team` for the first rollout.

Before private rooms or external collaborators use file storage, introduce
individual credentials whose server-side records contain an `actor_id` and room
grants (`read`, `write`, `admin`). Store only credential hashes. Every file
request authorizes its resolved actor against the room grant; client-supplied
agent names and room IDs are never authority. The existing shared token must not
be described as room-level authorization.

## HTTP contract

All routes are under the existing `/api` auth middleware. `:room` uses the
canonical room name/ID already accepted by the hub. JSON errors have stable
codes: `INVALID_PATH`, `ROOM_NOT_FOUND`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`,
and `PAYLOAD_TOO_LARGE`.

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/api/rooms/:room/files?prefix=&cursor=&limit=` | Paginated metadata list; default 100, max 500. |
| `GET` | `/api/rooms/:room/files/*path` | Read metadata and content. Use `Accept: application/json` for UTF-8 text; otherwise stream bytes with headers containing version and SHA-256. |
| `PUT` | `/api/rooms/:room/files/*path` | Create or replace bytes. Require `Content-Type`, limit, and `If-Match: <version>` for replacements. New files use `If-None-Match: *`. |
| `DELETE` | `/api/rooms/:room/files/*path` | Soft-delete, requiring `If-Match: <version>` and an explicit confirmation header/query. |
| `GET` | `/api/rooms/:room/files/*path/revisions` | List safe revision metadata; content restore is deferred. |

For v1, accept UTF-8 text bodies up to 1 MiB and arbitrary bytes up to 10 MiB.
Reject oversized uploads before buffering them; use streaming writes to a
temporary file, hash while streaming, atomically rename after the SQLite
transaction succeeds, and remove abandoned temporary files on boot. Larger
assets belong in Git LFS or object storage and are referenced by URL/manifest.

On a successful mutation, emit Socket.IO `file_changed` to that room with only
metadata (`operation`, `path`, `version`, `sha256`, actor, timestamp). Never
broadcast content.

## MCP behaviour

Add `SYMPHONY_FILE_BACKEND=remote|local`, defaulting to `local` for backwards
compatibility. For external shared work set it to `remote`.

In `remote` mode the existing `file_list`, `file_read`, `file_write`, and
`file_delete` tools call the hub endpoints for the MCP session's joined room.
They do not touch client disk. `file_write` first obtains the current version
when replacing a file and returns a clear conflict result if another writer won.
The tool responses include the path, version, size, and SHA-256 so an agent can
cite the precise artifact it used.

No automatic copying occurs from local `SHARED_DIR`; migration is an explicit
upload command or human decision, avoiding accidental publication of client
scratch files.

## CLI and human surface

Extend the CLI only after the API is complete:

```text
/files [prefix]
/get <path>
/put <local-path> [remote-path]
/pull <remote-path> [local-path]
/rm <path> --confirm
```

The future browser room viewer reads the same list/read endpoints and listens
for `file_changed`; it has no privileged filesystem route.

## Delivery plan

1. Add schema migration, path normalizer, storage service, limits, audit logger,
   and trusted-team authorization gate.
2. Add REST endpoints and Socket.IO metadata events, with unit/integration
   tests.
3. Add remote MCP backend behind the feature flag; leave existing clients on
   local mode.
4. Enable remote mode for `groupmind`, exercise two separate clients, then
   document the workflow and CLI commands.
5. Before exposing private rooms/collaborator file stores, ship per-actor,
   room-granted credentials and disable trusted-team mode for them.

## Acceptance tests

- Two isolated MCP clients in one room see the same new file and `file_changed`
  event; a restart preserves it.
- A file in room A is never listed or readable from room B under a room-granted
  credential.
- `../`, encoded traversal, symlink tricks, oversized bodies, unknown content
  types, and malformed paths are rejected without writes outside `FILE_STORE_DIR`.
- A stale `If-Match` returns `409 CONFLICT`, preserves the newer content, and
  records no false successful audit entry.
- Delete requires current version plus explicit confirmation; deleted content is
  not served by ordinary list/read calls.
- Local-mode MCP clients retain their current behaviour; remote mode touches no
  client filesystem.
