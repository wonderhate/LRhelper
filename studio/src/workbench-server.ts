import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Diff, GradeRequest, Job } from "./types.js";
import type { StudioHost } from "./studio-host.js";
import { parseBatchPhotos, type BatchView } from "./batch-queue.js";
import { defaultHostFile } from "./configuration.js";
import { VERSION } from "./version.js";
import { canReconcile, hasVerifiedPreview } from "./job-store.js";
import { imageLimit, localFilePath } from "./local-files.js";

interface Task {
  id: string;
  state: "running" | "completed" | "failed";
  stage: "capture" | "generate" | "preview" | "restore" | "reconcile" | "refine" | "save-style" | "apply-style" | "batch-plan" | "batch-preview";
  cancellable: boolean;
  job?: Awaited<ReturnType<typeof jobView>>;
  batch?: BatchView;
  error?: string;
}

const settingLabels: Record<string,string> = {
  Temperature:"色温", Tint:"色调", Exposure2012:"曝光", Contrast2012:"对比度", Highlights2012:"高光", Shadows2012:"阴影",
  Whites2012:"白色色阶", Blacks2012:"黑色色阶", Texture:"纹理", Clarity2012:"清晰度", Dehaze:"去朦胧", Vibrance:"自然饱和度", Saturation:"饱和度",
  ToneCurvePV2012:"曲线 · RGB", ToneCurvePV2012Red:"曲线 · 红色", ToneCurvePV2012Green:"曲线 · 绿色", ToneCurvePV2012Blue:"曲线 · 蓝色",
  SplitToningShadowHue:"阴影分级 · 色相", SplitToningShadowSaturation:"阴影分级 · 饱和度", ColorGradeShadowLum:"阴影分级 · 明亮度",
  ColorGradeMidtoneHue:"中间调分级 · 色相", ColorGradeMidtoneSat:"中间调分级 · 饱和度", ColorGradeMidtoneLum:"中间调分级 · 明亮度",
  SplitToningHighlightHue:"高光分级 · 色相", SplitToningHighlightSaturation:"高光分级 · 饱和度", ColorGradeHighlightLum:"高光分级 · 明亮度",
  ColorGradeGlobalHue:"全局分级 · 色相", ColorGradeGlobalSat:"全局分级 · 饱和度", ColorGradeGlobalLum:"全局分级 · 明亮度",
  ColorGradeBlending:"颜色分级 · 混合", SplitToningBalance:"颜色分级 · 平衡", ShadowTint:"校准 · 阴影色调",
  RedHue:"校准 · 红原色色相", RedSaturation:"校准 · 红原色饱和度", GreenHue:"校准 · 绿原色色相", GreenSaturation:"校准 · 绿原色饱和度",
  BlueHue:"校准 · 蓝原色色相", BlueSaturation:"校准 · 蓝原色饱和度", PostCropVignetteAmount:"裁剪后暗角",
  GrainAmount:"颗粒数量", GrainSize:"颗粒大小", GrainFrequency:"颗粒粗糙度",
};
const hslColours: Record<string,string> = { Red:"红色", Orange:"橙色", Yellow:"黄色", Green:"绿色", Aqua:"浅绿色", Blue:"蓝色", Purple:"紫色", Magenta:"洋红" };
const hslChannels: Record<string,string> = { Hue:"色相", Saturation:"饱和度", Luminance:"明亮度" };

function describeDiff(changes: Diff[]) {
  return changes.map(({key,before,after})=>{
    const hsl = /^(Hue|Saturation|Luminance)Adjustment(.+)$/.exec(key);
    const label = hsl && Object.hasOwn(hslColours,hsl[2]) ? `${hslColours[hsl[2]]} · ${hslChannels[hsl[1]]}` : settingLabels[key] ?? key;
    return `${label}  ${JSON.stringify(before)} → ${JSON.stringify(after)}`;
  }).join("\n");
}

