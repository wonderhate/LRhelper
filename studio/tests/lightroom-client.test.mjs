import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LightroomClient } from '../dist/lightroom.js';

test('the real MCP child receives bridge settings without API keys or unrelated credentials', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'lr-mcp-env-'));
  const keys = {
    OPENAI_API_KEY: 'test-openai-key',
    CODEX_API_KEY: 'test-codex-key',
    GH_TOKEN: 'test-github-token',
    NODE_OPTIONS: '--trace-warnings',
    LIGHTROOM_MCP_REQUEST_PORT: '58763',
    LIGHTROOM_MCP_TOKEN_PATH: path.join(directory, 'token'),
  };
  const previous = Object.fromEntries(Object.keys(keys).map(key => [key, process.env[key]]));
  Object.assign(process.env, keys);
  const entry = path.join(directory, 'mock-bridge.mjs'), observed = path.join(directory, 'environment.json');
  const client = new LightroomClient(entry);
  t.after(async () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await client.close();
    await rm(directory, { recursive: true, force: true });
  });
  await writeFile(entry, [
    "import { writeFileSync } from 'node:fs';",
    "import { createInterface } from 'node:readline';",
    "writeFileSync(" + JSON.stringify(observed) + ", JSON.stringify(process.env));",
    "createInterface({ input: process.stdin }).on('line', line => {",
    "  const request = JSON.parse(line);",
    "  if (request.method !== 'initialize') return;",
    "  const result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'test', version: '1' } };",
    "  console.log(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));",
    "});",
  ].join('\n'));
  await client.connect();
  const env = JSON.parse(await readFile(observed, 'utf8'));
  for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'GH_TOKEN', 'NODE_OPTIONS']) assert.equal(env[key], undefined);
  assert.equal(env.LIGHTROOM_MCP_REQUEST_PORT, keys.LIGHTROOM_MCP_REQUEST_PORT);
  assert.equal(env.LIGHTROOM_MCP_TOKEN_PATH, keys.LIGHTROOM_MCP_TOKEN_PATH);
  assert.equal(env.LIGHTROOM_MCP_TOOLSETS, 'all');
});
