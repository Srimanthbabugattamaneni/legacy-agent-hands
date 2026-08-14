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
 * (Caught by tests/replay.integration.test.ts against a second member.)
 *
 * Digits alone are not enough, though: a member's *name* has no digits at
 * all, so it would sail through and get baked into the checkpoint —
 * persisting PII into a committed artifact and breaking replay for every
 * other member. Two more filters close most of that gap. Any line containing
 * a value this run extracted is rejected outright, since extracted values
 * are per-record data by definition. And lines containing a tab are
 * deprioritised: innerText separates table cells with tabs, so a tabbed line
 * is a label/value data row while an untabbed one is a heading. Heuristic,
 * not a guarantee — see REPORT §7. */
function deriveCheckpoint(
  step: DiscoveryStepRecord,
  paramLiterals: Record<string, string>,
  extractedValues: string[] = []
): Checkpoint | undefined {
  const beforeLines = new Set(step.pageTextBefore.split("\n").map((l) => l.trim()).filter(Boolean));
  const perRecord = extractedValues.map((v) => v.trim()).filter((v) => v.length >= 3);
  const newLines = step.pageTextAfter
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !beforeLines.has(l))
    .filter((l) => !perRecord.some((v) => l.includes(v)));

  if (newLines.length > 0) {
    const candidates = newLines.map((line) => {
      const tokenized = tokenize(line.slice(0, 100), paramLiterals);
      const leftoverDigits = (tokenized.match(/\d/g) ?? []).length;
      const isDataRow = tokenized.includes("\t") ? 1 : 0;
      return { tokenized, leftoverDigits, isDataRow };
    });
    candidates.sort(
      (a, b) =>
        a.isDataRow - b.isDataRow || a.leftoverDigits - b.leftoverDigits || a.tokenized.length - b.tokenized.length
    );
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
  // A parameter is sensitive when the field that consumed it was flagged
  // sensitive by the surface (a password box, an SSN-shaped label, ...).
  // This was hardcoded `false`, which made the flag unreachable: the schema
  // carried it and compilation could *throw* over a sensitive literal, but
  // no artifact could ever actually mark a parameter as one.
  const sensitiveParams = new Set(
    opts.steps.filter((s) => s.sensitive && s.literalValue !== undefined).map((s) => s.literalValue)
  );
  const inputs: InputParam[] = Object.entries(opts.paramLiterals).map(([name, literal]) => ({
    name,
    type: inferType(literal),
    description: opts.paramDescriptions?.[name] ?? `Input parameter: ${name}`,
    required: true,
    sensitive: sensitiveParams.has(literal),
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
    const checkpoint = deriveCheckpoint(s, opts.paramLiterals, Object.values(opts.outputsDeclared).map(String));
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
