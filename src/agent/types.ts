import type { ActionType } from "../schema/artifact.js";
import type { LocatorDescriptor } from "../schema/locator.js";

/** What the discovery loop records for one executed step — the raw material
 * compileArtifact.ts turns into an ArtifactStep. Kept separate from the
 * artifact schema itself because this carries transient before/after page
 * state (used to derive checkpoints) that has no business being persisted. */
export type DiscoveryStepRecord = {
  id: string;
  action: ActionType;
  description: string;
  locator?: LocatorDescriptor;
  /** The literal value actually used for fill/select/press_key/navigate. */
  literalValue?: string;
  /** True if this value came from an element flagged sensitive by the surface. */
  sensitive?: boolean;
  extractTo?: string;
  urlBefore: string;
  urlAfter: string;
  pageTextBefore: string;
  pageTextAfter: string;
  risky: boolean;
};
