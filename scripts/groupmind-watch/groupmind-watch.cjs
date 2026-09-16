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
 *                            [--mentions-only] [--since ISO8601]
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

const list = v => String(v || "").split(",").map(s => s.trim()).filter(Boolean);
// Default: ignore your own messages and the join/leave notices.
const skip = new Set([...list(args.skip), me, "System"].filter(Boolean));
const only = new Set(list(args.only));

if (!url) {
  console.error("groupmind-watch: no hub URL. Pass --url, set CHAT_SERVER_URL, or configure the aeonia-hub MCP server.");
  process.exit(1);
}

let since = args.since || new Date().toISOString();
let quietFailures = 0;

const PAGE = 50;

// Returns how many messages the hub handed back, so a full page can be drained
// immediately instead of waiting a whole interval for the remainder.
async function fetchPage() {
  const q = new URLSearchParams({ since, limit: String(PAGE) });
  if (mentionsOnly && me) q.set("mentioning", me);
  const res = await fetch(`${url}/api/messages/${encodeURIComponent(room)}?${q}`, {
    headers: token ? { "x-auth-token": token } : {},
  });
  if (res.status === 401 || res.status === 403) {
    // Worth surfacing once: a bad token looks like silence otherwise.
    if (quietFailures++ === 0) console.log(`[groupmind-watch] hub rejected the auth token (${res.status}).`);
    return 0;
  }
  if (!res.ok) return 0;
  quietFailures = 0;
  const data = await res.json();
  const messages = data.messages || [];
  for (const m of messages) {
    // Advance before filtering: the cursor must pass over skipped messages too,
    // or they are re-fetched forever.
    since = m.timestamp;
    const who = m.agentName;
    if (skip.has(who)) continue;
    if (only.size && !only.has(who)) continue;
    console.log(`[${m.timestamp}] ${who}: ${m.content}`);
  }
  return messages.length;
}

async function poll() {
  try {
    // A full page means there may be more behind it. The cursor is exclusive on
    // timestamp, so leaving a burst half-read risks dropping any message that
    // shares a timestamp with the last one seen.
    let drained = 0;
    while ((await fetchPage()) === PAGE && ++drained < 20);
  } catch {
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

loop();
