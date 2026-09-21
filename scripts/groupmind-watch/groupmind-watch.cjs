#!/usr/bin/env node
/**
 * groupmind-watch — low-noise hub room watcher.
 *
 * Polls a Symphony hub room on an interval and prints ONLY the messages you
 * care about, one per line. Nothing is printed while the room is quiet, so it
 * is cheap to run under an agent's background-monitor tool (Claude Code's
 * Monitor, a launchd agent, tmux, etc.) — the agent only wakes when a line
 * appears.
 *
 * Usage:
 *   node groupmind-watch.cjs [--room groupmind] [--interval 60]
 *                            [--max-interval 600] [--request-timeout 30]
 *                            [--skip name,name] [--only name,name]
 *                            [--mentions-only] [--since ISO8601] [--debug]
 *
 * Config resolution (first hit wins):
 *   1. CLI flags
 *   2. Environment: CHAT_SERVER_URL, AUTH_TOKEN, AGENT_NAME, SYMPHONY_ROOM
 *   3. The aeonia-hub MCP server's env block in ~/.claude.json
 *
 * Option 3 means you normally need no setup at all: the token is read from the
 * config you already have, never passed on the command line, and never printed.
 *
 * Source: Rob, shared in the groupmind room 2026-09-16.
 */

const fs = require("fs");
const path = require("path");

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

// Find the aeonia-hub MCP server's env block wherever it sits in ~/.claude.json.
function envFromClaudeConfig() {
  const p = path.join(process.env.HOME || "", ".claude.json");
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(p, "utf8")); } catch { return {}; }
  const find = o => {
    if (!o || typeof o !== "object") return null;
    if (o["aeonia-hub"] && o["aeonia-hub"].env) return o["aeonia-hub"].env;
    for (const v of Object.values(o)) { const hit = find(v); if (hit) return hit; }
    return null;
  };
  return find(cfg) || {};
}

const args = parseArgs(process.argv);
const cfgEnv = envFromClaudeConfig();

