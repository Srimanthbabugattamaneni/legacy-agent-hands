import { mkdirSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import path from "node:path";
import { redactDeep } from "../safety/redact.js";

/** Structured, append-only JSONL run log. Every entry is redacted before it
 * touches disk — evidence/ is the one place a real capability's runtime
 * data could otherwise leak, so redaction happens here unconditionally. */
export class RunLogger {
  readonly dir: string;
  private readonly logPath: string;

  constructor(evidenceRoot: string, runId: string) {
    this.dir = path.join(evidenceRoot, runId);
    mkdirSync(this.dir, { recursive: true });
    this.logPath = path.join(this.dir, "run.jsonl");
    if (!existsSync(this.logPath)) writeFileSync(this.logPath, "");
  }

  log(event: string, data: Record<string, unknown> = {}): void {
    const entry = {
      ts: new Date().toISOString(),
      event,
      ...redactDeep(data),
    };
    appendFileSync(this.logPath, JSON.stringify(entry) + "\n");
  }

  artifactPath(name: string): string {
    return path.join(this.dir, name);
  }
}

/**
 * Where run evidence is written. Overridable so a test run does not scatter
 * directories through the repo it is testing — the suite points this at a
 * temp dir, while real runs keep writing to ./evidence for the reviewer.
 */
export function evidenceRoot(): string {
  return process.env.EVIDENCE_DIR ?? path.join(process.cwd(), "evidence");
}

/**
 * Where recorded capabilities live. Configurable for the same reason as the
 * evidence root: a test run that records a capability must not write it into
 * the catalog a reviewer reads. Without this, `npm test` quietly published
 * throwaway capabilities into `artifacts/` and twelve of them reached a commit.
 */
export function artifactsRoot(): string {
  return process.env.ARTIFACTS_DIR ?? path.join(process.cwd(), "artifacts");
}
