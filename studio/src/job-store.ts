import { mkdir, writeFile, rename, unlink, access, readdir } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Job } from "./types.js";
import { imageLimit, isRecordId, localFilePath, readRecord } from "./local-files.js";
import { validJob } from "./journal-schema.js";
import { withOperationLock } from "./operation-lock.js";

export class JobStore {
  constructor(readonly root: string) {}
  dir(id: string) {
    if(!isRecordId(id)) throw new Error("Invalid job ID");
    return path.join(this.root,id);
  }
  async create(job: Job) { await mkdir(this.dir(job.id),{recursive:true}); await this.save(job); }
  async save(job: Job) {
    const file=path.join(this.dir(job.id),"job.json"), temp=`${file}.${randomUUID()}.tmp`;
    await writeFile(temp,JSON.stringify(job,null,2),{mode:0o600}); await rename(temp,file);
  }
  async load(id: string): Promise<Job> {
    const problem = "任务记录无效";
    const job=await readRecord(this.dir(id),"job.json",problem);
    if(!validJob(job) || job.id!==id) throw new Error(problem);
    return job;
  }
  async list(): Promise<Job[]> {
    const entries=await readdir(this.root,{withFileTypes:true}).catch((error: NodeJS.ErrnoException)=>{if(error.code==="ENOENT") return [];throw error;});
    const jobs: Job[]=[];
    for(const entry of entries) {
      if(entry.isDirectory() && isRecordId(entry.name)) {
        try { jobs.push(await this.load(entry.name)); } catch { /* A damaged journal must not hide other conversations. */ }
      }
    }
    return jobs.sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||b.id.localeCompare(a.id));
  }
  async lock<T>(id: string, fn:()=>Promise<T>): Promise<T> {
    return withOperationLock(this.dir(id),fn);
  }
  async file(id: string, name: string, data: Buffer) {
    const file=path.join(this.dir(id),name), temp=`${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp,data,{mode:0o600});
      await rename(temp,file);
    } finally {
      await unlink(temp).catch(() => {});
    }
  }
}

export async function hasVerifiedPreview(job: Job, directory: string): Promise<boolean> {
  if (!job.plan || job.renderCompleted === false || (job.status !== "previewed" && job.status !== "restored")) return false;
  // Existing jobs predate renderCompleted. Require their successfully published file.
  return !!await localFilePath(directory, "after.jpg", imageLimit, "预览文件不可用").catch(() => undefined);
}
export async function available(file: string) {
  await access(file).catch(()=>{throw new Error(`Source file is unavailable: ${file}`);});
}
export function checkImage(data: Buffer) {
  const extension=data.subarray(0,3).equals(Buffer.from([255,216,255])) ? "jpg" : data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? "png" : (data.toString("ascii",0,4)==="RIFF" && data.toString("ascii",8,12)==="WEBP") ? "webp" : undefined;
  if(!extension || data.length>imageLimit) throw new Error("Reference must be a JPEG, PNG or WebP image below 20 MB");
  return extension;
}
