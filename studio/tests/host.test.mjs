import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {JobStore} from '../dist/job-store.js';
import {StudioHost} from '../dist/studio-host.js';

const plan={title:'柔和',analysis:{target:'阴天',reference:'无',adaptation:'提亮目标',skin:'保留'},scalars:[{key:'Exposure2012',mode:'delta',value:0.4}],curves:[],warnings:[]};
async function setup(t) {
  const dir=await mkdtemp(path.join(os.tmpdir(),'lr-studio-test-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const sourcePath=path.join(dir,'source.raw');await writeFile(sourcePath,'fixture');
  const source={id:1,path:sourcePath,filename:'source.raw',isVirtualCopy:false,developSettings:{exposure:1,temperature:5200}};
  const photos=new Map([[1,source]]),calls=[];
  const lr={
    keys:['Exposure2012','Temperature'],failWrite:false,stale:false,impostor:false,failRollback:false, mismatch:false,
    async discover(){return this.keys;},async selected(){return [{id:1}];},
    async metadata(id){return structuredClone(photos.get(Number(id)));},
    async preview(id){return Buffer.from(`render:${this.stale ? 1 : photos.get(Number(id)).developSettings.exposure}`);},
    async call(name,args){
      calls.push({name,args});
      if(name==='create_virtual_copies'){
        photos.set(2,{...structuredClone(source),id:2,isVirtualCopy:!this.impostor,virtualCopy:{masterPhotoId:1}});
        return {created:1,copies:[{photo_id:1,copy_id:2}]};
      }
      if(name==='create_develop_snapshot')return {success:true,snapshot:{id:'snapshot-1'}};
      if(name==='set_develop_settings'){
        if(this.failWrite)throw new Error('write failed');
        if(!this.mismatch) photos.get(2).developSettings.exposure=args.settings.Exposure2012;
        return {success:true};
      }
      if(name==='apply_develop_snapshot'){
        if(this.failRollback)throw new Error('rollback failed');
        photos.get(2).developSettings=structuredClone(source.developSettings);return {success:true};
      }
      throw new Error(name);
    },
  };
  let modelCalls=0;
  const model={async generate(){modelCalls++;return {plan:structuredClone(plan),threadId:'test-thread'};}};
  const store=new JobStore(path.join(dir,'jobs')),host=new StudioHost(lr,model,store,0);
  const capture=()=>host.capture({mode:'describe',prompt:'柔和高光',strength:0.5});
  return {dir,lr,source,photos,calls,host,store,capture,model,get modelCalls(){return modelCalls;}};
}

test('planning has no write calls; preview only writes verified copy and can restore it',async t=>{
  const f=await setup(t),job=await f.capture();
  const planned=await f.host.plan(job.id);
  assert.equal(planned.settings.Exposure2012,1.2);assert.equal(f.calls.length,0);
  const preview=await f.host.preview(job.id);
  assert.equal(preview.status,'previewed');assert.equal(f.source.developSettings.exposure,1);
  assert.equal(f.calls.find(c=>c.name==='set_develop_settings').args.photo_id,2);
  assert.equal((await readFile(path.join(f.store.dir(job.id),'after.jpg'))).toString(),'render:1.2');
  await assert.rejects(f.host.preview(job.id),/unapplied/);
  assert.equal((await f.host.restore(job.id)).status,'restored');assert.equal(f.photos.get(2).developSettings.exposure,1);
});
test('source edits made while model was running prevent preview before copy creation',async t=>{
  const f=await setup(t),job=await f.capture();await f.host.plan(job.id);
  f.source.developSettings.exposure=2;
  await assert.rejects(f.host.preview(job.id),/changed/);assert.equal(f.calls.length,0);
});
test('capability removed after planning is rejected before any mutation',async t=>{
  const f=await setup(t),job=await f.capture();await f.host.plan(job.id);f.lr.keys=[];
  await assert.rejects(f.host.preview(job.id),/Invalid grading/);assert.equal(f.calls.length,0);
});
test('a purported virtual copy is verified before snapshot/write',async t=>{
  const f=await setup(t),job=await f.capture();await f.host.plan(job.id);f.lr.impostor=true;
  await assert.rejects(f.host.preview(job.id),/identity/);
  assert.deepEqual(f.calls.map(c=>c.name),['create_virtual_copies']);
});
for(const failure of ['failWrite','mismatch','stale'])test(`${failure} records failure and restores the copy snapshot`,async t=>{
  const f=await setup(t),job=await f.capture();await f.host.plan(job.id);f.lr[failure]=true;
  await assert.rejects(f.host.preview(job.id));
  const saved=await f.store.load(job.id);
  assert.equal(saved.status,'failed');assert.equal(saved.copyId,2);assert.equal(saved.snapshotId,'snapshot-1');
  assert.ok(f.calls.some(c=>c.name==='apply_develop_snapshot'));assert.equal(f.source.developSettings.exposure,1);
});
test('failed automatic recovery preserves its error and allows explicit later recovery',async t=>{
  const f=await setup(t),job=await f.capture();await f.host.plan(job.id);f.lr.failWrite=true;f.lr.failRollback=true;
  await assert.rejects(f.host.preview(job.id));assert.match((await f.store.load(job.id)).recoveryError,/rollback failed/);
  f.lr.failRollback=false;assert.equal((await f.host.restore(job.id)).status,'restored');
});
test('job lock prevents duplicate side effects across concurrent preview requests',async t=>{
  const f=await setup(t),job=await f.capture();await f.host.plan(job.id);
  const results=await Promise.allSettled([f.host.preview(job.id),f.host.preview(job.id)]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(f.calls.filter(c=>c.name==='create_virtual_copies').length,1);
});
test('missing photo and invalid reference fail before calling AI',async t=>{
  const f=await setup(t);await rm(f.source.path);
  await assert.rejects(f.capture(),/unavailable/);assert.equal(f.modelCalls,0);
  await assert.rejects(f.host.capture({mode:'reference',prompt:'',strength:1}),/image path/);
});
test('non-image reference is rejected before creating a grading proposal',async t=>{
  const f=await setup(t),ref=path.join(f.dir,'ref.jpg');await writeFile(ref,'not an image');
  await assert.rejects(f.host.capture({mode:'reference',prompt:'',strength:1,reference:ref}),/JPEG/);assert.equal(f.modelCalls,0);
});
for(const mode of ['describe','lucky'])test(mode+' ignores a stale reference from another mode',async t=>{
  const f=await setup(t);
  const job=await f.host.capture({mode,prompt:'soft',strength:1,reference:path.join(f.dir,'deleted-reference.jpg')});
  assert.equal(job.request.reference,undefined);assert.equal(job.referenceFile,undefined);
  assert.equal((await f.host.plan(job.id)).status,'planned');
});
test('a cancelled generation saves an actionable message without creating a copy',async t=>{
  const f=await setup(t),job=await f.capture(),controller=new AbortController();
  f.model.generate=async()=>{controller.abort();throw new Error('AbortError: internal detail');};
  await assert.rejects(f.host.plan(job.id,controller.signal));
  assert.match((await f.store.load(job.id)).error,/生成已停止/);assert.equal(f.calls.length,0);
});

async function localSetup(t) {
  const f=await setup(t);
  const capabilities={subject:{exposure:[-0.5,0.5]},sky:{highlights:[-30,30]}};
  const localPlan={...plan,scalars:[],skinPresence:'uncertain',masks:[
    {kind:'subject',reason:'提亮主体',adjustments:[{key:'exposure',value:0.3}]},
    {kind:'sky',reason:'压低天空高光',adjustments:[{key:'highlights',value:-20}]},
  ]};
  const baseline=[{id:'existing',name:'原有蒙版',tools:[{id:'old-tool',subtype:'sky'}]}];
  let masks=structuredClone(baseline);
  const call=f.lr.call.bind(f.lr);
  f.lr.discoverMasks=async()=>capabilities;
  f.lr.preview=async id=>Buffer.from(`${f.photos.get(Number(id)).developSettings.exposure}:${Number(id)===1 ? baseline.length : masks.length}`);
  f.lr.call=async(name,args)=>{
    if (name==='apply_develop_snapshot') {
      const result=await call(name,args);
      masks=structuredClone(baseline);
      return result;
    }
    if (!['list_masks','create_mask','get_mask'].includes(name)) return call(name,args);
    f.calls.push({name,args});
    if (name==='list_masks') return {photo_id:args.photo_id,count:masks.length,masks:structuredClone(masks)};
    if (name==='get_mask') return {photo_id:args.photo_id,mask_id:args.mask_id,adjustments:{local_Exposure:0.15,local_Highlights:-10}};
    if (f.lr.failSky && args.type==='sky') throw new Error('no sky detected');
    masks.push({id:args.type,name:args.type,tools:[{id:`${args.type}-tool`,subtype:args.type}]});
    return {mask_id:args.type};
  };
  f.model.generate=async()=>({plan:structuredClone(localPlan)});
  const capture=()=>f.host.capture({mode:'describe',prompt:'局部',strength:0.5,localMasks:true});
  return {...f,capture,localPlan,capabilities,baseline};
}

test('mask-only preview verifies both sliders on the new copy and restores the original mask list',async t=>{
  const f=await localSetup(t),job=await f.capture();
  const planned=await f.host.plan(job.id);
  assert.deepEqual(planned.settings,{});
  assert.equal(f.calls.length,0);
  const preview=await f.host.preview(job.id);
  assert.deepEqual(preview.maskReadback.map(mask=>mask.adjustments),[{exposure:0.15},{highlights:-10}]);
  assert.deepEqual(preview.maskBaseline,f.baseline);
  assert.ok(f.calls.every(call=>call.name==='create_virtual_copies' || call.args.photo_id===2));
  assert.equal((await f.host.restore(job.id)).status,'restored');
});

test('second mask failure restores the first mask change and preserves the original mask',async t=>{
  const f=await localSetup(t),job=await f.capture();
  await f.host.plan(job.id);
  f.lr.failSky=true;
  await assert.rejects(f.host.preview(job.id),/no sky/);
  assert.equal(f.calls.at(-2).name,'apply_develop_snapshot');
  assert.equal(f.calls.at(-1).name,'list_masks');
  const failed=await f.store.load(job.id);
  assert.equal(failed.status,'failed');
  assert.equal(failed.recoveryError,undefined);
});

test('removed mask capability blocks preview before copy creation',async t=>{
  const f=await localSetup(t),job=await f.capture();
  await f.host.plan(job.id);
  f.lr.discoverMasks=async()=>({subject:f.capabilities.subject});
  await assert.rejects(f.host.preview(job.id),/不支持/);
  assert.equal(f.calls.length,0);
});

test('a changed source render blocks local preview before creating a copy even if global metadata is unchanged',async t=>{
  const f=await localSetup(t),job=await f.capture();
  await f.host.plan(job.id);
  f.lr.preview=async()=>Buffer.from('a different local edit');
  await assert.rejects(f.host.preview(job.id),/渲染图已变更/);
  assert.equal(f.calls.length,0);
});

test('an unapproved model mask is rejected, and opted-in skin protection bounds red/orange HSL',async t=>{
  const f=await localSetup(t);
  const ordinary=await f.host.capture({mode:'lucky',prompt:'',strength:1});
  await assert.rejects(f.host.plan(ordinary.id),/Invalid grading plan/);
  f.source.developSettings.HueAdjustmentOrange=5;
  f.lr.keys.push('HueAdjustmentOrange');
  f.localPlan.scalars=[{key:'HueAdjustmentOrange',mode:'absolute',value:40}];
  const job=await f.capture();
  assert.equal((await f.host.plan(job.id)).settings.HueAdjustmentOrange,8);
});

test('refinement carries prior mask sliders and can clear a selected mask without reapplying deltas',async t=>{
  const f=await localSetup(t),job=await f.capture();
  await f.host.plan(job.id);
  await f.host.preview(job.id);
  const refinement=await f.host.prepareRefinement(job.id,'撤掉天空蒙版',1,true);
  f.model.generate=async input=>{
    assert.equal(input.previousMasks[1].adjustments[0].value,-10);
    return {plan:{...f.localPlan,masks:[{kind:'sky',reason:'撤掉天空蒙版',adjustments:[{key:'highlights',value:0}]}]}};
  };
  const changed=await f.host.plan(refinement.id);
  assert.deepEqual(changed.masks.map(mask=>mask.kind),['subject']);
  assert.equal(changed.masks[0].adjustments[0].value,0.15);
});
