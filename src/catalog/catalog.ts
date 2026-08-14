import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { CapabilityArtifactSchema, type CapabilityArtifact } from "../schema/artifact.js";

const ARTIFACTS_DIR = path.join(process.cwd(), "artifacts");

/** Every recorded capability, agent-invocable by name — this is the whole
 * point of the record-once/replay-many model: an AI agent should be able to
 * discover "what can I do against this app" without re-reasoning about the
 * UI, by reading this catalog instead. */
export function listCapabilities(): CapabilityArtifact[] {
  if (!existsSync(ARTIFACTS_DIR)) return [];
  return readdirSync(ARTIFACTS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => CapabilityArtifactSchema.parse(JSON.parse(readFileSync(path.join(ARTIFACTS_DIR, f), "utf-8"))));
}

export function getCapability(name: string): CapabilityArtifact | undefined {
  return listCapabilities().find((c) => c.name === name);
}

const JSON_TYPE: Record<string, string> = { string: "string", number: "number", boolean: "boolean" };

/** Stretch goal: expose the catalog as a small function-calling surface an
 * AI agent could use to discover and invoke capabilities by name with typed
 * args, generated directly from each artifact's declared inputs/outputs. */
export function toAgentTools(capabilities: CapabilityArtifact[] = listCapabilities()): Anthropic.Tool[] {
  return capabilities.map((c) => ({
    name: c.name,
    description: `${c.description}\nOutputs: ${c.outputs.map((o) => `${o.name} (${o.type}) - ${o.description}`).join("; ") || "(none)"}`,
    input_schema: {
      type: "object",
      properties: Object.fromEntries(
        c.inputs.map((i) => [i.name, { type: JSON_TYPE[i.type] ?? "string", description: i.description }])
      ),
      required: c.inputs.filter((i) => i.required).map((i) => i.name),
    },
  }));
}
