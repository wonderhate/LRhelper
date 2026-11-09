import { randomUUID } from "node:crypto";
import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { withOperationLock } from "./operation-lock.js";
import { canReconcile } from "./job-store.js";
import type { StudioHost } from "./studio-host.js";
import type { Job } from "./types.js";
import { isRecordId, readRecord, writeAtomic } from "./local-files.js";
import { validBatch } from "./journal-schema.js";

const maxPhotos = 8;

interface BatchItem {
  photoId: string;
  jobId: string;
  planError?: string;
  previewError?: string;
}

export interface Batch {
  version: 1;
  id: string;
  createdAt: string;
  styleId: string;
  styleName: string;
  strength: number;
  state: "planning" | "finished" | "stopped";
  blockedByPhotoId?: string;
  previewStopped?: boolean;
  items: BatchItem[];
}

interface BatchProgress {
  stage: "planning" | "previewing";
  current: number;
  total: number;
}

export function parseBatchPhotos(input: unknown): string[] {
  if (!Array.isArray(input) || input.length < 2 || input.length > maxPhotos) throw new Error("请选择 2–8 张照片");
  if (input.some(id => typeof id !== "string" || !/^[1-9]\d*$/.test(id)) || new Set(input).size !== input.length) {
    throw new Error("批次照片 ID 无效或重复");
  }
  return input;
}

export class BatchQueue {
  readonly root: string;

  constructor(private readonly host: StudioHost) {
    this.root = path.join(path.dirname(host.store.root), "batches");
  }

  dir(id: string) {
    if (!isRecordId(id)) throw new Error("批次 ID 无效");
    return path.join(this.root, id);
  }

  async load(id: string): Promise<Batch> {
    const problem = "批次记录无效";
    const batch = await readRecord(this.dir(id), "batch.json", problem);
    if (!validBatch(batch) || batch.id !== id
      || new Set(batch.items.map(item => item.jobId)).size !== batch.items.length
      || (batch.blockedByPhotoId && !batch.items.some(item => item.photoId === batch.blockedByPhotoId))) throw new Error(problem);
    parseBatchPhotos(batch.items.map(item => item.photoId));
    return batch;
  }

  async references(jobIds: Set<string>): Promise<boolean> {
    const entries = await readdir(this.root,{withFileTypes:true}).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    for (const entry of entries) {
      if (!entry.isDirectory() || !isRecordId(entry.name)) continue;
      const batch = await this.load(entry.name).catch(() => undefined);
      if (batch?.items.some(item => jobIds.has(item.jobId))) return true;
    }
    return false;
  }

  private async save(batch: Batch) {
    await writeAtomic(path.join(this.dir(batch.id), "batch.json"), JSON.stringify(batch, null, 2));
  }

