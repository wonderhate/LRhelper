import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";

export const recordIdPattern = "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";
const recordId = new RegExp(recordIdPattern);
const recordLimit = 4 * 1024 * 1024;
export const imageLimit = 20 * 1024 * 1024;

export function isRecordId(id: unknown): id is string {
  return typeof id === "string" && id.length === 36 && recordId.test(id);
}

export async function readBoundedFile(filename: string, limit: number, errorMessage: string): Promise<Buffer> {
  const file = await open(filename, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = await file.stat();
    const { size } = stat;
    if (!stat.isFile() || size > limit || size <= 0) throw new Error(errorMessage);
    const data = Buffer.allocUnsafe(size + 1);
    let offset = 0;
    while (offset < data.length) {
      const { bytesRead } = await file.read(data, offset, data.length - offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset !== size) throw new Error(errorMessage);
    return data.subarray(0, size);
  } finally {
    await file.close();
  }
}

export async function localFilePath(directory: string, name: string, limit: number, errorMessage: string): Promise<string> {
  if (name !== path.basename(name) || !name || name === "." || name === "..") throw new Error(errorMessage);
  if (!(await lstat(directory)).isDirectory()) throw new Error(errorMessage);
  const filename = path.join(directory, name);
  const stat = await lstat(filename);
  if (!stat.isFile() || stat.size <= 0 || stat.size > limit) throw new Error(errorMessage);
  return filename;
}

export async function readLocalFile(directory: string, name: string, limit: number, errorMessage: string): Promise<Buffer> {
  return readBoundedFile(await localFilePath(directory, name, limit, errorMessage), limit, errorMessage);
}

export async function readRecord(directory: string, name: string, errorMessage: string): Promise<unknown> {
  const data = await readLocalFile(directory, name, recordLimit, errorMessage);
  try {
    return JSON.parse(data.toString("utf8"));
  } catch {
    throw new Error(errorMessage);
  }
}
