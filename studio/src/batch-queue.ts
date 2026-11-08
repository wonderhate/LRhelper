import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { withOperationLock } from "./job-store.js";
import type { StudioHost } from "./studio-host.js";
import type { Job } from "./types.js";

const maxPhotos = 8;
const idPattern = /^[0-9a-f-]{36}$/;

interface BatchItem {
  photoId: string;
  jobId: string;
  planError?: string;
  previewError?: string;
}

interface Batch {
  version: 1;
  id: string;
  createdAt: string;
  styleId: string;
  styleName: string;
  strength: number;
  state: "planning" | "finished" | "stopped";
  blockedByPhotoId?: string;
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
  private readonly root: string;

  constructor(private readonly host: StudioHost) {
    this.root = path.join(path.dirname(host.store.root), "batches");
  }

  dir(id: string) {
    if (!idPattern.test(id)) throw new Error("批次 ID 无效");
    return path.join(this.root, id);
  }

  private async load(id: string): Promise<Batch> {
    const batch = JSON.parse(await readFile(path.join(this.dir(id), "batch.json"), "utf8")) as Batch;
    if (batch.version !== 1 || batch.id !== id || !Array.isArray(batch.items)
      || batch.items.some(item => !item || typeof item.jobId !== "string" || !idPattern.test(item.jobId))
      || new Set(batch.items.map(item => item.jobId)).size !== batch.items.length) throw new Error("批次记录无效");
    parseBatchPhotos(batch.items.map(item => item.photoId));
    return batch;
  }

  private async save(batch: Batch) {
    const file = path.join(this.dir(batch.id), "batch.json");
    const temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(batch, null, 2), { mode: 0o600 });
    await rename(temporary, file);
  }

  async list() {
    const entries = await readdir(this.root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    const summaries = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !idPattern.test(entry.name)) continue;
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
          canPreview: this.canPreview(item, job), detail: job?.recoveryError ?? item.previewError ?? item.planError ?? job?.error,
        };
      } catch {
        return { photoId: item.photoId, status: "failed", canPreview: false, detail: "照片任务记录无法读取" };
      }
    }));
    return {
      id: batch.id, styleName: batch.styleName, strength: batch.strength, items, progress, blockedByPhotoId: batch.blockedByPhotoId,
      state: batch.state === "planning" && !progress ? "interrupted" : batch.state,
      previewable: batch.blockedByPhotoId ? 0 : items.filter(item => item.canPreview).length,
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
    await this.save(batch);
    for (const [index, item] of batch.items.entries()) {
      if (signal.aborted) break;
      publish(await this.view(batch, { stage: "planning", current: index + 1, total: ids.length }));
      if (signal.aborted) break;
      try {
        const job = await this.host.captureStyle(styleId, item.photoId, batch.strength, "", item.jobId);
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
  }

  async preview(id: string, publish: (view: BatchView) => void) {
    return withOperationLock(this.dir(id), async () => {
      const batch = await this.load(id);
      if (batch.blockedByPhotoId) throw new Error("本批次已停止，请检查相关副本与恢复状态");
      const eligible: BatchItem[] = [];
      for (const item of batch.items) {
        const job = await this.readItem(item).catch(() => undefined);
        if (this.canPreview(item, job)) eligible.push(item);
      }
      if (!eligible.length) throw new Error("此批次没有可预览的方案");
      for (const [index, item] of eligible.entries()) {
        publish(await this.view(batch, { stage: "previewing", current: index + 1, total: eligible.length }));
        try {
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
      return this.view(batch);
    });
  }
}

export type BatchView = Awaited<ReturnType<BatchQueue["show"]>>;
