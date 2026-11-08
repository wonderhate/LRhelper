import { Ajv } from "ajv";
import { maskKinds, maskLimits, maskSchema } from "./grading/masks.js";
import { curves, ranges } from "./grading/settings.js";
import { planSchema } from "./grading/validator.js";
import { recordIdPattern } from "./local-files.js";
import type { SavedStyle } from "./style-library.js";
import type { Batch } from "./batch-queue.js";
import type { Job } from "./types.js";

const text = { type: "string" };
const nonEmpty = { type: "string", minLength: 1 };
const bool = { type: "boolean" };
const number = { type: "number" };
const photoId = { anyOf: [{ type: "string", pattern: "^[1-9][0-9]*$" }, { type: "integer", minimum: 1 }] };
const recordId = { type: "string", minLength: 36, maxLength: 36, pattern: recordIdPattern };
const timestamp = { type: "string", pattern: "^\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d\\.\\d{3}Z$" };
const strength = { ...number, minimum: 0, maximum: 1 };
const referenceFile = { enum: ["reference.jpg", "reference.png", "reference.webp"] };
const maskKind = { enum: maskKinds };

const object = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object", required, properties,
});
const array = (items: object) => ({ type: "array", items });
const settingValue = { anyOf: [number, text, bool, array({})] };
const settings = { type: "object", additionalProperties: settingValue };
const diff = array(object({ key: nonEmpty, before: settingValue, after: settingValue }, ["key", "after"]));

const maskRange = { ...array(number), minItems: 2, maxItems: 2 };
const maskSliders = Object.keys(maskLimits);
const fullMasks = Object.fromEntries(maskKinds.map(kind => [kind, maskLimits]));
const savedPlan = planSchema([...Object.keys(ranges), ...curves]);
const masks = maskSchema(fullMasks);
Object.assign(savedPlan.properties, masks);

const jobProperties = {
  status: { enum: ["captured", "planned", "creating-copy", "snapshotting", "applying", "rendering", "previewed", "restoring", "restored", "failed"] },
  request: object({
    mode: { enum: ["describe", "reference", "lucky"] }, prompt: text, strength,
    reference: nonEmpty, localMasks: bool,
  }, ["mode", "prompt", "strength"]),
  source: object({
    id: photoId, path: nonEmpty, filename: nonEmpty, isVirtualCopy: bool, catalogPath: nonEmpty, copyName: text,
    virtualCopy: object({ masterPhotoId: photoId, copyIds: array(photoId) }), developSettings: { type: "object" },
  }, ["id", "path", "filename", "developSettings"]),
  sourceFingerprint: { type: "string", pattern: "^[0-9a-f]{64}$" },
  baseline: settings, capabilities: array(text),
  maskCapabilities: object(Object.fromEntries(maskKinds.map(kind => [kind,
    object(Object.fromEntries(maskSliders.map(slider => [slider, maskRange]))),
  ]))),
  masks: masks.masks,
  maskBaseline: array(object({
    id: nonEmpty, name: text, hidden: bool, tools: array(object({ id: nonEmpty }, ["id"])),
  }, ["id", "tools"])),
  maskReadback: array(object({
    kind: maskKind, id: nonEmpty, adjustments: { type: "object", additionalProperties: number },
  }, ["kind", "id", "adjustments"])),
  plan: savedPlan, settings, diff, stepDiff: diff, readback: settings,
  threadId: text, referenceFile, copyId: photoId, copyName: nonEmpty, snapshotId: nonEmpty, snapshotName: nonEmpty,
  recoveryNote: text,
  error: text, recoveryError: text, renderCompleted: bool,
  outcomeUnknown: { enum: ["timeout_unknown", "disconnect_unknown", "protocol_unknown"] },
  parentJobId: recordId, conversationId: recordId, revision: { type: "integer", minimum: 1, maximum: 20 },
  styleId: recordId, styleName: nonEmpty,
};

const ajv = new Ajv({ strict: true });
const record = (properties: Record<string, unknown>, required: string[]) => object({
  version: { const: 1 }, id: recordId, createdAt: timestamp, ...properties,
}, ["version", "id", "createdAt", ...required]);

export const validJob = ajv.compile<Job>(record(jobProperties,
  ["status", "request", "source", "sourceFingerprint", "baseline", "capabilities"]));

export const validStyle = ajv.compile<SavedStyle>(record({
  name: { ...nonEmpty, maxLength: 80, pattern: "\\S" },
  intent: { ...nonEmpty, maxLength: 20000, pattern: "\\S" },
  strength, sourceJobId: recordId, sourcePlan: savedPlan, sourceSettings: settings, sourceBaseline: settings, referenceFile,
}, ["name", "intent", "strength", "sourceJobId", "sourcePlan"]));

const batchPhotoId = { type: "string", pattern: "^[1-9][0-9]*$" };
export const validBatch = ajv.compile<Batch>(record({
  styleId: recordId, styleName: nonEmpty, strength, state: { enum: ["planning", "finished", "stopped"] },
  blockedByPhotoId: batchPhotoId,
  items: { ...array(object({ photoId: batchPhotoId, jobId: recordId, planError: text, previewError: text },
    ["photoId", "jobId"])), minItems: 2, maxItems: 8 },
}, ["styleId", "styleName", "strength", "state", "items"]));
