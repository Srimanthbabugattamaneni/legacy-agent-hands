import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { ActionType } from "../schema/artifact.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PolicyConfigSchema = z.object({
  allowedOrigins: z.array(z.string()),
  allowedRoutePatterns: z.array(z.string()),
  allowedActionTypes: z.array(z.string()),
  riskyActionNameKeywords: z.array(z.string()),
});
export type PolicyConfig = z.infer<typeof PolicyConfigSchema>;

let cached: PolicyConfig | undefined;

export function loadPolicy(configPath?: string): PolicyConfig {
  if (!configPath && cached) return cached;
  const p = configPath ?? path.join(__dirname, "allowlist.json");
  const raw = JSON.parse(readFileSync(p, "utf-8"));
  const parsed = PolicyConfigSchema.parse(raw);
  if (!configPath) cached = parsed;
  return parsed;
}

export type PolicyDecision = { allowed: boolean; reason: string };

/** Every navigation (discovery and replay) must pass this before the
 * browser is told to go anywhere. Enforces the allowlisted origin + route. */
export function checkNavigation(url: string, policy: PolicyConfig = loadPolicy()): PolicyDecision {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { allowed: false, reason: `not a valid absolute URL: ${url}` };
  }
  const origin = `${parsed.protocol}//${parsed.host}`;
  if (!policy.allowedOrigins.includes(origin)) {
    return { allowed: false, reason: `origin not allowlisted: ${origin}` };
  }
  const routeOk = policy.allowedRoutePatterns.some((pat) => new RegExp(pat).test(parsed.pathname));
  if (!routeOk) {
    return { allowed: false, reason: `route not allowlisted: ${parsed.pathname}` };
  }
  return { allowed: true, reason: "ok" };
}

/** Every action (click/fill/etc.) must pass this before it is executed. */
export function checkActionType(action: ActionType, policy: PolicyConfig = loadPolicy()): PolicyDecision {
  if (!policy.allowedActionTypes.includes(action)) {
    return { allowed: false, reason: `action type not allowlisted: ${action}` };
  }
  return { allowed: true, reason: "ok" };
}

/** Heuristic used at *discovery* time to flag a step as risky when the
 * artifact is compiled — based on the accessible name of the control the
 * agent is about to activate (e.g. a button named "Confirm & Open Account"). */
export function isRiskyByName(name: string, policy: PolicyConfig = loadPolicy()): boolean {
  const lower = name.toLowerCase();
  return policy.riskyActionNameKeywords.some((kw) => lower.includes(kw.toLowerCase()));
}

/** Applied at *replay* time: a step recorded as risky is blocked unless the
 * caller explicitly authorizes risky execution for this invocation. This is
 * the "handle the risky class conservatively" requirement (3.4) — default
 * posture is "block", not "confirm inline", because production replay has
 * no human present to confirm; authorization must come from the caller
 * (the agent/product) ahead of time, e.g. because a human already approved
 * the action in the calling product's own UI. */
export function checkRiskyStep(risky: boolean, allowRisky: boolean): PolicyDecision {
  if (risky && !allowRisky) {
    return { allowed: false, reason: "risky step requires explicit allowRisky authorization" };
  }
  return { allowed: true, reason: "ok" };
}
