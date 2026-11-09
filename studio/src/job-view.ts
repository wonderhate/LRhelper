import path from "node:path";
import { canReconcile, hasVerifiedPreview } from "./job-store.js";
import { imageLimit, localFilePath } from "./local-files.js";
import type { StudioHost } from "./studio-host.js";
import type { Diff, Job } from "./types.js";

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
