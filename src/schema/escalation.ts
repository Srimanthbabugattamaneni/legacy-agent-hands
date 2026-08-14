import { z } from "zod";

export const EscalationReasonSchema = z.enum([
  "discovery_stuck", // agent explicitly gave up, or repeated failed actions, or max steps
  "replay_unrecoverable", // replay hit a hard failure and was run with onHardFailure:"escalate"
  "risky_action_needs_confirmation", // a risky/irreversible step was reached without authorization
]);
export type EscalationReason = z.infer<typeof EscalationReasonSchema>;

export const HumanActionSchema = z.object({
  at: z.string(),
  description: z.string(),
});

export const EscalationRequestSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  reason: EscalationReasonSchema,
  goalOrCapability: z.string(),
  currentStepDescription: z.string(),
  detail: z.string(),
  screenshotPath: z.string().optional(),
  status: z.enum(["pending", "resolved"]).default("pending"),
  humanNotes: z.string().optional(),
  humanActions: z.array(HumanActionSchema).default([]),
  resolvedAt: z.string().optional(),
});
export type EscalationRequest = z.infer<typeof EscalationRequestSchema>;
