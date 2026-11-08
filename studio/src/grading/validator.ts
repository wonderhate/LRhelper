import { Ajv } from "ajv";
import { ranges, curves } from "./settings.js";
import { checkMask, maskSchema } from "./masks.js";
import type { GradePlan, MaskCapabilities } from "../types.js";

export function planSchema(keys: string[], masks?: MaskCapabilities) {
  const scalarKeys = keys.filter(k => Object.hasOwn(ranges,k));
  const curveKeys = keys.filter(k => curves.includes(k));
  return {
    type: "object", additionalProperties: false, required: ["title", "analysis", "scalars", "curves", "warnings", ...(masks ? ["masks", "skinPresence"] : [])],
    properties: {
      title: { type: "string", minLength: 1, maxLength: 160 },
      analysis: { type: "object", additionalProperties: false, required: ["target", "reference", "adaptation", "skin"], properties: Object.fromEntries(["target", "reference", "adaptation", "skin"].map(k=>[k,{ type:"string", maxLength:4000 }])) },
      scalars: { type:"array", maxItems:80, items: { type:"object", additionalProperties:false, required:["key","mode","value"], properties: { key:{type:"string",enum:scalarKeys.length ? scalarKeys : ["__unavailable__"]}, mode:{type:"string",enum:["delta","absolute"]}, value:{type:"number"} } } },
      curves: { type:"array", maxItems:4, items: { type:"object", additionalProperties:false, required:["key","points"], properties:{ key:{type:"string",enum:curveKeys.length ? curveKeys : ["__unavailable__"]}, points:{type:"array",minItems:4,maxItems:64,items:{type:"integer",minimum:0,maximum:255}} } } },
      warnings: {type:"array",maxItems:20,items:{type:"string",maxLength:2000}},
      ...(masks ? maskSchema(masks) : {}),
    },
  };
}
export function validateCurve(points: number[]): void {
  if (points.length < 4 || points.length > 64 || points.length % 2) throw new Error("Curve needs 2–32 x/y pairs");
  if (points[0] !== 0 || points.at(-2) !== 255) throw new Error("Curve must cover input 0–255");
  for (let i=0;i<points.length;i+=2) {
    if (!Number.isInteger(points[i]) || !Number.isInteger(points[i+1]) || points[i]<0 || points[i]>255 || points[i+1]<0 || points[i+1]>255) throw new Error("Invalid curve point");
    if (i && (points[i]<=points[i-2] || points[i+1]<points[i-1])) throw new Error("Curve must increase in x and not reverse in y");
  }
}
export function validatePlan(raw: unknown, keys: string[], masks?: MaskCapabilities): GradePlan {
  const validate = new Ajv({allErrors:true,strict:true}).compile(planSchema(keys,masks));
  if (!validate(raw)) throw new Error(`Invalid grading plan: ${JSON.stringify(validate.errors)}`);
  const plan = raw as unknown as GradePlan;
  const seen = new Set<string>();
  for (const item of [...plan.scalars,...plan.curves]) {
    if (!keys.includes(item.key)) throw new Error(`Unsupported setting: ${item.key}`);
    if (seen.has(item.key)) throw new Error(`Duplicate setting: ${item.key}`);
    seen.add(item.key);
  }
  for (const item of plan.scalars) {
    if (!Number.isFinite(item.value)) throw new Error("Nonfinite value");
    if (["Temperature","Tint"].includes(item.key) && item.mode !== "delta") throw new Error("White balance must be relative to the target");
    if (item.mode === "absolute") {
      const [min,max] = ranges[item.key];
      if (item.value < min || item.value > max) throw new Error(`Out of range: ${item.key}`);
    }
    if (item.key === "Temperature" && Math.abs(item.value)>1500) throw new Error("WB shift exceeds preview limit of 1500 K");
    if (item.key === "Tint" && Math.abs(item.value)>30) throw new Error("Tint shift exceeds preview limit of 30");
  }
  plan.curves.forEach(c=>validateCurve(c.points));
  if (masks && plan.masks) {
    if (new Set(plan.masks.map(mask=>mask.kind)).size!==plan.masks.length) throw new Error("同一区域只能有一个局部蒙版");
    for (const mask of plan.masks) checkMask(mask,masks);
  }
  return plan;
}
