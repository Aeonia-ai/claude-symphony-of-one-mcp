#!/usr/bin/env node
import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";
import { v4 as uuidv4 } from "uuid";
import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import chokidar from "chokidar";
import sqlite3 from "sqlite3";
import winston from "winston";

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

// Socket.IO auth handshake middleware (AUTH_TOKEN resolved after io is created)
// Note: AUTH_TOKEN const is defined below after express.json(); we use
// process.env.AUTH_TOKEN directly here to avoid forward-reference issues.
io.use((socket, next) => {
  const authToken = process.env.AUTH_TOKEN || '';
  if (!authToken) return next();           // open mode
  const token =
    socket.handshake.auth?.token ||
    socket.handshake.headers?.['x-auth-token'] ||
    null;
  if (token === authToken) return next();
  return next(new Error('Unauthorized'));
});

app.use(cors());
// File PUTs need their original bytes, including valid JSON documents. Let the
// route-local raw parser own those bodies; JSON remains the default elsewhere.
app.use(express.json({
  type: (req) => !(
    req.method === "PUT" && /^\/api\/rooms\/[^/]+\/files\//.test(req.originalUrl || req.url)
  ) && Boolean(req.is("application/json")),
}));

// Shared-token auth (gracefully disabled when AUTH_TOKEN is unset)
const AUTH_TOKEN = process.env.AUTH_TOKEN || '';

// REST middleware: guard /api/* routes
app.use('/api', (req, res, next) => {
  if (!AUTH_TOKEN) return next();          // open mode
  const bearer = req.headers['authorization'];
  const xToken = req.headers['x-auth-token'];
  const provided =
    (bearer && bearer.startsWith('Bearer ') ? bearer.slice(7) : null) ||
    xToken ||
    null;
  if (provided === AUTH_TOKEN) return next();
  return res.status(401).json({ success: false, error: 'Unauthorized' });
});

// Configuration
const SHARED_DIR = process.env.SHARED_DIR || path.join(process.cwd(), "shared");
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), "data");
// This is deliberately separate from SHARED_DIR. SHARED_DIR is the legacy
// local-watcher directory; FILE_STORE_DIR is private hub-managed storage.
const FILE_STORE_DIR = process.env.FILE_STORE_DIR || path.join(DATA_DIR, "files");
const FILES_AUTHZ_MODE = process.env.FILES_AUTHZ_MODE || "trusted-team";
const MAX_TEXT_FILE_BYTES = 1024 * 1024;
const MAX_BINARY_FILE_BYTES = 10 * 1024 * 1024;

// Logging setup
const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: "claude-symphony-of-one-hub" },
  transports: [
    new winston.transports.File({
      filename: path.join(DATA_DIR, "error.log"),
      level: "error",
    }),
    new winston.transports.File({
      filename: path.join(DATA_DIR, "combined.log"),
    }),
    new winston.transports.Console({
      format: winston.format.simple(),
    }),
  ],
});

// Database setup
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, "claude-symphony-of-one.db");
const db = new sqlite3.Database(DB_PATH);

// How many recent messages per room to rehydrate into memory on boot.
// Bounded so a long-lived DB doesn't load unboundedly at startup; older
// messages remain in SQLite and are simply not served by /api/messages.
const MESSAGE_HISTORY_LIMIT = parseInt(
  process.env.MESSAGE_HISTORY_LIMIT || "200",
  10
);

// In-memory storage (with database persistence)
const rooms = new Map();
const agents = new Map();
const messages = new Map();
const tasks = new Map();
const fileWatcher = new Map();
const agentMemory = new Map(); // Persistent agent memories
// SQLite uses one connection for this hub. Queue mutations per logical file so
// an optimistic version check and its transaction cannot interleave with a
// second writer for that same file.
const fileMutationTails = new Map();

// Initialize directories and database
async function initializeSystem() {
  try {
    await fs.access(SHARED_DIR);
  } catch {
    await fs.mkdir(SHARED_DIR, { recursive: true });
    logger.info(`Created shared directory: ${SHARED_DIR}`);
  }

  await fs.mkdir(FILE_STORE_DIR, { recursive: true });

  try {
    await fs.access(DATA_DIR);
  } catch {
    await fs.mkdir(DATA_DIR, { recursive: true });
    logger.info(`Created data directory: ${DATA_DIR}`);
  }

  // Schema migrations — run before table creation so columns exist on first boot
  // and are added to existing DBs that predate this column.
  await new Promise((resolve) => {
    db.run("ALTER TABLE notifications ADD COLUMN agent_name TEXT", () => resolve());
  });

  // Initialize database tables — wrapped in a Promise so loadDataFromDatabase
  // only runs after all CREATE TABLE statements have completed.
  await new Promise((resolve, reject) => {
    db.serialize(() => {
      db.run(`CREATE TABLE IF NOT EXISTS rooms (
        id TEXT PRIMARY KEY,
        name TEXT UNIQUE,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        is_active BOOLEAN DEFAULT 1,
        settings TEXT
      )`);

      db.run(`CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        name TEXT,
        room TEXT,
        capabilities TEXT,
        joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_active DATETIME DEFAULT CURRENT_TIMESTAMP,
        status TEXT DEFAULT 'active'
      )`);

      db.run(`CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        room TEXT,
        agent_id TEXT,
        agent_name TEXT,
        content TEXT,
        type TEXT DEFAULT 'message',
        mentions TEXT,
        metadata TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
      )`);

      // Index for the /api/messages DB fallback: `since` windows that reach
      // past the in-memory horizon query the table directly.
      db.run("CREATE INDEX IF NOT EXISTS idx_messages_room_ts ON messages(room, timestamp)");

      db.run(`CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        room TEXT,
        title TEXT,
        description TEXT,
        assignee TEXT,
        creator TEXT,
        priority TEXT DEFAULT 'medium',
        status TEXT DEFAULT 'todo',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`);

      db.run(`CREATE TABLE IF NOT EXISTS agent_memory (
        id TEXT PRIMARY KEY,
        agent_id TEXT,
        room TEXT,
        key TEXT,
        value TEXT,
        type TEXT DEFAULT 'note',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        expires_at DATETIME
      )`);

      db.run(`CREATE TABLE IF NOT EXISTS notifications (
        id TEXT PRIMARY KEY,
        agent_id TEXT,
        agent_name TEXT,
        room TEXT,
        message TEXT,
        type TEXT DEFAULT 'mention',
        is_read BOOLEAN DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`);

      // The logical path is metadata only. Content is kept under an opaque id,
      // so no request path is ever used as a host filesystem path.
      db.run(`CREATE TABLE IF NOT EXISTS files (
        id TEXT PRIMARY KEY,
        room TEXT NOT NULL,
        logical_path TEXT NOT NULL,
        content_type TEXT NOT NULL,
        byte_size INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        version INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        updated_by TEXT NOT NULL,
        deleted_at TEXT,
        UNIQUE(room, logical_path)
      )`);
      db.run(`CREATE TABLE IF NOT EXISTS file_revisions (
        id TEXT PRIMARY KEY,
        file_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        sha256 TEXT,
        byte_size INTEGER,
        actor_id TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        operation TEXT NOT NULL
      )`);
      db.run(`CREATE TABLE IF NOT EXISTS file_audit (
        id TEXT PRIMARY KEY,
        actor_id TEXT NOT NULL,
        room TEXT NOT NULL,
        operation TEXT NOT NULL,
        logical_path TEXT,
        result TEXT NOT NULL,
        request_id TEXT,
        timestamp TEXT NOT NULL,
        metadata TEXT
      )`, (err) => {
        if (err) reject(err); else resolve();
      });
    });
  });

  // Load existing data into memory
  await loadDataFromDatabase();
}

/**
 * Fire-and-forget write that at least reports its own failure.
 *
 * sqlite3's db.run() swallows errors entirely when given no callback — no
 * throw, no log — so a failed INSERT was indistinguishable from a successful
 * one. Use this for writes with no caller waiting on the result (heartbeats,
 * side-effect rows). Writes whose success is REPORTED to a caller should pass
 * an explicit callback and gate the response on it instead.
 *
 * @param {string} sql
 * @param {Array} params
 * @param {string} context  Short label for the log line, e.g. "notification insert"
 */
function dbRun(sql, params, context) {
  db.run(sql, params, function (err) {
    if (err) {
      logger.error(`Database write failed (${context}): ${err.message}`);
    }
  });
}

/**
 * Timestamps double as pagination cursors (`?since=<ts>` with a strict `>`),
 * so two messages sharing a millisecond are indistinguishable: whichever falls
 * on a page boundary is skipped forever. Under concurrent load that is common.
 *
 * Guarantee a strictly increasing timestamp per room so the cursor is exact.
 * Skew is at most a few ms and only under bursts.
 */
const lastIssuedTs = new Map();

function nextTimestamp(room) {
  // Reserve SYNCHRONOUSLY from a counter, not from the last element of the
  // messages array: the array is appended inside the DB write callback, so
  // concurrent sends would all read the same stale tail and collide anyway.
  const now = Date.now();
  const prev = lastIssuedTs.get(room) ?? 0;
  const ts = prev >= now ? prev + 1 : now;
  lastIssuedTs.set(room, ts);
  return new Date(ts).toISOString();
}

/**
 * In-flight write watermark.
 *
 * A timestamp is reserved synchronously, but the message only becomes visible
 * (pushed to the array) when its DB write completes. So a later message can be
 * visible while an earlier-timestamped one is still writing — a reader that
 * advances its cursor to the later one then skips the earlier one forever when
 * it lands. This was the measured ~4% live-poll miss under burst.
 *
 * Track reserved-but-not-yet-settled timestamps per room. Reads refuse to
 * return (and so cannot advance a cursor past) any message at or beyond the
 * oldest in-flight write, until that write settles. Latency cost is a few ms
 * under burst; on failure the timestamp is released immediately.
 */
