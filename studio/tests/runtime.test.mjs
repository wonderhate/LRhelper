import {test} from 'node:test';
import assert from 'node:assert/strict';
import {CodexRuntime} from '../dist/codex-runtime.js';
import {modelOnlyOverrides} from '../dist/runtime-isolation.js';
const prepare=async()=>({env:{},configOverrides:[...modelOnlyOverrides,'mcp_servers."lightroom".enabled=false']});
class TestRuntime extends CodexRuntime { constructor(factory){super(factory,prepare);} }

const input={request:{mode:'reference',prompt:'保留自然肤色',strength:0.7},photo:{id:1},baseline:{Exposure2012:0},keys:['Exposure2012'],targetImage:'C:/jobs/before.jpg',referenceImage:'C:/jobs/reference.jpg'};
test('SDK receives target before reference, strict schema and per-call tool isolation',async()=>{
  let config,threadOptions,content,turnOptions;
  const runtime=new TestRuntime(options=>{
    config=options;
    return {startThread(options){
      threadOptions=options;
      return {id:'sdk-thread',async runStreamed(images,options){
        content=images;turnOptions=options;
        return {events:(async function*(){yield {type:'item.completed',item:{type:'agent_message',text:'{"title":"test"}'}};})()};
      }};
    }};
  });
  const result=await runtime.generate(input);
  assert.deepEqual(content.filter(c=>c.type==='local_image').map(c=>c.path),[input.targetImage,input.referenceImage]);
  assert.equal(threadOptions.sandboxMode,'read-only');assert.equal(threadOptions.webSearchMode,'disabled');assert.equal(threadOptions.networkAccessEnabled,false);
  assert.ok(config.configOverrides.includes('mcp_servers."lightroom".enabled=false'));assert.ok(config.configOverrides.includes('features.shell_tool=false'));
  assert.equal(turnOptions.outputSchema.additionalProperties,false);assert.ok(turnOptions.signal);
  assert.equal(result.threadId,'sdk-thread');assert.deepEqual(result.plan,{title:'test'});
});
for(const event of [{type:'turn.failed',error:{message:'provider unavailable'}},{type:'error',message:'provider unavailable'}])test(`${event.type} does not produce a usable grading plan`,async()=>{
  const runtime=new TestRuntime(()=>({startThread:()=>({id:'x',runStreamed:async()=>({events:(async function*(){yield event;})()})})}));
  await assert.rejects(runtime.generate(input),/provider unavailable/);
});
test('cancelled requests never start an SDK subprocess',async()=>{
  let started=false;
  const runtime=new TestRuntime(()=>{started=true;throw new Error('must not start');});
  await assert.rejects(runtime.generate({...input,signal:AbortSignal.abort()}));assert.equal(started,false);
});
test('empty SDK completion is rejected',async()=>{
  const runtime=new TestRuntime(()=>({startThread:()=>({id:'x',runStreamed:async()=>({events:(async function*(){})()})})}));
  await assert.rejects(runtime.generate(input),/no grading plan/);
});
test('bounded SDK reconnect notices do not discard a later valid completion',async()=>{
  const runtime=new TestRuntime(()=>({startThread:()=>({id:'x',runStreamed:async()=>({events:(async function*(){
    yield {type:'error',message:'Reconnecting... 2/5 (request timed out)'};
    yield {type:'item.completed',item:{type:'agent_message',text:'{"ok":true}'}};
  })()})})}));
  assert.deepEqual((await runtime.generate(input)).plan,{ok:true});
});
test('non-reference runtime attaches only the target even if handed a stale reference',async()=>{
  let attached;
  const runtime=new TestRuntime(()=>({startThread:()=>({id:'x',runStreamed:async content=>{
    attached=content;return {events:(async function*(){yield {type:'item.completed',item:{type:'agent_message',text:'{"ok":true}'}};})()};
  }})}));
  await runtime.generate({...input,request:{...input.request,mode:'lucky'}});
  assert.deepEqual(attached.filter(item=>item.type==='local_image').map(item=>item.path),[input.targetImage]);
});