export async function jobView(job: Job, host: StudioHost) {
  const dir = host.store.dir(job.id);
  const imagePath = (name: string) => localFilePath(dir, name, imageLimit, "预览文件不可用").catch(() => "");
  const [canRefine, beforePath, referencePath] = await Promise.all([
    hasVerifiedPreview(job, dir), imagePath("before.jpg"), job.referenceFile ? imagePath(job.referenceFile) : "",
  ]);
  const sliderLabels={exposure:"曝光",highlights:"高光",shadows:"阴影",saturation:"饱和度"};
  const maskLines=(job.masks ?? []).map(mask=>{
    const values=mask.adjustments.map(({key,value})=>`${sliderLabels[key]} ${value>0 ? "+" : ""}${value}`).join("，");
    return `${mask.kind === "sky" ? "天空" : "主体"} · ${values}\n${mask.reason}`;
  });
  const skin=job.plan?.skinPresence;
  if (skin && !maskLines.length) maskLines.push("本轮累计方案没有局部调整。");
  if (skin && skin!=="none") maskLines.push("肤色保护：本轮限制红色和橙色的色相、饱和度与明亮度变化。");
  const plan=job.plan, analysis=plan?.analysis;
  const sections=analysis ? [
    ["目标照片",analysis.target],["参考风格",analysis.reference],["适配思路",analysis.adaptation],["肤色判断",analysis.skin],
    ["注意事项",plan.warnings.join("\n")],
  ].filter(([,body])=>body).map(([label,body])=>`${label}\n${body}`).join("\n\n") : "选择调色方式，生成方案后查看参数差异。";
  return {
    id: job.id, status: job.status, filename: job.source.filename, photoId: String(job.source.id),
    request: job.request, hasPlan: !!job.plan,
    copyId: job.copyId === undefined ? undefined : String(job.copyId),
    conversationId:job.conversationId ?? job.id,revision:job.revision ?? 1,parentJobId:job.parentJobId,
    canRefine,styleName:job.styleName,
    canRestore: job.copyId !== undefined && !!job.snapshotId,
    canReconcile: canReconcile(job), recoveryNote: job.recoveryNote,
    title: job.plan?.title ?? "照片已读取",
    analysis: analysis ? [...Object.values(analysis), ...plan.warnings].filter(Boolean).join("\n\n") : sections,
    displayAnalysis: sections,
    diff: (job.diff ?? []).map(d=>`${d.key}: ${JSON.stringify(d.before)} → ${JSON.stringify(d.after)}`).join("\n"),
    displayDiff: describeDiff(job.diff ?? []),
    hasMaskChanges: !!job.masks?.length,
    maskSummary: maskLines.join("\n\n"),
    stepDiff:(job.stepDiff ?? job.diff ?? []).map(d=>`${d.key}: ${JSON.stringify(d.before)} → ${JSON.stringify(d.after)}`).join("\n"),
    displayStepDiff:describeDiff(job.stepDiff ?? job.diff ?? []),
    beforePath,
    afterPath: canRefine ? path.join(dir, "after.jpg") : "",
    referencePath,
    error: job.error, recoveryError: job.recoveryError, outcomeUnknown: job.outcomeUnknown,
  };
}

export function parseGenerateRequest(raw: unknown): GradeRequest {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("缺少调色输入");
  const data = raw as Record<string,unknown>;
  if (Object.keys(data).some(k => !["mode","prompt","reference","strength","localMasks"].includes(k))) throw new Error("未知调色输入");
  if (data.localMasks !== undefined && typeof data.localMasks !== "boolean") throw new Error("局部蒙版选项无效");
  if (!["describe","reference","lucky"].includes(String(data.mode))) throw new Error("请选择调色方式");
  if (typeof data.prompt !== "string" || data.prompt.length > 24000) throw new Error("风格描述过长");
  if (typeof data.strength !== "number" || !Number.isFinite(data.strength) || data.strength < 0 || data.strength > 1) throw new Error("强度必须在 0–1 之间");
  if (data.mode === "reference" && data.reference !== undefined && (typeof data.reference !== "string" || !path.isAbsolute(data.reference) || data.reference.length > 2048)) throw new Error("参考图需要完整本地路径");
  if (data.mode === "reference" && !data.reference) throw new Error("请选择参考图片");
  if (data.mode === "describe" && !data.prompt.trim()) throw new Error("请填写风格描述");
  return { mode:data.mode as GradeRequest["mode"], prompt:data.prompt, strength:data.strength,
    ...(data.localMasks === true ? {localMasks:true} : {}),
    ...(data.mode === "reference" ? {reference:data.reference as string} : {}) };
}

