import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,symlink} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {JobStore} from '../dist/job-store.js';
import {StudioHost} from '../dist/studio-host.js';
import {WorkbenchServer} from '../dist/workbench-server.js';
import {StyleLibrary} from '../dist/style-library.js';
import {parseBatchPhotos} from '../dist/batch-queue.js';
import {LightroomOutcomeUnknown} from '../dist/lightroom.js';

const proposal=(key='Exposure2012',value=.4)=>({title:'自然海岸',analysis:{target:'目标光线',reference:'参考冷暖',adaptation:'柔和高光与冷暖关系',skin:'保留自然肤色'},scalars:[{key,mode:'delta',value}],curves:[],warnings:[]});
async function fixture(t,reference=false) {
  const dir=await mkdtemp(path.join(os.tmpdir(),'lr-conversation-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const sourcePath=path.join(dir,'source.raw');await writeFile(sourcePath,'fixture');
  const source={id:1,path:sourcePath,filename:'source.raw',isVirtualCopy:false,developSettings:{Exposure2012:1,Temperature:5200,Saturation:7}};
  const photos=new Map([[1,source]]),snapshots=new Map(),writes=[],inputs=[];let next=10;
  const lr={keys:['Exposure2012','Temperature','Saturation'],async discover(){return this.keys;},async selected(){return [{id:1}];},async metadata(id){return structuredClone(photos.get(Number(id)));},async preview(id){return Buffer.from(JSON.stringify(photos.get(Number(id)).developSettings));},async call(name,args){
    writes.push({name,args:structuredClone(args)});
    if(name==='create_virtual_copies'){const id=next++,original=photos.get(Number(args.photo_ids[0]));photos.set(id,{...structuredClone(original),id,isVirtualCopy:true,virtualCopy:{masterPhotoId:original.id}});return {created:1,copies:[{copy_id:id,photo_id:original.id}]};}
    const photo=photos.get(Number(args.photo_id));
    if(name==='create_develop_snapshot'){const id='snapshot-'+args.photo_id;snapshots.set(id,structuredClone(photo.developSettings));return {snapshot:{id}};}
    if(name==='set_develop_settings'){Object.assign(photo.developSettings,args.settings);return {success:true};}
    if(name==='apply_develop_snapshot'){photo.developSettings=structuredClone(snapshots.get(args.snapshot_id));return {success:true};}
    throw new Error(name);
  }};
  const model={next:proposal(),async generate(input){inputs.push(input);if(input.signal?.aborted)throw new Error('aborted');return {plan:structuredClone(this.next),threadId:'thread-'+inputs.length};}};
  const store=new JobStore(path.join(dir,'jobs')),host=new StudioHost(lr,model,store,0);
  let ref;
  if(reference){ref=path.join(dir,'reference.jpg');await writeFile(ref,Buffer.from([255,216,255,12,23]));}
  const job=await host.capture({mode:reference?'reference':'describe',prompt:'海岸柔和冷暖',strength:.5,reference:ref});
  await host.plan(job.id);
  return {dir,store,host,lr,model,source,photos,writes,inputs,job,ref};
}

async function batchFixture(t) {
  const f = await fixture(t, true);
  const second = {...structuredClone(f.source), id: 2, filename: 'second.raw'};
  second.developSettings.Exposure2012 = 2;
  f.photos.set(2, second);
  await f.host.preview(f.job.id);
  const style = await f.host.saveStyle(f.job.id, '批次风格');
  f.writes.length = 0;
  f.inputs.length = 0;
  return {...f, style, second};
}

test('batch is bounded, target-aware, read-only until preview, and reusable after restart', async t => {
  for (const invalid of [null, ['1'], ['1','1'], ['1', '01'], ['1', 2], Array.from({length: 9}, (_, i) => String(i + 1))]) {
    assert.throws(() => parseBatchPhotos(invalid));
  }
  const f = await batchFixture(t);
  const result = await f.host.batches.plan(f.style.id, ['1', '2'], undefined, new AbortController().signal, () => {});
  assert.equal(result.previewable, 2);
  assert.deepEqual(f.inputs.map(input => input.baseline.Exposure2012), [1, 2]);
  assert.equal(f.writes.length, 0);
  assert.ok(f.inputs.every(input => input.referenceImage));
  const restarted = new StudioHost(f.lr, f.model, new JobStore(f.store.root), 0);
  assert.equal((await restarted.batches.list())[0].id, result.id);
  const rendered = await restarted.batches.preview(result.id, () => {});
  assert.deepEqual(rendered.items.map(item => item.status), ['previewed', 'previewed']);
  assert.deepEqual(f.writes.filter(write => write.name === 'create_virtual_copies').map(write => write.args.photo_ids[0]), [1, 2]);
  assert.deepEqual(f.writes.filter(write => write.name === 'set_develop_settings').map(write => write.args.settings.Exposure2012), [1.2, 2.2]);
  await assert.rejects(restarted.batches.preview(result.id, () => {}), /没有可预览/);
  await restarted.restore(rendered.items[0].jobId);
  assert.deepEqual((await restarted.batches.show(result.id)).items.map(item => item.status), ['restored', 'previewed']);
  assert.equal(f.source.developSettings.Exposure2012, 1);
  assert.equal(f.second.developSettings.Exposure2012, 2);
});

test('batch preserves completed plans when stopped and records per-photo capture failure', async t => {
  const f = await batchFixture(t), controller = new AbortController();
  const stopped = await f.host.batches.plan(f.style.id, ['1', '2'], undefined, controller.signal, batch => {
    if (batch.progress.current === 2) controller.abort();
  });
  assert.equal(stopped.state, 'stopped');
  assert.deepEqual(stopped.items.map(item => item.status), ['planned', 'queued']);
  assert.equal(f.inputs.length, 1);
  const partial = await f.host.batches.plan(f.style.id, ['999', '2'], undefined, new AbortController().signal, () => {});
  assert.deepEqual(partial.items.map(item => item.status), ['failed', 'planned']);
  assert.ok(partial.items[0].detail);
  assert.equal(f.writes.length, 0);
});

test('stale sources are skipped but an uncertain copy creation blocks later writes in the batch', async t => {
  const f = await batchFixture(t);
  const plans = () => f.host.batches.plan(f.style.id, ['1', '2'], undefined, new AbortController().signal, () => {});
  const stale = await plans();
  f.source.developSettings.Exposure2012 = 1.3;
  const result = await f.host.batches.preview(stale.id, () => {});
  assert.deepEqual(result.items.map(item => item.status), ['preview-failed', 'previewed']);
  const batch = await plans();
  f.writes.length = 0;
  const call = f.lr.call;
  f.lr.call = async (name, args) => {
    if (name !== 'create_virtual_copies') return call(name, args);
    f.writes.push({name, args});
    throw new Error('reply lost after copy request');
  };
  const blocked = await f.host.batches.preview(batch.id, () => {});
  assert.equal(blocked.blockedByPhotoId, '1');
  assert.equal(blocked.previewable, 0);
  assert.equal(f.writes.length, 1);
  assert.deepEqual(blocked.items.map(item => item.status), ['failed', 'planned']);
  await assert.rejects(f.host.batches.preview(batch.id, () => {}), /批次已停止/);
});

test('batch stops when a write is unconfirmed even with a known recovery snapshot', async t => {
  const f = await batchFixture(t);
  const batch = await f.host.batches.plan(f.style.id, ['1', '2'], undefined, new AbortController().signal, () => {});
  const call = f.lr.call.bind(f.lr);
  f.lr.call = async (name, args) => {
    const reply = await call(name, args);
    if (name === 'set_develop_settings') throw new LightroomOutcomeUnknown('timeout_unknown');
    return reply;
  };
  const blocked = await f.host.batches.preview(batch.id, () => {});
  assert.equal(blocked.blockedByPhotoId, '1');
  assert.deepEqual(f.writes.map(write => write.name), ['create_virtual_copies', 'create_develop_snapshot', 'set_develop_settings']);
  assert.equal((await f.store.load(blocked.items[0].jobId)).outcomeUnknown, 'timeout_unknown');
  assert.equal(blocked.items[1].status, 'planned');
  f.lr.call = call;
  await f.host.restore(blocked.items[0].jobId);
  const afterRestore = await f.host.batches.preview(batch.id, () => {});
  assert.deepEqual(afterRestore.items.map(item => item.status), ['restored', 'previewed']);
});

test('after host restart a batch exposes interrupted writes before offering the next photo', async t => {
  const f = await batchFixture(t);
  const batch = await f.host.batches.plan(f.style.id, ['1', '2'], undefined, new AbortController().signal, () => {});
  const job = await f.store.load(batch.items[0].jobId);
  job.status = 'creating-copy';
  await f.store.save(job);
  const restarted = new StudioHost(f.lr, f.model, new JobStore(f.store.root), 0);
  const blocked = await restarted.batches.show(batch.id);
  assert.equal(blocked.blockedByPhotoId, '1');
  assert.equal(blocked.previewable, 0);
  await assert.rejects(restarted.batches.preview(batch.id, () => {}), /批次已停止/);
  assert.equal(f.writes.length, 0);
});

test('stopping a batch lets the current Lightroom write finish and leaves other photos ready', async t => {
  const f = await batchFixture(t), controller = new AbortController();
  const batch = await f.host.batches.plan(f.style.id, ['1', '2'], undefined, new AbortController().signal, () => {});
  const call = f.lr.call.bind(f.lr);
  f.lr.call = async (name, args) => {
    if (name === 'set_develop_settings') controller.abort();
    return call(name, args);
  };
  const stopped = await f.host.batches.preview(batch.id, () => {}, controller.signal);
  assert.equal(stopped.previewStopped, true);
  assert.deepEqual(stopped.items.map(item => item.status), ['previewed', 'planned']);
  assert.deepEqual(f.writes.map(write => write.name), ['create_virtual_copies', 'create_develop_snapshot', 'set_develop_settings']);
  assert.equal((await f.host.batches.show(batch.id)).previewStopped, true);
  const resumed = await f.host.batches.preview(batch.id, () => {});
  assert.equal(resumed.previewStopped, undefined);
  assert.deepEqual(resumed.items.map(item => item.status), ['previewed', 'previewed']);
});

test('damaged journals do not hide valid records or let history resolve outside the job store', async t => {
  const f = await batchFixture(t);
  const makeBatch = () => f.host.batches.plan(f.style.id, ['1', '2'], undefined, new AbortController().signal, () => {});
  const good = await makeBatch(), damaged = await makeBatch();
  const jobId = damaged.items[0].jobId;
  const jobFile = path.join(f.store.dir(jobId), 'job.json');
  const job = JSON.parse(await readFile(jobFile, 'utf8'));
  await writeFile(jobFile, JSON.stringify({ ...job, referenceFile: '../../other.jpg' }));
  await assert.rejects(f.store.load(jobId), /任务记录无效/);
  assert.ok(!(await f.store.list()).some(item => item.id === jobId));
  assert.ok((await f.store.list()).some(item => item.id === f.job.id));
  assert.equal((await f.host.batches.show(damaged.id)).items[0].status, 'failed');

  const saved = await f.host.saveStyle(f.job.id, '损坏记录');
  const styleFile = path.join(f.host.styles.dir(saved.id), 'style.json');
  const style = JSON.parse(await readFile(styleFile, 'utf8'));
  await writeFile(styleFile, JSON.stringify({ ...style, sourcePlan: { title: 'incomplete' } }));
  assert.deepEqual((await f.host.styles.list()).map(item => item.id), [f.style.id]);
  const batchFile = path.join(f.host.batches.dir(damaged.id), 'batch.json');
  const batch = JSON.parse(await readFile(batchFile, 'utf8'));
  await writeFile(batchFile, JSON.stringify({ ...batch, blockedByPhotoId: '999' }));
  assert.deepEqual((await f.host.batches.list()).map(item => item.id), [good.id]);

  await rm(f.store.dir(jobId), { recursive: true });
  await symlink(f.store.dir(f.job.id), f.store.dir(jobId), 'junction');
  await assert.rejects(f.store.load(jobId), /任务记录无效/);
});

test('refinement uses the actual prior render and retains unmentioned settings in a new copy',async t=>{
  const f=await fixture(t),first=await f.host.preview(f.job.id);
  f.model.next=proposal('Saturation',-10);
  const draft=await f.host.prepareRefinement(first.id,'降低饱和度，保留曝光',.5);
  assert.equal(f.writes.filter(w=>w.name==='create_virtual_copies').length,1);
  const second=await f.host.plan(draft.id);
  assert.deepEqual(second.settings,{Exposure2012:1.2,Saturation:2});
  assert.deepEqual(second.stepDiff,[{key:'Saturation',before:7,after:2}]);
  assert.equal(f.inputs[1].baseline.Exposure2012,1.2);
  assert.equal((await readFile(f.inputs[1].targetImage)).toString(),(await readFile(path.join(f.store.dir(first.id),'after.jpg'))).toString());
  const rendered=await f.host.preview(second.id);
  assert.notEqual(rendered.copyId,first.copyId);
  assert.equal(f.photos.get(first.copyId).developSettings.Saturation,7);
  assert.equal(f.source.developSettings.Exposure2012,1);
  await f.host.restore(second.id);
  assert.equal(f.photos.get(rendered.copyId).developSettings.Exposure2012,1);
  assert.equal((await f.store.load(first.id)).status,'previewed');
});

test('an older-result branch replays only its own lineage and recomputes carried settings',async t=>{
  const f=await fixture(t);await f.host.preview(f.job.id);
  f.model.next=proposal('Saturation',-8);
  const child=await f.host.prepareRefinement(f.job.id,'降低饱和度');await f.host.plan(child.id);await f.host.preview(child.id);
  const tampered=await f.store.load(f.job.id);tampered.settings.Exposure2012=4;await f.store.save(tampered);
  const branch=await f.host.prepareRefinement(f.job.id,'保留饱和度，仅微调曝光');f.model.next=proposal('Exposure2012',.1);await f.host.plan(branch.id);
  assert.equal(f.inputs.at(-1).history.length,1);
  assert.equal(f.inputs.at(-1).baseline.Exposure2012,1.2);
  assert.equal(f.inputs.at(-1).baseline.Saturation,7);
  assert.equal((await f.host.conversations()).length,1);
  assert.equal((await f.host.conversation(branch.id)).jobs.length,3);
  const restarted=new StudioHost(f.lr,f.model,new JobStore(f.store.root),0);
  assert.equal((await restarted.chain(branch.id)).length,2);
});

test('refinement refuses unrendered or changed source and unavailable inherited capabilities',async t=>{
  const f=await fixture(t);
  await assert.rejects(f.host.prepareRefinement(f.job.id,'再亮一点'),/完成上一轮预览/);
  await f.host.preview(f.job.id);const count=f.writes.length;
  f.source.developSettings.Exposure2012=2;
  await assert.rejects(f.host.prepareRefinement(f.job.id,'再亮一点'),/源照片已变更/);
  f.source.developSettings.Exposure2012=1;f.lr.keys=['Saturation'];
  await assert.rejects(f.host.prepareRefinement(f.job.id,'再亮一点'),/Invalid grading/);
  assert.equal(f.writes.length,count);
});

test('cancelled refinement preserves the prior result and creates no new Lightroom resource',async t=>{
  const f=await fixture(t);await f.host.preview(f.job.id);const count=f.writes.length;
  const child=await f.host.prepareRefinement(f.job.id,'保留自然颜色');
  await assert.rejects(f.host.plan(child.id,AbortSignal.abort()));
  const failed=await f.store.load(child.id);
  assert.match(failed.error,/生成已停止/);assert.equal(failed.copyId,undefined);
  assert.equal((await f.store.load(f.job.id)).status,'previewed');assert.equal(f.writes.length,count);
});

test('invalid or cyclic conversation lineage fails before model or Lightroom writes',async t=>{
  const f=await fixture(t);const job=await f.store.load(f.job.id);job.parentJobId=job.id;await f.store.save(job);
  await assert.rejects(f.host.chain(job.id),/会话链/);
  assert.equal(f.writes.length,0);
});

test('saved reference styles own their image and regenerate against the new target baseline',async t=>{
  const f=await fixture(t,true);await f.host.preview(f.job.id);
  const style=await f.host.saveStyle(f.job.id,'自然海岸');
  assert.equal(style.hasReference,true);assert.equal((await f.host.styles.list()).length,1);
  await rm(f.ref);await rm(path.join(f.store.dir(f.job.id),'reference.jpg'));
  assert.deepEqual(await readFile(style.referencePath),Buffer.from([255,216,255,12,23]));
  f.source.developSettings.Exposure2012=-1;
  const applied=await f.host.captureStyle(style.id,'1',.5);await f.host.plan(applied.id);
  assert.equal(f.inputs.at(-1).baseline.Exposure2012,-1);
  assert.equal((await f.store.load(applied.id)).settings.Exposure2012,-.8);
  assert.equal(f.inputs.at(-1).history.length,0);
  assert.match(f.inputs.at(-1).request.prompt,/按新目标/);
  assert.equal(f.writes.filter(w=>w.name==='create_virtual_copies').length,1);
});

test('style validation rejects unpreviewed results, invalid names and path traversal records',async t=>{
  const f=await fixture(t);
  await assert.rejects(f.host.saveStyle(f.job.id,'name'),/完成预览/);
  await f.host.preview(f.job.id);
  await assert.rejects(f.host.saveStyle(f.job.id,' '),/名称/);
  const style=await f.host.saveStyle(f.job.id,'文字风格');assert.equal(style.hasReference,false);
  const file=path.join(f.host.styles.dir(style.id),'style.json'),raw=JSON.parse(await readFile(file,'utf8'));
  raw.referenceFile='../../outside.jpg';await writeFile(file,JSON.stringify(raw));
  await assert.rejects(new StyleLibrary(f.host.styles.root).load(style.id),/记录无效/);
  assert.deepEqual(await f.host.styles.list(),[]);
});

test('authenticated local API lists durable history and styles and bounds new action inputs',async t=>{
  const f=await fixture(t);await f.host.preview(f.job.id);await f.host.saveStyle(f.job.id,'海岸');
  const config=path.join(f.dir,'host.json'),server=new WorkbenchServer(f.host,config);await server.start();t.after(()=>server.stop());
  const {url,token}=JSON.parse(await readFile(config,'utf8'));
  const get=async route=>fetch(url+route,{headers:{'X-Studio-Token':token}});
  assert.equal((await get('/workspace')).status,200);
  const workspace=await (await get('/workspace')).json();assert.equal(workspace.conversations.length,1);assert.equal(workspace.styles.length,1);
  assert.equal((await (await get('/conversations/'+f.job.id)).json()).jobs[0].id,f.job.id);
  assert.equal((await fetch(url+'/workspace')).status,403);
  const invalid=await fetch(url+'/tasks',{method:'POST',headers:{'X-Studio-Token':token,'Content-Type':'application/json'},body:JSON.stringify({action:'refine',jobId:f.job.id,feedback:'',strength:1})});
  assert.equal(invalid.status,400);
  const run=async body=>{
    const response=await fetch(url+'/tasks',{method:'POST',headers:{'X-Studio-Token':token,'Content-Type':'application/json'},body:JSON.stringify(body)});
    assert.equal(response.status,202);
    let task=await response.json();
    for(let n=0;n<200 && task.state==='running';n++){await new Promise(resolve=>setTimeout(resolve,5));task=await (await get('/tasks/'+task.id)).json();}
    assert.equal(task.state,'completed',task.error);return task.job;
  };
  f.model.next=proposal('Saturation',-4);
  const child=await run({action:'refine',jobId:f.job.id,feedback:'稍微降低饱和度',strength:1});
  assert.equal(child.parentJobId,f.job.id);assert.equal(child.revision,2);
  assert.match(child.stepDiff,/Saturation/);
  assert.equal(child.displayStepDiff,'饱和度  7 → 3');
  assert.match(child.displayAnalysis,/目标照片/);
  await run({action:'preview',jobId:child.id});
  await run({action:'save-style',jobId:child.id,name:'第二轮风格'});
  const styles=(await (await get('/workspace')).json()).styles;
  assert.equal(styles.length,2);
  const adapted=await run({action:'apply-style',styleId:styles[0].id,photoId:'1',strength:.6});
  assert.equal(adapted.revision,1);assert.equal(adapted.parentJobId,undefined);
  assert.equal((await f.host.conversations()).length,2);
});
