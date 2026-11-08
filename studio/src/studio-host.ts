import { randomUUID, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { JobStore, available, checkImage, hasVerifiedPreview } from "./job-store.js";
import { allowedKeys, equalValue, fingerprint, flatten, stable } from "./grading/settings.js";
import { validatePlan } from "./grading/validator.js";
import { mapPlan } from "./grading/mapper.js";
import { checkMask, limitSkinHsl, mapMasks, maskSliderNames } from "./grading/masks.js";
import { StyleLibrary } from "./style-library.js";
import { BatchQueue } from "./batch-queue.js";
import { LightroomOutcomeUnknown } from "./lightroom.js";
import type { GradeRequest, Job, Lightroom, MaskPlan, MaskSummary, ModelRuntime, Settings } from "./types.js";

export class StudioHost {
  readonly styles: StyleLibrary;
  readonly batches: BatchQueue;
  constructor(private readonly lr: Lightroom, private readonly model: ModelRuntime, readonly store: JobStore, private readonly settleMs=3500) {
    this.styles=new StyleLibrary(path.join(path.dirname(store.root),"styles"));
    this.batches = new BatchQueue(this);
  }
  async capture(request: GradeRequest, photoId?: string|number, jobId: string = randomUUID()): Promise<Job> {
    if(!["describe","reference","lucky"].includes(request.mode)) throw new Error("Unknown grading mode");
    if(request.mode!=="reference") request={...request,reference:undefined};
    if(!Number.isFinite(request.strength) || request.strength<0 || request.strength>1) throw new Error("Strength must be 0–1");
    if(request.mode==="describe" && !request.prompt.trim()) throw new Error("Describe mode needs a style description");
    if(request.mode==="reference" && !request.reference) throw new Error("Reference mode needs an image path");
    const capabilities=await this.lr.discover();
    const maskCapabilities=request.localMasks ? await this.requireMasks() : undefined;
    const id=photoId ?? (await this.lr.selected())[0].id;
    const source=await this.lr.metadata(id);
    await available(source.path);
    const reference=request.reference ? await readFile(request.reference) : undefined;
    const referenceFile=reference ? `reference.${checkImage(reference)}` : undefined;
    const job: Job={version:1,id:jobId,createdAt:new Date().toISOString(),status:"captured",request,source,sourceFingerprint:fingerprint(source),baseline:flatten(source.developSettings),capabilities,maskCapabilities};
    job.conversationId=job.id;job.revision=1;
    job.referenceFile=referenceFile;
    await this.store.create(job);
    try {
      if(reference && referenceFile) await this.store.file(job.id,referenceFile,reference);
      await this.store.file(job.id,"before.jpg",await this.renderStable(source.id));
      if(fingerprint(await this.lr.metadata(source.id))!==job.sourceFingerprint) throw new Error("Photo changed during capture; capture again");
    } catch(error) {job.status="failed";job.error=String(error);await this.store.save(job);throw error;}
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
  async prepareRefinement(parentId: string, feedback: string, strength=1, localMasks?: boolean): Promise<Job> {
    if(typeof feedback!=="string" || !feedback.trim() || feedback.length>8000) throw new Error("请填写 1–8000 字符的调整意见");
    if(!Number.isFinite(strength) || strength<0 || strength>1) throw new Error("强度必须在 0–1 之间");
    return this.store.lock(parentId,async()=>{
      const chain=await this.chain(parentId),parent=chain.at(-1)!;
      if(chain.length>=20) throw new Error("本会话已达 20 轮，请开始新会话");
      if(!await hasVerifiedPreview(parent,this.store.dir(parent.id))) throw new Error("请先完成上一轮预览，再继续调整");
      if(fingerprint(await this.lr.metadata(parent.source.id))!==parent.sourceFingerprint) throw new Error("源照片已变更，请重新读取并开始新会话");
      const capabilities=await this.lr.discover();
      const maskCapabilities=localMasks ? await this.requireMasks() : undefined;
      this.mapChain(chain,allowedKeys(capabilities,parent.baseline));
      const original=await readFile(path.join(this.store.dir(chain[0].id),"before.jpg"));
      const rendered=await readFile(path.join(this.store.dir(parent.id),"after.jpg"));
      const reference=parent.referenceFile ? await readFile(path.join(this.store.dir(parent.id),parent.referenceFile)) : undefined;
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
  async captureStyle(styleId: string, photoId?: string|number, strength?: number, extra="", jobId?: string, localMasks?: boolean) {
    if(typeof extra!=="string" || extra.length>8000) throw new Error("附加描述过长");
    const style=await this.styles.load(styleId);
    const reference=style.referenceFile ? path.join(this.styles.dir(style.id),style.referenceFile) : undefined;
    const job=await this.capture({mode:reference ? "reference" : "describe",reference,strength:strength ?? style.strength,localMasks,prompt:`风格名称：${style.name}\n以下是风格意图。按新目标的主体、光线与肤色重新适配；不要复制原照片曝光、白平衡或几何。\n${style.intent}${extra ? `\n本次附加方向：${extra}` : ""}`},photoId,jobId);
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
        const result=await this.model.generate({request:job.request,photo:job.source,baseline:{...job.baseline,...previous?.settings},keys,targetImage:path.join(this.store.dir(id),job.parentJobId ? "input.jpg" : "before.jpg"),referenceImage:job.referenceFile ? path.join(this.store.dir(id),job.referenceFile) : undefined,history:parents.map(parent=>({direction:parent.request.prompt,title:parent.plan!.title,adaptation:parent.plan!.analysis.adaptation})),maskCapabilities:job.maskCapabilities,previousMasks:previous?.masks,signal});
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
      if(fingerprint(source)!==job.sourceFingerprint) throw new Error("Source edit changed since capture; capture and plan again");
      await available(source.path);
      const before=await readFile(path.join(this.store.dir(id),"before.jpg"));
      if(masks.length && !before.equals(await this.renderStable(source.id))) throw new Error("源照片的渲染图已变更，请重新读取并生成方案。");
      try {
        job.renderCompleted=false;
        job.status="creating-copy";await this.store.save(job);
        const result=await this.lr.call("create_virtual_copies",{photo_ids:[source.id],copy_name:`Studio ${job.id.slice(0,8)}`});
        const copies=result.copies as {copy_id:string|number;photo_id:string|number}[];
        if(result.created!==1 || !Array.isArray(copies) || copies.length!==1 ||
          (typeof copies[0]?.copy_id!=="string" && typeof copies[0]?.copy_id!=="number")) {
          throw new LightroomOutcomeUnknown("protocol_unknown");
        }
        job.copyId=copies[0].copy_id;
        // Persist the resource identity before the next remote operation.
        await this.store.save(job);
        const copy=await this.verifiedCopy(job);
        if(fingerprint({...copy,id:source.id})!==job.sourceFingerprint) throw new Error("Copy baseline differs from captured source");
        if(masks.length) job.maskBaseline=await this.maskList(copy.id);
        job.status="snapshotting";await this.store.save(job);
        const snap=await this.lr.call("create_develop_snapshot",{photo_id:job.copyId,name:`Studio baseline ${job.id}`});
        const snapshot=snap.snapshot as {id?:string};
        if(typeof snapshot?.id!=="string" || !snapshot.id) throw new LightroomOutcomeUnknown("protocol_unknown");
        job.snapshotId=snapshot.id;job.status="applying";await this.store.save(job);
        if(Object.keys(job.settings).length) await this.lr.call("set_develop_settings",{photo_id:copy.id,settings:job.settings});
        if(masks.length) job.maskReadback=await this.applyMasks(copy.id,masks,job.maskBaseline!);
        job.readback=await this.verifySettings(copy.id,masks.length ? {...job.baseline,...job.settings} : job.settings);
        job.status="rendering";await this.store.save(job);
        const after=await this.renderStable(job.copyId!);
        if(after.equals(before)) throw new Error("Rendered preview is unchanged; possible stale Lightroom preview");
        if(fingerprint(await this.lr.metadata(source.id))!==job.sourceFingerprint) throw new Error("Source changed during preview; inspect concurrent Lightroom activity");
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
  async restore(id: string): Promise<Job> {
    return this.store.lock(id,async()=>{
      const job=await this.store.load(id);
      if(job.copyId===undefined || !job.snapshotId) throw new Error("Job has no recoverable copy/snapshot");
      job.renderCompleted ??= await hasVerifiedPreview(job,this.store.dir(id));
      job.status="restoring";await this.store.save(job);
      try {
        await this.recoverCopy(job);
        job.status="restored";job.error=undefined;job.recoveryError=undefined;job.outcomeUnknown=undefined;await this.store.save(job);return job;
      } catch(error) {
        job.status="failed";job.recoveryError=String(error);
        if(error instanceof LightroomOutcomeUnknown) job.outcomeUnknown=error.code;
        await this.store.save(job);throw error;
      }
    });
  }
  private async requireMasks() {
    const capabilities=await this.lr.discoverMasks?.();
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
    await this.lr.call("apply_develop_snapshot",{photo_id:copy.id,snapshot_id:job.snapshotId});
    await this.verifySettings(copy.id,job.baseline);
    if(job.maskBaseline && stable(this.maskStructure(await this.maskList(copy.id)))!==stable(this.maskStructure(job.maskBaseline))) throw new Error("副本蒙版列表未恢复到预览前状态");
  }
  private async verifiedCopy(job: Job) {
    if(job.copyId===undefined || String(job.copyId)===String(job.source.id)) throw new Error("Refusing to edit the source photo");
    const copy=await this.lr.metadata(job.copyId);
    const expectedMaster=job.source.isVirtualCopy ? job.source.virtualCopy?.masterPhotoId : job.source.id;
    if(copy.isVirtualCopy!==true || String(copy.id)!==String(job.copyId) || expectedMaster===undefined || String(copy.virtualCopy?.masterPhotoId)!==String(expectedMaster) || copy.path!==job.source.path) throw new Error("Copy identity/master verification failed");
    return copy;
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
  private async renderStable(id: string|number): Promise<Buffer> {
    await delay(this.settleMs);
    let previous=await this.lr.preview(id);
    for(let attempt=0;attempt<4;attempt++) {
      await delay(this.settleMs ? 700 : 0);
      const current=await this.lr.preview(id);
      if(createHash("sha256").update(current).digest("hex")===createHash("sha256").update(previous).digest("hex")) return current;
      previous=current;
    }
    throw new Error("Lightroom preview has not settled; retry capture after rendering finishes");
  }
}