  async list() {
    const entries = await readdir(this.root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    const summaries = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !isRecordId(entry.name)) continue;
      try {
        const batch = await this.load(entry.name);
        summaries.push({ id: batch.id, styleName: batch.styleName, createdAt: batch.createdAt, total: batch.items.length });
      } catch { /* Leave the other batches available if a journal is unreadable. */ }
    }
    return summaries.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)).slice(0, 30);
  }

  private async readItem(item: BatchItem) {
    const job = await this.host.store.load(item.jobId).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (job && String(job.source.id) !== item.photoId) throw new Error("批次照片与任务记录不匹配");
    return job;
  }

  private canPreview(item: BatchItem, job: Job | undefined) {
    return !item.planError && !item.previewError && job?.status === "planned" && !!job.diff?.length;
  }

  private async view(batch: Batch, progress?: BatchProgress) {
    const items = await Promise.all(batch.items.map(async item => {
      try {
        const job = await this.readItem(item);
        const status = item.previewError && job?.status === "planned" ? "preview-failed"
          : job?.status === "planned" && !job.diff?.length ? "no-change"
          : item.planError ? "failed" : job?.status ?? "queued";
        return {
          photoId: item.photoId, jobId: job?.id, filename: job?.source.filename, status,
          canPreview: this.canPreview(item, job),
          needsReview: !!job && (canReconcile(job) || !!job.recoveryError),
          detail: job?.recoveryNote ?? job?.recoveryError ?? item.previewError ?? item.planError ?? job?.error,
        };
      } catch {
        return { photoId: item.photoId, status: "failed", canPreview: false, needsReview: true, detail: "照片任务记录无法读取" };
      }
    }));
    const previousBlock = items.find(item => item.photoId === batch.blockedByPhotoId && item.status !== "restored");
    const blockedByPhotoId = (previousBlock ?? items.find(item => item.needsReview))?.photoId;
    return {
      id: batch.id, styleName: batch.styleName, strength: batch.strength, items, progress, blockedByPhotoId, previewStopped: batch.previewStopped,
      state: batch.state === "planning" && !progress ? "interrupted" : batch.state,
      previewable: blockedByPhotoId ? 0 : items.filter(item => item.canPreview).length,
    };
  }

  async show(id: string) {
    return this.view(await this.load(id));
  }

  async plan(styleId: string, photoIds: string[], strength: number | undefined, signal: AbortSignal, publish: (view: BatchView) => void) {
    const ids = parseBatchPhotos(photoIds);
    const style = await this.host.styles.load(styleId);
    const batch: Batch = {
      version: 1, id: randomUUID(), createdAt: new Date().toISOString(), styleId, styleName: style.name,
      strength: strength ?? style.strength, state: "planning", items: ids.map(photoId => ({ photoId, jobId: randomUUID() })),
    };
    if (!Number.isFinite(batch.strength) || batch.strength < 0 || batch.strength > 1) throw new Error("强度必须在 0–1 之间");
    await mkdir(this.dir(batch.id), { recursive: true });
    return withOperationLock(this.dir(batch.id), async () => {
      await this.save(batch);
      for (const [index, item] of batch.items.entries()) {
        if (signal.aborted) break;
        publish(await this.view(batch, { stage: "planning", current: index + 1, total: ids.length }));
        if (signal.aborted) break;
        try {
          const job = await this.host.captureStyle(styleId, item.photoId, batch.strength, "", item.jobId, undefined, signal);
          if (!signal.aborted) await this.host.plan(job.id, signal);
        } catch (error) {
          if (signal.aborted) break;
          item.planError = String(error);
          await this.save(batch);
        }
      }
      batch.state = signal.aborted ? "stopped" : "finished";
      await this.save(batch);
      return this.view(batch);
    });
  }

  async preview(id: string, publish: (view: BatchView) => void, signal?: AbortSignal) {
    return withOperationLock(this.dir(id), async () => {
      const batch = await this.load(id);
      if ((await this.view(batch)).blockedByPhotoId) throw new Error("本批次已停止，请检查相关副本与恢复状态");
      if (batch.blockedByPhotoId) {
        batch.blockedByPhotoId = undefined;
        await this.save(batch);
      }
      const eligible: BatchItem[] = [];
      for (const item of batch.items) {
        const job = await this.readItem(item).catch(() => undefined);
        if (this.canPreview(item, job)) eligible.push(item);
      }
      if (!eligible.length) throw new Error("此批次没有可预览的方案");
      if (batch.previewStopped) {
        batch.previewStopped = undefined;
        await this.save(batch);
      }
      let stopped = false;
      for (const [index, item] of eligible.entries()) {
        if (signal?.aborted) { stopped = true; break; }
        publish(await this.view(batch, { stage: "previewing", current: index + 1, total: eligible.length }));
        if (signal?.aborted) { stopped = true; break; }
        try {
          // Finish the in-flight photo, including its write/readback or recovery, before stopping.
          await this.host.preview(item.jobId);
        } catch (error) {
          item.previewError = String(error);
          // An uncertain catalog write or failed rollback needs review before further writes.
          const job = await this.readItem(item).catch(() => undefined);
          if (!job || job.outcomeUnknown || job.recoveryError || (job.status !== "planned" && !job.snapshotId)) batch.blockedByPhotoId = item.photoId;
          await this.save(batch);
          if (batch.blockedByPhotoId) break;
        }
      }
      if (stopped) {
        batch.previewStopped = true;
        await this.save(batch);
      }
      return this.view(batch);
    });
  }
}

export type BatchView = Awaited<ReturnType<BatchQueue["show"]>>;
