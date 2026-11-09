import { access } from "node:fs/promises";
import { LightroomClient } from "./lightroom.js";
import { runtimeEnvironment } from "./runtime-environment.js";
import { checkCodex } from "./runtime-isolation.js";
import type { loadConfiguration } from "./configuration.js";

export async function preflight(config: Awaited<ReturnType<typeof loadConfiguration>>) {
  const codex = checkCodex(config.codexPath,await runtimeEnvironment())
    .then(value=>({ok:true,...value}),error=>({ok:false,message:(error as Error).message}));
  const bridge = (async ()=>{
    const client = new LightroomClient(config.mcpEntry,true);
    try {
      await access(config.mcpEntry);
      await client.connect();
      const status = await client.bridgeStatus();
      return { ...status, ok: status.compatible === true };
    } catch {
      return {ok:false,message:"无法检查 Lightroom MCP。请确认服务端已安装、两个端口有效且不同，并关闭占用连接的旧版客户端。"};
    } finally {
      await client.close().catch(()=>{});
    }
  })();
  const [codexResult,bridgeResult] = await Promise.all([codex,bridge]);
  const node = { version:process.versions.node, arch:process.arch, platform:process.platform,
    ok:Number(process.versions.node.split(".")[0])>=22 };
  return {ok:node.ok && codexResult.ok && bridgeResult.ok,node,codex:codexResult,bridge:bridgeResult};
}
