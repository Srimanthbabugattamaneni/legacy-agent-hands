import { z } from "zod";

/**
 * Hard-failure taxonomy. These are conditions the replay engine could not
 * classify as a legitimate business outcome and could not recover from.
 */
/**
 * Note what is deliberately *absent*: `session_timeout`. An expired session
 * is a legitimate answer the caller has to handle, so it is a business
 * outcome (see `src/replay/business-outcomes.json`), not a failure. Listing
 * it in both places would be exactly the business-outcome/failure conflation
 * the brief names as the most common design mistake — one condition must
 * have one home.
 */
export const ErrorClassSchema = z.enum([
  "element_not_found", // locator (primary + all fallbacks) failed to resolve
  "checkpoint_failed", // action ran but expected resulting state never appeared
  "unexpected_dialog", // a native dialog appeared that the artifact didn't anticipate
  "transient_load_failure", // navigation/network error after retry budget exhausted
  "policy_blocked", // safety layer refused the step (out of allowlist or risky w/o authorization)
  "unknown",
]);
export type ErrorClass = z.infer<typeof ErrorClassSchema>;

const BaseResult = z.object({
  artifactId: z.string(),
  artifactVersion: z.number(),
  startedAt: z.string(),
  finishedAt: z.string(),
  evidenceDir: z.string(),
});

export const ReplayResultSchema = z.discriminatedUnion("status", [
  BaseResult.extend({
    status: z.literal("success"),
    outputs: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  }),
  BaseResult.extend({
    status: z.literal("business_outcome"),
    outcome: z.string(), // e.g. "member_not_found", "validation_error"
    detail: z.string(),
    stepId: z.string(),
  }),
  BaseResult.extend({
    status: z.literal("failure"),
    errorClass: ErrorClassSchema,
    stepId: z.string(),
    expected: z.string(),
    observed: z.string(),
  }),
  BaseResult.extend({
    status: z.literal("escalated"),
    escalationId: z.string(),
    stepId: z.string(),
    reason: z.string(),
    resolution: z.string().optional(),
  }),
]);
export type ReplayResult = z.infer<typeof ReplayResultSchema>;
