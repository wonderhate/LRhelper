import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,access} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {WorkbenchServer,parseGenerateRequest} from '../dist/workbench-server.js';

const job={id:'00000000-0000-0000-0000-000000000001',status:'captured',source:{id:1,filename:'fixture.raw'}};
async function setup(t,hostOverrides={}) {
  const dir=await mkdtemp(path.join(os.tmpdir(),'studio-http-'));
  const host={store:{dir: id=>{if(!/^[0-9a-f-]{36}$/.test(id))throw new Error('Invalid job ID');return path.join(dir,id);},load:async()=>job},capture:async()=>job,plan:async()=>({...job,status:'planned'}),preview:async()=>({...job,status:'previewed'}),restore:async()=>({...job,status:'restored'}),...hostOverrides};
  const configPath=path.join(dir,'host.json'),server=new WorkbenchServer(host,configPath);
  const {url}=await server.start();const config=JSON.parse(await readFile(configPath,'utf8'));
  const request=(route,options={})=>fetch(url+route,{...options,headers:{'X-Studio-Token':config.token,'Content-Type':'application/json',...options.headers}});
  t.after(async()=>{await server.stop();await rm(dir,{recursive:true,force:true});});
  return {url,request,server,configPath};
}
test('local API requires token and rejects browser-origin requests',async t=>{
  const f=await setup(t);
  assert.equal((await fetch(f.url+'/health')).status,403);
  assert.equal((await f.request('/health',{headers:{Origin:'https://example.com'}})).status,403);
  assert.equal((await f.request('/health')).status,200);
});
test('XMP export accepts only a saved style ID and a single authenticated output field', async t => {
  const calls = [];
  const f = await setup(t, {styles: {exportXmp: async (id, output) => {
    calls.push([id, output]);
    return {path: output, keys: ['Shadows2012']};
  }}});
  const output = path.join(os.tmpdir(), 'fixture.xmp');
  const route = '/styles/' + job.id + '/xmp';
  const options = {method: 'POST', body: JSON.stringify({output})};
  assert.equal((await fetch(f.url + route, options)).status, 403);
  assert.equal((await f.request('/styles/not-an-id/xmp', options)).status, 404);
  assert.equal((await f.request(route, {...options, body: JSON.stringify({output, settings: {}})})).status, 400);
  const response = await f.request(route, options);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {path: output, keys: ['Shadows2012']});
  assert.deepEqual(calls, [[job.id, output]]);
});
test('request validation rejects unsupported modes, oversized inputs and invalid reference paths',()=>{
  for(const request of [null,{}, {mode:'fake',prompt:'x',strength:1},{mode:'describe',prompt:'',strength:1},{mode:'reference',prompt:'',strength:1,reference:'relative.jpg'},{mode:'lucky',prompt:'',strength:NaN},{mode:'lucky',prompt:'',strength:1,settings:{}}]) assert.throws(()=>parseGenerateRequest(request));
  assert.equal(parseGenerateRequest({mode:'lucky',prompt:'',strength:0.6}).strength,0.6);
  assert.equal(parseGenerateRequest({mode:'lucky',prompt:'',strength:0.6,reference:'old-relative-path.jpg'}).reference,undefined);
});
test('two concurrent requests cannot both claim the Lightroom operation slot',async t=>{
  let release;
  const f=await setup(t,{capture:()=>new Promise(resolve=>{release=()=>resolve(job);})});
  const requests=await Promise.all([f.request('/tasks',{method:'POST',body:JSON.stringify({action:'capture'})}),f.request('/tasks',{method:'POST',body:JSON.stringify({action:'capture'})})]);
  assert.deepEqual(requests.map(r=>r.status).sort(),[202,409]);release();
});
test('generation is cancellable; writes cannot be interrupted through cancel endpoint',async t=>{
  let entered;
  const generating=new Promise(resolve=>{entered=resolve;});
  const f=await setup(t,{plan:async(_id,signal)=>{entered();return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(new Error('cancelled')),{once:true}));}});
  assert.equal((await f.request('/cancel',{method:'POST',body:'{}'})).status,409);
  const started=await (await f.request('/tasks',{method:'POST',body:JSON.stringify({action:'generate',request:{mode:'lucky',prompt:'',strength:1}})})).json();
  await generating;
  assert.equal((await f.request('/cancel',{method:'POST',body:'{}'})).status,200);
  await new Promise(resolve=>setTimeout(resolve,10));
  const task=await (await f.request('/tasks/'+started.id)).json();
  assert.equal(task.state,'failed');assert.match(task.error,/已停止/);
});
test('invalid operation and job selectors fail before reaching the host',async t=>{
  const f=await setup(t);
  for(const body of [{action:'delete'},{action:'preview',jobId:'../../other'},{action:'capture',photoId:'file://x'}]) assert.equal((await f.request('/tasks',{method:'POST',body:JSON.stringify(body)})).status,400);
  assert.equal((await f.request('/tasks/00000000-0000-0000-0000-000000000000')).status,404);
});
test('stopping an idle server removes its own discovery/token file',async t=>{
  const f=await setup(t);await f.server.stop();await assert.rejects(access(f.configPath));
});
test('starting a second host does not replace a live discovery/token file',async t=>{
  const f=await setup(t),before=await readFile(f.configPath,'utf8');
  const duplicate=new WorkbenchServer({},f.configPath);
  await assert.rejects(duplicate.start(),/已在运行/);
  assert.equal(await readFile(f.configPath,'utf8'),before);
});
test('failed preview returns the persisted recovery state for the UI',async t=>{
  const failed={...job,status:'failed',copyId:2,snapshotId:'snapshot',error:'write failed'};
  const f=await setup(t,{store:{dir:id=>path.join(os.tmpdir(),id),load:async()=>failed},preview:async()=>{throw new Error('write failed');}});
  const started=await (await f.request('/tasks',{method:'POST',body:JSON.stringify({action:'preview',jobId:job.id})})).json();
  const task=await (await f.request('/tasks/'+started.id)).json();
  assert.equal(task.state,'failed');assert.equal(task.job.canRestore,true);assert.equal(task.job.status,'failed');
});
