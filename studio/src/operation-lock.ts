import { createHash, randomUUID } from "node:crypto";
import { link, lstat, realpath, unlink, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { readRecord } from "./local-files.js";

const busy = "任务正在运行，请等待完成。";
const unreadable = "无法确认操作锁的归属，请先关闭其他工作台并检查此任务。";
const hasCode = (error: unknown, code: string) => (error as NodeJS.ErrnoException)?.code === code;
const hardLinkUnavailable = new Set(["EPERM", "ENOTSUP", "ENOSYS", "EOPNOTSUPP"]);

/** The OS releases this gate on exit, even after a forced termination. */
async function takeGate(directory: string): Promise<() => Promise<void>> {
  const canonical = await realpath(directory);
  const key = createHash("sha256").update(process.platform === "win32" ? canonical.toLowerCase() : canonical).digest("hex");
  const address = process.platform === "win32" ? `\\\\.\\pipe\\lrhelper-operation-${key}`
    : process.platform === "linux" ? `\0lrhelper-operation-${key}` : undefined;
  if (!address) return async () => {}; // Other platforms keep the exclusive disk lock and never auto-reclaim it.

  const server = net.createServer(socket => socket.destroy());
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(address, () => { server.removeListener("error", reject); resolve(); });
    });
  } catch (error) {
    if (hasCode(error, "EADDRINUSE")) throw new Error(busy);
    throw error;
  }
  return () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

async function clearDeadOwner(directory: string, filename: string) {
  const stat = await lstat(filename).catch(error => {
    if (hasCode(error, "ENOENT")) return undefined;
    throw error;
  });
  if (!stat) return;
  if (process.platform !== "win32" && process.platform !== "linux") throw new Error(busy);
  const owner = await readRecord(directory, "operation.lock", unreadable).catch(() => undefined);
  const pid = owner && typeof owner === "object" && "pid" in owner ? owner.pid : undefined;
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0 || pid > 0x7fffffff) throw new Error(unreadable);
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (hasCode(error, "ESRCH")) {
      await unlink(filename);
      return;
    }
    if (!hasCode(error, "EPERM")) throw new Error(unreadable);
  }
  throw new Error(busy);
}

export async function withOperationLock<T>(directory: string, fn: () => Promise<T>): Promise<T> {
  const releaseGate = await takeGate(directory);
  try {
    const filename = path.join(directory, "operation.lock");
    await clearDeadOwner(directory, filename);
    const pending = `${filename}.${randomUUID()}.tmp`;
    const owner = JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() });
    try {
      await writeFile(pending, owner, { flag: "wx", mode: 0o600 });
      // Publish the fully written owner atomically, including for older versions sharing the data directory.
      await link(pending, filename).catch(error => {
        if (!hardLinkUnavailable.has(error.code)) throw error;
        return writeFile(filename, owner, { flag: "wx", mode: 0o600 });
      });
    } catch (error) {
      throw hasCode(error, "EEXIST") ? new Error(busy) : error;
    } finally {
      await unlink(pending).catch(() => {});
    }
    try {
      return await fn();
    } finally {
      await unlink(filename);
    }
  } finally {
    await releaseGate();
  }
}
