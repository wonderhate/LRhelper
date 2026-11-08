import { mkdir, writeFile, rename, readdir } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { checkImage, hasVerifiedPreview, type JobStore } from "./job-store.js";
import type { GradePlan, Job, Settings } from "./types.js";
import { canExportXmp, exportStyleXmp } from "./xmp-preset.js";
import { imageLimit, isRecordId, localFilePath, readLocalFile, readRecord } from "./local-files.js";
import { validStyle } from "./journal-schema.js";

export interface SavedStyle {
  version: 1;
  id: string;
  name: string;
  createdAt: string;
  intent: string;
  strength: number;
  sourceJobId: string;
  sourcePlan: GradePlan;
  sourceSettings?: Settings;
  sourceBaseline?: Settings;
  referenceFile?: string;
}

export class StyleLibrary {
  constructor(readonly root: string) {}
  dir(id: string) {
    if(!isRecordId(id)) throw new Error("风格 ID 无效");
    return path.join(this.root,id);
  }
  async load(id: string): Promise<SavedStyle> {
    const problem = "风格记录无效";
    const style=await readRecord(this.dir(id),"style.json",problem);
    if(!validStyle(style) || style.id!==id) throw new Error(problem);
    if(style.referenceFile) await localFilePath(this.dir(id),style.referenceFile,imageLimit,"风格参考图不可用");
    return style;
  }
  view(style: SavedStyle) {
    return {id:style.id,name:style.name,createdAt:style.createdAt,intent:style.intent,strength:style.strength,hasReference:!!style.referenceFile,referencePath:style.referenceFile ? path.join(this.dir(style.id),style.referenceFile) : "",canExportXmp:canExportXmp(style)};
  }
  async exportXmp(id: string, output: string) {
    return exportStyleXmp(await this.load(id), output);
  }
  async list() {
    const entries=await readdir(this.root,{withFileTypes:true}).catch((error: NodeJS.ErrnoException)=>{if(error.code==="ENOENT") return [];throw error;});
    const styles=[];
    for(const entry of entries) if(entry.isDirectory() && isRecordId(entry.name)) {
      try {styles.push(this.view(await this.load(entry.name)));} catch { /* Keep other valid local styles visible. */ }
    }
    return styles.sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||a.name.localeCompare(b.name));
  }
  async save(job: Job, chain: Job[], name: string, store: JobStore) {
    if(typeof name!=="string" || !name.trim() || name.trim().length>80) throw new Error("风格名称需要 1–80 个字符");
    if(!job.plan || !await hasVerifiedPreview(job,store.dir(job.id))) throw new Error("请先完成预览，再保存风格");
    const directions=chain.map((turn,index)=>`${index===0 ? "初始意图" : "继续调整"}：${turn.request.prompt || "根据目标照片选择自然、克制的调色"}`);
    const intent=[...directions,`适配思路：${job.plan.analysis.adaptation}`,`肤色原则：${job.plan.analysis.skin}`].join("\n");
    if(intent.length>20000) throw new Error("风格意图过长，请以简短描述重新开始会话后保存");
    const reference=job.referenceFile ? await readLocalFile(store.dir(job.id),job.referenceFile,imageLimit,"任务参考图无效") : undefined;
    const style: SavedStyle={version:1,id:randomUUID(),name:name.trim(),createdAt:new Date().toISOString(),intent,strength:chain[0].request.strength,sourceJobId:job.id,sourcePlan:job.plan,sourceSettings:job.settings,sourceBaseline:job.baseline};
    if(reference) style.referenceFile=`reference.${checkImage(reference)}`;
    await mkdir(this.dir(style.id),{recursive:true});
    if(reference && style.referenceFile) await writeFile(path.join(this.dir(style.id),style.referenceFile),reference,{mode:0o600});
    const file=path.join(this.dir(style.id),"style.json"),temporary=`${file}.${randomUUID()}.tmp`;
    await writeFile(temporary,JSON.stringify(style,null,2),{mode:0o600});await rename(temporary,file);
    return this.view(style);
  }
}
