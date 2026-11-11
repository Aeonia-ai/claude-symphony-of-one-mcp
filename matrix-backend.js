import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID, createHash } from 'node:crypto';

const execFileAsync = promisify(execFile);
const API = '/_matrix/client/v3';
const NS = 'org.aeonia.symphony';

export class MatrixBackend {
  constructor({ credentialsFile = process.env.SYMPHONY_MATRIX_CREDENTIALS_FILE, container = process.env.SYMPHONY_MATRIX_CONTAINER, timeoutMs = 30000 } = {}) {
    this.enabled = Boolean(credentialsFile || container);
    this.credentialsFile = credentialsFile;
    this.container = container;
    this.timeoutMs = timeoutMs;
    this._credentialsPromise = null;
    this._knownUserId = null;
    this._roomNames = new Map();
  }

  static isMatrixRoom(name) { return typeof name === 'string' && /^matrix:![^\s]+$/.test(name); }

  async _credentials() {
    if (!this._credentialsPromise) this._credentialsPromise = (async () => {
      if (!this.enabled) throw new Error('Matrix backend is disabled');
      let raw;
      try {
        if (this.credentialsFile) raw = await readFile(this.credentialsFile, 'utf8');
        else {
          const script = 'import os\np=os.path.join(os.environ.get("EMBASSY_STATE_DIR", "/data/state"), "credentials.json")\nprint(open(p).read())';
          ({ stdout: raw } = await execFileAsync('docker', ['exec', this.container, 'python3', '-c', script], { timeout: this.timeoutMs, maxBuffer: 1024 * 1024 }));
        }
        const c = JSON.parse(raw);
        const homeserver = c.homeserver || c.homeserver_url || c.server_url || c.url;
        const token = c.access_token || c.accessToken;
        if (!homeserver || !token) throw new Error();
        const userId = c.user_id || c.userId;
        if (!userId) throw new Error();
        this._knownUserId = userId;
        return { homeserver: homeserver.replace(/\/$/, ''), token, userId };
      } catch { throw new Error('Unable to load Matrix credentials'); }
    })().catch(error => { this._credentialsPromise = null; throw error; });
    return this._credentialsPromise;
  }

