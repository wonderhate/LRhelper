import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, readdir, rm, unlink } from "node:fs/promises";
import path from "node:path";
import { canReconcile, type JobStore } from "./job-store.js";
import type { StyleLibrary } from "./style-library.js";
import type { BatchQueue } from "./batch-queue.js";
import { isRecordId, readRecord, writeAtomic } from "./local-files.js";
import { withOperationLock, type MoveLockedDirectory } from "./operation-lock.js";

const kinds = ["conversation", "style", "batch"] as const;
type Kind = typeof kinds[number];
type Bucket = "jobs" | "styles" | "batches";
const buckets: Record<Kind,Bucket> = {conversation:"jobs",style:"styles",batch:"batches"};
interface Entry { bucket: Bucket; id: string }
interface Archive { version: 1; createdAt: string; kind: Kind; id: string; entries: Entry[] }
const isKind = (value: unknown): value is Kind => kinds.some(kind=>kind===value);
const isMissing = (error: NodeJS.ErrnoException) => error.code === "ENOENT";

async function directories(directory: string) {
  const info = await lstat(directory).catch((error: NodeJS.ErrnoException) => { if (!isMissing(error)) throw error; });
  if (!info) return [];
  if (!info.isDirectory()) throw new Error("存储目录不可用。");
  return (await readdir(directory,{withFileTypes:true})).filter(entry=>entry.isDirectory() && isRecordId(entry.name)).map(entry=>entry.name);
}

async function size(directory: string): Promise<number> {
  let bytes = 0;
  for (const item of await readdir(directory,{withFileTypes:true})) {
    const target=path.join(directory,item.name);
    if (item.isDirectory()) bytes+=await size(target);
    else if (item.isFile()) bytes+=(await lstat(target)).size;
  }
  return bytes;
}

export class WorkspaceStorage {
  private readonly root: string;
  private readonly trash: string;
  constructor(private readonly jobs: JobStore, private readonly styles: StyleLibrary, private readonly batches: BatchQueue) {
    this.root=path.dirname(jobs.root);
    this.trash=path.join(this.root,".trash");
  }

  private entryDir(entry: Entry) {
    if (entry.bucket==="jobs") return this.jobs.dir(entry.id);
    if (entry.bucket==="styles") return this.styles.dir(entry.id);
    return this.batches.dir(entry.id);
  }
  private async entries(kind: Kind,id: string): Promise<Entry[]> {
    if (kind==="style") { await this.styles.load(id); return [{bucket:"styles",id}]; }
    if (kind==="batch") { await this.batches.load(id); return [{bucket:"batches",id}]; }
    const root=await this.jobs.load(id);
    const members=(await this.jobs.list()).filter(job=>(job.conversationId ?? job.id)===root.id);
    if (!members.length) throw new Error("找不到会话。");
    return members.map(job=>({bucket:"jobs",id:job.id}));
  }
  private async lockEntries<T>(entries: Entry[], fn: (moves: MoveLockedDirectory[])=>Promise<T>, moves: MoveLockedDirectory[]=[]): Promise<T> {
    if (moves.length===entries.length) return fn(moves);
    return withOperationLock(this.entryDir(entries[moves.length]),move=>this.lockEntries(entries,fn,[...moves,move]));
  }
  private async inspect(entries: Entry[]) {
    let bytes=0, images=0;
    for (const entry of entries) {
      const directory=this.entryDir(entry);
      bytes+=await size(directory);
      images+=(await readdir(directory,{withFileTypes:true})).filter(file=>file.isFile() && /^(?:before|after|input|reference)\.(jpg|png|webp)$/.test(file.name)).length;
    }
    return { records:entries.length, images, bytes };
  }

  async summary() {
    const total = async (root: string) => {
      const ids=await directories(root);
      let bytes=0;
      for (const id of ids) bytes+=await size(path.join(root,id));
      return {records:ids.length,bytes};
    };
    const [jobs, styles, batches, trash]=await Promise.all([
      total(this.jobs.root),total(this.styles.root),total(this.batches.root),total(this.trash),
    ]);
    const archives=[];
    for (const id of await directories(this.trash)) {
      const record=await this.readArchive(id).catch(()=>undefined);
      if (record) archives.push({id,kind:record.kind,sourceId:record.id,createdAt:record.createdAt,records:record.entries.length});
    }
    archives.sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
    return {jobs,styles,batches,trash,archives};
  }

  async run(body: { action?: unknown; kind?: unknown; id?: unknown; output?: unknown; days?: unknown }) {
    await mkdir(this.root,{recursive:true});
    return withOperationLock(this.root,async()=>{
      if (body.action==="purge") return this.purge(body.days);
      if (body.action==="restore") return this.restore(body.id);
      if (!isKind(body.kind) || !isRecordId(body.id)) throw new Error("请选择有效的会话、风格或批次。");
      const {kind,id}=body;
      const entries=await this.entries(kind,id);
      if (body.action==="inspect") return this.inspect(entries);
      if (body.action==="export" && kind==="batch") {
        for (const item of (await this.batches.load(id)).items) {
          try { await this.jobs.load(item.jobId); entries.push({bucket:"jobs",id:item.jobId}); }
          catch (error) { if (!isMissing(error as NodeJS.ErrnoException)) throw error; }
        }
      }
      entries.sort((a,b)=>this.entryDir(a).localeCompare(this.entryDir(b)));
      return this.lockEntries(entries,async moves=>{
        if (body.action==="export") return this.export(kind,id,entries,body.output);
        if (body.action==="trash") return this.moveToTrash(kind,id,entries,moves);
        throw new Error("不支持的存储操作。");
      });
    });
  }

