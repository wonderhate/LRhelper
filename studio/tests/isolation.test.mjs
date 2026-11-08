import {test} from 'node:test';
import assert from 'node:assert/strict';
import {isolatedMcpOverrides} from '../dist/runtime-isolation.js';

test('inherited MCP servers are explicitly disabled and discovery is verified',async()=>{
  const calls=[];
  const values=await isolatedMcpOverrides(async args=>{
    calls.push(args);
    return args[0]==='mcp' ? [{name:'lightroom',enabled:true},{name:'with.dots',enabled:true}] : [{name:'lightroom',enabled:false},{name:'with.dots',enabled:false}];
  });
  assert.equal(values.length,1);
  assert.ok(values[0].includes('"lightroom"={command='));
  assert.ok(values[0].includes('"with.dots"={command='));
  assert.equal((values[0].match(/enabled=false/g)||[]).length,2);
  assert.deepEqual(calls[1],['-c',values[0],'mcp','list','--json']);
});
test('a still-enabled or newly discovered server fails closed',async()=>{
  let calls=0;
  await assert.rejects(isolatedMcpOverrides(async()=>++calls===1 ? [] : [{name:'unexpected',enabled:true}]),/Cannot verify/);
});
