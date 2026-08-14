import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CapabilityArtifactSchema, type CapabilityArtifact } from "../schema/artifact.js";

/**
 * A capability's identity is its *behaviour*, not the run that produced it.
 * Two things therefore have to be excluded from any comparison: `createdAt`,
 * which differs on every run, and the generated step/artifact ids, which are
 * random per run. What remains — the ordered steps with their locators,
 * values and checkpoints, plus the declared contract — is what a reviewer
 * actually diffs and what a caller actually depends on.
 */
export function structuralFingerprint(artifact: CapabilityArtifact): string {
  return JSON.stringify({
    target: artifact.target,
    inputs: artifact.inputs,
    outputs: artifact.outputs,
    successCheckpoint: artifact.successCheckpoint,
    steps: artifact.steps.map((s) => ({
      action: s.action,
      locator: s.locator,
      value: s.value,
      url: s.url,
      extractTo: s.extractTo,
      checkpoint: s.checkpoint,
      risky: s.risky,
    })),
  });
}

export type VersionDecision = {
  artifact: CapabilityArtifact;
  /** "created" | "unchanged" | "bumped" — for logging and CLI output. */
  disposition: "created" | "unchanged" | "bumped";
  artifactPath: string;
  archivedPath?: string;
};

/**
 * Decides what version a freshly compiled artifact should carry, and
 * preserves whatever was there before.
 *
 * `version` used to be a schema field that was always 1: re-recording a
 * capability overwrote `artifacts/<name>.json` in place, so a prior version
 * was simply gone and "versioned and reviewable" described the shape of the
 * data rather than anything the system did. Now a re-record that changes
 * behaviour bumps the version and archives the previous file, and one that
 * doesn't leaves the artifact alone rather than churning it.
 *
 * `artifacts/<name>.json` stays the current-version pointer, so the catalog
 * and `replay --capability <name>` are unaffected.
 */
export function resolveVersion(artifact: CapabilityArtifact, artifactsDir: string): VersionDecision {
  const artifactPath = path.join(artifactsDir, `${artifact.name}.json`);
  if (!existsSync(artifactPath)) {
    return { artifact, disposition: "created", artifactPath };
  }

  let previous: CapabilityArtifact;
  try {
    previous = CapabilityArtifactSchema.parse(JSON.parse(readFileSync(artifactPath, "utf-8")));
  } catch {
    // An unreadable or schema-invalid file on disk shouldn't strand a good
    // new recording; treat it as if nothing were there.
    return { artifact, disposition: "created", artifactPath };
  }

  if (structuralFingerprint(previous) === structuralFingerprint(artifact)) {
    // Same behaviour: keep the existing version and leave the file untouched
    // so re-running discovery doesn't produce a spurious diff.
    return { artifact: previous, disposition: "unchanged", artifactPath };
  }

  const historyDir = path.join(artifactsDir, "history");
  mkdirSync(historyDir, { recursive: true });
  const archivedPath = path.join(historyDir, `${artifact.name}.v${previous.version}.json`);
  writeFileSync(archivedPath, JSON.stringify(previous, null, 2));

  return {
    artifact: { ...artifact, version: previous.version + 1 },
    disposition: "bumped",
    artifactPath,
    archivedPath,
  };
}