const pendingTs = new Map(); // room -> Set<ms>

function reservePending(room, iso) {
  const ms = new Date(iso).getTime();
  if (!pendingTs.has(room)) pendingTs.set(room, new Set());
  pendingTs.get(room).add(ms);
  return ms;
}

function releasePending(room, ms) {
  pendingTs.get(room)?.delete(ms);
}

// Highest timestamp (ms) safe to serve: strictly below the oldest in-flight
// write, or Infinity when nothing is pending.
function safeWatermark(room) {
  const set = pendingTs.get(room);
  if (!set || set.size === 0) return Infinity;
  return Math.min(...set) - 1;
}

// Append a message to a room's in-memory buffer AND bound it. Previously
// MESSAGE_HISTORY_LIMIT was applied only at boot, so the buffer grew without
// limit at runtime — a slow memory leak on any long-lived busy room. Trimmed
// messages stay on disk and are served by the /api/messages DB fallback.
function recordMessage(room, message) {
  const arr = messages.get(room);
  if (!arr) {
    // Previously a bare `return` — the message was dropped and the caller
    // still answered {success: true}. /api/broadcast hit this on every room
    // that had not been created yet. Callers must call getRoom() first; if one
    // does not, say so rather than losing the message quietly.
    logger.error(
      `recordMessage: no buffer for room "${room}" — message ${message.id} (${message.type}) dropped. Call getRoom() before recording.`
    );
    return;
  }
  arr.push(message);
  const overflow = arr.length - MESSAGE_HISTORY_LIMIT;
  if (overflow > 0) arr.splice(0, overflow);
}

// How long to keep already-read notifications before pruning (days).
const NOTIFICATION_RETENTION_DAYS = parseInt(
  process.env.NOTIFICATION_RETENTION_DAYS || "14",
  10
);

/**
 * Periodic storage hygiene. Two tables grew without bound:
 *  - agent_memory: expired rows were hidden on read but never deleted.
 *  - notifications: nothing was ever pruned (marking read didn't delete).
 * Unread notifications are NEVER pruned — that is the live signal — only read
 * ones past the retention window, so the backlog shrinks without losing mentions.
 */
function pruneExpiredData() {
  dbRun(
    "DELETE FROM agent_memory WHERE expires_at IS NOT NULL AND expires_at <= datetime('now')",
    [],
    "prune expired memory"
  );
  dbRun(
    `DELETE FROM notifications WHERE is_read = 1 AND created_at < datetime('now', ?)`,
    [`-${NOTIFICATION_RETENTION_DAYS} days`],
    "prune old read notifications"
  );
}