async function requestBody(req: IncomingMessage): Promise<Record<string,unknown>> {
  if (!req.headers["content-type"]?.startsWith("application/json")) throw new Error("Content-Type must be application/json");
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64*1024) throw new Error("Request is too large");
    chunks.push(Buffer.from(chunk));
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected JSON object");
  return value as Record<string,unknown>;
}

export class WorkbenchServer {
  private readonly token = randomBytes(32).toString("hex");
  private readonly tasks = new Map<string,Task>();
  private active?: {task: Task; controller: AbortController; done: Promise<void>};
  private closing = false;
  private url = "";
  private readonly server = createServer((req,res) => {void this.route(req,res);});

  constructor(private readonly host: StudioHost, readonly configPath = defaultHostFile(), private readonly onShutdown?: ()=>void, private readonly root?: string) {}

  async start(port = 0) {
    let previous: {url?: string; token?: string} | undefined;
    try { previous = JSON.parse(await readFile(this.configPath,"utf8")); } catch { /* First start. */ }
    if (previous?.url?.match(/^http:\/\/127\.0\.0\.1:\d+$/) && previous.token) {
      const response = await fetch(previous.url+"/health", {headers:{"X-Studio-Token":previous.token},signal:AbortSignal.timeout(1000)}).catch(()=>undefined);
      if (response?.ok) throw new Error("Studio Host 已在运行，请使用现有工作台。");
    }
    await new Promise<void>((resolve,reject) => {this.server.once("error",reject);this.server.listen(port,"127.0.0.1",()=>{this.server.removeListener("error",reject);resolve();});});
    this.server.requestTimeout = 10000;
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    await mkdir(path.dirname(this.configPath),{recursive:true});
    const temporary = `${this.configPath}.${process.pid}.tmp`;
    await writeFile(temporary,JSON.stringify({version:1,url:this.url,token:this.token,pid:process.pid}),{mode:0o600});
    await rename(temporary,this.configPath);
    return {url:this.url,configPath:this.configPath};
  }

  async stop() {
    this.closing = true;
    if (this.active?.task.cancellable) this.active.controller.abort();
    await this.active?.done;
    await new Promise<void>(resolve => this.server.close(()=>resolve()));
    try {
      const config = JSON.parse(await readFile(this.configPath,"utf8"));
      if (config.token === this.token) await unlink(this.configPath);
    } catch { /* Another host or a removed config must not be overwritten. */ }
  }

