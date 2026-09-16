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
const intervalMs = Number(args.interval || 60) * 1000;
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
  console.error(`[groupmind-watch] config: url=${url}, room=${room}, agent=${me || "(unset)"}, interval=${intervalMs / 1000}s, skip=[${[...skip].join(",")}], only=[${[...only].join(",")}]`);
}

let since = args.since || new Date().toISOString();
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
  });

  if (res.status === 401 || res.status === 403) {
    const msg = `hub rejected the auth token (${res.status}). Check AUTH_TOKEN in ~/.claude.json or pass --url with a valid server.`;
    if (lastErrorMsg !== msg) {
      console.error(`[groupmind-watch] ERROR: ${msg}`);
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

async function poll() {
  try {
    // A full page means there may be more behind it. The cursor is exclusive on
    // timestamp, so leaving a burst half-read risks dropping any message that
    // shares a timestamp with the last one seen.
    let drained = 0;
    while ((await fetchPage()) === PAGE && ++drained < 20);
  } catch (err) {
    const msg = `${err.name}: ${err.message}`;
    if (lastErrorMsg !== msg) {
      console.error(`[groupmind-watch] ERROR: ${msg}`);
      lastErrorMsg = msg;
    }
    // Transient DNS/network blips are common; stay silent and retry next tick.
  }
}

// Self-scheduling rather than setInterval: a slow or stalled request must not
// overlap with the next tick, or two polls share one cursor and print the same
// messages twice.
async function loop() {
  await poll();
  setTimeout(loop, intervalMs);
}

console.error(`[groupmind-watch] starting: polling ${room} every ${intervalMs / 1000}s`);
loop();
