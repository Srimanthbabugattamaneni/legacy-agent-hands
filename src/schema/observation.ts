import { z } from "zod";

/**
 * One interactive-or-informative element on the current page, as perceived
 * by the surface layer. `ref` is only stable for the lifetime of a single
 * observation (one page state) — it's how the LLM points at "the thing it
 * just saw" within a turn. It is never persisted into an artifact; only the
 * derived LocatorDescriptor is.
 */
export const ObservedElementSchema = z.object({
  ref: z.string(),
  tag: z.string(),
  role: z.string(),
  name: z.string(),
  text: z.string().optional(),
  value: z.string().optional(),
  placeholder: z.string().optional(),
  href: z.string().optional(),
  type: z.string().optional(),
  checked: z.boolean().optional(),
  disabled: z.boolean().optional(),
  sensitive: z.boolean().default(false),
});
export type ObservedElement = z.infer<typeof ObservedElementSchema>;

export const ObservationSchema = z.object({
  url: z.string(),
  title: z.string(),
  /** Short, human/LLM-readable summary of visible page text (truncated). */
  pageText: z.string(),
  elements: z.array(ObservedElementSchema),
});
export type Observation = z.infer<typeof ObservationSchema>;
