import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { loadConfiguration } from '../dist/configuration.js';

test('installed settings live beside the release and allow existing environment overrides', async t=>{
  const install=await mkdtemp(path.join(os.tmpdir(),'studio install '));
  t.after(()=>rm(install,{recursive:true,force:true}));
  const root=path.join(install,'current');
  await mkdir(root);
  await writeFile(path.join(root,'release.json'),'{}');
  const settings=path.join(install,'settings.json');
  await writeFile(settings,'\uFEFF'+JSON.stringify({codexPath:path.join(install,'codex.exe'),model:'configured',useSystemProxy:false}));
  const config=await loadConfiguration(root,{STUDIO_CODEX_MODEL:'override'});
  assert.equal(config.settingsFile,settings);
  assert.equal(config.jobsDirectory,path.join(install,'data','jobs'));
  assert.equal(config.codexPath,path.join(install,'codex.exe'));
  assert.equal(config.model,'override');
  assert.equal(config.useSystemProxy,false);
});

test('an explicit unreadable settings file or relative settings path fails before launch', async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'studio config '));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const settings=path.join(root,'settings.json');
  await assert.rejects(loadConfiguration(root,{STUDIO_SETTINGS_FILE:settings}),/无法读取 Studio 配置/);
  await writeFile(settings,JSON.stringify({jobsDirectory:'relative/jobs'}));
  await assert.rejects(loadConfiguration(root,{STUDIO_SETTINGS_FILE:settings}),/jobsDirectory 需要绝对路径/);
});