// Tolerate malformed/NULL JSON columns rather than throwing during boot.
function safeJsonParse(value, fallback) {
  if (value === null || value === undefined) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

/**
 * Human-readable type name for validation errors, so a rejected request says
 * what it actually received rather than just "invalid".
 */
function typeName(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/**
 * Validate a required string field.
 *
 * Untyped bodies used to flow straight through: `content` could be an object,
 * `agentId` could be absent. Nothing rejected them, so the row was written with
 * a coerced or NULL value and the caller was told it succeeded. Worse, a
 * non-string `content` carrying an @mention reached
 * `message.content.substring()` inside a db.run callback — a TypeError with no
 * try/catch around it, which is an uncaught exception, which kills the process.
 * One malformed message from one buggy agent took down the whole hub.
 *
 * @returns {string|null} an error message, or null when the value is valid.
 */
function invalidString(value, field, maxLength = 100000) {
  if (typeof value !== "string") {
    return `'${field}' is required and must be a string (received ${typeName(value)}).`;
  }
  if (value.trim() === "") {
    return `'${field}' is required and must not be empty or whitespace-only.`;
  }
  if (value.length > maxLength) {
    return `'${field}' is ${value.length} characters, which exceeds the ${maxLength} character limit.`;
  }
  return null;
}

// Every column of a `messages` row, in insert order.
const MESSAGE_INSERT_SQL =
  "INSERT INTO messages (id, room, agent_id, agent_name, content, type, mentions, metadata, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)";

function messageInsertParams(m) {
  return [
    m.id,
    m.room,
    m.agentId ?? null,
    m.agentName ?? null,
    m.content,
    m.type,
    JSON.stringify(m.mentions || []),
    JSON.stringify(m.metadata || {}),
    m.timestamp,
  ];
}

/**
 * The single place a message row is written.
 *
 * Anything an agent can read back MUST go through here. Broadcasts, leave
 * notices and file-change events were only ever pushed to the in-memory buffer,
 * so they vanished on restart AND were missing from the DB-fallback read path
 * (a `since` reaching past the in-memory horizon). That leaves a hole in the
 * middle of history that reads exactly like a quiet period — the caller has no
 * way to tell "nothing was said" from "the record was never kept".
 */
function persistMessage(m, cb) {
  db.run(MESSAGE_INSERT_SQL, messageInsertParams(m), cb);
}

// Same write, for messages with no caller waiting on the result.
function persistMessageAsync(m, context) {
  dbRun(MESSAGE_INSERT_SQL, messageInsertParams(m), context);
}

// Map a `messages` DB row to the in-memory message shape used by
// /api/messages and the socket 'message' event.
function rowToMessage(row) {
  return {
    id: row.id,
    type: row.type || "message",
    agentId: row.agent_id,
    agentName: row.agent_name,
    content: row.content,
    mentions: safeJsonParse(row.mentions, []),
    metadata: safeJsonParse(row.metadata, {}),
    timestamp: row.timestamp,
    room: row.room,
  };
}

/**
 * Rehydrate recent message history from SQLite into the in-memory Map.
 *
 * Messages were previously persisted but never read back, so every restart
 * left /api/messages blind to history that was sitting on disk — and a
 * `since` query spanning a restart returned a truthful-looking empty result.
 */
function loadMessagesForRooms(roomNames) {
  return Promise.all(
    roomNames.map(
      (name) =>
        new Promise((resolve) => {
          db.all(
            "SELECT * FROM messages WHERE room = ? ORDER BY timestamp DESC LIMIT ?",
            [name, MESSAGE_HISTORY_LIMIT],
            (err, rows) => {
              if (err) {
                logger.error(`Failed to load messages for room ${name}:`, err);
                return resolve(0); // leave the [] initializer in place
              }
              // Rows come back newest-first; stored order is chronological
              // ascending, which /api/messages' slice(-limit) depends on.
              const loaded = rows.reverse().map(rowToMessage);
              messages.set(name, loaded);
              // Seed the cursor counter so timestamps stay strictly increasing
              // across a restart, not just within one process lifetime.
              const newest = loaded.at(-1)?.timestamp;
              if (newest) {
                const ms = new Date(newest).getTime();
                if (Number.isFinite(ms)) lastIssuedTs.set(name, ms);
              }
              resolve(rows.length);
            }
          );
        })
    )
  );
}

// Load data from database into memory maps
async function loadDataFromDatabase() {
  return new Promise((resolve, reject) => {
    db.all("SELECT * FROM rooms WHERE is_active = 1", (err, rows) => {
      if (err) {
        logger.error("Failed to load rooms from database:", err);
        return reject(err);
      }

      rows.forEach((row) => {
        rooms.set(row.name, {
          name: row.name,
          agents: new Set(),
          createdAt: row.created_at,
          isActive: row.is_active === 1,
          settings: row.settings ? JSON.parse(row.settings) : {},
        });
        messages.set(row.name, []);
      });

      logger.info(`Loaded ${rows.length} rooms from database`);

      // Bug 3 fix: also load tasks from DB into the tasks Map
      db.all("SELECT * FROM tasks", (taskErr, taskRows) => {
        if (taskErr) {
          logger.error("Failed to load tasks from database:", taskErr);
          // Non-fatal — resolve anyway so the server still starts
          return resolve();
        }
        taskRows.forEach((row) => {
          tasks.set(row.id, {
            id: row.id,
            room: row.room,
            title: row.title,
            description: row.description,
            assignee: row.assignee,
            creator: row.creator,
            priority: row.priority,
            status: row.status,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
          });
        });
        logger.info(`Loaded ${taskRows.length} tasks from database`);

        // Rehydrate agents. Without this every agent is unknown after a
        // restart and /api/send answers 404 "Agent not found" until it
        // happens to re-join — so a deploy silently muted the whole room.
        // socketId is intentionally null: the old socket is gone, so
        // real-time pushes are skipped until the agent reconnects, but
        // REST sends work immediately.
        db.all("SELECT * FROM agents", (agentErr, agentRows) => {
          if (agentErr) {
            logger.error("Failed to load agents from database:", agentErr);
          } else {
            // Keep only the newest record per (name, room). Agents regenerate
            // their id every session and old rows were never reaped, so a busy
            // deployment accumulated stale duplicates that inflated presence and
            // could misdirect mention classification. Newest-by-last_active wins;
            // the rest are deleted here so the backlog clears on this boot rather
            // than only as agents happen to rejoin.
            const byKey = new Map();
            for (const row of agentRows) {
              const key = `${(row.name || "").toLowerCase()} ${row.room}`;
              const prev = byKey.get(key);
              if (!prev || (row.last_active || "") > (prev.last_active || "")) {
                if (prev) dbRun("DELETE FROM agents WHERE id = ?", [prev.id], `dedupe stale agent ${prev.id}`);
                byKey.set(key, row);
              } else {
                dbRun("DELETE FROM agents WHERE id = ?", [row.id], `dedupe stale agent ${row.id}`);
              }
            }
            for (const row of byKey.values()) {
              agents.set(row.id, {
                id: row.id,
                name: row.name,
                room: row.room,
                capabilities: safeJsonParse(row.capabilities, {}),
                joinedAt: row.joined_at,
                lastActive: row.last_active,
                status: row.status || "active",
                socketId: null,
              });
              const room = rooms.get(row.room);
              if (room) room.agents.add(row.id);
            }
            const dropped = agentRows.length - byKey.size;
            logger.info(
              `Loaded ${byKey.size} agents from database` +
                (dropped > 0 ? ` (dropped ${dropped} stale duplicate rows)` : "")
            );
          }
        });

        // Rehydrate message history so /api/messages survives a restart.
        loadMessagesForRooms(rows.map((r) => r.name))
          .then((counts) => {
            const total = counts.reduce((a, b) => a + b, 0);
            logger.info(
              `Loaded ${total} messages from database across ${rows.length} rooms (limit ${MESSAGE_HISTORY_LIMIT}/room)`
            );
            resolve();
          })
          .catch((msgErr) => {
            logger.error("Failed to load message history:", msgErr);
            resolve(); // non-fatal — server still starts
          });
      });
    });
  });
}

/**
 * Parse @mentions from message content.
 *
 * Separators (`-`, `.`, `_`) are allowed INSIDE a name but never at the end,
 * so "@agent.with.dots" resolves fully while "@agent." at the end of a
 * sentence yields "agent" rather than "agent.". The previous pattern
 * (/@(\w+(?:-\w+)*)/) stopped at the first dot, silently targeting the wrong
 * agent.
 *
 * Results are deduplicated case-insensitively: mentioning the same agent twice
 * in one message previously created two notification rows for one event.
 * The first spelling encountered is preserved.
 */
function parseMentions(content) {
  const mentionRegex = /@([A-Za-z0-9_]+(?:[.\-][A-Za-z0-9_]+)*)/g;
  const mentions = [];
  const seen = new Set();
  let match;

  while ((match = mentionRegex.exec(content)) !== null) {
    const name = match[1];
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    mentions.push(name);
  }

  return mentions;
}

// Create notifications for mentioned agents
async function createNotifications(message, mentions) {
  // String() defensively: /api/send now rejects non-string content, but this
  // helper is reachable from other call sites and a TypeError here lands in a
  // db.run callback with nothing to catch it — i.e. it kills the process.
  const preview = String(message.content ?? "").substring(0, 100);
  const notifications = mentions.map((mentionedName) => {
    const agent = findAgentByName(mentionedName);
    return {
      id: uuidv4(),
      agent_id: agent?.id || null,
      agent_name: mentionedName,
      room: message.room,
      message: `${message.agentName} mentioned you: ${preview}...`,
      type: "mention",
      created_at: new Date().toISOString(),
    };
  });
  // Persist all notifications — even for agents not currently online.
  // Agents joining later will fetch by name from the server.
  notifications.forEach((notification) => {
    dbRun(
      "INSERT INTO notifications (id, agent_id, agent_name, room, message, type, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [
        notification.id,
        notification.agent_id,
        notification.agent_name,
        notification.room,
        notification.message,
        notification.type,
        notification.created_at,
      ],
      `notification insert for ${notification.agent_name}`
    );

    // Also push real-time if agent is currently connected
    if (notification.agent_id) {
      const agent = agents.get(notification.agent_id);
      if (agent && agent.socketId) {
        io.to(agent.socketId).emit("notification", notification);
      }
    }
  });

  return notifications;
}

// Find agent by name — case-insensitive
function findAgentByName(agentName) {
  const lower = agentName.toLowerCase();
  for (const agent of agents.values()) {
    if (agent.name.toLowerCase() === lower) {
      return agent;
    }
  }
  return null;
}

// All agent records matching a name. An agent that has joined several rooms has
// one record per room, so mention classification must consider ALL of them —
// findAgentByName returns whichever comes first in Map order, which could be a
// different room and wrongly reads as "not in this room".
function findAgentsByName(agentName) {
  const lower = agentName.toLowerCase();
  return Array.from(agents.values()).filter(
    (a) => a.name.toLowerCase() === lower
  );
}

// Classify a mention against the sender's room: notified (a match IS in this
// room), elsewhere (real agent, but only in other rooms), or unknown (no such
// agent anywhere — almost always a typo).
function classifyMention(name, room) {
  const matches = findAgentsByName(name);
  if (!matches.length) return { kind: "unknown", name };
  if (matches.some((a) => a.room === room)) return { kind: "notified", name };
  const rooms = [...new Set(matches.map((a) => a.room))];
  return { kind: "elsewhere", name, rooms };
}

// A record is "live" if it acted within this window. Reaping only removes
// STALE duplicates so a new join never silently evicts a session that is still
// polling under a different id — that would drop a live agent, discoverable
// only when its next call 404s.
const LIVE_AGENT_WINDOW_MS = parseInt(
  process.env.LIVE_AGENT_WINDOW_MS || String(2 * 60 * 1000),
  10
);

function isLiveAgent(a) {
  if (!a.lastActive) return false;
  const t = new Date(a.lastActive).getTime();
  return Number.isFinite(t) && Date.now() - t < LIVE_AGENT_WINDOW_MS;
}

// Drop STALE prior records for the same (name, room) held under a different
// agent id. Agents regenerate their id every session, so without this each
// rejoin leaves a dead "active" row, inflating presence and corrupting mention
// classification. A record that acted in the last couple of minutes is left
// alone — evicting a live session is worse than an extra presence row.
function reapDuplicateAgents(keepId, name, room) {
  const lower = name.toLowerCase();
  for (const [id, a] of agents) {
    if (
      id !== keepId &&
      a.room === room &&
      a.name.toLowerCase() === lower &&
      !isLiveAgent(a)
    ) {
      agents.delete(id);
      const r = rooms.get(room);
      if (r) r.agents.delete(id);
      dbRun("DELETE FROM agents WHERE id = ?", [id], `reap stale agent ${id}`);
    }
  }
}

// Setup file watcher for a room
function setupFileWatcher(roomName) {
  if (fileWatcher.has(roomName)) return;

  const watcher = chokidar.watch(SHARED_DIR, {
    ignored: /[\/\\]\./,
    persistent: true,
  });

  // File-change events are messages like any other: they appear in the room
  // stream, so they must be written to the same table. Previously they lived
  // only in the in-memory buffer, which left the same hole as broadcasts —
  // present in a normal read, missing from the DB-fallback read and after a
  // restart. nextTimestamp keeps them on the room's cursor sequence so a
  // poller cannot have already moved past them.
  const emitFileChange = (action, verb, filePath) => {
    const relativePath = path.relative(SHARED_DIR, filePath);
    const message = {
      id: uuidv4(),
      type: "file_change",
      agentId: null,
      agentName: "System",
      content: `File ${verb}: ${relativePath}`,
      mentions: [],
      metadata: { filePath: relativePath, action },
      timestamp: nextTimestamp(roomName),
      room: roomName,
    };

    recordMessage(roomName, message);
    persistMessageAsync(message, `file_change ${action} in ${roomName}`);
    io.to(roomName).emit("message", message);
  };

  watcher.on("change", (f) => emitFileChange("change", "modified", f));
  watcher.on("add", (f) => emitFileChange("add", "created", f));
  watcher.on("unlink", (f) => emitFileChange("delete", "deleted", f));

  fileWatcher.set(roomName, watcher);
}

// Room management
function getRoom(roomName) {
  if (!rooms.has(roomName)) {
    const room = {
      name: roomName,
      agents: new Set(),
      createdAt: new Date().toISOString(),
      isActive: true,
      settings: {},
    };
    rooms.set(roomName, room);
    messages.set(roomName, []);
    setupFileWatcher(roomName);

    // Persist to database
    dbRun(
      "INSERT OR REPLACE INTO rooms (id, name, created_at, is_active, settings) VALUES (?, ?, ?, ?, ?)",
      [uuidv4(), roomName, room.createdAt, 1, JSON.stringify(room.settings)],
      `room upsert ${roomName}`
    );

    logger.info(`Created new room: ${roomName}`);
  }
  return rooms.get(roomName);
}

// ---- Hub-managed, room-scoped file store ---------------------------------
// Kept here rather than in the legacy chokidar watcher: these files are shared
// through the hub API and must never become arbitrary host filesystem access.
function fileError(res, status, code, error) {
  return res.status(status).json({ success: false, code, error });
}

function normalizeLogicalPath(value) {
  if (typeof value !== "string" || !value || value.includes("\0") || value.includes("\\")) return null;
  const parts = value.split("/");
  if (!parts.length || parts.some((p) => !p || p === "." || p === "..")) return null;
  return parts.join("/");
}

function actorForFileRequest(req) {
  // The shared token can identify only the trusted team. An agent name may be
  // recorded for audit visibility, but is not an authorization claim.
  return String(req.headers["x-symphony-actor"] || req.headers["x-agent-name"] || "trusted-team").slice(0, 200);
}

function fileContentPath(fileId, version) {
  // Both values are server-generated. Each version is immutable, so an
  // unsuccessful metadata transaction can leave at most an unreferenced file,
  // never replace the bytes referenced by the previous version.
  return path.join(FILE_STORE_DIR, "objects", fileId, `v${version}`);
}

async function withFileMutation(room, logicalPath, operation) {
  const key = JSON.stringify([room, logicalPath]);
  const previous = fileMutationTails.get(key) || Promise.resolve();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const tail = previous.catch(() => {}).then(() => gate);
  fileMutationTails.set(key, tail);
  await previous.catch(() => {});
  try { return await operation(); }
  finally {
    release();
    if (fileMutationTails.get(key) === tail) fileMutationTails.delete(key);
  }
}

function dbGet(sql, params) {
  return new Promise((resolve, reject) => db.get(sql, params, (err, row) => err ? reject(err) : resolve(row)));
}
function dbAll(sql, params) {
  return new Promise((resolve, reject) => db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows)));
}
function dbRunAsync(sql, params) {
  return new Promise((resolve, reject) => db.run(sql, params, function (err) { err ? reject(err) : resolve(this); }));
}
function publicFile(row) {
  return {
    path: row.logical_path, contentType: row.content_type, byteSize: row.byte_size,
    sha256: row.sha256, version: row.version, createdAt: row.created_at,
    createdBy: row.created_by, updatedAt: row.updated_at, updatedBy: row.updated_by,
  };
}
async function auditFile(actor, room, operation, logicalPath, result, req, metadata = {}) {
  try {
    await dbRunAsync(
      "INSERT INTO file_audit (id, actor_id, room, operation, logical_path, result, request_id, timestamp, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [uuidv4(), actor, room, operation, logicalPath, result, String(req.headers["x-request-id"] || "").slice(0, 200), new Date().toISOString(), JSON.stringify(metadata)]
    );
  } catch (err) { logger.error(`Failed to audit file operation: ${err.message}`); }
}
function requireFileRoom(req, res) {
  if (FILES_AUTHZ_MODE !== "trusted-team") {
    fileError(res, 403, "FORBIDDEN", "File authorization mode is not configured");
    return null;
  }
  const room = rooms.get(req.params.room);
  if (!room) {
    fileError(res, 404, "ROOM_NOT_FOUND", "Room not found");
    return null;
  }
  return room;
}
function emitFileChange(room, operation, row, actor) {
  io.to(room).emit("file_changed", {
    operation, path: row.logical_path, version: row.version, sha256: row.sha256,
    byteSize: row.byte_size, actor, timestamp: new Date().toISOString(),
  });
}

