import { randomUUID, createHash } from "node:crypto";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { JobStore, available, canReconcile, checkImage, hasVerifiedPreview } from "./job-store.js";
import { allowedKeys, equalValue, fingerprint, flatten, stable } from "./grading/settings.js";
import { validatePlan } from "./grading/validator.js";
import { mapPlan } from "./grading/mapper.js";
import { checkMask, limitSkinHsl, mapMasks, maskSliderNames } from "./grading/masks.js";
import { StyleLibrary } from "./style-library.js";
import { BatchQueue } from "./batch-queue.js";
import { LightroomOutcomeUnknown } from "./lightroom.js";
import { imageLimit, localFilePath, readBoundedFile, readLocalFile } from "./local-files.js";
import type { GradeRequest, Job, Lightroom, MaskPlan, MaskSummary, ModelRuntime, Photo, Settings } from "./types.js";


export class StudioHost {
  readonly styles: StyleLibrary;
  readonly batches: BatchQueue;
  constructor(private readonly lr: Lightroom, private readonly model: ModelRuntime, readonly store: JobStore, private readonly settleMs=3500) {
    this.styles=new StyleLibrary(path.join(path.dirname(store.root),"styles"));
    this.batches = new BatchQueue(this);
  }
  async capture(request: GradeRequest, photoId?: string|number, jobId?: string, signal?: AbortSignal): Promise<Job> {
    return this.captureJob(request,photoId,jobId,signal);
  }
  private async captureJob(request: GradeRequest, photoId?: string|number, jobId: string = randomUUID(), signal?: AbortSignal, referenceData?: Buffer): Promise<Job> {
    signal?.throwIfAborted();
    if(!["describe","reference","lucky"].includes(request.mode)) throw new Error("Unknown grading mode");
    if(request.mode!=="reference") request={...request,reference:undefined};
    if(!Number.isFinite(request.strength) || request.strength<0 || request.strength>1) throw new Error("Strength must be 0–1");
    if(request.mode==="describe" && !request.prompt.trim()) throw new Error("Describe mode needs a style description");
    if(request.mode==="reference" && !request.reference) throw new Error("Reference mode needs an image path");
    const capabilities=await this.lr.discover(signal);
    signal?.throwIfAborted();
    const maskCapabilities=request.localMasks ? await this.requireMasks(signal) : undefined;
    const id=photoId ?? (await this.lr.selected(signal))[0].id;
    signal?.throwIfAborted();
    const source=await this.lr.metadata(id,signal);
    await available(source.path);
    const reference=request.reference ? referenceData ?? await readBoundedFile(request.reference,imageLimit,
      "Reference must be a JPEG, PNG or WebP image below 20 MB") : undefined;
    const referenceFile=reference ? `reference.${checkImage(reference)}` : undefined;
    signal?.throwIfAborted();
    const job: Job={version:1,id:jobId,createdAt:new Date().toISOString(),status:"captured",request,source,sourceFingerprint:fingerprint(source),baseline:flatten(source.developSettings),capabilities,maskCapabilities};
    job.conversationId=job.id;job.revision=1;
    job.referenceFile=referenceFile;
    await this.store.create(job);
    try {
      if(reference && referenceFile) await this.store.file(job.id,referenceFile,reference);
      await this.store.file(job.id,"before.jpg",await this.renderStable(source.id,signal));
      if(fingerprint(await this.lr.metadata(source.id,signal))!==job.sourceFingerprint) throw new Error("Photo changed during capture; capture again");
      signal?.throwIfAborted();
    } catch(error) {
      job.status="failed";
      job.error=signal?.aborted ? "已停止读取照片。" : String(error);
      await this.store.save(job);
      throw error;
    }
    return job;
  }
  async chain(id: string): Promise<Job[]> {
    const chain: Job[]=[],seen=new Set<string>();
    let next: string|undefined=id;
    while(next) {
      if(seen.has(next) || chain.length>=20) throw new Error("会话链无效或已达 20 轮，请开始新会话");
      seen.add(next);
      const job=await this.store.load(next);chain.unshift(job);next=job.parentJobId;
    }
    const root=chain[0];
    for(const job of chain) if(String(job.source.id)!==String(root.source.id) || job.source.path!==root.source.path || job.sourceFingerprint!==root.sourceFingerprint || stable(job.baseline)!==stable(root.baseline) || (job.conversationId && job.conversationId!==root.id)) throw new Error("会话照片或基线不一致");
    return chain;
  }
  private mapChain(chain: Job[], keys: string[]) {
    let settings: Settings={};
    let masks: MaskPlan[]=[];
    let stepDiff: Job["diff"]=[];
    for(const job of chain) {
      if(!job.plan) throw new Error("会话中缺少有效方案");
      validatePlan(job.plan,keys,job.request.localMasks ? job.maskCapabilities : undefined);
      const current={...job.baseline,...settings};
      const step=mapPlan(limitSkinHsl(job.plan,current),current,job.request.strength);
      settings={...settings,...step.settings};stepDiff=step.diff;
      masks=mapMasks(masks,job.plan.masks ?? [],job.request.strength);
      for(const key of Object.keys(settings)) if(equalValue(settings[key],job.baseline[key],0)) delete settings[key];
    }
    return {settings,masks,stepDiff,diff:Object.entries(settings).map(([key,after])=>({key,before:chain[0].baseline[key],after}))};
  }
  async prepareRefinement(parentId: string, feedback: string, strength=1, localMasks?: boolean, signal?: AbortSignal): Promise<Job> {
    signal?.throwIfAborted();
    if(typeof feedback!=="string" || !feedback.trim() || feedback.length>8000) throw new Error("请填写 1–8000 字符的调整意见");
    if(!Number.isFinite(strength) || strength<0 || strength>1) throw new Error("强度必须在 0–1 之间");
    return this.store.lock(parentId,async()=>{
      const chain=await this.chain(parentId),parent=chain.at(-1)!;
      if(chain.length>=20) throw new Error("本会话已达 20 轮，请开始新会话");
      if(!await hasVerifiedPreview(parent,this.store.dir(parent.id))) throw new Error("请先完成上一轮预览，再继续调整");
      const source=await this.lr.metadata(parent.source.id,signal);
      this.verifyCatalog(parent,source);
      if(fingerprint(source)!==parent.sourceFingerprint) throw new Error("源照片已变更，请重新读取并开始新会话");
      const capabilities=await this.lr.discover(signal);
      const maskCapabilities=localMasks ? await this.requireMasks(signal) : undefined;
      this.mapChain(chain,allowedKeys(capabilities,parent.baseline));
      const original=await readLocalFile(this.store.dir(chain[0].id),"before.jpg",imageLimit,"原始预览不可用");
      const rendered=await readLocalFile(this.store.dir(parent.id),"after.jpg",imageLimit,"上一轮预览不可用");
      const reference=parent.referenceFile ? await readLocalFile(this.store.dir(parent.id),parent.referenceFile,imageLimit,"任务参考图无效") : undefined;
      signal?.throwIfAborted();
      const job: Job={version:1,id:randomUUID(),createdAt:new Date().toISOString(),status:"captured",request:{...parent.request,prompt:feedback.trim(),strength,localMasks},source:parent.source,sourceFingerprint:parent.sourceFingerprint,baseline:parent.baseline,capabilities,maskCapabilities,parentJobId:parent.id,conversationId:chain[0].id,revision:chain.length+1,referenceFile:parent.referenceFile,styleId:parent.styleId,styleName:parent.styleName};
      await this.store.create(job);
      try {
        await this.store.file(job.id,"before.jpg",original);
        await this.store.file(job.id,"input.jpg",rendered);
        if(reference && job.referenceFile) await this.store.file(job.id,job.referenceFile,reference);
      } catch(error) {job.status="failed";job.error=String(error);await this.store.save(job);throw error;}
      return job;
    });
  }
  async conversations() {
    const groups=new Map<string,Job[]>();
    for(const job of await this.store.list()) {
      if(!job.plan && !job.parentJobId && !job.error) continue;
      const id=job.conversationId ?? job.id;
      const group=groups.get(id) ?? [];group.push(job);groups.set(id,group);
    }
    return [...groups].map(([id,jobs])=>({id,headJobId:jobs[0].id,title:jobs.find(j=>j.plan)?.plan?.title ?? "未完成的会话",filename:jobs[0].source.filename,updatedAt:jobs[0].createdAt,turns:jobs.length})).slice(0,200);
  }
  async conversation(id: string) {
    const selected=await this.store.load(id),root=selected.conversationId ?? selected.id;
    const jobs=(await this.store.list()).filter(job=>(job.conversationId ?? job.id)===root).reverse();
    return {id:root,jobs:jobs.map(job=>({id:job.id,parentJobId:job.parentJobId,revision:job.revision ?? 1,status:job.status,title:job.plan?.title ?? "未完成",direction:job.request.prompt,error:job.error,adaptation:job.plan?.analysis.adaptation ?? ""}))};
  }
  async saveStyle(id: string, name: string) {
    return this.store.lock(id,async()=>{
      const chain=await this.chain(id);
      return this.styles.save(chain.at(-1)!,chain,name,this.store);
    });
  }
  async captureStyle(styleId: string, photoId?: string|number, strength?: number, extra="", jobId?: string, localMasks?: boolean, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if(typeof extra!=="string" || extra.length>8000) throw new Error("附加描述过长");
    const style=await this.styles.load(styleId);
    const reference=style.referenceFile ? path.join(this.styles.dir(style.id),style.referenceFile) : undefined;
    const referenceData=style.referenceFile ? await readLocalFile(this.styles.dir(style.id),style.referenceFile,imageLimit,"风格参考图无效") : undefined;
    const job=await this.captureJob({mode:reference ? "reference" : "describe",reference,strength:strength ?? style.strength,localMasks,prompt:`风格名称：${style.name}\n以下是风格意图。按新目标的主体、光线与肤色重新适配；不要复制原照片曝光、白平衡或几何。\n${style.intent}${extra ? `\n本次附加方向：${extra}` : ""}`},photoId,jobId,signal,referenceData);
    job.styleId=style.id;job.styleName=style.name;await this.store.save(job);return job;
  }
  async plan(id: string, signal?: AbortSignal): Promise<Job> {
    return this.store.lock(id,async()=>{
      const job=await this.store.load(id);
      if(job.status!=="captured") throw new Error("Only a newly captured photo can be planned");
      try {
        signal?.throwIfAborted();
        const keys=allowedKeys(job.capabilities,job.baseline);
        if(!keys.length) throw new Error("No supported global grading settings available");
        const chain=await this.chain(id),parents=chain.slice(0,-1);
        const previous=parents.length ? this.mapChain(parents,keys) : undefined;
        const targetImage=await localFilePath(this.store.dir(id),job.parentJobId ? "input.jpg" : "before.jpg",imageLimit,"照片预览不可用");
        const referenceImage=job.referenceFile ? await localFilePath(this.store.dir(id),job.referenceFile,imageLimit,"任务参考图无效") : undefined;
        const result=await this.model.generate({request:job.request,photo:job.source,baseline:{...job.baseline,...previous?.settings},keys,targetImage,referenceImage,history:parents.map(parent=>({direction:parent.request.prompt,title:parent.plan!.title,adaptation:parent.plan!.analysis.adaptation})),maskCapabilities:job.maskCapabilities,previousMasks:previous?.masks,signal});
        signal?.throwIfAborted();
        job.plan=validatePlan(result.plan,keys,job.maskCapabilities);
        chain[chain.length-1]=job;
        Object.assign(job,this.mapChain(chain,keys));
        job.threadId=result.threadId;
        job.status="planned";
        await this.store.save(job);
        return job;
      } catch(error) {
        job.status="failed";
        job.error=signal?.aborted ? "生成已停止，可重新生成方案。" : String(error);
        await this.store.save(job);throw error;
      }
    });
  }
  async preview(id: string): Promise<Job> {
    return this.store.lock(id,async()=>{
      const job=await this.store.load(id);
      if(job.status!=="planned" || !job.plan || !job.settings) throw new Error("Job is not an unapplied plan");
      // Revalidate persisted plans against CURRENT capabilities, not saved discovery.
      const keys=allowedKeys(await this.lr.discover(),job.baseline);
      Object.assign(job,this.mapChain(await this.chain(id),keys));
      const masks=job.masks ?? [];
      if(!Object.keys(job.settings).length && !masks.length) throw new Error("No parameter changes at this strength");
      if(masks.length) {
        const capabilities=await this.requireMasks();
        for (const mask of masks) checkMask(mask,capabilities);
      }
      const source=await this.lr.metadata(job.source.id);
      this.verifyCatalog(job,source);
      if(fingerprint(source)!==job.sourceFingerprint) throw new Error("Source edit changed since capture; capture and plan again");
      await available(source.path);
      const before=await readLocalFile(this.store.dir(id),"before.jpg",imageLimit,"原始预览不可用");
      if(masks.length && !before.equals(await this.renderStable(source.id))) throw new Error("源照片的渲染图已变更，请重新读取并生成方案。");
      try {
        job.renderCompleted=false;
        job.copyName=`Studio ${job.id}`;
        job.snapshotName=`Studio baseline ${job.id}`;
        job.status="creating-copy";await this.store.save(job);
        const result=await this.lr.call("create_virtual_copies",{photo_ids:[source.id],copy_name:job.copyName});
        const copies=result.copies as {copy_id:string|number;photo_id:string|number}[];
        const copyId=Array.isArray(copies) ? copies[0]?.copy_id : undefined;
        if(result.created!==1 || !Array.isArray(copies) || copies.length!==1 ||
          String(copies[0]?.photo_id)!==String(source.id) ||
          (typeof copyId!=="string" && typeof copyId!=="number") || !/^[1-9]\d*$/.test(String(copyId))) {
          throw new LightroomOutcomeUnknown("protocol_unknown");
        }
        job.copyId=copyId;
        // Persist the resource identity before the next remote operation.
        await this.store.save(job);
        const copy=await this.verifiedCopy(job);
        if(fingerprint({...copy,id:source.id})!==job.sourceFingerprint) throw new Error("Copy baseline differs from captured source");
        if(masks.length) job.maskBaseline=await this.maskList(copy.id);
        job.status="snapshotting";await this.store.save(job);
        const snap=await this.lr.call("create_develop_snapshot",{photo_id:job.copyId,name:job.snapshotName});
        const snapshot=snap.snapshot as {id?:string};
        if(typeof snapshot?.id!=="string" || !snapshot.id) throw new LightroomOutcomeUnknown("protocol_unknown");
        job.snapshotId=snapshot.id;job.status="applying";await this.store.save(job);
        if(Object.keys(job.settings).length) await this.lr.call("set_develop_settings",{photo_id:copy.id,settings:job.settings});
        if(masks.length) job.maskReadback=await this.applyMasks(copy.id,masks,job.maskBaseline!);
        job.readback=await this.verifySettings(copy.id,masks.length ? {...job.baseline,...job.settings} : job.settings);
        job.status="rendering";await this.store.save(job);
        const after=await this.renderStable(job.copyId!);
        if(after.equals(before)) throw new Error("Rendered preview is unchanged; possible stale Lightroom preview");
        const currentSource=await this.lr.metadata(source.id);
        this.verifyCatalog(job,currentSource);
        if(fingerprint(currentSource)!==job.sourceFingerprint) throw new Error("Source changed during preview; inspect concurrent Lightroom activity");
        await this.store.file(id,"after.jpg",after);
        job.renderCompleted=true;
        job.status="previewed";await this.store.save(job);
        return job;
      } catch(error) {
        job.error=String(error);
        job.renderCompleted=false;
        if(error instanceof LightroomOutcomeUnknown) job.outcomeUnknown=error.code;
        if(!job.outcomeUnknown && job.copyId!==undefined && job.snapshotId) {
          try { await this.recoverCopy(job); }
          catch(restoreError) {
            job.recoveryError=String(restoreError);
            if(restoreError instanceof LightroomOutcomeUnknown) job.outcomeUnknown=restoreError.code;
          }
        }
        job.status="failed";await this.store.save(job);throw error;
      }
    });
  }
  async reconcile(id: string): Promise<Job> {
    return this.store.lock(id,async()=>{
      const job=await this.store.load(id);
      if(!canReconcile(job)) throw new Error("此任务无需检查中断状态。");
      const source=await this.lr.metadata(job.source.id);
      this.verifyCatalog(job,source);
      if(String(source.id)!==String(job.source.id) || source.path!==job.source.path ||
        (source.isVirtualCopy===true)!==(job.source.isVirtualCopy===true)) {
        throw new Error("源照片身份已变更，无法检查中断任务。");
      }

      if(job.copyId===undefined) {
        if(!job.copyName || !job.source.catalogPath) throw new Error("旧任务缺少可核对的副本标识，请在 Lightroom 中检查。");
        const masterId=this.masterId(job);
        if(masterId===undefined) throw new Error("任务记录缺少原照片的主照片 ID。");
        const master=source.isVirtualCopy ? await this.lr.metadata(masterId) : source;
        this.verifyCatalog(job,master);
        if(master.isVirtualCopy===true || String(master.id)!==String(this.masterId(job)) || master.path!==job.source.path) {
          throw new Error("无法确认原照片与主照片的关系。");
        }
        const copyIds=master.virtualCopy?.copyIds ?? [];
        if(copyIds.length>100) throw new Error("此照片的副本较多，请在 Lightroom 中按完整副本名核对。");
        const candidates=[];
        for(const copyId of copyIds) {
          if(String(copyId)===String(job.source.id)) continue;
          const copy=await this.lr.metadata(copyId);
          if(copy.copyName!==job.copyName) continue;
          this.verifyCopy(job,copy,copyId);
          candidates.push(copy.id);
        }
        if(candidates.length!==1) throw new Error(candidates.length ? "发现多个同名副本，请在 Lightroom 中确认。" :
          "暂未找到此任务的副本。请确认 Lightroom 已结束原操作后再检查。");
        job.copyId=candidates[0];
        await this.store.save(job);
      }
      const copy=await this.verifiedCopy(job);
      const snapshotName=job.snapshotName ?? `Studio baseline ${job.id}`;
      const snapshots=await this.lr.call("list_develop_snapshots",{photo_id:copy.id});
      if(String(snapshots.photo_id)!==String(copy.id) || !Array.isArray(snapshots.snapshots)) {
        throw new Error("无法核对副本的 Lightroom 快照。");
      }
      const matches=snapshots.snapshots.filter(item=>item?.name===snapshotName &&
        typeof item.id==="string" && (!job.snapshotId || item.id===job.snapshotId));
      if(matches.length>1) throw new Error("发现多个匹配的快照，请在 Lightroom 中确认。");
      job.snapshotId=matches[0]?.id;
      job.status="failed";
      job.recoveryNote=job.snapshotId ? "已核对副本和快照。请在 Lightroom 确认原操作已结束，再选择恢复副本。" :
        "已找到此任务的副本。尚未找到恢复快照，请在 Lightroom 中检查该副本。";
      await this.store.save(job);
      return job;
    });
  }
  async restore(id: string): Promise<Job> {
    return this.store.lock(id,async()=>{
      const job=await this.store.load(id);
      if(job.copyId===undefined || !job.snapshotId) throw new Error("Job has no recoverable copy/snapshot");
      job.renderCompleted ??= await hasVerifiedPreview(job,this.store.dir(id));
      job.status="restoring";await this.store.save(job);
      try {
        await this.recoverCopy(job);
        job.status="restored";job.error=undefined;job.recoveryError=undefined;job.outcomeUnknown=undefined;job.recoveryNote=undefined;await this.store.save(job);return job;
      } catch(error) {
        job.status="failed";job.recoveryError=String(error);
        if(error instanceof LightroomOutcomeUnknown) job.outcomeUnknown=error.code;
        await this.store.save(job);throw error;
      }
    });
  }
  private async requireMasks(signal?: AbortSignal) {
    const capabilities=await this.lr.discoverMasks?.(signal);
    if(!capabilities || !Object.keys(capabilities).length) throw new Error("当前 Lightroom MCP 不支持所需的蒙版工具。取消勾选局部蒙版后可生成全局方案。");
    return capabilities;
  }
  private async maskList(id: string|number) {
    const result=await this.lr.call("list_masks",{photo_id:id});
    if(String(result.photo_id)!==String(id) || !Array.isArray(result.masks) || result.masks.length!==result.count) throw new Error("Lightroom 蒙版列表读回无效");
    return result.masks as MaskSummary[];
  }
  private maskStructure(masks: MaskSummary[]) {
    return masks.map(({id,tools,...mask})=>stable({...mask,tools:tools.map(({id,...tool})=>tool)})).sort();
  }
  private async applyMasks(id: string|number, masks: MaskPlan[], baseline: MaskSummary[]) {
    const readback: NonNullable<Job["maskReadback"]>=[];
    const oldIds=new Set(baseline.map(mask=>mask.id));
    for (const mask of masks) {
      const adjustments=Object.fromEntries(mask.adjustments.map(({key,value})=>[key,value]));
      const result=await this.lr.call("create_mask",{photo_id:id,type:mask.kind,adjustments});
      const maskId=result.mask_id;
      if(typeof maskId!=="string" || !maskId || oldIds.has(maskId) || readback.some(entry=>entry.id===maskId)) throw new Error("Lightroom 未返回新建蒙版 ID");
      const read=await this.lr.call("get_mask",{photo_id:id,mask_id:maskId,kinds:["adjustments"]});
      if(String(read.photo_id)!==String(id) || read.mask_id!==maskId) throw new Error("Lightroom 蒙版读回对象不匹配");
      const values=read.adjustments as Record<string,unknown> | undefined;
      const verified: Record<string,number>={};
      for (const {key,value} of mask.adjustments) {
        const actual=values?.[maskSliderNames[key]];
        if(typeof actual!=="number" || !equalValue(actual,value,key==="exposure" ? 0.011 : 0.51)) throw new Error(`Lightroom 局部参数读回不一致：${mask.kind} / ${key}`);
        verified[key]=actual;
      }
      readback.push({kind:mask.kind,id:maskId,adjustments:verified});
    }
    const current=await this.maskList(id);
    const newIds=new Set(readback.map(mask=>mask.id));
    const remaining=current.filter(mask=>!newIds.has(mask.id));
    if(current.length!==baseline.length+masks.length || readback.some(mask=>!current.some(item=>item.id===mask.id)) || stable(this.maskStructure(remaining))!==stable(this.maskStructure(baseline))) throw new Error("Lightroom 蒙版列表与预览方案不一致");
    return readback;
  }
  private async recoverCopy(job: Job) {
    const copy=await this.verifiedCopy(job);
    const identity=job.source.catalogPath ? {
      expected_catalog_path:job.source.catalogPath, expected_copy_name:job.copyName,
    } : {};
    await this.lr.call("apply_develop_snapshot",{photo_id:copy.id,snapshot_id:job.snapshotId,...identity});
    await this.verifySettings(copy.id,job.baseline);
    if(job.maskBaseline && stable(this.maskStructure(await this.maskList(copy.id)))!==stable(this.maskStructure(job.maskBaseline))) throw new Error("副本蒙版列表未恢复到预览前状态");
  }
  private async verifiedCopy(job: Job) {
    if(job.copyId===undefined) throw new Error("No virtual copy identity recorded");
    const copy=await this.lr.metadata(job.copyId);
    this.verifyCopy(job,copy,job.copyId);
    return copy;
  }
  private masterId(job: Job) {
    return job.source.isVirtualCopy ? job.source.virtualCopy?.masterPhotoId : job.source.id;
  }
  private verifyCatalog(job: Job, photo: Photo) {
    if(job.source.catalogPath && job.source.catalogPath!==photo.catalogPath) throw new Error("请打开此任务原先使用的 Lightroom 目录。");
  }
  private verifyCopy(job: Job, copy: Photo, copyId: string|number) {
    this.verifyCatalog(job,copy);
    if(String(copyId)===String(job.source.id)) throw new Error("Refusing to edit the source photo");
    const expectedMaster=this.masterId(job);
    if(copy.isVirtualCopy!==true || String(copy.id)!==String(copyId) || expectedMaster===undefined ||
      String(copy.virtualCopy?.masterPhotoId)!==String(expectedMaster) || copy.path!==job.source.path ||
      (job.copyName && job.source.catalogPath && copy.copyName!==job.copyName)) {
      throw new Error("Copy identity/master verification failed");
    }
  }
  private async verifySettings(id: string|number, expected: Settings): Promise<Settings> {
    let got: Settings={};
    for(let attempt=0;attempt<6;attempt++) {
      got=flatten((await this.lr.metadata(id)).developSettings);
      const mismatches=Object.keys(expected).filter(k=>!equalValue(got[k],expected[k],Array.isArray(expected[k]) ? 1 : k==="Temperature" ? 1 : 0.02));
      if(!mismatches.length) return got;
      if(attempt===5) throw new Error(`Develop readback mismatch: ${mismatches.join(", ")}`);
      await delay(this.settleMs ? 500 : 0);
    }
    return got;
  }
  private async renderStable(id: string|number, signal?: AbortSignal): Promise<Buffer> {
    await delay(this.settleMs,undefined,{signal});
    let previous=await this.lr.preview(id,signal);
    for(let attempt=0;attempt<4;attempt++) {
      await delay(this.settleMs ? 700 : 0,undefined,{signal});
      const current=await this.lr.preview(id,signal);
      if(createHash("sha256").update(current).digest("hex")===createHash("sha256").update(previous).digest("hex")) return current;
      previous=current;
    }
    throw new Error("Lightroom preview has not settled; retry capture after rendering finishes");
  }
}
