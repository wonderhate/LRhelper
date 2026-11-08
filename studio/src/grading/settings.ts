import { createHash } from "node:crypto";
import type { Photo, Settings } from "../types.js";

export const curves = ["ToneCurvePV2012", "ToneCurvePV2012Red", "ToneCurvePV2012Green", "ToneCurvePV2012Blue"];
export const ranges: Record<string, readonly [number, number]> = {
  Exposure2012: [-5, 5], Temperature: [2000, 50000], Tint: [-150, 150],
};
for (const key of ["Contrast2012", "Highlights2012", "Shadows2012", "Whites2012", "Blacks2012", "Texture", "Clarity2012", "Dehaze", "Vibrance", "Saturation", "SplitToningBalance", "ColorGradeShadowLum", "ColorGradeMidtoneLum", "ColorGradeHighlightLum", "ColorGradeGlobalLum", "ShadowTint", "RedHue", "RedSaturation", "GreenHue", "GreenSaturation", "BlueHue", "BlueSaturation", "PostCropVignetteAmount"]) ranges[key] = [-100, 100];
for (const colour of ["Red", "Orange", "Yellow", "Green", "Aqua", "Blue", "Purple", "Magenta"]) {
  for (const channel of ["Hue", "Saturation", "Luminance"]) ranges[`${channel}Adjustment${colour}`] = [-100, 100];
}
export const hueSaturation: Record<string, string> = {
  SplitToningShadowHue: "SplitToningShadowSaturation",
  SplitToningHighlightHue: "SplitToningHighlightSaturation",
  ColorGradeMidtoneHue: "ColorGradeMidtoneSat",
  ColorGradeGlobalHue: "ColorGradeGlobalSat",
};
for (const [hue, sat] of Object.entries(hueSaturation)) { ranges[hue] = [0, 360]; ranges[sat] = [0, 100]; }
for (const key of ["ColorGradeBlending", "GrainAmount", "GrainSize", "GrainFrequency"]) ranges[key] = [0, 100];

const aliases: Record<string, string> = {
  whiteBalance: "WhiteBalance", temperature: "Temperature", tint: "Tint", exposure: "Exposure2012",
  contrast: "Contrast2012", highlights: "Highlights2012", shadows: "Shadows2012", whites: "Whites2012", blacks: "Blacks2012",
  texture: "Texture", clarity: "Clarity2012", dehaze: "Dehaze", vibrance: "Vibrance", saturation: "Saturation",
  toneCurve: curves[0], toneCurveRed: curves[1], toneCurveGreen: curves[2], toneCurveBlue: curves[3],
};
export function flatten(develop: Photo["developSettings"]): Settings {
  const out: Settings = {};
  function walk(group: Record<string, unknown>) {
    for (const [key, value] of Object.entries(group)) {
      if (value && typeof value === "object" && !Array.isArray(value)) walk(value as Record<string, unknown>);
      else if (value !== undefined && value !== null) out[aliases[key] ?? key] = value as Settings[string];
    }
  }
  walk(develop);
  return out;
}
export function allowedKeys(liveKeys: string[], baseline: Settings): string[] {
  return liveKeys.filter(key => (Object.hasOwn(ranges, key) || curves.includes(key)) && Object.hasOwn(baseline, key))
    .filter(key => key !== "Temperature" || (typeof baseline.Temperature === "number" && baseline.Temperature >= 2000));
}
export function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k,v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export function fingerprint(photo: Photo): string {
  return createHash("sha256").update(stable({ id: String(photo.id), path: photo.path, settings: photo.developSettings })).digest("hex");
}
export function equalValue(a: unknown, b: unknown, tolerance = 0.02): boolean {
  if (typeof a === "number" && typeof b === "number") return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tolerance;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v,i) => equalValue(v,b[i], tolerance));
  return a === b;
}