  private async export(kind: Kind,id: string,entries: Entry[],output: unknown) {
    if (typeof output!=="string" || !path.isAbsolute(output) || !(await lstat(output)).isDirectory()) throw new Error("请选择本机的导出目录。");
    const destination=path.join(output,`LRhelper-${kind}-${id}`);
    await mkdir(destination);
    try {
      for (const entry of entries) {
        const source=this.entryDir(entry),target=path.join(destination,entry.bucket,entry.id);
        await mkdir(target,{recursive:true});
        for (const file of await readdir(source,{withFileTypes:true})) {
          if (file.isFile() && /^(job\.json|style\.json|batch\.json|(?:before|after|input|reference)\.(jpg|png|webp))$/.test(file.name)) {
            await copyFile(path.join(source,file.name),path.join(target,file.name),constants.COPYFILE_EXCL);
          }
        }
      }
      await writeAtomic(path.join(destination,"backup.json"),JSON.stringify({version:1,kind,id,entries},null,2));
    } catch (error) { await rm(destination,{recursive:true,force:true}); throw error; }
    return {path:destination,records:entries.length};
  }

  private async moveToTrash(kind: Kind,id: string,entries: Entry[],moves: MoveLockedDirectory[]) {
    if (kind==="conversation") {
      if ((await this.entries(kind,id)).length!==entries.length) throw new Error("会话刚有新轮次，请刷新后再操作。");
      for (const entry of entries) {
        const job=await this.jobs.load(entry.id);
        if (canReconcile(job) || job.recoveryError) throw new Error("此会话还有待核对的副本，请先完成恢复。");
      }
      if (await this.batches.references(new Set(entries.map(entry=>entry.id)))) throw new Error("这个会话仍在批次中使用，请先处理关联批次。");
    }
    const summary=await this.inspect(entries);
    await mkdir(this.trash,{recursive:true});
    if (!(await lstat(this.trash)).isDirectory()) throw new Error("回收站目录不可用。");
    const archiveId=randomUUID();
    const directory=path.join(this.trash,archiveId);
    await mkdir(directory);
    const archive: Archive={version:1,kind,id,entries,createdAt:new Date().toISOString()};
    await writeAtomic(path.join(directory,"archive.json"),JSON.stringify(archive,null,2));
    const moved: number[]=[];
    try {
      for (const [index, entry] of entries.entries()) {
        const bucket=path.join(directory,entry.bucket);
        await mkdir(bucket,{recursive:true});
        await moves[index](path.join(bucket,entry.id));
        moved.push(index);
      }
      await writeAtomic(path.join(directory,"complete"),"ready");
    } catch (error) {
      for (const index of moved.reverse()) await moves[index](this.entryDir(entries[index]));
      await rm(directory,{recursive:true,force:true});
      throw error;
    }
    return {...summary,archiveId};
  }

  private async readArchive(id: string): Promise<Archive> {
    if (!(await lstat(this.trash)).isDirectory()) throw new Error("回收站目录不可用。");
    const problem="回收站记录无效";
    const record=await readRecord(path.join(this.trash,id),"archive.json",problem) as Partial<Archive>|null;
    if (record?.version!==1 || !isKind(record.kind) || !isRecordId(record.id) ||
      typeof record.createdAt!=="string" || !Number.isFinite(Date.parse(record.createdAt)) ||
      !Array.isArray(record.entries) || !record.entries.length ||
      record.entries.some(entry=>!entry || !isRecordId(entry.id) || entry.bucket!==buckets[record.kind!]) ||
      new Set(record.entries.map(entry=>entry.id)).size!==record.entries.length) throw new Error(problem);
    return record as Archive;
  }

  private async restore(id: unknown) {
    if (!isRecordId(id)) throw new Error("请选择回收站记录。");
    const record=await this.readArchive(id), directory=path.join(this.trash,id);
    const available: Array<{source:string; target:string}>=[];
    const bucket=path.join(directory,buckets[record.kind]);
    const bucketStat=await lstat(bucket).catch((error:NodeJS.ErrnoException)=>{if (!isMissing(error)) throw error;});
    if (bucketStat && !bucketStat.isDirectory()) throw new Error("回收站目录无效。");
    for (const entry of record.entries) {
      const source=path.join(directory,entry.bucket,entry.id), target=this.entryDir(entry);
      const archived=await lstat(source).catch((error:NodeJS.ErrnoException)=>{if (!isMissing(error)) throw error;});
      const original=await lstat(target).catch((error:NodeJS.ErrnoException)=>{if (!isMissing(error)) throw error;});
      if ((archived && original) || (!archived && !original) || (archived && !archived.isDirectory()) || (original && !original.isDirectory())) {
        throw new Error("回收站和工作区的记录发生冲突，请先保留现有文件。");
      }
      if (archived) available.push({source,target});
    }
    // Until all entries are restored, an interruption must leave a recoverable archive.
    await unlink(path.join(directory,"complete")).catch((error:NodeJS.ErrnoException)=>{if (!isMissing(error)) throw error;});
    for (const entry of available) await withOperationLock(entry.source,move=>move(entry.target));
    await rm(directory,{recursive:true});
    return {records:record.entries.length};
  }

  private async purge(days: unknown) {
    if (typeof days!=="number" || !Number.isInteger(days) || days<1 || days>3650) throw new Error("保留天数必须在 1–3650 之间。");
    const cutoff=Date.now()-days*86400000;
    let removed=0;
    for (const id of await directories(this.trash)) {
      const directory=path.join(this.trash,id);
      const record=await this.readArchive(id).catch(()=>undefined);
      if (!record || !(Date.parse(record.createdAt)<cutoff)) continue;
      const complete=await lstat(path.join(directory,"complete")).catch(()=>undefined);
      if (!complete?.isFile()) continue;
      await rm(directory,{recursive:true});
      removed++;
    }
    return {removed};
  }
}