// Capability advertisement. Clients ask the hub what it supports rather than
// each operator hand-setting a matching flag; a hub that lacks this endpoint is
// treated as an older hub with no room file store.
app.get("/api/capabilities", (req, res) => {
  res.json({
    protocolVersion: 1,
    capabilities: {
      roomFileStore: {
        enabled: true,
        maxTextBytes: MAX_TEXT_FILE_BYTES,
        maxBinaryBytes: MAX_BINARY_FILE_BYTES,
        authzMode: FILES_AUTHZ_MODE,
      },
    },
  });
});

app.get("/api/rooms/:room/files", async (req, res) => {
  if (!requireFileRoom(req, res)) return;
  const prefix = req.query.prefix === undefined ? "" : normalizeLogicalPath(String(req.query.prefix).replace(/\/$/, ""));
  if (prefix === null) return fileError(res, 400, "INVALID_PATH", "Invalid file path prefix");
  const requested = Number.parseInt(req.query.limit || "100", 10);
  const limit = Math.min(Math.max(Number.isFinite(requested) ? requested : 100, 1), 500);
  const cursor = String(req.query.cursor || "");
  try {
    const rows = await dbAll(
      "SELECT * FROM files WHERE room = ? AND deleted_at IS NULL AND logical_path LIKE ? AND logical_path > ? ORDER BY logical_path LIMIT ?",
      [req.params.room, `${prefix}${prefix ? "/" : ""}%`, cursor, limit + 1]
    );
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit).map(publicFile);
    res.json({ files: page, returned: page.length, hasMore, ...(hasMore ? { nextCursor: page.at(-1).path } : {}) });
  } catch (err) { logger.error(`File list failed: ${err.message}`); fileError(res, 500, "INTERNAL_ERROR", "File list failed"); }
});

app.get("/api/rooms/:room/files/*/revisions", async (req, res) => {
  if (!requireFileRoom(req, res)) return;
  const logicalPath = normalizeLogicalPath(req.params[0]);
  if (!logicalPath) return fileError(res, 400, "INVALID_PATH", "Invalid file path");
  try {
    const file = await dbGet("SELECT * FROM files WHERE room = ? AND logical_path = ?", [req.params.room, logicalPath]);
    if (!file) return fileError(res, 404, "NOT_FOUND", "File not found");
    const revisions = await dbAll("SELECT version, sha256, byte_size AS byteSize, actor_id AS actorId, timestamp, operation FROM file_revisions WHERE file_id = ? ORDER BY version DESC", [file.id]);
    res.json({ path: logicalPath, revisions });
  } catch (err) { logger.error(`File revisions failed: ${err.message}`); fileError(res, 500, "INTERNAL_ERROR", "File revisions failed"); }
});

app.get("/api/rooms/:room/files/*", async (req, res) => {
  if (!requireFileRoom(req, res)) return;
  const logicalPath = normalizeLogicalPath(req.params[0]);
  if (!logicalPath) return fileError(res, 400, "INVALID_PATH", "Invalid file path");
  try {
    const file = await dbGet("SELECT * FROM files WHERE room = ? AND logical_path = ? AND deleted_at IS NULL", [req.params.room, logicalPath]);
    if (!file) return fileError(res, 404, "NOT_FOUND", "File not found");
    const content = await fs.readFile(fileContentPath(file.id, file.version));
    const metadata = publicFile(file);
    // JSON is opt-in. A normal/no Accept header should stream bytes, not make
    // a binary download unexpectedly negotiate to JSON through `*/*`.
    if (String(req.headers.accept || "").split(",").some((value) => value.trim().startsWith("application/json"))) {
      if (!file.content_type.startsWith("text/") && file.content_type !== "application/json") return fileError(res, 406, "NOT_ACCEPTABLE", "JSON reads are available for text files only");
      return res.json({ ...metadata, content: content.toString("utf8") });
    }
    res.set({ "Content-Type": file.content_type, "Content-Length": String(content.length), "ETag": `\"${file.version}\"`, "X-Symphony-Version": String(file.version), "X-Symphony-SHA256": file.sha256 });
    res.send(content);
  } catch (err) { logger.error(`File read failed: ${err.message}`); fileError(res, 500, "INTERNAL_ERROR", "File read failed"); }
});

app.put("/api/rooms/:room/files/*", express.raw({ type: "*/*", limit: MAX_BINARY_FILE_BYTES }), async (req, res) => {
  if (!requireFileRoom(req, res)) return;
  const logicalPath = normalizeLogicalPath(req.params[0]);
  if (!logicalPath) return fileError(res, 400, "INVALID_PATH", "Invalid file path");
  const contentType = String(req.headers["content-type"] || "").split(";", 1)[0].trim().toLowerCase();
  if (!contentType) return fileError(res, 400, "INVALID_ARGUMENT", "Content-Type is required");
  const body = Buffer.isBuffer(req.body) ? req.body : Buffer.from("");
  const maxBytes = contentType.startsWith("text/") || contentType === "application/json" ? MAX_TEXT_FILE_BYTES : MAX_BINARY_FILE_BYTES;
  if (body.length > maxBytes) return fileError(res, 413, "PAYLOAD_TOO_LARGE", "File exceeds the allowed size");
  const actor = actorForFileRequest(req);
  return withFileMutation(req.params.room, logicalPath, async () => {
    let transactionOpen = false;
    try {
    // Acquire the write lock before looking up the version. Two simultaneous
    // writers therefore cannot both decide that version N is current.
    await dbRunAsync("BEGIN IMMEDIATE", []);
    transactionOpen = true;
    const existing = await dbGet("SELECT * FROM files WHERE room = ? AND logical_path = ?", [req.params.room, logicalPath]);
    const ifMatch = req.headers["if-match"];
    if (existing && existing.deleted_at === null && String(ifMatch || "").replaceAll('"', "") !== String(existing.version)) {
      await dbRunAsync("ROLLBACK", []);
      transactionOpen = false;
      await auditFile(actor, req.params.room, "write", logicalPath, "conflict", req, { expectedVersion: existing.version });
      return fileError(res, 409, "CONFLICT", "File has changed; fetch its current version before replacing it");
    }
    if (!existing && req.headers["if-none-match"] !== "*") {
      await dbRunAsync("ROLLBACK", []);
      transactionOpen = false;
      return fileError(res, 409, "CONFLICT", "New files require If-None-Match: *");
    }
    const id = existing?.id || uuidv4();
    const version = (existing?.version || 0) + 1;
    const now = new Date().toISOString();
    const sha256 = crypto.createHash("sha256").update(body).digest("hex");
    const target = fileContentPath(id, version);
    await fs.mkdir(path.dirname(target), { recursive: true });
    const temp = `${target}.${uuidv4()}.tmp`;
    await fs.writeFile(temp, body, { flag: "wx" });
    await fs.rename(temp, target);
    try {
      if (existing) await dbRunAsync("UPDATE files SET content_type=?, byte_size=?, sha256=?, version=?, updated_at=?, updated_by=?, deleted_at=NULL WHERE id=?", [contentType, body.length, sha256, version, now, actor, id]);
      else await dbRunAsync("INSERT INTO files (id,room,logical_path,content_type,byte_size,sha256,version,created_at,created_by,updated_at,updated_by,deleted_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,NULL)", [id, req.params.room, logicalPath, contentType, body.length, sha256, version, now, actor, now, actor]);
      await dbRunAsync("INSERT INTO file_revisions (id,file_id,version,sha256,byte_size,actor_id,timestamp,operation) VALUES (?,?,?,?,?,?,?,?)", [uuidv4(), id, version, sha256, body.length, actor, now, existing ? "write" : "create"]);
      await dbRunAsync("COMMIT", []);
      transactionOpen = false;
    } catch (error) {
      try { await dbRunAsync("ROLLBACK", []); } catch {}
      transactionOpen = false;
      throw error;
    }
    const row = await dbGet("SELECT * FROM files WHERE id=?", [id]);
    await auditFile(actor, req.params.room, existing ? "write" : "create", logicalPath, "success", req, { version, byteSize: body.length, sha256 });
    emitFileChange(req.params.room, existing ? "write" : "create", row, actor);
    res.status(existing ? 200 : 201).set("ETag", `\"${version}\"`).json({ success: true, file: publicFile(row) });
    } catch (err) {
      if (transactionOpen) { try { await dbRunAsync("ROLLBACK", []); } catch {} }
      logger.error(`File write failed: ${err.message}`); await auditFile(actor, req.params.room, "write", logicalPath, "error", req); return fileError(res, 500, "INTERNAL_ERROR", "File write failed");
    }
  });
});

