import { equalValue, hueSaturation, ranges } from "./settings.js";
import { validateCurve } from "./validator.js";
import type { GradePlan, Settings, Diff } from "../types.js";

function at(points: number[], x: number): number {
  for(let i=2;i<points.length;i+=2) if(x<=points[i]) return points[i-1]+(points[i+1]-points[i-1])*(x-points[i-2])/(points[i]-points[i-2]);
  return points.at(-1)!;
}
export function mapPlan(plan: GradePlan, baseline: Settings, strength: number): {settings: Settings; diff: Diff[]} {
  if (!Number.isFinite(strength) || strength<0 || strength>1) throw new Error("Strength must be between 0 and 1");
  const settings: Settings = {};
  for(const item of plan.scalars) {
    const before = baseline[item.key];
    if(typeof before !== "number" || !Number.isFinite(before)) throw new Error(`Missing numeric baseline: ${item.key}`);
    const target = item.mode === "delta" ? before+item.value : item.value;
    const range = ranges[item.key];
    if(!range || !Number.isFinite(target) || target<range[0] || target>range[1]) throw new Error(`Result out of range: ${item.key}`);
    if(strength===0) continue;
    let after = before+(target-before)*strength;
    if(Object.hasOwn(hueSaturation,item.key)) {
      const sat = baseline[hueSaturation[item.key]];
      // Hue is an angle, and a neutral baseline has no visible hue to interpolate from.
      after = sat === 0 && strength > 0 ? target : (before+(((target-before+540)%360)-180)*strength+360)%360;
    }
    after = Math.round(after*(item.key === "Exposure2012" ? 100 : 1))/(item.key === "Exposure2012" ? 100 : 1);
    if (!equalValue(before,after,0)) settings[item.key]=after;
  }
  for(const curve of plan.curves) {
    const before=baseline[curve.key];
    if(!Array.isArray(before)) throw new Error(`Missing curve baseline: ${curve.key}`);
    validateCurve(before);
    const xs=[...new Set([...before.filter((_,i)=>i%2===0),...curve.points.filter((_,i)=>i%2===0)])].sort((a,b)=>a-b);
    const after=xs.flatMap(x=>[x,Math.round(at(before,x)*(1-strength)+at(curve.points,x)*strength)]);
    validateCurve(after);
    if(strength>0 && xs.some(x=>Math.abs(at(before,x)-at(after,x))>0.01)) settings[curve.key]=after;
  }
  return {settings,diff:Object.entries(settings).map(([key,after])=>({key,before:baseline[key],after}))};
}
