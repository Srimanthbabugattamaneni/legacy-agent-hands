import { z } from "zod";
import { LocatorDescriptorSchema } from "./locator.js";

export const ACTION_TYPES = [
  "navigate",
  "click",
  "fill",
  "select",
  "check",
  "press_key",
  "wait_for",
  "extract",
] as const;
export const ActionTypeSchema = z.enum(ACTION_TYPES);
export type ActionType = z.infer<typeof ActionTypeSchema>;

/** A step's input value: either a fixed literal recorded at discovery time,
 * or a reference to one of the capability's declared input parameters. */
export const ValueRefSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("literal"), value: z.string() }),
  z.object({ kind: z.literal("param"), name: z.string() }),
]);
export type ValueRef = z.infer<typeof ValueRefSchema>;

/** A condition asserted after a step to confirm the surface actually
 * reached the expected state, instead of assuming the action worked. */
export const CheckpointSchema = z.object({
  description: z.string(),
  urlContains: z.string().optional(),
  textContains: z.string().optional(),
  locatorVisible: LocatorDescriptorSchema.optional(),
});
export type Checkpoint = z.infer<typeof CheckpointSchema>;

export const ArtifactStepSchema = z.object({
  id: z.string(),
  action: ActionTypeSchema,
  description: z.string(),
  locator: LocatorDescriptorSchema.optional(),
  value: ValueRefSchema.optional(),
  /** Only for action: "extract" — where the read value is written. */
  extractTo: z.string().optional(),
  /** Only for action: "navigate" — literal or param-templated URL. */
  url: ValueRefSchema.optional(),
  checkpoint: CheckpointSchema.optional(),
  /** Irreversible / consequential steps (e.g. final submit). Blocked on
   * replay unless the caller explicitly authorizes risky execution. */
  risky: z.boolean().default(false),
});
export type ArtifactStep = z.infer<typeof ArtifactStepSchema>;

export const InputParamSchema = z.object({
  name: z.string(),
  type: z.enum(["string", "number", "boolean"]),
  description: z.string(),
  required: z.boolean().default(true),
  /** Field looked sensitive at discovery time (password/SSN/etc.) — value
   * must never be persisted into the artifact or logs, only supplied live. */
  sensitive: z.boolean().default(false),
});
export type InputParam = z.infer<typeof InputParamSchema>;

export const OutputFieldSchema = z.object({
  name: z.string(),
  type: z.enum(["string", "number", "boolean"]),
  description: z.string(),
});
export type OutputField = z.infer<typeof OutputFieldSchema>;

export const CapabilityArtifactSchema = z.object({
  schemaVersion: z.literal("1.0"),
  id: z.string(),
  name: z.string(),
  version: z.number().int().min(1),
  description: z.string(),
  goal: z.string(),
  createdAt: z.string(),
  target: z.object({
    appId: z.string(),
    /** The absolute URL replay starts by navigating to. */
    entryUrl: z.string(),
  }),
  inputs: z.array(InputParamSchema),
  outputs: z.array(OutputFieldSchema),
  steps: z.array(ArtifactStepSchema).min(1),
  successCheckpoint: CheckpointSchema,
});
export type CapabilityArtifact = z.infer<typeof CapabilityArtifactSchema>;
