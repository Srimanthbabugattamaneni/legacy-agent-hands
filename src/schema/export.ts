import { zodToJsonSchema } from "zod-to-json-schema";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  CapabilityArtifactSchema,
  ObservationSchema,
  ReplayResultSchema,
  EscalationRequestSchema,
} from "./index.js";

/** Dumps every top-level schema to JSON Schema under artifacts/schema/ so a
 * human reviewer or an external agent can inspect the capability contract
 * without reading TypeScript. */
function main() {
  const outDir = path.join(process.cwd(), "artifacts", "schema");
  mkdirSync(outDir, { recursive: true });

  const dumps: Record<string, unknown> = {
    "capability-artifact.schema.json": zodToJsonSchema(CapabilityArtifactSchema, "CapabilityArtifact"),
    "observation.schema.json": zodToJsonSchema(ObservationSchema, "Observation"),
    "replay-result.schema.json": zodToJsonSchema(ReplayResultSchema, "ReplayResult"),
    "escalation-request.schema.json": zodToJsonSchema(EscalationRequestSchema, "EscalationRequest"),
  };

  for (const [file, schema] of Object.entries(dumps)) {
    const outPath = path.join(outDir, file);
    writeFileSync(outPath, JSON.stringify(schema, null, 2));
    console.log(`wrote ${path.relative(process.cwd(), outPath)}`);
  }
}

main();