const url = args.url || process.env.CHAT_SERVER_URL || cfgEnv.CHAT_SERVER_URL;
const token = process.env.AUTH_TOKEN || cfgEnv.AUTH_TOKEN || "";
const me = args.me || process.env.AGENT_NAME || cfgEnv.AGENT_NAME || "";
const room = args.room || process.env.SYMPHONY_ROOM || "groupmind";
// A bad --interval must not become a tight loop or a negative cadence. Zero,
// negative and non-numeric values all fall back to the default rather than being
// trusted: this script's whole purpose is to poll gently.
function seconds(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const baseIntervalMs = seconds(args.interval, 60) * 1000;
// Idle backoff, off unless asked for. When --max-interval is set above
// --interval, an idle room doubles the wait between polls up to that ceiling,
// and ANY traffic drops it straight back to the base interval. The trade is
// explicit: a quiet room costs fewer requests, and the first message after a
// long silence waits up to --max-interval to be seen. Leave it unset and the
// cadence is exactly as before.
const maxIntervalMs = seconds(args["max-interval"], 0) * 1000;
// Every request to the hub gives up after this long. Without it, a connection
// that goes quiet rather than failing — a Wi-Fi blip, the Mac sleeping, the hub
// restarting mid-request — makes fetch wait forever. And because the loop only
// schedules the next poll after the current one returns, one stalled request
// stops the watcher for good while the process still looks perfectly healthy:
// silent, no CPU, no errors — indistinguishable from a quiet room. A timeout
// turns that into an ordinary failed poll, which is already handled.
const requestTimeoutMs = seconds(args["request-timeout"], 30) * 1000;
const backoffEnabled = maxIntervalMs > baseIntervalMs;
let intervalMs = baseIntervalMs;
const mentionsOnly = Boolean(args["mentions-only"]);
const debug = Boolean(args.debug);

const list = v => String(v || "").split(",").map(s => s.trim()).filter(Boolean);
// Default: ignore your own messages and the join/leave notices.
const skip = new Set([...list(args.skip), me, "System"].filter(Boolean));
const only = new Set(list(args.only));

if (!url) {
  console.error("groupmind-watch: no hub URL. Pass --url, set CHAT_SERVER_URL, or configure the aeonia-hub MCP server.");
  process.exit(1);
}

if (debug) {
  console.error(`[groupmind-watch] config: url=${url}, room=${room}, agent=${me || "(unset)"}, interval=${baseIntervalMs / 1000}s, maxInterval=${backoffEnabled ? maxIntervalMs / 1000 + "s" : "(backoff off)"}, skip=[${[...skip].join(",")}], only=[${[...only].join(",")}]`);
}

let since = args.since || new Date().toISOString();
// Only consecutive identical errors are suppressed: two alternating failures
// (a flapping DNS error and an HTTP 502, say) will report on every tick. Left as
// is deliberately — these go to stderr, so the cost is log noise, and a
// genuinely flapping hub is worth seeing.
let lastErrorMsg = "";

const PAGE = 50;

// Returns how many messages the hub handed back, so a full page can be drained
// immediately instead of waiting a whole interval for the remainder.
async function fetchPage() {
  const q = new URLSearchParams({ since, limit: String(PAGE) });
  if (mentionsOnly && me) q.set("mentioning", me);

  if (debug) console.error(`[groupmind-watch] polling since=${since}`);

  const res = await fetch(`${url}/api/messages/${encodeURIComponent(room)}?${q}`, {
    headers: token ? { "x-auth-token": token } : {},
    signal: AbortSignal.timeout(requestTimeoutMs),
  });

  if (res.status === 401 || res.status === 403) {
    // Deliberately stdout, unlike every other diagnostic here. Under a
    // supervising monitor only stdout becomes a notification; stderr lands in a
    // file nobody opens unless they already suspect a problem. A rejected token
    // is permanent, silent, and needs a human — routing it to stderr makes a bad
    // token indistinguishable from a quiet room, which is the one failure this
    // line exists to prevent. A valid token never trips it, so "quiet room, no
    // output" still holds.
    const msg = `hub rejected the auth token (${res.status}). Check AUTH_TOKEN in ~/.claude.json or pass --url with a valid server.`;
    if (lastErrorMsg !== msg) {
      console.log(`[groupmind-watch] ERROR: ${msg}`);
      lastErrorMsg = msg;
    }
    return 0;
  }

  if (!res.ok) {
    const msg = `HTTP ${res.status} from ${url}/api/messages/${room}`;
    if (lastErrorMsg !== msg) {
      console.error(`[groupmind-watch] ERROR: ${msg}`);
      lastErrorMsg = msg;
    }
    return 0;
  }

  lastErrorMsg = "";
  const data = await res.json();
  const messages = data.messages || [];

  if (debug && messages.length > 0) console.error(`[groupmind-watch] got ${messages.length} messages`);

  for (const m of messages) {
    // Advance before filtering: the cursor must pass over skipped messages too,
    // or they are re-fetched forever.
    since = m.timestamp;
    const who = m.agentName;
    if (skip.has(who)) {
      if (debug) console.error(`[groupmind-watch] skipping ${who}: in skip list`);
      continue;
    }
    if (only.size && !only.has(who)) {
      if (debug) console.error(`[groupmind-watch] skipping ${who}: not in only list`);
      continue;
    }
    console.log(`[${m.timestamp}] ${who}: ${m.content}`);
  }

  if (debug && messages.length === 0) console.error(`[groupmind-watch] no new messages`);

  return messages.length;
}

// Returns the number of messages seen, or null if the poll failed. The
// distinction matters: a failed poll must not be read as an idle room, or a
// broken connection would quietly slow its own recovery.
async function poll() {
  let seen = 0;
  let failed = false;
  try {
    // A full page means there may be more behind it. The cursor is exclusive on
    // timestamp, so leaving a burst half-read risks dropping any message that
    // shares a timestamp with the last one seen.
    let drained = 0;
    let page;
    while ((page = await fetchPage()) === PAGE && ++drained < 20) seen += page;
    seen += page;
  } catch (err) {
    const msg = `${err.name}: ${err.message}`;
    if (lastErrorMsg !== msg) {
      console.error(`[groupmind-watch] ERROR: ${msg}`);
      lastErrorMsg = msg;
    }
    // Transient DNS/network blips are common; stay silent and retry next tick.
    failed = true;
  }
  // A failure after traffic is still traffic: report what was seen so the cadence
  // resets. Only a poll that failed having seen nothing is genuinely unknown.
  return failed && seen === 0 ? null : seen;
}

// Any traffic at all resets the cadence, including messages that were filtered
// out. A room full of bot chatter is an active room; sleeping through it would
// mean the next message addressed to us waits out a long idle interval.
function adjustInterval(seen) {
  if (!backoffEnabled) return;
  // A failed poll tells us nothing about whether the room is busy. Hold the
  // current cadence rather than treating the failure as silence.
  if (seen === null) {
    if (debug) console.error(`[groupmind-watch] poll failed; holding interval at ${intervalMs / 1000}s`);
    return;
  }
  const previous = intervalMs;
  intervalMs = seen > 0 ? baseIntervalMs : Math.min(intervalMs * 2, maxIntervalMs);
  if (debug && intervalMs !== previous) {
    console.error(`[groupmind-watch] interval ${previous / 1000}s -> ${intervalMs / 1000}s (${seen > 0 ? "traffic, reset" : "idle, backing off"})`);
  }
}

// Self-scheduling rather than setInterval: a slow or stalled request must not
// overlap with the next tick, or two polls share one cursor and print the same
// messages twice.
async function loop() {
  adjustInterval(await poll());
  setTimeout(loop, intervalMs);
}

console.error(
  `[groupmind-watch] starting: polling ${room} every ${baseIntervalMs / 1000}s` +
  (backoffEnabled ? `, backing off to ${maxIntervalMs / 1000}s while idle` : "")
);
loop();
