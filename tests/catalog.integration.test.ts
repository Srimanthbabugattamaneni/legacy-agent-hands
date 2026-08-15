import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import path from "node:path";
import { app } from "../apps/mock-bank/server.js";
import { toAgentTools, getCapability } from "../src/catalog/catalog.js";
import { replay } from "../src/replay/replay.js";

/**
 * The stretch goal asks for a catalog of callable capabilities an agent could
 * discover and invoke by name with typed args — *and to show one being
 * invoked*. `toAgentTools` was exported and never called by anything, which
 * made the claim decorative. This is the demonstration: pick a tool out of the
 * catalog the way an agent would, check the arguments against the schema the
 * catalog published, and run it.
 */

let server: Server;
let priorArtifactsDir: string | undefined;

beforeAll(async () => {
  // This suite is specifically about the *shipped* catalog being callable, so
  // it reads the committed artifacts rather than the temp dir the rest of the
  // suite records into.
  priorArtifactsDir = process.env.ARTIFACTS_DIR;
  process.env.ARTIFACTS_DIR = path.join(process.cwd(), "artifacts");

  const port = Number(process.env.MOCK_BANK_PORT ?? 4000);
  server = app.listen(port);
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", (err: NodeJS.ErrnoException) => {
      reject(
        err.code === "EADDRINUSE"
          ? new Error(`port ${port} in use — stop \`npm run mock\` before running the tests`)
          : err
      );
    });
  });
});

afterAll(async () => {
  if (priorArtifactsDir === undefined) delete process.env.ARTIFACTS_DIR;
  else process.env.ARTIFACTS_DIR = priorArtifactsDir;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("recorded capabilities are discoverable and callable as agent tools", () => {
  it("publishes a typed tool definition per capability", () => {
    const tools = toAgentTools();
    const lookup = tools.find((t) => t.name === "lookup-balance");

    expect(lookup).toBeDefined();
    expect(lookup!.input_schema.properties).toHaveProperty("memberId");
    expect(lookup!.input_schema.required).toContain("memberId");
    // The description carries the return shape, so a calling agent knows what
    // it gets back without reading the artifact.
    expect(lookup!.description).toMatch(/savingsBalance/);
  });

  it("invokes a capability chosen from the catalog and gets its declared outputs", async () => {
    // Exactly the sequence an agent would follow: discover the tool, satisfy
    // its declared required arguments, invoke by name.
    const tool = toAgentTools().find((t) => t.name === "lookup-balance")!;
    const args: Record<string, string> = { memberId: "10567" };
    for (const required of tool.input_schema.required ?? []) {
      expect(args).toHaveProperty(required);
    }

    const artifact = getCapability(tool.name)!;
    const result = await replay({ artifact, params: args, headless: true });

    expect(result.status).toBe("success");
    if (result.status === "success") {
      // Every output the tool advertised actually comes back.
      for (const declared of artifact.outputs) {
        expect(result.outputs).toHaveProperty(declared.name);
      }
      expect(result.outputs.savingsBalance).toBe("$18902.50");
    }
  }, 30000);

  it("surfaces a business outcome through the same invocation path", async () => {
    // An agent calling a capability must be able to tell "no such member"
    // from "the capability broke", which is the whole point of the result
    // contract being part of the tool surface.
    const artifact = getCapability("lookup-balance")!;
    const result = await replay({ artifact, params: { memberId: "55555" }, headless: true });

    expect(result.status).toBe("business_outcome");
    if (result.status === "business_outcome") {
      expect(result.outcome).toBe("member_not_found");
    }
  }, 30000);
});
