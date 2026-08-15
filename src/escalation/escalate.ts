import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { EscalationRequestSchema, type EscalationRequest, type EscalationReason } from "../schema/escalation.js";
import { newId } from "../util/ids.js";
import { evidenceRoot } from "../util/logger.js";

function escalationDir(): string {
  return path.join(evidenceRoot(), "escalations");
}

export function escalationPath(id: string): string {
  return path.join(escalationDir(), `${id}.json`);
}

/**
 * Raises an intervention request. This is a file, not an in-memory queue,
 * on purpose: it's the handoff boundary between the automation process
 * (which keeps the live browser session open and paused) and the separate
 * operator console process (`npm run operator`) that a human uses to see
 * context and signal resume. Two independent processes, one shared,
 * append-mostly document — no broker required for a single-operator demo.
 */
export function createEscalation(input: {
  reason: EscalationReason;
  goalOrCapability: string;
  currentStepDescription: string;
  detail: string;
  screenshotPath?: string;
}): EscalationRequest {
  mkdirSync(escalationDir(), { recursive: true });
  const req: EscalationRequest = EscalationRequestSchema.parse({
    id: newId("esc"),
    createdAt: new Date().toISOString(),
    status: "pending",
    humanActions: [],
    ...input,
  });
  writeFileSync(escalationPath(req.id), JSON.stringify(req, null, 2));
  return req;
}

export function readEscalation(id: string): EscalationRequest {
  return EscalationRequestSchema.parse(JSON.parse(readFileSync(escalationPath(id), "utf-8")));
}

export function listEscalations(): EscalationRequest[] {
  if (!existsSync(escalationDir())) return [];
  return readdirSync(escalationDir())
    .filter((f) => f.endsWith(".json"))
    .map((f) => EscalationRequestSchema.parse(JSON.parse(readFileSync(path.join(escalationDir(), f), "utf-8"))))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Blocks (via polling — this is a file-backed handoff, not a socket) until
 * a human resolves the escalation via the operator console, or the bounded
 * timeout elapses. The automation process is doing nothing else during this
 * window except keeping the live session open for the human to drive. */
export async function waitForResolution(
  id: string,
  opts: { timeoutMs?: number; pollMs?: number } = {}
): Promise<EscalationRequest | null> {
  const timeoutMs = opts.timeoutMs ?? Number(process.env.ESCALATION_TIMEOUT_MS ?? 10 * 60 * 1000);
  const pollMs = opts.pollMs ?? 1500;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const req = readEscalation(id);
    if (req.status === "resolved") return req;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return null;
}

export type SessionSnapshot = { url: string; title: string };

/**
 * Records what the human actually did with the session, by comparing it
 * either side of the handoff.
 *
 * The operator's free-text notes are their own account of events; this is the
 * independent one. It is deliberately what the system can *observe* rather
 * than what it is told: whether the session moved, and where to. A keystroke-
 * level record would need CDP tracing over the handoff window — a richer
 * signal, and the natural next step, but a much bigger dependency than the
 * question "did the session end up somewhere else, and where" warrants.
 */
export function recordSessionDelta(id: string, before: SessionSnapshot, after: SessionSnapshot): void {
  const moved = before.url !== after.url;
  const description = moved
    ? `operator navigated the session: ${before.url} -> ${after.url} ("${after.title}")`
    : `operator left the session on ${after.url} ("${after.title}") — no navigation observed`;

  const req = readEscalation(id);
  const updated: EscalationRequest = {
    ...req,
    humanActions: [...req.humanActions, { at: new Date().toISOString(), description }],
  };
  writeFileSync(escalationPath(id), JSON.stringify(updated, null, 2));
}