app.delete("/api/rooms/:room/files/*", async (req, res) => {
  if (!requireFileRoom(req, res)) return;
  const logicalPath = normalizeLogicalPath(req.params[0]);
  if (!logicalPath) return fileError(res, 400, "INVALID_PATH", "Invalid file path");
  if (req.headers["x-confirm-delete"] !== "true") return fileError(res, 400, "INVALID_ARGUMENT", "Deletion requires X-Confirm-Delete: true");
  const actor = actorForFileRequest(req);
  return withFileMutation(req.params.room, logicalPath, async () => {
    let transactionOpen = false;
    try {
    await dbRunAsync("BEGIN IMMEDIATE", []);
    transactionOpen = true;
    const file = await dbGet("SELECT * FROM files WHERE room = ? AND logical_path = ? AND deleted_at IS NULL", [req.params.room, logicalPath]);
    if (!file) {
      await dbRunAsync("ROLLBACK", []);
      transactionOpen = false;
      return fileError(res, 404, "NOT_FOUND", "File not found");
    }
    if (String(req.headers["if-match"] || "").replaceAll('"', "") !== String(file.version)) {
      await dbRunAsync("ROLLBACK", []);
      transactionOpen = false;
      return fileError(res, 409, "CONFLICT", "File has changed; fetch its current version before deleting it");
    }
    const now = new Date().toISOString(), version = file.version + 1;
    await dbRunAsync("UPDATE files SET version=?, updated_at=?, updated_by=?, deleted_at=? WHERE id=?", [version, now, actor, now, file.id]);
    await dbRunAsync("INSERT INTO file_revisions (id,file_id,version,sha256,byte_size,actor_id,timestamp,operation) VALUES (?,?,?,?,?,?,?,?)", [uuidv4(), file.id, version, file.sha256, file.byte_size, actor, now, "delete"]);
    await dbRunAsync("COMMIT", []);
    transactionOpen = false;
    const row = { ...file, version, updated_at: now, updated_by: actor };
    await auditFile(actor, req.params.room, "delete", logicalPath, "success", req, { version });
    emitFileChange(req.params.room, "delete", row, actor);
    res.json({ success: true, file: publicFile(row) });
    } catch (err) {
      if (transactionOpen) { try { await dbRunAsync("ROLLBACK", []); } catch {} }
      logger.error(`File delete failed: ${err.message}`); return fileError(res, 500, "INTERNAL_ERROR", "File delete failed");
    }
  });
});

// HTTP API Endpoints
app.post("/api/join/:room", (req, res) => {
  const { room: roomName } = req.params;
  const { agentId, agentName, capabilities = {} } = req.body;

  // Reject a join that cannot produce a usable agent record. Without this an
  // absent agentId registered an agent under the key `undefined` and answered
  // 200, so the caller believed it had joined; every later /api/send from a
  // client with the same bug then posted as that one shared ghost agent.
  const idError = invalidString(agentId, "agentId", 200);
  const nameError = invalidString(agentName, "agentName", 200);
  if (idError || nameError) {
    return res.status(400).json({
      success: false,
      error: idError || nameError,
      code: "INVALID_ARGUMENT",
    });
  }

  // Is this name ALREADY in the room? If so this is a re-join (agents get a
  // fresh id every session), not a genuine arrival, and we suppress the
  // "has joined" announcement. Autonomous workers re-join every cycle and
  // never leave, so without this those notices were the single largest source
  // of room noise — 41% of messages in one active room. Check BEFORE mutating.
  const isRejoin = findAgentsByName(agentName).some((a) => a.room === roomName);

  const room = getRoom(roomName);
  room.agents.add(agentId);

  const agent = {
    id: agentId,
    name: agentName,
    room: roomName,
    capabilities,
    joinedAt: new Date().toISOString(),
    lastActive: new Date().toISOString(),
    socketId: null,
    status: "active",
  };

  agents.set(agentId, agent);

  // Remove stale records for this same (name, room) under old session ids.
  reapDuplicateAgents(agentId, agentName, roomName);

  // Persist agent to database
  dbRun(
    "INSERT OR REPLACE INTO agents (id, name, room, capabilities, joined_at, last_active, status) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [
      agentId,
      agentName,
      roomName,
      JSON.stringify(capabilities),
      agent.joinedAt,
      agent.lastActive,
      agent.status,
    ],
    `agent upsert ${agentName}`
  );

  // Announce only genuine first arrivals, not every session re-join.
  if (!isRejoin) {
    const joinMessage = {
      id: uuidv4(),
      type: "system",
      agentId: null,
      agentName: "System",
      content: `${agentName} has joined the room`,
      timestamp: nextTimestamp(roomName),
      room: roomName,
      mentions: [],
      metadata: { type: "join" },
    };

    recordMessage(roomName, joinMessage);
    persistMessageAsync(joinMessage, `join message for ${roomName}`);
    io.to(roomName).emit("message", joinMessage);
  }

  logger.info(
    `Agent ${agentName} (${agentId}) ${isRejoin ? "re-joined" : "joined"} room ${roomName}`
  );

  res.json({
    success: true,
    roomName,
    agentId,
    currentAgents: Array.from(room.agents).map((id) => agents.get(id)),
  });
});

app.post("/api/leave/:agentId", (req, res) => {
  const { agentId } = req.params;
  const agent = agents.get(agentId);

  if (!agent) {
    return res.status(404).json({ success: false, error: "Agent not registered — your session may have been replaced by a newer one or cleared on a restart. Call room_join to re-register, then retry.", code: "AGENT_NOT_REGISTERED" });
  }

  const room = rooms.get(agent.room);
  if (room) {
    room.agents.delete(agentId);

    const leaveMessage = {
      id: uuidv4(),
      type: "system",
      agentId: null,
      agentName: "System",
      content: `${agent.name} has left the room`,
      mentions: [],
      metadata: { type: "leave" },
      // nextTimestamp, not wall-clock: under burst the room's cursor counter
      // can already be ahead of Date.now(), and a leave notice stamped behind
      // a poller's cursor is never delivered to it.
      timestamp: nextTimestamp(agent.room),
      room: agent.room,
    };

    recordMessage(agent.room, leaveMessage);
    // Join notices were persisted and leave notices were not, so after a
    // restart every departure had been erased and the room read as though
    // those agents were still present.
    persistMessageAsync(leaveMessage, `leave message for ${agent.room}`);
    io.to(agent.room).emit("message", leaveMessage);
  }

  agents.delete(agentId);
  // Delete the DB row too — leaving it behind meant a restart rehydrated the
  // departed agent as active, so presence and mention classification saw
  // agents who had left.
  dbRun("DELETE FROM agents WHERE id = ?", [agentId], `leave ${agentId}`);
  res.json({ success: true });
});

app.post("/api/send", (req, res) => {
  const { agentId, content, metadata = {} } = req.body;

  // Validate BEFORE any lookup or write. A non-string `content` used to be
  // accepted, stored coerced, and — if it stringified to something containing
  // an @mention — thrown a TypeError inside a db.run callback, which is
  // uncaught and terminates the process. A single malformed send took the hub
  // down for every agent.
  const contentError = invalidString(content, "content");
  if (contentError) {
    return res
      .status(400)
      .json({ success: false, error: contentError, code: "INVALID_ARGUMENT" });
  }

  const agent = agents.get(agentId);

  if (!agent) {
    return res.status(404).json({ success: false, error: "Agent not registered — your session may have been replaced by a newer one or cleared on a restart. Call room_join to re-register, then retry.", code: "AGENT_NOT_REGISTERED" });
  }

  // Parse mentions from content
  const mentions = parseMentions(content);

  const message = {
    id: uuidv4(),
    type: "message",
    agentId,
    agentName: agent.name,
    content,
    mentions,
    metadata,
    timestamp: nextTimestamp(agent.room),
    room: agent.room,
  };

  // Mark this timestamp in-flight so readers won't advance a cursor past it
  // (or past any later message) until the write settles.
  const pendingMs = reservePending(agent.room, message.timestamp);

  // Persist BEFORE broadcasting or acknowledging. Previously the emit and the
  // 200 both happened regardless of the write, so a failed INSERT meant every
  // other agent saw a message that would not survive a restart, and the sender
  // was told it succeeded.
  persistMessage(
    message,
    function (err) {
      releasePending(agent.room, pendingMs);
      if (err) {
        logger.error(
          `Failed to persist message from ${agent.name} in ${agent.room}: ${err.message}`
        );
        return res.status(500).json({
          success: false,
          error: "Failed to persist message — not delivered",
        });
      }

      recordMessage(agent.room, message);

      // Update agent last active time
      agent.lastActive = new Date().toISOString();
      dbRun(
        "UPDATE agents SET last_active = ? WHERE id = ?",
        [agent.lastActive, agentId],
        `last_active heartbeat for ${agent.name}`
      );

      // Create notifications for mentions
      if (mentions.length > 0) {
        createNotifications(message, mentions);
      }

      io.to(agent.room).emit("message", message);

      logger.info(
        `Message sent by ${agent.name} in ${agent.room}${
          mentions.length > 0 ? ` with mentions: ${mentions.join(", ")}` : ""
        }`
      );

      // Classify mentions. A misspelled name parses perfectly and creates a
      // notification row addressed to an agent that does not exist, so the
      // sender sees a successful mention while nobody is ever notified —
      // "@ar-client-dev" instead of "@client-ar-dev" reads as delivered.
      // Report which mentions actually reached someone.
      const notified = [];
      const elsewhere = [];
      const unknown = [];
      for (const name of mentions) {
        const c = classifyMention(name, agent.room);
        if (c.kind === "notified") notified.push(name);
        else if (c.kind === "elsewhere") elsewhere.push({ name, room: c.rooms.join(", ") });
        else unknown.push(name);
      }

      res.json({
        success: true,
        messageId: message.id,
        mentions,
        notified,
        ...(elsewhere.length ? { elsewhere } : {}),
        ...(unknown.length ? { unknown } : {}),
      });
    }
  );
});

