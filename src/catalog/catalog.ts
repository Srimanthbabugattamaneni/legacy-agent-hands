import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import type { ToolSpec } from "../agent/llm/types.js";
import { CapabilityArtifactSchema, type CapabilityArtifact } from "../schema/artifact.js";
import { artifactsRoot } from "../util/logger.js";



/** Every recorded capability, agent-invocable by name — this is the whole
 * point of the record-once/replay-many model: an AI agent should be able to
 * discover "what can I do against this app" without re-reasoning about the
 * UI, by reading this catalog instead. */
export function listCapabilities(): CapabilityArtifact[] {
  const dir = artifactsRoot();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => CapabilityArtifactSchema.parse(JSON.parse(readFileSync(path.join(dir, f), "utf-8"))));
}

export function getCapability(name: string): CapabilityArtifact | undefined {
  return listCapabilities().find((c) => c.name === name);
}

const JSON_TYPE: Record<string, string> = { string: "string", number: "number", boolean: "boolean" };

/** Stretch goal: expose the catalog as a small function-calling surface an
 * AI agent could use to discover and invoke capabilities by name with typed
 * args, generated directly from each artifact's declared inputs/outputs.
 *
 * Emitted as our own provider-neutral `ToolSpec` rather than a vendor SDK
 * type: the shape (name / description / JSON-Schema parameters) is what every
 * tool-calling API takes, so binding the catalog to one vendor's types would
 * be a dependency bought for nothing. */
export function toAgentTools(capabilities: CapabilityArtifact[] = listCapabilities()): ToolSpec[] {
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
