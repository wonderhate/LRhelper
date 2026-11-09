import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CodexOptions } from "@openai/codex-sdk";
import { runtimeEnvironment } from "./runtime-environment.js";

const execute = promisify(execFile);
export const modelOnlyOverrides = [
  "features.apps=false", "features.plugins=false", "features.remote_plugin=false",
  "features.hooks=false", "features.shell_tool=false", "features.unified_exec=false",
  "features.multi_agent=false", "features.computer_use=false", "features.browser_use=false",
  "project_doc_max_bytes=0",
];

type ConfiguredServer = {name: string; enabled: boolean};
type Query = (args: string[])=>Promise<ConfiguredServer[]>;

export async function checkCodex(cli: string, env: Record<string,string>) {
  let version: string;
  try {
    const result = await execute(cli,["--version"],{env,windowsHide:true,timeout:5000,maxBuffer:64*1024});
    const match = /^codex(?:-cli)?\s+([\d.]+(?:[-+][\w.-]+)?)/i.exec(result.stdout.trim());
    if (!match) throw new Error("Unrecognized version");
    version = match[1];
  } catch {
    throw new Error("找不到可用的 Codex CLI。请安装 CLI，或在设置中指定 codexPath。");
  }
  if (!env.CODEX_API_KEY && !env.OPENAI_API_KEY) {
    try {
      await execute(cli,["login","status"],{env,windowsHide:true,timeout:5000,maxBuffer:64*1024});
    } catch {
      throw new Error("Codex CLI 尚未登录。请在 PowerShell 中运行 codex login。");
    }
  }
  return { version, proxyConfigured: !!(env.HTTPS_PROXY || env.HTTP_PROXY || env.ALL_PROXY || env.https_proxy || env.http_proxy || env.all_proxy) };
}

/** Empty TOML tables merge with inherited config; disable every discovered server explicitly. */
export async function isolatedMcpOverrides(query: Query): Promise<string[]> {
  const servers = await query(["mcp","list","--json"]);
  if (!Array.isArray(servers) || servers.some(s=>typeof s.name!=="string" || !s.name)) throw new Error("Invalid MCP discovery response");
  // Codex replaces each server entry atomically across config layers. A lone
  // enabled=false loses its required transport; use inert complete entries.
  // Names are TOML keys in the VALUE, not dotted override paths.
  const names = [...new Set(servers.map(s=>s.name))];
  const entries = names.map(name=>`${JSON.stringify(name)}={command=${JSON.stringify(process.execPath)},enabled=false}`);
  const overrides = [`mcp_servers={${entries.join(",")}}`];
  const args = overrides.flatMap(value=>["-c",value]);
  const verified = await query([...args,"mcp","list","--json"]);
  if (!Array.isArray(verified) || verified.some(s=>s.enabled !== false)) throw new Error("Cannot verify model-only MCP isolation");
  return overrides;
}

export async function prepareCodexRuntime(): Promise<CodexOptions> {
  const env = await runtimeEnvironment();
  const cli = process.env.STUDIO_CODEX_PATH ?? process.env.CODEX_APP_RUNTIME_CLI_PATH ?? "codex";
  await checkCodex(cli,env);
  try {
    const overrides = await isolatedMcpOverrides(async args=>{
      const {stdout} = await execute(cli,args,{env,windowsHide:true,timeout:5000,maxBuffer:2*1024*1024});
      return JSON.parse(stdout) as ConfiguredServer[];
    });
    return {env,codexPathOverride:cli,configOverrides:[...modelOnlyOverrides,...overrides]};
  } catch {
    // CLI discovery can include private server configuration. Do not copy its output into a job/log.
    throw new Error("无法确认 Codex 工具隔离。请检查 Codex CLI 或 STUDIO_CODEX_PATH；尚未调用模型。");
  }
}
