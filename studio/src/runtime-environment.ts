import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
const retainedCodexKeys = new Set(["CODEX_HOME", "CODEX_API_KEY"]);

export interface SystemProxy { enabled: boolean; server?: string }

/** Preserve user credentials/config location, not the parent desktop chat's IPC/session. */
export function standaloneEnvironment(source: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(Object.entries(source).filter((entry): entry is [string,string] =>
    typeof entry[1] === "string" && (!entry[0].startsWith("CODEX_") || retainedCodexKeys.has(entry[0]))));
}

export function applySystemProxy(env: Record<string,string>, proxy: SystemProxy): Record<string,string> {
  const result = { ...env };
  if (!proxy.enabled || !proxy.server || env.STUDIO_USE_SYSTEM_PROXY === "0") return result;
  const entries = proxy.server.split(";").map(value => value.trim()).filter(Boolean);
  const byProtocol = Object.fromEntries(entries.filter(value => value.includes("=")).map(value => {
    const split = value.indexOf("="); return [value.slice(0,split), value.slice(split+1)];
  }));
  for (const protocol of ["http", "https"]) {
    const key = `${protocol.toUpperCase()}_PROXY`;
    if (env[key] || env[`${protocol}_proxy`] || env.ALL_PROXY || env.all_proxy) continue;
    const address = byProtocol[protocol] ?? (entries.length === 1 && !entries[0].includes("=") ? entries[0] : undefined);
    if (!address) continue;
    const url = address.includes("://") ? address : `http://${address}`;
    try {
      const parsed = new URL(url);
      if (["http:", "https:", "socks5:", "socks5h:"].includes(parsed.protocol) && parsed.hostname) result[key] = url;
    } catch { /* Invalid system entries do not replace explicit user networking. */ }
  }
  return result;
}

export async function readWindowsProxy(): Promise<SystemProxy> {
  const {stdout} = await execute("reg.exe", ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings"], {windowsHide:true,timeout:3000,maxBuffer:128*1024});
  return {
    enabled: /ProxyEnable\s+REG_DWORD\s+0x1\b/i.test(stdout),
    server: stdout.match(/ProxyServer\s+REG_SZ\s+([^\r\n]+)/i)?.[1].trim(),
  };
}

export async function runtimeEnvironment(source: NodeJS.ProcessEnv = process.env): Promise<Record<string,string>> {
  const env = standaloneEnvironment(source);
  if (process.platform !== "win32" || env.STUDIO_USE_SYSTEM_PROXY === "0") return env;
  try { return applySystemProxy(env, await readWindowsProxy()); }
  catch { return env; }
}