/**
 * The cursor the caller should send as `since` on its next poll.
 *
 * Clients used to derive this themselves from the returned page, which meant a
 * poll that returned NOTHING produced no cursor at all — and an empty poll is
 * exactly when a client most needs one. An agent that lost its cursor fell back
 * to a no-`since` poll, which re-reads the whole room tail with no way to tell
 * which messages are new. In a normally-paced room most polls are empty, so
 * this was the common case, not the edge case.
 *
 * Computed server-side because the server owns the clock that stamps messages;
 * a client substituting its own `Date.now()` would skip messages whenever its
 * clock ran ahead of the hub's.
 *
 *  - page has messages  -> the newest one in the page (walk forward)
 *  - empty, had a since -> that same since, unchanged (nothing new happened)
 *  - count-only with matches -> undefined; the caller has seen no bodies yet
 *    and must not advance past them
 *  - genuinely nothing anywhere -> now, i.e. "start watching from here",
 *    but never past an in-flight write (see below)
 *
 * `safeTs` is the in-flight write watermark. The "start from now" case must
 * respect it: a message whose timestamp is reserved but whose row has not
 * landed yet is correctly excluded from this page, so handing back a cursor at
 * `now` would put it BEHIND the caller's cursor and skip it permanently once
 * it settles. The other branches are already safe — a page message is at or
 * below the watermark by construction, and `since` came from an earlier page,
 * which was too. Only this fallback can outrun a pending write.
 */
function nextSinceCursor(page, roomMessages, since, safeTs = Infinity) {
  if (page.length) {
    const newest = page.reduce((a, m) =>
      new Date(m.timestamp) > new Date(a.timestamp) ? m : a
    );
    return newest.timestamp;
  }
  if (since) return since;
  if (roomMessages.length) return undefined;
  return new Date(Math.min(Date.now(), safeTs)).toISOString();
}

// Build the paged /api/messages response from an already sorted+filtered set.
// `safeTs` is the in-flight write watermark, so the cursor cannot outrun a
// message that is reserved but not yet committed.
function buildMessagesResponse(res, roomMessages, since, max, safeTs) {
  const matched = roomMessages.length;

  // Truncation direction matters.
  //   - No `since`: the caller wants the most recent N, so take the tail.
  //   - With `since`: the caller is walking forward through a backlog. Taking
  //     the tail would return the NEWEST N and skip the oldest unseen ones —
  //     and because the caller then advances its cursor past them, they would
  //     never be seen again. Take the head so repeated polls walk the backlog
  //     contiguously.
  const page =
    max === 0
      ? [] // count-only query
      : since
        ? roomMessages.slice(0, max)
        : roomMessages.slice(-max);

  // On a count-only query, report who the new messages are FROM. Lets an agent
  // see both its own new-message count and every other participant's without
  // transferring a single message body.
  let byAgent;
  if (max === 0) {
    byAgent = {};
    for (const m of roomMessages) {
      const who = m.agentName || "unknown";
      byAgent[who] = (byAgent[who] || 0) + 1;
    }
  }

  const nextSince = nextSinceCursor(page, roomMessages, since, safeTs);

  res.json({
    messages: page,
    // `matched` is the full size of the window before truncation, so callers
    // can tell "50 messages" from "50 of 120 messages".
    matched,
    returned: page.length,
    hasMore: page.length < matched,
    // Always present when the caller can safely advance — including on an
    // empty result, where it echoes the incoming cursor back unchanged.
    ...(nextSince ? { nextSince } : {}),
    ...(byAgent ? { byAgent } : {}),
  });
}

// Does a message @mention this name (case-insensitive)?
function mentionsName(m, name) {
  const lower = name.toLowerCase();
  return Array.isArray(m.mentions) && m.mentions.some((x) => String(x).toLowerCase() === lower);
}

app.get("/api/messages/:room", (req, res) => {
  const { room } = req.params;
  const { since, limit = 100, mentioning } = req.query;

  let sinceTime = null;
  if (since) {
    sinceTime = new Date(since).getTime();
    // An unparseable `since` yields NaN, and every `> NaN` comparison is false —
    // which would silently return zero messages instead of erroring. A false
    // "nothing new" is indistinguishable from a quiet room, so reject it loudly.
    if (Number.isNaN(sinceTime)) {
      return res.status(400).json({
        error: `Invalid 'since' timestamp: ${JSON.stringify(since)}. Expected an ISO 8601 timestamp, e.g. 2026-07-23T21:00:00.000Z`,
      });
    }
    // A date-time with no timezone designator ("2026-07-23T16:10:00") is parsed
    // in the SERVER's local timezone, not the caller's. Agents polling from a
    // different timezone would silently get the wrong window, so require an
    // explicit offset (Z or ±HH:MM) and make the cursor absolute.
    if (/\d[T ]\d/.test(since) && !/(Z|[+-]\d{2}:?\d{2})$/.test(since.trim())) {
      return res.status(400).json({
        error: `Ambiguous 'since' timestamp: ${JSON.stringify(since)} has no timezone offset and would be interpreted in the server's timezone. Append 'Z' for UTC or an explicit offset, e.g. 2026-07-23T21:00:00.000Z`,
      });
    }
  }

  // `slice(-0)` is `slice(0)` — the WHOLE array — so a limit of 0 would return
  // everything. Clamp to a non-negative integer; 0 means count-only.
  const parsed = parseInt(limit);
  const max = Number.isFinite(parsed) && parsed >= 0 ? parsed : 100;

  // Hold back messages at or beyond the oldest in-flight write, so a cursor
  // never advances past a message that has not landed yet.
  const safeTs = safeWatermark(room);

  // Sort a COPY by timestamp — never reorder the stored array during a read.
  // Under concurrency writes land out of order, so paging by array position
  // would set the cursor to a non-maximum message and skip/repeat.
  const inMem = [...(messages.get(room) || [])].sort(
    (a, b) => new Date(a.timestamp) - new Date(b.timestamp)
  );
  const oldestInMem = inMem.length
    ? new Date(inMem[0].timestamp).getTime()
    : Infinity;

  // DB fallback: only the most recent MESSAGE_HISTORY_LIMIT messages per room
  // are held in memory. A `since` that reaches before that horizon would
  // otherwise silently return just the part of the window still in the tail,
  // with no signal that older matches exist on disk. Query the table instead.
  const needDb = since && sinceTime < oldestInMem;

  if (!needDb) {
    let rows = inMem;
    if (since) rows = rows.filter((m) => new Date(m.timestamp).getTime() > sinceTime);
    rows = rows.filter((m) => new Date(m.timestamp).getTime() <= safeTs);
    // `mentioning` returns only messages that @mention this name — the
    // "just what's directed to me" stream, full content, cursor-driven.
    if (mentioning) rows = rows.filter((m) => mentionsName(m, mentioning));
    return buildMessagesResponse(res, rows, since, max, safeTs);
  }

  db.all(
    "SELECT * FROM messages WHERE room = ? AND timestamp > ? ORDER BY timestamp ASC",
    [room, new Date(sinceTime).toISOString()],
    (err, dbRows) => {
      if (err) {
        logger.error(`Failed to read messages for room ${room}:`, err);
        return res.status(500).json({ success: false, error: "Database error" });
      }
      let rows = dbRows
        .map(rowToMessage)
        .filter((m) => new Date(m.timestamp).getTime() <= safeTs);
      if (mentioning) rows = rows.filter((m) => mentionsName(m, mentioning));
      return buildMessagesResponse(res, rows, since, max, safeTs);
    }
  );
});

app.get("/api/rooms", (req, res) => {
  const roomList = Array.from(rooms.entries()).map(([name, room]) => ({
    name,
    agentCount: room.agents.size,
    agents: Array.from(room.agents)
      .map((id) => agents.get(id))
      .filter(Boolean),
    createdAt: room.createdAt,
  }));

  res.json({ rooms: roomList });
});

