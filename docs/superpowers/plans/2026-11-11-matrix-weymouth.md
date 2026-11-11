# Matrix rooms through Symphony — implementation plan

Goal: existing agents can list, join, read and send Matrix rooms with their usual
Symphony tools on Weymouth. Spec: docs/transports.md, approved scope November 11.
Baseline: deployed revision 40f79296dda04d66f227727b730f40c851f16b40. GitHub issues
are disabled for this repository; this file is the execution owner. The KB
bootstrap/master plan were consulted; this is user-selected collaboration
infrastructure, not acceptance of a gameplay milestone.

Owner: main agent owns architecture, server integration, deployment and acceptance;
Terra worker owns only matrix-backend.js and test/matrix-backend.test.js; independent
Gemini reviews the integrated change. No automatic coding worker.

- [x] Baseline: run npm test on deployed source; record actual result.
- [x] Add failing Matrix backend and hub-route tests, then implement.
  Consumes: activated Embassy credential inside Weymouth Docker volume.
  Produces: MatrixBackend listRooms/joinRoom/getMessages/sendMessage/sync methods.
  Keep server routing in server.js; preserve existing native-room handlers.
- [x] Run focused tests and existing npm test; inspect the actual diff.
- [x] Independent cross-vendor review of backend, hub routes and existing transport seam (Claude fallback; Gemini unavailable);
  verify and resolve findings before enabling the change.
- [x] Deploy an isolated candidate on Weymouth using its real local container;
  verify authenticated Matrix listing and native-room parity.
- [ ] Activate candidate behind the existing Symphony service, then exercise
  room_join, list_rooms, send_message, get_messages through a fresh MCP client.
  Use a temporary bot-owned room, verify restart/history and clean up membership.
- [ ] Record deployed revision, proof and rollback in this execution record.

Verification commands: npm test; node --test test/matrix-backend.test.js
 test/matrix-hub.test.js. Real integration must use the service's existing auth
without printing tokens, and must not post test messages to other people's rooms.
The existing Embassy container is the credential owner; clients keep their
existing HTTP plus Socket.IO connection. Deployment may use SSH for administration;
normal agent access does not.

## Review and evidence ledger

Baseline npm test: 192 passed. First integrated suite: 196 passed. Real isolated
candidate on Weymouth port 3101 passed MCP list/join/send/history/cursor round-trip
and native-room parity. Actual Matrix sync to Socket.IO preserved the event ID.

Gemini review was attempted with the skill-pinned model (retired), then the
available Gemini 4 Argon High model (account quota exhausted, no verdict). Per
review-ladder fallback, independent Anthropic Sonnet reviewed through the private
normal-account OpenCode launcher. No Gemini approval is claimed; merge remains
subject to the required Gemini gate.

Verified review dispositions: alias mismatch resolved by canonical-only joins and
socket subscription to the registered agent room. Unbounded initial reads bounded;
full-history scans for old ISO windows remain deliberate to avoid skipping
clock-skewed events, and event cursors have no arbitrary 10,000-event cutoff.
Matrix listing failure now preserves native results and exposes warnings; room
name requests are cached/batched. Matrix rooms skip native directory watchers,
and socket relay bypasses cannot inject fake Matrix history. Notifications use
stable event/name IDs and INSERT OR IGNORE; sync retries deduplicate live events,
back off, reload rejected credentials and report limited-stream gaps. Mentions
match the native parser. Retry IDs bind to payload and ambiguous sends return the
retry key. Malformed timestamps are skipped. Canonical modern room IDs work.
Matrix send activity updates the agent heartbeat. History includes edits and
redactions; live edit UI updates remain outside the existing message-tool scope.

Final independent review returned three medium findings, all verified and fixed:
MCP errors now expose Matrix guidance and ambiguous retry keys; Matrix statistics
are explicitly unavailable rather than zero; the remaining non-cursor traversal
cap was removed and empty ISO polls move to an event cursor. The full regression
suite passed after the first review fixes; focused Matrix/MCP tests were rerun
for these final corrections. No high findings remained in the final review.

Final full-suite result: 196 passed, zero failures. Final focused Matrix/MCP result: 32 passed.
