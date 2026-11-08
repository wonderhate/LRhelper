import type { LightroomUnknownCode } from "./lightroom.js";

export type Settings = Record<string, number | string | boolean | number[]>;
export type Mode = "describe" | "reference" | "lucky";
export interface GradeRequest {
  mode: Mode;
  prompt: string;
  reference?: string;
  strength: number;
  localMasks?: boolean;
}
export type MaskKind = "subject" | "sky";
export type MaskSlider = "exposure" | "highlights" | "shadows" | "saturation";
export type MaskCapabilities = Partial<Record<MaskKind, Partial<Record<MaskSlider, [number, number]>>>>;
export interface MaskPlan {
  kind: MaskKind;
  reason: string;
  adjustments: { key: MaskSlider; value: number }[];
}
export interface MaskSummary { id: string; name?: string; hidden?: boolean; tools: { id: string }[] }
export interface GradePlan {
  title: string;
  analysis: { target: string; reference: string; adaptation: string; skin: string };
  scalars: { key: string; mode: "delta" | "absolute"; value: number }[];
  curves: { key: string; points: number[] }[];
  warnings: string[];
  masks?: MaskPlan[];
  skinPresence?: "visible" | "uncertain" | "none";
}
export interface Photo {
  id: string | number;
  path: string;
  filename: string;
  catalogPath?: string;
  copyName?: string;
  isVirtualCopy?: boolean;
  virtualCopy?: { masterPhotoId?: string | number; copyIds?: (string | number)[] };
  developSettings: Record<string, unknown>;
  [key: string]: unknown;
}
export interface Diff { key: string; before: Settings[string]; after: Settings[string] }
export interface Job {
  version: 1;
  id: string;
  createdAt: string;
  status: "captured" | "planned" | "creating-copy" | "snapshotting" | "applying" | "rendering" | "previewed" | "restoring" | "restored" | "failed";
  request: GradeRequest;
  source: Photo;
  sourceFingerprint: string;
  baseline: Settings;
  capabilities: string[];
  maskCapabilities?: MaskCapabilities;
  masks?: MaskPlan[];
  maskBaseline?: MaskSummary[];
  maskReadback?: { kind: MaskKind; id: string; adjustments: Record<string, number> }[];
  plan?: GradePlan;
  settings?: Settings;
  diff?: Diff[];
  threadId?: string;
  referenceFile?: string;
  copyId?: string | number;
  copyName?: string;
  snapshotId?: string;
  snapshotName?: string;
  recoveryNote?: string;
  readback?: Settings;
  error?: string;
  recoveryError?: string;
  renderCompleted?: boolean;
  outcomeUnknown?: LightroomUnknownCode;
  parentJobId?: string;
  conversationId?: string;
  revision?: number;
  stepDiff?: Diff[];
  styleId?: string;
  styleName?: string;
}
export interface ConversationTurn {
  direction: string;
  title: string;
  adaptation: string;
}
export interface ModelRuntime {
  generate(input: { request: GradeRequest; photo: Photo; baseline: Settings; keys: string[]; targetImage: string; referenceImage?: string; history?: ConversationTurn[]; maskCapabilities?: MaskCapabilities; previousMasks?: MaskPlan[]; signal?: AbortSignal }): Promise<{ plan: unknown; threadId?: string }>;
}
export interface Lightroom {
  discover(signal?: AbortSignal): Promise<string[]>;
  discoverMasks?(signal?: AbortSignal): Promise<MaskCapabilities>;
  selected(signal?: AbortSignal): Promise<{ id: string | number }[]>;
  metadata(id: string | number, signal?: AbortSignal): Promise<Photo>;
  preview(id: string | number, signal?: AbortSignal): Promise<Buffer>;
  call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
}
