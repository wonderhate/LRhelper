import {test} from 'node:test';
import assert from 'node:assert/strict';
import {standaloneEnvironment,applySystemProxy} from '../dist/runtime-environment.js';

test('standalone child retains auth location and removes parent desktop session/IPC',()=>{
  assert.deepEqual(standaloneEnvironment({PATH:'node',CODEX_HOME:'home',CODEX_API_KEY:'credential',OPENAI_API_KEY:'other',CODEX_THREAD_ID:'parent',CODEX_APP_TOOLS_PIPE_PATH:'pipe',CODEX_INTERNAL_ORIGINATOR_OVERRIDE:'parent',empty:undefined}),{PATH:'node',CODEX_HOME:'home',CODEX_API_KEY:'credential',OPENAI_API_KEY:'other'});
});
test('enabled Windows shared proxy is applied only to the child environment',()=>{
  const env={PATH:'node'};
  assert.deepEqual(applySystemProxy(env,{enabled:true,server:'127.0.0.1:7892'}),{PATH:'node',HTTP_PROXY:'http://127.0.0.1:7892',HTTPS_PROXY:'http://127.0.0.1:7892'});
  assert.deepEqual(env,{PATH:'node'});
});
test('per-protocol proxies and explicit environment overrides take precedence',()=>{
  assert.deepEqual(applySystemProxy({HTTPS_PROXY:'http://explicit:80'},{enabled:true,server:'http=local:12;https=local:13'}),{HTTP_PROXY:'http://local:12',HTTPS_PROXY:'http://explicit:80'});
  assert.deepEqual(applySystemProxy({all_proxy:'socks5://explicit:80'},{enabled:true,server:'local:12'}),{all_proxy:'socks5://explicit:80'});
});
test('disabled, invalid and opted-out proxies are ignored',()=>{
  for(const proxy of [{enabled:false,server:'local:12'},{enabled:true},{enabled:true,server:'http://[invalid'}]) assert.deepEqual(applySystemProxy({},proxy),{});
  assert.deepEqual(applySystemProxy({STUDIO_USE_SYSTEM_PROXY:'0'},{enabled:true,server:'local:12'}),{STUDIO_USE_SYSTEM_PROXY:'0'});
});
