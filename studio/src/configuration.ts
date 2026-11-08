import os from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

export function defaultHostFile() {
  return path.join(os.homedir(),".config","lr-codex-studio","host.json");
}

export async function loadConfiguration(root: string, env: NodeJS.ProcessEnv) {
  const installed = existsSync(path.join(root,"release.json"));
  const home = installed ? path.dirname(root) : path.join(root,".studio");
  const settingsFile = path.resolve(env.STUDIO_SETTINGS_FILE ?? path.join(home,"settings.json"));
  let settings: Record<string,unknown> = {};
  try {
    const raw: unknown = JSON.parse((await readFile(settingsFile,"utf8")).replace(/^\uFEFF/,""));
    if (!raw || typeof raw!=="object" || Array.isArray(raw)) throw new Error("expected a JSON object");
    settings=raw as Record<string,unknown>;
  } catch(error) {
    if ((error as NodeJS.ErrnoException).code!=="ENOENT" || env.STUDIO_SETTINGS_FILE) {
      throw new Error(`无法读取 Studio 配置 ${settingsFile}。请检查路径和 JSON 格式。`);
    }
  }
  const allowed = ["jobsDirectory","codexPath","model","mcpEntry","useSystemProxy"];
  for (const key of Object.keys(settings)) {
    if (!allowed.includes(key)) throw new Error(`未知 Studio 配置项：${key}`);
  }
  const settingPath = (key: string) => {
    const value=settings[key];
    if (value===undefined) return undefined;
    if (typeof value!=="string" || !path.isAbsolute(value) || /[\0\r\n]/.test(value)) throw new Error(`Studio 配置 ${key} 需要绝对路径。`);
    return value;
  };
  const jobs=settingPath("jobsDirectory"), codex=settingPath("codexPath"), mcp=settingPath("mcpEntry");
  const model=settings.model, proxy=settings.useSystemProxy;
  if (model!==undefined && (typeof model!=="string" || !model.trim() || model.length>160 || /[\0\r\n]/.test(model))) throw new Error("Studio 配置 model 无效。");
  if (proxy!==undefined && typeof proxy!=="boolean") throw new Error("Studio 配置 useSystemProxy 必须是布尔值。");
  return {
    settingsFile,
    hostFile:path.resolve(env.STUDIO_HOST_FILE ?? defaultHostFile()),
    jobsDirectory:path.resolve(env.STUDIO_DATA_DIR ?? jobs ?? path.join(home,installed ? "data/jobs" : "jobs")),
    mcpEntry:path.resolve(env.STUDIO_MCP_ENTRY ?? mcp ?? path.join(root,"server/dist/index.js")),
    codexPath:env.STUDIO_CODEX_PATH ?? codex ?? env.CODEX_APP_RUNTIME_CLI_PATH ?? "codex",
    model:env.STUDIO_CODEX_MODEL ?? (typeof model==="string" ? model : undefined),
    useSystemProxy:env.STUDIO_USE_SYSTEM_PROXY!==undefined ? env.STUDIO_USE_SYSTEM_PROXY!=="0" : proxy ?? true,
  };
}
