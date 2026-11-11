import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
const require=createRequire(import.meta.url);
async function check(file,legacy=false){
 const urls=[],timers=[];let round=0;
 const context={require:name=>name==='fs'?{readFileSync(){throw Error('No test config')}}:require(name),process:{argv:['node',file,'--url','http://test.invalid','--room','matrix:!room:example','--since','2026-11-11T00:00:00.000Z'],env:{HOME:'/nonexistent'},exit(){throw Error('exit')}},console:{log(){},error(){}},setTimeout:fn=>{timers.push(fn);return 1},clearTimeout(){},AbortSignal,URLSearchParams,fetch:async url=>{urls.push(new URL(url));round++;return{ok:true,status:200,json:async()=>({messages:round===1?[{timestamp:'2026-11-11T01:00:00.000Z',agentName:'Other',content:'one'}]:[],...(legacy?{}:{nextSince:round===1?'matrix-cursor:page1':'matrix-cursor:empty'})})}}};
 await vm.runInNewContext(fs.readFileSync(file,'utf8'),context,{filename:file});
 await timers.shift()();
 assert.equal(urls[1].searchParams.get('since'),legacy?'2026-11-11T01:00:00.000Z':'matrix-cursor:page1');
 if(!legacy){await timers.shift()();assert.equal(urls[2].searchParams.get('since'),'matrix-cursor:empty');}
}
const watcher=fileURLToPath(new URL('../scripts/groupmind-watch/groupmind-watch.cjs',import.meta.url));
test('watcher preserves opaque and empty-page server cursors',()=>check(watcher));
test('watcher retains timestamp fallback for older servers',()=>check(watcher,true));

test('watcher reports an unavailable Matrix cursor and stops without resetting it',async()=>{
 const output=[],timers=[],calls=[];
 const context={require:name=>name==='fs'?{readFileSync(){throw Error('no config')}}:require(name),process:{argv:['node',watcher,'--url','http://test.invalid','--since','matrix-cursor:missing'],env:{HOME:'/nonexistent'}},console:{log:m=>output.push(m),error:m=>output.push(m)},setTimeout:fn=>{timers.push(fn);return 1},clearTimeout(){},AbortSignal,URLSearchParams,fetch:async url=>{calls.push(new URL(url));return new Response(JSON.stringify({code:'MATRIX_CURSOR_UNAVAILABLE',error:'Saved Matrix cursor event is no longer available'}),{status:410,headers:{'content-type':'application/json'}})}};
 await vm.runInNewContext(fs.readFileSync(watcher,'utf8'),context,{filename:watcher});
 assert.equal(calls.length,1);assert.equal(calls[0].searchParams.get('since'),'matrix-cursor:missing');
 assert.equal(context.process.exitCode,1);assert.equal(timers.length,0);assert.ok(output.some(s=>s.includes('cursor event is no longer available')));
});