  async _request(path, { method = 'GET', body, timeoutMs = this.timeoutMs } = {}) {
    const c = await this._credentials();
    let response;
    try {
      response = await fetch(`${c.homeserver}${API}${path}`, { method, headers: { Authorization: `Bearer ${c.token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(timeoutMs) });
    } catch { const e = new Error('Matrix request failed or timed out'); e.ambiguous = true; throw e; }
    if (!response.ok) {
      let code = '';
      try { const data = await response.json(); if (/^M_[A-Z_]+$/.test(data.errcode)) code = ` ${data.errcode}`; } catch {}
      if (response.status === 401) { this._credentialsPromise = null; this._knownUserId = null; }
      const e = new Error(`Matrix request failed (${response.status}${code})`); e.status = response.status; e.matrixCode = code.trim(); e.ambiguous = response.status >= 500; throw e;
    }
    try { return await response.json(); } catch { throw new Error('Matrix returned invalid JSON'); }
  }

  _roomId(room) {
    if (!MatrixBackend.isMatrixRoom(room) || !room.startsWith('matrix:!')) throw new Error('Expected a canonical Matrix room ID');
    return room.slice(7);
  }
  async _descriptor(id) {
    let displayName = this._roomNames.get(id);
    if (!displayName) {
      try { displayName = (await this._request(`/rooms/${encodeURIComponent(id)}/state/m.room.name`)).name || id; } catch (e) { if (e.status !== 404) throw e; displayName = id; }
      this._roomNames.set(id, displayName);
    }
    return { name: `matrix:${id}`, displayName, backend: 'matrix', matrixRoomId: id };
  }
  async listRooms() {
    const result = await this._request('/joined_rooms');
    const rooms = [];
    for (let i = 0; i < result.joined_rooms.length; i += 8) rooms.push(...await Promise.all(result.joined_rooms.slice(i, i + 8).map(id => this._descriptor(id))));
    return rooms;
  }
  async joinRoom(name) {
    if (!MatrixBackend.isMatrixRoom(name)) throw new Error('Expected a canonical Matrix room ID; use an ID from the room list');
    const id = name.slice(7);
    const joined = await this._request(`/join/${encodeURIComponent(id)}`, { method: 'POST', body: {} });
    if (!joined.room_id || joined.room_id !== id) throw new Error('Matrix join returned an unexpected room');
    return this._descriptor(id);
  }
  normalizeEvent(roomId, event) {
    if (event.type !== 'm.room.message' || event.unsigned?.redacted_because || event.content?.['m.relates_to']?.rel_type === 'm.replace') return null;
    const c = event.unsigned?.['m.relations']?.['m.replace']?.content?.['m.new_content'] || event.content || {};
    if (typeof c.body !== 'string' || !Number.isFinite(event.origin_server_ts) || !Number.isFinite(new Date(event.origin_server_ts).getTime())) return null;
    const own = event.sender === this._knownUserId ? (c[NS] || {}) : {};
    const content = typeof own.originalContent === 'string' ? own.originalContent : c.body;
    const metadata = { ...(own.metadata || {}) };
    const relation = c['m.relates_to'];
    if (relation?.rel_type === 'm.thread' && relation.event_id) metadata.threadRootEventId = relation.event_id;
    const mentions = []; const seen = new Set();
    for (const match of content.matchAll(/@([A-Za-z0-9_]+(?:[.\-][A-Za-z0-9_]+)*)/g)) { const name = match[1]; if (!seen.has(name.toLowerCase())) { seen.add(name.toLowerCase()); mentions.push(name); } }
    return { id: event.event_id, type: 'message', agentId: own.agentId || event.sender, agentName: own.agentName || event.sender, content, mentions, metadata, timestamp: new Date(event.origin_server_ts).toISOString(), room: `matrix:${roomId}` };
  }
  async getMessages(room, { since, limit = 100, mentioning } = {}) {
    const id = this._roomId(room);
    limit = Number(limit);
    if (!Number.isInteger(limit) || limit < 0) throw new Error('Invalid message limit');
    let anchor, sinceTime;
    if (since?.startsWith('matrix-cursor:')) {
      try { const v = JSON.parse(Buffer.from(since.slice(14), 'base64url').toString()); if (v.room !== id || typeof v.event !== 'string') throw new Error(); anchor = v.event; } catch { throw new Error('Invalid or wrong-room Matrix cursor'); }
    } else if (since) {
      if (!/(?:Z|[+-]\d\d:\d\d)$/i.test(since) || !Number.isFinite(Date.parse(since))) throw new Error('Invalid since timestamp');
      sinceTime = Date.parse(since);
    }
    const collected = []; const edits = new Map(); let from, scanned = 0, found = false, newestEvent, truncated = false;
    do {
      const q = new URLSearchParams({ dir: 'b', limit: '100' }); if (from) q.set('from', from);
      const batch = await this._request(`/rooms/${encodeURIComponent(id)}/messages?${q}`);
      const chunk = batch.chunk || []; scanned += chunk.length;
      if (chunk.length === 0) break;
      for (const event of chunk) {
        if (!newestEvent && typeof event.event_id === 'string') newestEvent = event.event_id;
        if (anchor && event.event_id === anchor) { found = true; break; }
        const relation = event.content?.['m.relates_to'];
        if (event.type === 'm.room.message' && relation?.rel_type === 'm.replace' && relation.event_id && event.content?.['m.new_content'] && !event.unsigned?.redacted_because && !edits.has(relation.event_id)) edits.set(relation.event_id, event);
        const edit = edits.get(event.event_id);
        const visibleEvent = edit && edit.sender === event.sender ? { ...event, content: edit.content['m.new_content'] } : event;
        const m = this.normalizeEvent(id, visibleEvent);
        if (m && (sinceTime === undefined || event.origin_server_ts > sinceTime)) collected.push(m);
      }
      if (found) break;
      // Initial reads need only the newest requested page, plus one to detect more.
      if (!since && limit > 0 && collected.filter(m => !mentioning || m.mentions.some(x => x.toLowerCase() === String(mentioning).replace(/^@/, '').toLowerCase())).length > limit) { truncated = Boolean(batch.end); break; }
      // ISO timestamps are not Matrix stream order; inspect the full window rather than silently skipping clock-skewed events.
      if (batch.end && batch.end === from) throw new Error('Matrix history pagination did not advance');
      from = batch.end;
    } while (from);
    if (anchor && !found) throw new Error('Matrix cursor event is no longer available');
    collected.reverse();
    const matches = mentioning ? collected.filter(m => m.mentions.some(x => x.toLowerCase() === String(mentioning).replace(/^@/, '').toLowerCase())) : collected;
    const page = limit === 0 ? [] : since ? matches.slice(0, limit) : matches.slice(-limit);
    const result = { messages: page, matched: matches.length, returned: page.length, hasMore: page.length < matches.length, ...(truncated ? { matchedAtLeast: true } : {}) };
    if (page.length) result.nextSince = `matrix-cursor:${Buffer.from(JSON.stringify({ room: id, event: page.at(-1).id })).toString('base64url')}`;
    else if (!matches.length && newestEvent) result.nextSince = `matrix-cursor:${Buffer.from(JSON.stringify({ room: id, event: newestEvent })).toString('base64url')}`;
    else if (since) result.nextSince = since;
    if (limit === 0) { result.byAgent = {}; for (const m of matches) result.byAgent[m.agentName || 'unknown'] = (result.byAgent[m.agentName || 'unknown'] || 0) + 1; }
    return result;
  }
  async sendMessage(room, { agentId, agentName, content, metadata = {} }) {
    const id = this._roomId(room);
    if (typeof content !== 'string' || typeof agentName !== 'string') throw new Error('Invalid Matrix message');
    const key = metadata.transactionId || randomUUID();
    const payloadMetadata = { ...metadata }; delete payloadMetadata.transactionId;
    const transactionId = createHash('sha256').update(JSON.stringify([key, id, agentId, agentName, content, payloadMetadata])).digest('hex');
    const body = { msgtype: 'm.text', body: `[${agentName}] ${content}`, [NS]: { agentId, agentName, originalContent: content, metadata: payloadMetadata } };
    const thread = metadata.threadRootEventId || metadata.thread;
    if (typeof thread === 'string') body['m.relates_to'] = { rel_type: 'm.thread', event_id: thread, is_falling_back: true, 'm.in_reply_to': { event_id: thread } };
    let sent;
    try { sent = await this._request(`/rooms/${encodeURIComponent(id)}/send/m.room.message/${encodeURIComponent(transactionId)}`, { method: 'PUT', body }); }
    catch (e) { if (e.ambiguous) { e.transactionId = key; e.ambiguous = true; } throw e; }
    if (typeof sent.event_id !== 'string' || !sent.event_id) throw new Error('Matrix send returned an invalid event ID');
    const credentials = await this._credentials();
    return this.normalizeEvent(id, { type: 'm.room.message', event_id: sent.event_id, sender: credentials.userId, origin_server_ts: Date.now(), content: body });
  }
  async sync({ since, timeoutMs = 25000 } = {}) {
    const q = new URLSearchParams({ timeout: String(timeoutMs), filter: JSON.stringify({room:{state:{lazy_load_members:true},timeline:{limit:100}}}) }); if (since) q.set('since', since);
    return this._request(`/sync?${q}`, { timeoutMs: timeoutMs + this.timeoutMs });
  }
}
