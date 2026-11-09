#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { LightroomClient } from "./lightroom.js";
import { CodexRuntime } from "./codex-runtime.js";
import { JobStore } from "./job-store.js";
import { StudioHost } from "./studio-host.js";
import { WorkbenchServer } from "./workbench-server.js";
import type { Mode } from "./types.js";
import { loadConfiguration } from "./configuration.js";
import { VERSION } from "./version.js";
import { preflight } from "./preflight.js";

const HELP=`LR Codex Studio ${VERSION} — 调色、风格与局部蒙版

  doctor                         检查选中照片并在本机保存诊断预览
  doctor --preflight             检查 Node、Codex 登录和 Lightroom 桥接
  config                         显示生效的配置与数据目录
  serve                          启动 Lightroom 原生工作台的本地 Host
  plan --mode describe --prompt "柔和高光，保留自然肤色"
  plan --mode reference --reference "C:/images/look.jpg"
  plan --mode lucky [--photo ID] [--strength 0.7]
  show JOB_ID                    查看方案及参数差异
  preview JOB_ID                 创建虚拟副本、快照、应用、读回和真实渲染
  restore JOB_ID                 恢复该任务的虚拟副本
  reconcile JOB_ID               核对中断任务的副本与快照（不修改照片）
  refine JOB_ID --prompt "阴影再柔和一点" [--strength 0.65]
  conversations                  列出本地会话
  history JOB_ID                 查看所属会话的轮次
  styles                         列出本地风格
  save-style JOB_ID --name "我的海岸"  保存已预览的调色意图和参考图
  apply-style STYLE_ID [--photo ID] [--strength 0.65] [--prompt "附加方向"]
  export-xmp STYLE_ID --output "C:/Presets/my-style.xmp"
  batches                        列出批次记录
  batch-show BATCH_ID            查看批次中的方案、预览和恢复状态

plan 只读取照片并调用 Codex。preview 是显式执行动作，始终只改新建虚拟副本。
plan、refine、apply-style 可加 --local-masks，启用主体/天空方案和肤色保护。
任务和图片保存在 .studio/jobs（不进入 Git）。配置：
settings.json 或 STUDIO_CODEX_PATH / STUDIO_CODEX_MODEL / STUDIO_DATA_DIR / STUDIO_MCP_ENTRY
`;

async function main() {
  const {values,positionals}=parseArgs({allowPositionals:true,options:{help:{type:"boolean",short:"h"},version:{type:"boolean"},mode:{type:"string"},prompt:{type:"string"},reference:{type:"string"},photo:{type:"string"},strength:{type:"string"},name:{type:"string"},output:{type:"string"},preflight:{type:"boolean"},"local-masks":{type:"boolean"}}});
  const command=positionals[0];
  if(values.version) { console.log(VERSION);return; }
  if(values.help || !command) { console.log(HELP);return; }
  if(!["config","doctor","plan","show","preview","restore","reconcile","serve","refine","conversations","history","styles","save-style","apply-style","export-xmp","batches","batch-show"].includes(command)) throw new Error(`Unknown command: ${command}`);
  const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../..");
  const config=await loadConfiguration(root,process.env);
  if(command==="config") { console.log(JSON.stringify(config,null,2));return; }
  process.env.STUDIO_CODEX_PATH=config.codexPath;
  if(config.model!==undefined) process.env.STUDIO_CODEX_MODEL=config.model;
  process.env.STUDIO_USE_SYSTEM_PROXY=config.useSystemProxy ? "1" : "0";
  if(command==="doctor" && values.preflight) {
    const result=await preflight(config);
    console.log(JSON.stringify(result,null,2));
    if(!result.ok) process.exitCode=1;
    return;
  }
  const store=new JobStore(config.jobsDirectory);
  if(command==="show") { console.log(JSON.stringify(await store.load(positionals[1]),null,2));return; }
  if(["preview","restore","reconcile"].includes(command)) store.dir(positionals[1]);
  const client=new LightroomClient(config.mcpEntry);
  const host=new StudioHost(client,new CodexRuntime(),store);
  if (command === "batches" || command === "batch-show") {
    const batch = command === "batches" ? await host.batches.list() : await host.batches.show(positionals[1]);
    console.log(JSON.stringify(batch, null, 2));
    return;
  }
  if (command === "export-xmp") {
    if (!positionals[1] || !values.output) throw new Error("用法：export-xmp STYLE_ID --output FILE.xmp");
    console.log(JSON.stringify(await host.styles.exportXmp(positionals[1], path.resolve(values.output)), null, 2));
    return;
  }
  if(["conversations","history","styles","save-style"].includes(command)) {
    const data=command==="conversations" ? await host.conversations() : command==="history" ? await host.conversation(positionals[1]) : command==="styles" ? await host.styles.list() : await host.saveStyle(positionals[1],values.name ?? "");
    console.log(JSON.stringify(data,null,2));return;
  }
  const controller=new AbortController();
  process.once("SIGINT",()=>controller.abort());
  try {
    await client.connect();
    if(command==="serve") {
      const server = new WorkbenchServer(host,config.hostFile,()=>controller.abort(),root);
      await server.start();
      console.error("Studio Host 已就绪，可从 Lightroom 菜单打开工作台。按 Ctrl+C 退出。");
      await new Promise<void>(resolve => {controller.signal.addEventListener("abort",()=>resolve(),{once:true});process.once("SIGTERM",()=>resolve());});
      await server.stop();
    } else if(command==="doctor") {
      const job=await host.capture({mode:"lucky",prompt:"",strength:1},values.photo);
      console.log(JSON.stringify({ok:true,photoId:job.source.id,filename:job.source.filename,capabilities:job.capabilities.length,baseline:path.join(store.dir(job.id),"before.jpg"),captureId:job.id},null,2));
    } else if(["plan","refine","apply-style"].includes(command)) {
      const localMasks=values["local-masks"];
      const job=command==="refine" ? await host.prepareRefinement(positionals[1],values.prompt ?? "",Number(values.strength ?? 1),localMasks) : command==="apply-style" ? await host.captureStyle(positionals[1],values.photo,values.strength===undefined ? undefined : Number(values.strength),values.prompt ?? "",undefined,localMasks) : await host.capture({mode:(values.mode ?? "describe") as Mode,prompt:values.prompt ?? "",reference:values.reference ? path.resolve(values.reference) : undefined,strength:Number(values.strength ?? 1),localMasks},values.photo);
      console.error(`已读取照片；任务 ${job.id}`);
      const planned=await host.plan(job.id,controller.signal);
      console.log(JSON.stringify({id:planned.id,conversationId:planned.conversationId,parentJobId:planned.parentJobId,revision:planned.revision,status:planned.status,title:planned.plan?.title,analysis:planned.plan?.analysis,stepDiff:planned.stepDiff,diff:planned.diff,masks:planned.masks,skinPresence:planned.plan?.skinPresence,warnings:planned.plan?.warnings},null,2));
    } else {
      const job=command==="preview" ? await host.preview(positionals[1]) :
        command==="reconcile" ? await host.reconcile(positionals[1]) : await host.restore(positionals[1]);
      console.log(JSON.stringify({id:job.id,status:job.status,copyId:job.copyId,snapshotId:job.snapshotId,recoveryNote:job.recoveryNote,artifacts:store.dir(job.id)},null,2));
    }
  } finally { await client.close(); }
}
main().catch(error=>{
  if(process.argv[2]==="serve") console.error("Studio Host 启动失败。请检查安装配置和 Lightroom MCP 连接。");
  else console.error(String(error));
  process.exitCode=1;
});