  private send(res: ServerResponse, status: number, data: unknown) {
    res.writeHead(status,{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"});
    res.end(JSON.stringify(data));
  }

  private async route(req: IncomingMessage,res: ServerResponse) {
    const supplied = req.headers["x-studio-token"];
    if (req.headers.origin || typeof supplied !== "string" || Buffer.byteLength(supplied) !== Buffer.byteLength(this.token) || !timingSafeEqual(Buffer.from(supplied),Buffer.from(this.token))) {
      this.send(res,403,{error:"Unauthorized local client"});return;
    }
    if (req.headers.host !== new URL(this.url).host) {this.send(res,403,{error:"Invalid host"});return;}
    try {
      if (req.method === "GET" && req.url === "/health") {this.send(res,200,{ok:true,version:VERSION,busy:!!this.active,root:this.root});return;}
      if (req.method === "GET" && req.url === "/workspace") {
        const [conversations,styles,batches]=await Promise.all([this.host.conversations(),this.host.styles.list(),this.host.batches.list()]);
        this.send(res,200,{conversations,styles,batches});return;
      }
      const batchMatch = req.url?.match(/^\/batches\/([0-9a-f-]{36})$/);
      if (req.method === "GET" && batchMatch) {
        const current = this.active?.task.batch;
        this.send(res, 200, current?.id === batchMatch[1] ? current : await this.host.batches.show(batchMatch[1]));
        return;
      }
      const conversationMatch=req.url?.match(/^\/conversations\/([0-9a-f-]{36})$/);
      if(req.method==="GET" && conversationMatch) {this.send(res,200,await this.host.conversation(conversationMatch[1]));return;}
      const styleMatch=req.url?.match(/^\/styles\/([0-9a-f-]{36})$/);
      if(req.method==="GET" && styleMatch) {this.send(res,200,this.host.styles.view(await this.host.styles.load(styleMatch[1])));return;}
      const xmpMatch = req.url?.match(/^\/styles\/([0-9a-f-]{36})\/xmp$/);
      if (req.method === "POST" && xmpMatch) {
        const body = await requestBody(req);
        if (Object.keys(body).length !== 1 || typeof body.output !== "string") throw new Error("请选择 XMP 文件路径");
        this.send(res, 200, await this.host.styles.exportXmp(xmpMatch[1], body.output));
        return;
      }
      const taskMatch = req.url?.match(/^\/tasks\/([0-9a-f-]{36})$/);
      if (req.method === "GET" && taskMatch) {
        const task = this.tasks.get(taskMatch[1]);this.send(res,task ? 200 : 404,task ?? {error:"任务不存在，请重新读取照片"});return;
      }
      const jobMatch = req.url?.match(/^\/jobs\/([0-9a-f-]{36})$/);
      if (req.method === "GET" && jobMatch) {this.send(res,200,await jobView(await this.host.store.load(jobMatch[1]),this.host));return;}
      if (req.method === "POST" && req.url === "/cancel") {
        const { taskId } = await requestBody(req);
        const active = this.active;
        if (!active?.task.cancellable || (taskId !== undefined && taskId !== active.task.id)) {
          this.send(res,409,{error:"当前没有可停止的对应任务"});return;
        }
        active.task.cancellable = false;
        active.controller.abort();this.send(res,200,{ok:true});return;
      }
      if (req.method === "POST" && req.url === "/shutdown") {
        if (this.active || !this.onShutdown) {this.send(res,409,{error:"请等待当前任务完成后再停止 Host"});return;}
        this.send(res,200,{ok:true});this.onShutdown();return;
      }
      if (req.method === "POST" && req.url === "/tasks") {
        if (this.active || this.closing) {this.send(res,409,{error:"已有任务进行中，请等待完成"});return;}
        const body = await requestBody(req);
        if (this.active || this.closing) {this.send(res,409,{error:"已有任务进行中，请等待完成"});return;}
        const fields: Record<Task["stage"], string[]> = {
          capture:["photoId"],generate:["photoId","request"],preview:["jobId"],restore:["jobId"],reconcile:["jobId"],refine:["jobId","feedback","strength","localMasks"],
          "save-style":["jobId","name"],"apply-style":["styleId","photoId","strength","extra","localMasks"],
          "batch-plan":["styleId","photoIds","strength"],"batch-preview":["batchId"],
        };
        if (typeof body.action !== "string" || !Object.hasOwn(fields, body.action)) throw new Error("未知操作");
        const action = body.action as Task["stage"];
        if (Object.keys(body).some(key => !["action",...fields[action]].includes(key))) throw new Error("未知操作输入");
        if (body.localMasks!==undefined && typeof body.localMasks!=="boolean") throw new Error("局部蒙版选项无效");
        if (body.photoId !== undefined && (typeof body.photoId !== "string" || !/^\d+$/.test(body.photoId))) throw new Error("照片 ID 无效");
        const request = action === "generate" ? parseGenerateRequest(body.request) : undefined;
        if (["preview","restore","reconcile","refine","save-style"].includes(action)) this.host.store.dir(String(body.jobId));
        if(action==="refine" && (typeof body.feedback!=="string" || !body.feedback.trim() || body.feedback.length>8000)) throw new Error("请填写 1–8000 字符的调整意见");
        if(body.strength!==undefined && (typeof body.strength!=="number" || !Number.isFinite(body.strength) || body.strength<0 || body.strength>1)) throw new Error("强度必须在 0–1 之间");
        if(action==="save-style" && (typeof body.name!=="string" || !body.name.trim() || body.name.trim().length>80)) throw new Error("风格名称需要 1–80 个字符");
        if(action==="apply-style") {
          this.host.styles.dir(String(body.styleId));
          if(body.extra!==undefined && (typeof body.extra!=="string" || body.extra.length>8000)) throw new Error("附加描述过长");
        }
        const batchPhotos = action === "batch-plan" ? parseBatchPhotos(body.photoIds) : undefined;
        if (action === "batch-plan") this.host.styles.dir(String(body.styleId));
        if (action === "batch-preview") this.host.batches.dir(String(body.batchId));
        const generates=["generate","refine","apply-style"].includes(action);
        const task: Task = {id:randomUUID(),state:"running",stage:generates ? "capture" : action,
          cancellable:generates || action === "capture" || action === "batch-plan" || action === "batch-preview"};
        const controller = new AbortController();
        this.tasks.set(task.id,task);
        const run = async () => {
          try {
            if (batchPhotos || action === "batch-preview") {
              const publish = (batch: BatchView) => { task.batch = batch; };
              task.batch = batchPhotos
                ? await this.host.batches.plan(String(body.styleId), batchPhotos, body.strength as number | undefined, controller.signal, publish)
                : await this.host.batches.preview(String(body.batchId), publish, controller.signal);
              task.state = "completed";
              return;
            }
            let job: Job;
            if (action === "capture" || generates) {
              if(action==="refine") job=await this.host.prepareRefinement(String(body.jobId),body.feedback as string,body.strength as number|undefined,body.localMasks===true,controller.signal);
              else if(action==="apply-style") job=await this.host.captureStyle(String(body.styleId),body.photoId as string|undefined,body.strength as number|undefined,body.extra as string|undefined,undefined,body.localMasks===true,controller.signal);
              else job = await this.host.capture(request ?? {mode:"lucky",prompt:"",strength:1},body.photoId as string|undefined,undefined,controller.signal);
              task.job = await jobView(job,this.host);
              if (generates) {
                controller.signal.throwIfAborted();
                task.stage = "generate";task.cancellable = true;
                job = await this.host.plan(job.id,controller.signal);
              }
            } else {
              task.job = await jobView(await this.host.store.load(String(body.jobId)),this.host);
              if(action==="save-style") {await this.host.saveStyle(String(body.jobId),body.name as string);job=await this.host.store.load(String(body.jobId));}
              else if(action==="reconcile") job=await this.host.reconcile(String(body.jobId));
              else job = action === "preview" ? await this.host.preview(String(body.jobId)) : await this.host.restore(String(body.jobId));
            }
            task.job = await jobView(job,this.host);task.state = "completed";
          } catch (error) {
            task.error = controller.signal.aborted ? (task.stage==="capture" ? "已停止读取照片。" : "生成已停止，可重新生成方案。") : String(error);
            if (task.job) {
              try {task.job = await jobView(await this.host.store.load(task.job.id),this.host);} catch { /* Keep the primary error if the journal is unavailable. */ }
            }
            task.state = "failed";
          } finally {task.cancellable = false;this.active = undefined;}
        };
        // Claim the slot before starting any asynchronous Lightroom operation.
        this.active = {task,controller,done:Promise.resolve()};
        this.active.done = run();
        this.send(res,202,task);
        while (this.tasks.size > 100) {
          const oldest = this.tasks.keys().next().value;
          if (oldest) this.tasks.delete(oldest);
        }
        return;
      }
      this.send(res,404,{error:"Unknown endpoint"});
    } catch(error) {this.send(res,400,{error:String(error)});}
  }
}
