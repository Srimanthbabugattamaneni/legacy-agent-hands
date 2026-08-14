import { z } from "zod";

/**
 * A single way to find an element on the surface. Artifacts store a primary
 * strategy plus an ordered list of fallbacks — replay tries each in order
 * until one resolves to exactly one element. This is what keeps replay
 * working on legacy markup where a single selector strategy is brittle.
 */
export const LocatorStrategySchema = z.discriminatedUnion("strategy", [
  z.object({
    strategy: z.literal("role"),
    role: z.string(),
    name: z.string(),
    nameMatch: z.enum(["exact", "contains"]).default("exact"),
    nth: z.number().int().min(0).default(0),
  }),
  z.object({
    strategy: z.literal("label"),
    label: z.string(),
    nth: z.number().int().min(0).default(0),
  }),
  z.object({
    strategy: z.literal("text"),
    text: z.string(),
    exact: z.boolean().default(false),
    nth: z.number().int().min(0).default(0),
  }),
  z.object({
    strategy: z.literal("css"),
    selector: z.string(),
    nth: z.number().int().min(0).default(0),
  }),
  z.object({
    strategy: z.literal("testid"),
    testId: z.string(),
  }),
]);
export type LocatorStrategy = z.infer<typeof LocatorStrategySchema>;

export const LocatorDescriptorSchema = z.object({
  primary: LocatorStrategySchema,
  fallbacks: z.array(LocatorStrategySchema).default([]),
  /** Free-text note on why this strategy was chosen / how robust it is. */
  reasoning: z.string().optional(),
});
export type LocatorDescriptor = z.infer<typeof LocatorDescriptorSchema>;
