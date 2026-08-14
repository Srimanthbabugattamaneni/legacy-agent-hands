import type { CapabilityArtifact, ArtifactStep, InputParam, OutputField, Checkpoint, ValueRef } from "../schema/artifact.js";
import { CapabilityArtifactSchema } from "../schema/artifact.js";
import type { DiscoveryStepRecord } from "./types.js";
import { tokenize, tokenizeUrl } from "../util/template.js";

function inferType(value: string): "string" | "number" {
  return /^-?\d+(\.\d+)?$/.test(value) ? "number" : "string";
}

function toValueRef(literal: string, paramLiterals: Record<string, string>, sensitive: boolean): ValueRef {
  const paramName = Object.entries(paramLiterals).find(([, v]) => v === literal)?.[0];
  if (paramName) return { kind: "param", name: paramName };
  if (sensitive) {
    throw new Error(
      `discovery touched a field flagged sensitive but no input parameter was declared for its value; ` +
        `pass it via --param so it is never persisted as a literal`
    );
  }
  return { kind: "literal", value: literal };
}

/** Derives a checkpoint from what text newly appeared on the page after a
 * step ran — the actual evidence the action worked, not an assumption that
 * it did. Falls back to a URL-change checkpoint, then to none.
 *
 * Candidate lines are tokenized against the *declared* params first, then
 * ranked by how many digits remain afterward — a proxy for "this text still
 * contains per-record data the caller never told us about" (a dollar
 * balance, a generated account number, ...). A single discovery run can't
 * distinguish "stable page chrome" from "this record's own values" any
 * other way; preferring the leftover-digit-free candidate, and the
 * shortest one among ties, reliably picks a heading/label over a data row.
 * (Caught by tests/replay.integration.test.ts against a second member.) */
function deriveCheckpoint(step: DiscoveryStepRecord, paramLiterals: Record<string, string>): Checkpoint | undefined {
  const beforeLines = new Set(step.pageTextBefore.split("\n").map((l) => l.trim()).filter(Boolean));
  const newLines = step.pageTextAfter
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !beforeLines.has(l));

  if (newLines.length > 0) {
    const candidates = newLines.map((line) => {
      const tokenized = tokenize(line.slice(0, 100), paramLiterals);
      const leftoverDigits = (tokenized.match(/\d/g) ?? []).length;
      return { tokenized, leftoverDigits };
    });
    candidates.sort((a, b) => a.leftoverDigits - b.leftoverDigits || a.tokenized.length - b.tokenized.length);
    const snippet = candidates[0]!.tokenized;
    return { description: `page shows new text: ${snippet}`, textContains: snippet };
  }
  if (step.urlAfter !== step.urlBefore) {
    const path = tokenize(new URL(step.urlAfter).pathname, paramLiterals);
    return { description: `navigated to ${path}`, urlContains: path };
  }
  return undefined;
}

export function compileArtifact(opts: {
  id: string;
  name: string;
  description: string;
  goal: string;
  appId: string;
  entryUrl: string;
  steps: DiscoveryStepRecord[];
  paramLiterals: Record<string, string>;
  paramDescriptions?: Record<string, string>;
  outputsDeclared: Record<string, string | number | boolean>;
  outputDescriptions?: Record<string, string>;
  version?: number;
}): CapabilityArtifact {
  const inputs: InputParam[] = Object.entries(opts.paramLiterals).map(([name, literal]) => ({
    name,
    type: inferType(literal),
    description: opts.paramDescriptions?.[name] ?? `Input parameter: ${name}`,
    required: true,
    sensitive: false,
  }));

  // finish_success can *say* it produced a value without the agent ever
  // having called extract for it (observed in practice with a weaker
  // model: it fabricated a value instead of extracting one). Only an
  // output actually backed by an extract step in the trace becomes part
  // of the artifact's contract — otherwise replay could never deliver on
  // what the schema promises.
  const extractedKeys = new Set(opts.steps.map((s) => s.extractTo).filter((k): k is string => Boolean(k)));
  const outputs: OutputField[] = Object.entries(opts.outputsDeclared)
    .filter(([name]) => extractedKeys.has(name))
    .map(([name, value]) => ({
      name,
      type: typeof value === "number" ? "number" : typeof value === "boolean" ? "boolean" : "string",
      description: opts.outputDescriptions?.[name] ?? `Extracted value: ${name}`,
    }));

  const steps: ArtifactStep[] = opts.steps.map((s) => {
    const step: ArtifactStep = {
      id: s.id,
      action: s.action,
      description: s.description,
      locator: s.locator,
      risky: s.risky,
    };
    if (s.literalValue !== undefined) {
      if (s.action === "navigate") {
        // A recorded URL is never *equal* to a parameter's value, so plain
        // exact-match ValueRef resolution would freeze the discovery-time
        // member/account into every future replay. Tokenize it instead;
        // replay render()s literals, so embedded {{tokens}} resolve.
        const exactParam = Object.entries(opts.paramLiterals).find(([, v]) => v === s.literalValue)?.[0];
        step.url = exactParam
          ? { kind: "param", name: exactParam }
          : { kind: "literal", value: tokenizeUrl(s.literalValue, opts.paramLiterals) };
      } else {
        step.value = toValueRef(s.literalValue, opts.paramLiterals, s.sensitive ?? false);
      }
    }
    if (s.extractTo) step.extractTo = s.extractTo;
    const checkpoint = deriveCheckpoint(s, opts.paramLiterals);
    if (checkpoint) step.checkpoint = checkpoint;
    return step;
  });

  const lastCheckpoint = [...steps].reverse().find((s) => s.checkpoint)?.checkpoint;
  const successCheckpoint: Checkpoint = lastCheckpoint ?? {
    description: "goal reported complete by discovery agent",
  };

  const artifact: CapabilityArtifact = {
    schemaVersion: "1.0",
    id: opts.id,
    name: opts.name,
    version: opts.version ?? 1,
    description: opts.description,
    goal: opts.goal,
    createdAt: new Date().toISOString(),
    target: { appId: opts.appId, entryUrl: tokenizeUrl(opts.entryUrl, opts.paramLiterals) },
    inputs,
    outputs,
    steps,
    successCheckpoint,
  };

  return CapabilityArtifactSchema.parse(artifact);
}
