// Real Lightroom integration smoke. No AI-quality claim: a deterministic small
// exposure change isolates the copy/snapshot/readback/render/recovery pipeline.
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {mkdir,writeFile} from 'node:fs/promises';
import {parseArgs} from 'node:util';
import {LightroomClient} from '../dist/lightroom.js';
import {StudioHost} from '../dist/studio-host.js';
import {JobStore} from '../dist/job-store.js';
import {fingerprint} from '../dist/grading/settings.js';

const {values}=parseArgs({options:{photo:{type:'string'},'write-copy':{type:'boolean'}}});
if(!values.photo) throw new Error('Supply --photo with a known local practice photo ID');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const store=new JobStore(path.join(root,'.studio/jobs'));
const lr=new LightroomClient(path.join(root,'server/dist/index.js'));
const model={async generate(){return {plan:{title:'Integration smoke: +0.15 EV',analysis:{target:'Controlled integration test',reference:'None',adaptation:'A bounded target-relative exposure change',skin:'Visual inspection required'},scalars:[{key:'Exposure2012',mode:'delta',value:0.15}],curves:[],warnings:['Deterministic test fixture; not AI grading.']}};}};
const host=new StudioHost(lr,model,store);
try {
  await lr.connect();
  const job=await host.capture({mode:'lucky',prompt:'Integration smoke',strength:1},values.photo);
  if(!values['write-copy']) {console.log(JSON.stringify({ok:true,captureId:job.id,wrotePhoto:false}));}
  else {
    await host.plan(job.id);
    const preview=await host.preview(job.id);
    const unchanged=fingerprint(await lr.metadata(job.source.id))===job.sourceFingerprint;
    const restored=await host.restore(job.id);
    if(!unchanged || restored.status!=='restored') throw new Error('Source integrity / recovery failed');
    const result={ok:true,kind:'deterministic Lightroom pipeline smoke (not AI)',jobId:job.id,sourceId:job.source.id,copyId:preview.copyId,snapshotId:preview.snapshotId,sourceUnchanged:unchanged,restored:true,artifacts:store.dir(job.id)};
    await mkdir(path.join(root,'.studio/validation'),{recursive:true});
    await writeFile(path.join(root,'.studio/validation/preview-run.json'),JSON.stringify(result,null,2));
    console.log(JSON.stringify(result,null,2));
  }
} finally {await lr.close();}
