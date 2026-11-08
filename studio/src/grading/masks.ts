import type { GradePlan, MaskCapabilities, MaskKind, MaskPlan, MaskSlider, Settings } from "../types.js";

export const maskKinds = ["subject", "sky"] as const;
export const maskLimits: Record<MaskSlider, number> = { exposure: 0.5, highlights: 30, shadows: 25, saturation: 8 };
export const maskSliderNames: Record<MaskSlider, string> = {
  exposure: "local_Exposure", highlights: "local_Highlights", shadows: "local_Shadows", saturation: "local_Saturation",
};

export function maskSchema(capabilities: MaskCapabilities) {
  const kinds = Object.keys(capabilities);
  const sliders = [...new Set(Object.values(capabilities).flatMap(values => Object.keys(values)))];
  return {
    masks: { type: "array", maxItems: kinds.length, items: {
      type: "object", additionalProperties: false, required: ["kind", "reason", "adjustments"], properties: {
        kind: { type: "string", enum: kinds },
        reason: { type: "string", minLength: 1, maxLength: 200 },
        adjustments: { type: "array", minItems: 1, maxItems: sliders.length, items: {
          type: "object", additionalProperties: false, required: ["key", "value"], properties: {
            key: { type: "string", enum: sliders }, value: { type: "number" },
          },
        } },
      },
    } },
    skinPresence: { type: "string", enum: ["visible", "uncertain", "none"] },
  };
}

export function checkMask(mask: MaskPlan, capabilities: MaskCapabilities) {
  const seen = new Set<MaskSlider>();
  for (const {key, value} of mask.adjustments) {
    const range = capabilities[mask.kind]?.[key];
    if (!range || seen.has(key) || !Number.isFinite(value) || value < range[0] || value > range[1]) {
      throw new Error(`局部参数无效或当前 Lightroom 不支持：${mask.kind} / ${key}`);
    }
    seen.add(key);
  }
}

export function mapMasks(previous: MaskPlan[], proposals: MaskPlan[], strength: number) {
  const masks = new Map<MaskKind, MaskPlan>(previous.map(mask => [mask.kind, mask]));
  if (strength === 0) return previous;
  for (const proposal of proposals) {
    const sliders = new Map(masks.get(proposal.kind)?.adjustments.map(({key, value}) => [key, value]));
    for (const {key, value} of proposal.adjustments) {
      const before = sliders.get(key) ?? 0;
      const precision = key === "exposure" ? 100 : 1;
      const after = Math.round((before + (value - before) * strength) * precision) / precision;
      if (after) sliders.set(key, after);
      else sliders.delete(key);
    }
    if (sliders.size) masks.set(proposal.kind, {...proposal, adjustments: [...sliders].map(([key, value]) => ({key, value}))});
    else masks.delete(proposal.kind);
  }
  return [...masks.values()];
}

export function limitSkinHsl(plan: GradePlan, baseline: Settings): GradePlan {
  if (!plan.skinPresence || plan.skinPresence === "none") return plan;
  const limits: Record<string, number> = { Hue: 6, Saturation: 10, Luminance: 12 };
  return {...plan, scalars: plan.scalars.map(item => {
    const channel = /^(Hue|Saturation|Luminance)Adjustment(?:Red|Orange)$/.exec(item.key);
    const before = baseline[item.key];
    if (!channel || typeof before !== "number") return item;
    const limit = limits[channel[1]];
    const target = item.mode === "absolute" ? item.value : before + item.value;
    const bounded = Math.max(-100, before - limit, Math.min(100, before + limit, target));
    return {...item, mode: "absolute", value: bounded};
  })};
}
