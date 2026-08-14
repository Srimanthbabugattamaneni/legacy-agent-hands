import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { EscalationRequestSchema, type EscalationRequest, type EscalationReason } from "../schema/escalation.js";
import { newId } from "../util/ids.js";

const ESCALATION_DIR = path.join(process.cwd(), "evidence", "escalations");

export function escalationPath(id: string): string {
  return path.join(ESCALATION_DIR, `${id}.json`);
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
  mkdirSync(ESCALATION_DIR, { recursive: true });
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
  if (!existsSync(ESCALATION_DIR)) return [];
  return readdirSync(ESCALATION_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => EscalationRequestSchema.parse(JSON.parse(readFileSync(path.join(ESCALATION_DIR, f), "utf-8"))))
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