// DELETE /api/messages/:room — clear messages from a room, optionally filtered.
// Irreversible, so it requires an explicit confirm flag. Intended for the CLI
// (human operator); no MCP tool exposes it. Optional filters make it selective:
//   ?before=<ISO>  only messages strictly older than this timestamp
//   ?type=system   only messages of this type (e.g. purge join notices)
app.delete("/api/messages/:room", (req, res) => {
  const { room } = req.params;
  const { before, type } = req.query;
  const confirm = req.query.confirm === "true" || req.body?.confirm === true;

  if (!confirm) {
    return res.status(400).json({
      success: false,
      error: "Refusing to delete without confirmation. Pass confirm=true.",
    });
  }
  if (before && Number.isNaN(new Date(before).getTime())) {
    return res.status(400).json({
      success: false,
      error: `Invalid 'before' timestamp: ${JSON.stringify(before)}`,
    });
  }

  const where = ["room = ?"];
  const params = [room];
  if (before) { where.push("timestamp < ?"); params.push(new Date(before).toISOString()); }
  if (type) { where.push("type = ?"); params.push(type); }

  db.run(`DELETE FROM messages WHERE ${where.join(" AND ")}`, params, function (err) {
    if (err) {
      logger.error(`Failed to clear messages for ${room}:`, err);
      return res.status(500).json({ success: false, error: "Database error" });
    }
    // Mirror the delete in the in-memory buffer.
    const buf = messages.get(room);
    if (buf) {
      const beforeMs = before ? new Date(before).getTime() : null;
      messages.set(
        room,
        buf.filter((m) => {
          const matches =
            (beforeMs === null || new Date(m.timestamp).getTime() < beforeMs) &&
            (!type || m.type === type);
          return !matches; // keep everything that did NOT match the filters
        })
      );
    }
    logger.warn(
      `Cleared ${this.changes} messages from room ${room}` +
        (before ? ` before ${before}` : "") + (type ? ` of type ${type}` : "")
    );
    res.json({ success: true, deleted: this.changes });
  });
});

// DELETE /api/rooms/:room — delete a room and ALL its data. Requires confirm=true
// AND confirmName matching the room, so a single stray call can't trigger it.
app.delete("/api/rooms/:room", (req, res) => {
  const { room } = req.params;
  const confirm = req.query.confirm === "true" || req.body?.confirm === true;
  const confirmName = req.query.confirmName || req.body?.confirmName;

  if (!confirm || confirmName !== room) {
    return res.status(400).json({
      success: false,
      error: `Refusing to delete room. Pass confirm=true and confirmName="${room}".`,
    });
  }

  const counts = {};
  db.serialize(() => {
    db.run("DELETE FROM messages WHERE room = ?", [room], function () { counts.messages = this.changes; });
    db.run("DELETE FROM tasks WHERE room = ?", [room], function () { counts.tasks = this.changes; });
    db.run("DELETE FROM notifications WHERE room = ?", [room], function () { counts.notifications = this.changes; });
    db.run("DELETE FROM agents WHERE room = ?", [room], function () { counts.agents = this.changes; });
    db.run("DELETE FROM rooms WHERE name = ?", [room], function (err) {
      if (err) {
        logger.error(`Failed to delete room ${room}:`, err);
        return res.status(500).json({ success: false, error: "Database error" });
      }
      counts.room = this.changes;

      // Purge in-memory state.
      for (const [id, a] of agents) if (a.room === room) agents.delete(id);
      for (const [id, t] of tasks) if (t.room === room) tasks.delete(id);
      rooms.delete(room);
      messages.delete(room);
      lastIssuedTs.delete(room);
      pendingTs.delete(room);
      const watcher = fileWatcher.get(room);
      if (watcher) { try { watcher.close(); } catch {} fileWatcher.delete(room); }

      logger.warn(`Deleted room ${room}: ${JSON.stringify(counts)}`);
      res.json({ success: true, deleted: counts });
    });
  });
});

app.get("/api/agents/:room", (req, res) => {
  const { room: roomName } = req.params;
  const room = rooms.get(roomName);

  if (!room) {
    return res.status(404).json({ success: false, error: "Room not found" });
  }

  const roomAgents = Array.from(room.agents)
    .map((id) => agents.get(id))
    .filter(Boolean);

  res.json({ agents: roomAgents });
});

// Task endpoints
app.post("/api/tasks", (req, res) => {
  const {
    roomName,
    title,
    description,
    assignee,
    creator,
    priority = "medium",
  } = req.body;

  // A task with no room is unreachable: GET /api/tasks/:room filters by room,
  // so a task created with roomName undefined is stored, counted in /api/stats,
  // and listed by nothing. The creator was told it succeeded.
  const roomError = invalidString(roomName, "roomName", 200);
  const titleError = invalidString(title, "title", 500);
  if (roomError || titleError) {
    return res.status(400).json({
      success: false,
      error: roomError || titleError,
      code: "INVALID_ARGUMENT",
    });
  }

  const task = {
    id: uuidv4(),
    room: roomName,
    title,
    description,
    assignee,
    creator,
    priority,
    status: "todo",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  // Bug 3 fix: persist task to DB on creation.
  // The write gates the in-memory insert, the broadcast and the 200 — a task
  // reported as created must actually exist on disk.
  db.run(
    "INSERT INTO tasks (id, room, title, description, assignee, creator, priority, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [task.id, task.room, task.title, task.description, task.assignee, task.creator, task.priority, task.status, task.createdAt, task.updatedAt],
    function (err) {
      if (err) {
        logger.error(`Failed to persist task ${task.id}: ${err.message}`);
        return res
          .status(500)
          .json({ success: false, error: "Failed to persist task" });
      }

      tasks.set(task.id, task);

      io.to(roomName).emit("task", { type: "created", task });

      // Bug 5 fix: also emit task_assigned so mcp-server.js listeners fire
      if (task.assignee) {
        io.to(roomName).emit("task_assigned", task);
      }

      res.json({ success: true, task });
    }
  );
});

app.get("/api/tasks/:room", (req, res) => {
  const { room } = req.params;
  const roomTasks = Array.from(tasks.values()).filter((t) => t.room === room);
  res.json({ tasks: roomTasks });
});

// Bug 4 fix: single-task GET and PUT routes used by the CLI
app.get("/api/tasks/:room/:taskId", (req, res) => {
  const { room, taskId } = req.params;
  const task = tasks.get(taskId);
  if (!task || task.room !== room) {
    return res.status(404).json({ success: false, error: "Task not found" });
  }
  res.json({ success: true, task });
});

app.put("/api/tasks/:room/:taskId", (req, res) => {
  const { room, taskId } = req.params;
  const task = tasks.get(taskId);
  if (!task || task.room !== room) {
    return res.status(404).json({ success: false, error: "Task not found" });
  }
  const { status, assignee, priority } = req.body;
  if (status) task.status = status;
  if (assignee) task.assignee = assignee;
  if (priority) task.priority = priority;
  task.updatedAt = new Date().toISOString();
  db.run(
    "UPDATE tasks SET status = ?, assignee = ?, priority = ?, updated_at = ? WHERE id = ?",
    [task.status, task.assignee, task.priority, task.updatedAt, task.id],
    function (err) {
      if (err) {
        logger.error(`Failed to persist update to task ${task.id}: ${err.message}`);
        return res
          .status(500)
          .json({ success: false, error: "Failed to persist task update" });
      }
      res.json({ success: true, task });
    }
  );
});

// Agent management endpoints
app.get("/api/stats", (req, res) => {
  const stats = {
    totalRooms: rooms.size,
    totalAgents: agents.size,
    totalTasks: tasks.size,
    sharedDirectory: SHARED_DIR,
    rooms: Array.from(rooms.entries()).map(([name, room]) => ({
      name,
      agentCount: room.agents.size,
      messageCount: messages.get(name)?.length || 0,
      isActive: room.isActive,
    })),
  };
  res.json(stats);
});

app.post("/api/broadcast/:room", (req, res) => {
  const { room: roomName } = req.params;
  const { content, from = "Orchestrator" } = req.body;

  const contentError = invalidString(content, "content");
  if (contentError) {
    return res
      .status(400)
      .json({ success: false, error: contentError, code: "INVALID_ARGUMENT" });
  }
  const fromError = invalidString(from, "from", 200);
  if (fromError) {
    return res
      .status(400)
      .json({ success: false, error: fromError, code: "INVALID_ARGUMENT" });
  }

  // Create the room if it does not exist yet. Without this, broadcasting to a
  // room nobody had joined found no in-memory buffer, recordMessage dropped the
  // message, nothing was persisted — and the orchestrator was still told
  // {success: true} with a messageId for a message that existed nowhere.
  getRoom(roomName);

  const message = {
    id: uuidv4(),
    type: "broadcast",
    agentId: null,
    agentName: from,
    content: `[${from}] ${content}`,
    mentions: [],
    metadata: { from },
    timestamp: nextTimestamp(roomName),
    room: roomName,
    from,
  };

  // Broadcasts were never written to the messages table, so they survived only
  // in the in-memory buffer: gone on restart, and absent from the DB-fallback
  // read path used when a `since` reaches past the in-memory horizon. An agent
  // paging through backlog silently never saw them. Gate the 200 on the write.
  persistMessage(message, function (err) {
    if (err) {
      logger.error(
        `Failed to persist broadcast to ${roomName}: ${err.message}`
      );
      return res.status(500).json({
        success: false,
        error: "Failed to persist broadcast — not delivered",
      });
    }

    recordMessage(roomName, message);
    io.to(roomName).emit("message", message);

    res.json({ success: true, messageId: message.id });
  });
});

app.post("/api/tasks/:taskId/update", (req, res) => {
  const { taskId } = req.params;
  const { status, assignee, priority } = req.body;

  const task = tasks.get(taskId);
  if (!task) {
    return res.status(404).json({ success: false, error: "Task not found" });
  }

  if (status) task.status = status;
  if (assignee) task.assignee = assignee;
  if (priority) task.priority = priority;
  task.updatedAt = new Date().toISOString();

  // Update in database — gates the broadcast and the 200.
  db.run(
    "UPDATE tasks SET status = ?, assignee = ?, priority = ?, updated_at = ? WHERE id = ?",
    [task.status, task.assignee, task.priority, task.updatedAt, taskId],
    function (err) {
      if (err) {
        logger.error(`Failed to persist update to task ${taskId}: ${err.message}`);
        return res
          .status(500)
          .json({ success: false, error: "Failed to persist task update" });
      }

      io.to(task.room).emit("task", { type: "updated", task });

      logger.info(
        `Task ${taskId} updated: status=${task.status}, assignee=${task.assignee}`
      );

      res.json({ success: true, task });
    }
  );
});

// Agent memory endpoints
app.post("/api/memory/:agentId", (req, res) => {
  const { agentId } = req.params;
  const { key, value, type = "note", expiresIn } = req.body;

  const agent = agents.get(agentId);
  if (!agent) {
    return res.status(404).json({ success: false, error: "Agent not registered — your session may have been replaced by a newer one or cleared on a restart. Call room_join to re-register, then retry.", code: "AGENT_NOT_REGISTERED" });
  }

  const memoryId = uuidv4();
  const expiresAt = expiresIn
    ? new Date(Date.now() + expiresIn * 1000).toISOString()
    : null;

  const memory = {
    id: memoryId,
    agentId,
    room: agent.room,
    key,
    value,
    type,
    createdAt: new Date().toISOString(),
    expiresAt,
  };

  // Store in database — gates the 200, since "stored" must mean stored.
  db.run(
    "INSERT INTO agent_memory (id, agent_id, room, key, value, type, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [
      memoryId,
      agentId,
      agent.room,
      key,
      value,
      type,
      memory.createdAt,
      expiresAt,
    ],
    function (err) {
      if (err) {
        logger.error(
          `Failed to store memory "${key}" for agent ${agent.name}: ${err.message}`
        );
        return res
          .status(500)
          .json({ success: false, error: "Failed to store memory" });
      }

      logger.info(`Memory stored for agent ${agent.name}: ${key}`);

      res.json({ success: true, memoryId, memory });
    }
  );
});

