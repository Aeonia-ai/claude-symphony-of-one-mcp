# Feature Branch: message-management

## Overview
This feature branch adds message deletion capabilities, fixes critical bugs in room management, and improves timestamp display for better UX.

## Critical Bug Fixes

### 1. Fix room_leave API Call ⚠️ HIGH PRIORITY
**File:** `mcp-server.js:199`
**Issue:** Client sends agentId in request body to `/api/leave`, but server expects URL parameter `/api/leave/:agentId`

**Current (broken):**
```javascript
await axios.post(`${SERVER_URL}/api/leave`, {
  agentId: currentAgentId,
});
```

**Should be:**
```javascript
await axios.post(`${SERVER_URL}/api/leave/${currentAgentId}`);
```

**Impact:** room_leave fails with 404 errors, agents cannot properly leave rooms

---

### 2. Fix Message Cache Bug ⚠️ HIGH PRIORITY
**File:** `mcp-server.js:136`
**Issue:** `messageHistory` is not cleared when joining a new room (only cleared in room_leave)

**Fix:** Add after line 136:
```javascript
currentRoom = params.roomName;
messageHistory = [];  // Clear old messages from previous room
notifications = [];   // Clear old notifications too
```

**Impact:** When switching rooms without explicit leave, old messages persist in cache causing get_messages to return wrong room's messages

---

## UX Improvements

### 3. Update Message Timestamp Display
**File:** `mcp-server.js:324, 346`
**Change:** Replace `toLocaleTimeString()` with `toLocaleString()` to show date+time

**Current:**
```javascript
[${new Date(m.timestamp).toLocaleTimeString()}] ${m.agentName}: ${m.content}
```

**Should be:**
```javascript
[${new Date(m.timestamp).toLocaleString()}] ${m.agentName}: ${m.content}
```

**Impact:** Users can see when messages were sent (date+time) instead of just time

---

## Message Deletion Feature

### 4. Add deleted_at Column to Database Schema
**File:** `server.js:101-111`
**Action:** Add soft delete support to messages table

**Migration:**
```sql
ALTER TABLE messages ADD COLUMN deleted_at DATETIME DEFAULT NULL;
```

**Schema update:**
```javascript
db.run(`CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  room TEXT,
  agent_id TEXT,
  agent_name TEXT,
  content TEXT,
  type TEXT DEFAULT 'message',
  mentions TEXT,
  metadata TEXT,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
  deleted_at DATETIME DEFAULT NULL
)`);
```

---

### 5. Implement DELETE /api/messages/:messageId Endpoint
**File:** `server.js` (new endpoint)
**Action:** Add deletion API with authorization

**Implementation:**
```javascript
app.delete("/api/messages/:messageId", (req, res) => {
  const { messageId } = req.params;
  const { agentId } = req.body;

  // Get message from database
  db.get("SELECT * FROM messages WHERE id = ?", [messageId], (err, message) => {
    if (err || !message) {
      return res.status(404).json({ success: false, error: "Message not found" });
    }

    // Authorization: only message author can delete
    if (message.agent_id !== agentId) {
      return res.status(403).json({ success: false, error: "Not authorized" });
    }

    // Soft delete
    const deletedAt = new Date().toISOString();
    db.run("UPDATE messages SET deleted_at = ? WHERE id = ?", [deletedAt, messageId], (err) => {
      if (err) {
        return res.status(500).json({ success: false, error: "Delete failed" });
      }

      // Broadcast deletion to room
      io.to(message.room).emit("message_deleted", { messageId, deletedAt });

      res.json({ success: true, messageId, deletedAt });
    });
  });
});
```

---

### 6. Add Message IDs to get_messages Output
**File:** `mcp-server.js:324, 346`
**Action:** Display message IDs so agents know what to delete

**Current:**
```javascript
[${new Date(m.timestamp).toLocaleString()}] ${m.agentName}: ${m.content}
```

**Should be:**
```javascript
[${m.id.slice(0,8)}] [${new Date(m.timestamp).toLocaleString()}] ${m.agentName}: ${m.content}
```

---

### 7. Create delete_message MCP Tool
**File:** `mcp-server.js` (new tool)
**Action:** Add MCP tool for agents to delete messages

**Implementation:**
```javascript
server.registerTool(
  "delete_message",
  {
    title: "Delete Message",
    description: "Delete a message you sent (requires message ID)",
    inputSchema: {
      messageId: z.string().describe("The ID of the message to delete"),
    },
  },
  async (params) => {
    if (!currentAgentId) {
      return {
        content: [{ type: "text", text: "Not in a room. Use room_join first." }],
        isError: true
      };
    }

    try {
      const response = await axios.delete(
        `${SERVER_URL}/api/messages/${params.messageId}`,
        { data: { agentId: currentAgentId } }
      );

      return {
        content: [{ type: "text", text: `Message ${params.messageId} deleted successfully` }]
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Failed to delete message: ${error.response?.data?.error || error.message}` }],
        isError: true
      };
    }
  }
);
```

---

### 8. Add Socket.IO Broadcast for Deletion Events
**File:** `server.js:757-778` (socket handlers)
**Action:** Handle message_deleted events

**Implementation:**
```javascript
socket.on("message_deleted", (data) => {
  // Broadcast to all room members
  io.to(data.room).emit("message_deleted", data);
});
```

**Client side (mcp-server.js:36-110):**
```javascript
socket.on("message_deleted", (data) => {
  // Remove from local cache
  messageHistory = messageHistory.filter(m => m.id !== data.messageId);
  console.error(`[System] Message ${data.messageId.slice(0,8)} was deleted`);
});
```

---

### 9. Test Message Deletion Functionality
**Test Cases:**
- [ ] Delete own message successfully
- [ ] Attempt to delete another agent's message (should fail with 403)
- [ ] Attempt to delete non-existent message (should fail with 404)
- [ ] Verify deleted message no longer appears in get_messages
- [ ] Verify real-time deletion notification to all room members
- [ ] Verify soft delete (deleted_at set, message still in DB)
- [ ] Test room_leave fix (verify agents can leave properly)
- [ ] Test message cache fix (verify messages clear on room switch)
- [ ] Test timestamp display shows date+time

---

## Implementation Order

1. **Bug fixes first** (items 1-2) - Critical for basic functionality
2. **Timestamp improvement** (item 3) - Quick win, improves UX
3. **Database schema** (item 4) - Foundation for deletion feature
4. **API endpoint** (item 5) - Server-side deletion logic
5. **MCP tool** (item 7) - Client-side deletion interface
6. **Message ID display** (item 6) - Enable users to identify messages
7. **Socket.IO events** (item 8) - Real-time sync
8. **Testing** (item 9) - Verify everything works

---

## Notes

- All deletions are **soft deletes** (deleted_at timestamp) for audit trail
- Only message authors can delete their own messages (authorization enforced)
- Deleted messages filtered from get_messages queries but remain in database
- Real-time notifications ensure all agents see deletions immediately
- Message IDs shown as 8-char prefix for readability

---

**Branch:** `feature/message-management`
**Base:** `main`
**Status:** In Progress
**Last Updated:** 2025-11-14
