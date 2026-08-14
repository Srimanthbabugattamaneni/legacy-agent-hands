import type { CapabilityArtifact } from "../schema/artifact.js";
import type { ValueRef } from "../schema/artifact.js";

/** Turning a caller's invocation arguments into the strings a step consumes. */

export function coerceParams(artifact: CapabilityArtifact, supplied: Record<string, string | number | boolean>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const input of artifact.inputs) {
    const value = supplied[input.name];
    // Only absent is missing. An empty string is a value the caller chose to
    // send — and often the interesting one, since it exercises the target's
    // own required-field validation, which is a business outcome we want to
    // report rather than an error we refuse to attempt.
    if (value === undefined || value === null) {
      if (input.required) throw new Error(`missing required input parameter: ${input.name}`);
      continue;
    }
    out[input.name] = String(value);
  }
  return out;
}

/** Resolves a step's literal-or-parameter reference against this invocation. */
export function resolveValue(ref: ValueRef, params: Record<string, string>): string {
  return ref.kind === "literal" ? ref.value : params[ref.name] ?? "";
}