app.get("/api/memory/:agentId", (req, res) => {
  const { agentId } = req.params;
  const { key, type } = req.query;

  let query =
    "SELECT * FROM agent_memory WHERE agent_id = ? AND (expires_at IS NULL OR expires_at > datetime('now'))";
  const params = [agentId];

  if (key) {
    query += " AND key = ?";
    params.push(key);
  }

  if (type) {
    query += " AND type = ?";
    params.push(type);
  }

  query += " ORDER BY created_at DESC";

  db.all(query, params, (err, rows) => {
    if (err) {
      logger.error("Failed to retrieve agent memory:", err);
      return res.status(500).json({ success: false, error: "Database error" });
    }

    res.json({ success: true, memories: rows });
  });
});

app.get("/api/notifications/:agentId", (req, res) => {
  const { agentId } = req.params;
  const { unreadOnly = false, agentName, room } = req.query;

  // Match by agent_id OR agent_name (case-insensitive) so offline agents
  // that were @mentioned can retrieve their notifications after joining.
  //
  // `room` is optional and opt-in: retrieval is NOT room-scoped by default,
  // because narrowing it silently would hide mentions an agent was already
  // relying on. Callers that only care about the room they are working in
  // pass it explicitly; the room is reported on every notification either way.
  let match = "(agent_id = ? OR LOWER(agent_name) = LOWER(?))";
  const params = [agentId, agentName || agentId];
  if (room) {
    match += " AND room = ?";
    params.push(room);
  }

  let query = `SELECT * FROM notifications WHERE ${match}`;
  if (unreadOnly === "true") {
    query += " AND is_read = 0";
  }

  // Bounded page, but the caller is told the true totals so it can tell
  // "50 notifications" from "50 of 120" — and page back with `offset`
  // instead of older notifications being permanently unreachable.
  const max = Math.min(parseInt(req.query.limit || "50", 10) || 50, 200);
  const offset = parseInt(req.query.offset || "0", 10) || 0;
  query += " ORDER BY created_at DESC LIMIT ? OFFSET ?";

  db.all(query, [...params, max, offset], (err, rows) => {
    if (err) {
      logger.error("Failed to retrieve notifications:", err);
      return res.status(500).json({ success: false, error: "Database error" });
    }

    // Real totals, counted in SQL rather than inferred from the page.
    db.get(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN is_read = 0 THEN 1 ELSE 0 END) AS unread
         FROM notifications WHERE ${match}`,
      params,
      (countErr, counts) => {
        if (countErr) {
          logger.error("Failed to count notifications:", countErr);
          return res
            .status(500)
            .json({ success: false, error: "Database error" });
        }

        const total = counts?.total || 0;
        const unread = counts?.unread || 0;
        res.json({
          success: true,
          notifications: rows,
          returned: rows.length,
          total,
          unread,
          hasMore: offset + rows.length < (unreadOnly === "true" ? unread : total),
        });
      }
    );
  });
});

app.post("/api/notifications/:notificationId/read", (req, res) => {
  const { notificationId } = req.params;

  db.run(
    "UPDATE notifications SET is_read = 1 WHERE id = ?",
    [notificationId],
    function (err) {
      if (err) {
        logger.error("Failed to mark notification as read:", err);
        return res
          .status(500)
          .json({ success: false, error: "Database error" });
      }

      res.json({ success: true, updated: this.changes > 0 });
    }
  );
});

// body-parser normally renders an HTML 413. Keep the file API's documented
// JSON error contract even when the raw parser rejects a body before its route
// handler is entered.
app.use((err, req, res, next) => {
  if (err?.type === "entity.too.large" && /^\/api\/rooms\/[^/]+\/files\//.test(req.originalUrl || req.url)) {
    return fileError(res, 413, "PAYLOAD_TOO_LARGE", "File exceeds the allowed size");
  }
  return next(err);
});

// WebSocket handling
io.on("connection", (socket) => {
  console.log(`Client connected: ${socket.id}`);

  socket.on("register", ({ agentId, room }) => {
    const agent = agents.get(agentId);
    if (agent) {
      agent.socketId = socket.id;
      socket.join(room);
      console.log(`Agent ${agent.name} registered with socket ${socket.id}`);
    }
  });

  socket.on("message", (data) => {
    if (data.room) {
      io.to(data.room).emit("message", data);
    }
  });

  socket.on("disconnect", () => {
    console.log(`Client disconnected: ${socket.id}`);
  });
});

// Start server
const PORT = process.env.PORT || 3000;

/**
 * Graceful shutdown.
 *
 * Message/task/notification writes use fire-and-forget `db.run(...)`, so
 * statements can still be queued in the sqlite3 driver when systemd sends
 * SIGTERM. Without this, a restart silently drops whatever was in flight —
 * messages that were acknowledged to the sender with `{success: true}`.
 * db.close() waits for queued statements to finish before closing.
 */
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`${signal} received — draining pending database writes`);

  // Stop accepting new work. Socket.IO holds persistent connections, so
  // httpServer.close() would never fire its callback until every agent
  // disconnects — the DB flush must NOT be gated behind it.
  io.close();
  httpServer.close();

  // This is the part that actually matters for durability: db.close() waits
  // for queued statements to finish before closing.
  db.close((err) => {
    if (err) logger.error("Error closing database:", err);
    else logger.info("Database closed cleanly");
    process.exit(0);
  });

  // Don't hang forever if a socket refuses to close.
  setTimeout(() => {
    logger.error("Shutdown timed out — forcing exit");
    process.exit(1);
  }, 5000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

async function startServer() {
  await initializeSystem();

  // Storage hygiene: once at boot, then hourly. Unref so it never holds the
  // process open during shutdown.
  pruneExpiredData();
  setInterval(pruneExpiredData, 60 * 60 * 1000).unref();

  httpServer.listen(PORT, () => {
    logger.info(`Claude Gateway Hub started on port ${PORT}`);
    console.log(`🚀 Claude Gateway Hub running on http://localhost:${PORT}`);
    console.log(`📁 Shared Directory: ${SHARED_DIR}`);
    console.log(`💾 Data Directory: ${DATA_DIR}`);
    console.log(`\nCore Endpoints:`);
    console.log(`  POST   /api/join/:room         - Join a room`);
    console.log(`  POST   /api/leave/:agentId     - Leave current room`);
    console.log(`  POST   /api/send               - Send a message`);
    console.log(`  GET    /api/messages/:room     - Get room messages`);
    console.log(`  GET    /api/rooms              - List all rooms`);
    console.log(`  GET    /api/agents/:room       - Get room agents`);
    console.log(`\nTask Management:`);
    console.log(`  POST   /api/tasks              - Create a task`);
    console.log(`  GET    /api/tasks/:room        - Get room tasks`);
    console.log(`  POST   /api/tasks/:id/update   - Update task status`);
    console.log(`\nAgent Memory & Notifications:`);
    console.log(`  POST   /api/memory/:agentId    - Store agent memory`);
    console.log(`  GET    /api/memory/:agentId    - Retrieve agent memory`);
    console.log(`  GET    /api/notifications/:id  - Get notifications`);
    console.log(`  POST   /api/notifications/:id/read - Mark as read`);
    console.log(`\nOrchestration:`);
    console.log(`  GET    /api/stats              - Get system stats`);
    console.log(`  POST   /api/broadcast/:room    - Broadcast to room`);
    console.log(`\nFeatures:`);
    console.log(`  🏷️  Agent tagging with @mentions`);
    console.log(`  🔔 Real-time notifications`);
    console.log(`  💾 Persistent logging & storage`);
    console.log(`  📝 Agent memory management`);
    console.log(`\nWebSocket Events:`);
    console.log(`  - message: Chat messages & file changes`);
    console.log(`  - task: Task updates`);
    console.log(`  - notification: Mentions & alerts`);
    console.log(`\n🤖 Ready for MCP agent connections!`);
  });
}

startServer().catch(console.error);
