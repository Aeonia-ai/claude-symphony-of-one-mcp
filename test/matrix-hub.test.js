import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer } from './helpers.js';

describe('Matrix rooms through existing hub routes', () => {
  let matrix, srv, base, dir, sent = [], failed = false;
  const room = 'matrix:!test:example.test';
  const api = async (route, body) => {
    const r = await fetch(base + route, { ...(body ? {method:'POST',body:JSON.stringify(body)} : {}), headers:{'Content-Type':'application/json','x-auth-token':'hub-test'} });
    return {status:r.status, body:await r.json()};
  };
  before(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(),'symphony-matrix-'));
    matrix = http.createServer(async (req,res) => {
      res.setHeader('Content-Type','application/json');
      if (req.headers.authorization !== 'Bearer matrix-test') { res.writeHead(401); return res.end('{}'); }
      const url = decodeURIComponent(req.url);
      if (failed) { res.writeHead(503); return res.end('{"errcode":"M_UNAVAILABLE"}'); }
      if (url.includes('/joined_rooms')) return res.end('{"joined_rooms":["!test:example.test"]}');
      if (url.includes('/state/m.room.name')) return res.end('{"name":"Matrix test"}');
      if (url.includes('/join/')) return res.end('{"room_id":"!test:example.test"}');
      if (url.includes('/sync')) { return setTimeout(() => { if(!res.destroyed) res.end('{"next_batch":"s1","rooms":{"join":{}}}'); },100).unref(); }
      if (url.includes('/send/')) {
        let raw=''; for await (const part of req) raw+=part;
        sent.push({type:'m.room.message',event_id:'$'+sent.length,sender:'@bot:example.test',origin_server_ts:Date.now(),content:JSON.parse(raw)});
        return res.end(JSON.stringify({event_id:sent.at(-1).event_id}));
      }
      if (url.includes('/messages')) return res.end(JSON.stringify({chunk:[...sent].reverse(),start:'s1'}));
      res.writeHead(404);res.end('{}');
    });
    await new Promise(r => matrix.listen(0,'127.0.0.1',r));
    const file=path.join(dir,'credentials.json');
    await fs.writeFile(file,JSON.stringify({homeserver:'http://127.0.0.1:'+matrix.address().port,access_token:'matrix-test',user_id:'@bot:example.test'}));
    srv=await startServer({AUTH_TOKEN:'hub-test',SYMPHONY_MATRIX_CREDENTIALS_FILE:file,SYMPHONY_MATRIX_SYNC_STATE:path.join(dir,'sync.json')});
    base='http://localhost:'+srv.port;
  });
  after(async()=>{ await srv?.stop(); matrix?.closeAllConnections(); await new Promise(r=>matrix?.close(r)); await fs.rm(dir,{recursive:true,force:true}); });
  it('lists Matrix and native rooms and preserves normal room behavior',async()=>{
    assert.equal((await api('/api/join/native',{agentId:'native',agentName:'Native'})).body.success,true);
    const r=await api('/api/rooms');
    assert.ok(r.body.rooms.some(x=>x.name===room && x.backend==='matrix'));
    assert.ok(r.body.rooms.some(x=>x.name==='native'));
  });
  it('joins, sends named messages and reads Matrix history through existing routes',async()=>{
    assert.equal((await api('/api/join/'+encodeURIComponent(room),{agentId:'mx',agentName:'Tester'})).body.success,true);
    const send=await api('/api/send',{agentId:'mx',content:'Hello from Symphony'});
    assert.equal(send.body.success,true);assert.equal(send.body.messageId,'$0');
    assert.equal(sent[0].content.body,'[Tester] Hello from Symphony');
    const history=await api('/api/messages/'+encodeURIComponent(room));
    assert.equal(history.body.messages[0].content,'Hello from Symphony');
    assert.equal(history.body.messages[0].agentName,'Tester');
    assert.ok(history.body.nextSince);
    await api('/api/leave/mx',{});
    assert.equal((await api('/api/messages/'+encodeURIComponent(room))).body.messages.length,1);
  });
  it('distinguishes invalid requests and unavailable cursors from backend outages',async()=>{
    const invalid=await api('/api/messages/'+encodeURIComponent(room)+'?limit=-1');assert.equal(invalid.status,400);
    const cursor='matrix-cursor:'+Buffer.from(JSON.stringify({room:'!test:example.test',event:'$missing'})).toString('base64url');
    const stale=await api('/api/messages/'+encodeURIComponent(room)+'?since='+encodeURIComponent(cursor));assert.equal(stale.status,410);assert.equal(stale.body.code,'MATRIX_CURSOR_UNAVAILABLE');
  });
  it('reports Matrix errors while native sending continues and auth still applies',async()=>{
    failed=true;
    assert.equal((await api('/api/messages/'+encodeURIComponent(room))).status,502);
    const listed=await api('/api/rooms'); assert.equal(listed.status,200); assert.ok(listed.body.rooms.some(r=>r.name==='native')); assert.ok(listed.body.backendErrors.matrix);
    assert.equal((await api('/api/send',{agentId:'native',content:'still works'})).body.success,true);
    const r=await fetch(base+'/api/rooms');assert.equal(r.status,401);
  });
});
