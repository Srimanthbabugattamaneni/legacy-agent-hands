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
