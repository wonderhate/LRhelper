import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, link, open, readdir, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import { curves, equalValue, hueSaturation, ranges } from "./grading/settings.js";
import { validateCurve } from "./grading/validator.js";
import type { SavedStyle } from "./style-library.js";
import type { Settings } from "./types.js";

const presetScalars = new Set([
  "Contrast2012", "Highlights2012", "Shadows2012", "Whites2012", "Blacks2012",
  "Texture", "Clarity2012", "Dehaze", "Vibrance", "Saturation",
  ...Object.keys(ranges).filter(key => /^(Hue|Saturation|Luminance)Adjustment/.test(key)),
  ...Object.keys(hueSaturation), ...Object.values(hueSaturation),
  "SplitToningBalance", "ColorGradeBlending", "ColorGradeShadowLum", "ColorGradeMidtoneLum",
  "ColorGradeHighlightLum", "ColorGradeGlobalLum", "GrainAmount", "GrainSize", "GrainFrequency",
  "PostCropVignetteAmount",
]);

const photoExtensions = new Set((
  "3fr arw avif bmp cr2 cr3 crw dcr dng fff gpr heic heif iiq jpe jpeg jpg jxl kdc mef mos mrw nef nrw " +
  "orf pef png psd raf raw rw2 rwl sr2 srf srw tif tiff webp"
).split(" "));

function xmlText(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function presetName(name: string) {
  const cleaned = name.replace(/\s+/gu, " ").trim();
  if (!cleaned || /[^\u0020-\ud7ff\ue000-\ufffd\u{10000}-\u{10ffff}]/u.test(cleaned)) {
    throw new Error("风格名称包含 XMP 不支持的字符");
  }
  return cleaned;
}

function presetSettings(style: SavedStyle): Settings {
  const settings: Settings = {};
  for (const [key, value] of Object.entries(style.sourceSettings ?? {})) {
    if (!presetScalars.has(key) && !curves.includes(key)) continue;
    if (curves.includes(key)) {
      if (!Array.isArray(value)) throw new Error(`XMP 曲线无效：${key}`);
      validateCurve(value);
    } else {
      const [min, max] = ranges[key];
      if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
        throw new Error(`XMP 参数无效：${key}`);
      }
    }
    if (!equalValue(value, style.sourceBaseline?.[key], 0)) settings[key] = value;
  }
  return settings;
}

export function canExportXmp(style: SavedStyle) {
  try {
    return Object.keys(presetSettings(style)).length > 0 && !!presetName(style.name);
  } catch {
    return false;
  }
}

function renderXmp(style: SavedStyle, settings: Settings) {
  const name = presetName(style.name);
  const uuid = createHash("sha256").update(`LR Codex Studio XMP v1:${style.id}`).digest("hex").slice(0, 32).toUpperCase();
  const entries = Object.entries(settings).sort(([a], [b]) => a.localeCompare(b));
  const scalars = entries.flatMap(([key, value]) => typeof value === "number" ? [`   crs:${key}="${value}"`] : []);
  if (settings.ToneCurvePV2012) scalars.push('   crs:ToneCurveName2012="Custom"');
  const sequences = entries.flatMap(([key, value]) => {
    if (!Array.isArray(value)) return [];
    const points = [];
    for (let i = 0; i < value.length; i += 2) points.push(`<rdf:li>${value[i]}, ${value[i + 1]}</rdf:li>`);
    return [`   <crs:${key}><rdf:Seq>${points.join("")}</rdf:Seq></crs:${key}>`];
  });
  const group = "LR Codex Studio";
  const titles = [["Name", name], ["ShortName", Array.from(name).slice(0, 32).join("")], ["SortName", name], ["Group", group]];
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<x:xmpmeta xmlns:x="adobe:ns:meta/">',
    ' <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">',
    '  <rdf:Description rdf:about="" xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"',
    '   crs:PresetType="Normal" crs:Version="15.0" crs:SupportsAmount="False"',
    '   crs:SupportsColor="True" crs:SupportsMonochrome="False"',
    '   crs:SupportsHighDynamicRange="False" crs:SupportsNormalDynamicRange="True"',
    '   crs:SupportsSceneReferred="True" crs:SupportsOutputReferred="True"',
    `   crs:UUID="${uuid}"`, ...scalars, "  >", ...sequences,
    ...titles.map(([key, value]) => `   <crs:${key}><rdf:Alt><rdf:li xml:lang="x-default">${xmlText(value)}</rdf:li></rdf:Alt></crs:${key}>`),
    "  </rdf:Description>", " </rdf:RDF>", "</x:xmpmeta>", "",
  ].join("\n");
}

export async function exportStyleXmp(style: SavedStyle, output: string) {
  const settings = presetSettings(style);
  const keys = Object.keys(settings).sort();
  if (!keys.length) throw new Error("此风格没有可导出的 XMP 参数，请选择包含全局调色的风格");
  if (!path.isAbsolute(output) || output.length > 2048 || /[\u0000-\u001f]/.test(output) || path.extname(output).toLowerCase() !== ".xmp") {
    throw new Error("请选择完整的本地 .xmp 文件路径");
  }
  if (process.platform === "win32" && !/^[a-z]:[\\/][^:]*$/i.test(output)) {
    throw new Error("请选择本机磁盘上的 .xmp 文件");
  }
  const directory = await realpath(path.dirname(output));
  if (process.platform === "win32" && !/^[a-z]:[\\/]/i.test(directory)) {
    throw new Error("请选择本机磁盘上的 .xmp 文件");
  }
  const target = path.join(directory, path.basename(output));
  const stem = path.parse(target).name.toLowerCase();
  if (process.platform === "win32" && /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(stem)) {
    throw new Error("请选择有效的 Windows 预设文件名");
  }
  const siblings = await readdir(directory);
  if (siblings.some(entry => {
    const photo = path.parse(entry.toLowerCase());
    return photoExtensions.has(photo.ext.slice(1)) && (photo.name === stem || photo.base === stem);
  })) throw new Error("文件名与同目录的照片匹配，请使用独立的预设文件名");

  const content = renderXmp(style, settings);
  const temporary = path.join(directory, `.lr-studio-${randomUUID()}.tmp`);
  const file = await open(temporary, "wx", 0o600);
  try {
    try {
      await file.writeFile(content, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await link(temporary, target);
    } catch (error) {
      if (!["EPERM", "ENOSYS", "ENOTSUP", "EOPNOTSUPP"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      // Removable drives may not support hard links. Exclusive copy still refuses replacement.
      await copyFile(temporary, target, constants.COPYFILE_EXCL);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("目标文件已存在，请选择新的文件名");
    throw error;
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
  return { path: target, keys };
}
