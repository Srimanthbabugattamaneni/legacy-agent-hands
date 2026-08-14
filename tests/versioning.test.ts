import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveVersion, structuralFingerprint } from "../src/agent/versioning.js";
import type { CapabilityArtifact } from "../src/schema/artifact.js";

function artifact(overrides: Partial<CapabilityArtifact> = {}): CapabilityArtifact {
  return {
    schemaVersion: "1.1",
    id: "cap_abc",
    name: "lookup-balance",
    version: 1,
    description: "test",
    goal: "test",
    createdAt: new Date().toISOString(),
    target: { appId: "mock-bank", entryUrl: "http://localhost:4000/" },
    inputs: [],
    outputs: [],
    steps: [
      {
        id: "step_1",
        action: "click",
        description: "click Search",
        locator: { primary: { strategy: "role", role: "button", name: "Search", nameMatch: "exact", nth: 0 }, fallbacks: [] },
        effect: "read",
      },
    ],
    successCheckpoint: { description: "done", textContains: "Sub-Accounts" },
    ...overrides,
  };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "artifacts-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("structuralFingerprint", () => {
  it("ignores per-run noise (ids and createdAt)", () => {
    const a = artifact();
    const b = artifact({
      id: "cap_totally_different",
      createdAt: new Date(Date.now() + 60_000).toISOString(),
      steps: [{ ...artifact().steps[0]!, id: "step_regenerated" }],
    });
    expect(structuralFingerprint(a)).toBe(structuralFingerprint(b));
  });

  it("notices a behavioural change", () => {
    const changed = artifact({ steps: [{ ...artifact().steps[0]!, effect: "irreversible" }] });
    expect(structuralFingerprint(artifact())).not.toBe(structuralFingerprint(changed));
  });
});

describe("resolveVersion", () => {
  it("creates v1 when nothing exists yet", () => {
    const decision = resolveVersion(artifact(), dir);
    expect(decision.disposition).toBe("created");
    expect(decision.artifact.version).toBe(1);
  });

  it("leaves an unchanged re-recording alone rather than churning the file", () => {
    writeFileSync(path.join(dir, "lookup-balance.json"), JSON.stringify(artifact(), null, 2));
    const decision = resolveVersion(artifact({ id: "cap_new_run" }), dir);
    expect(decision.disposition).toBe("unchanged");
    expect(decision.artifact.version).toBe(1);
    expect(decision.archivedPath).toBeUndefined();
  });

  it("bumps the version and archives the previous file when behaviour changed", () => {
    // Regression: version was always 1 and artifacts/<name>.json was
    // overwritten in place, so "versioned and reviewable" described the
    // schema rather than anything the system actually did.
    writeFileSync(path.join(dir, "lookup-balance.json"), JSON.stringify(artifact(), null, 2));
    const changed = artifact({ steps: [{ ...artifact().steps[0]!, effect: "irreversible" }] });

    const decision = resolveVersion(changed, dir);
    expect(decision.disposition).toBe("bumped");
    expect(decision.artifact.version).toBe(2);
    expect(existsSync(decision.archivedPath!)).toBe(true);

    const archived = JSON.parse(readFileSync(decision.archivedPath!, "utf-8")) as CapabilityArtifact;
    expect(archived.version).toBe(1);
    expect(archived.steps[0]!.effect).toBe("read");
  });

  it("keeps bumping across successive changes", () => {
    const p = path.join(dir, "lookup-balance.json");
    writeFileSync(p, JSON.stringify(artifact({ version: 2 }), null, 2));
    const decision = resolveVersion(artifact({ steps: [] as CapabilityArtifact["steps"] }), dir);
    expect(decision.artifact.version).toBe(3);
  });

  it("treats an unreadable existing artifact as absent instead of stranding the new recording", () => {
    writeFileSync(path.join(dir, "lookup-balance.json"), "{ not json");
    const decision = resolveVersion(artifact(), dir);
    expect(decision.disposition).toBe("created");
  });
});
