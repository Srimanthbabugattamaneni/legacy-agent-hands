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
  /** Require explicit authorization for merely state-changing steps too, not
   * just irreversible ones. Off by default — see checkStepAuthorization. */
  gateStateChanging: z.boolean().default(false),
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

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Classifies what a step *did*, in two tiers.
 *
 * The original bug was narrower than it first looked, and my first fix
 * over-corrected. Pressing Enter in a form field submits that form, but the
 * name being inspected was the *input's* ("Initial Deposit") rather than the
 * submit control's — so an irreversible submit classified as harmless. The
 * conclusion I drew ("labels are unreliable, treat every non-GET as risky")
 * is wrong for this environment: legacy server-rendered apps POST for almost
 * everything, including reversible intermediate steps like "Continue → review
 * screen". Gating all of them would push callers to pass `--allow-risky`
 * habitually, which is the rubber-stamp failure this guardrail exists to
 * avoid — an always-on gate is the same as no gate.
 *
 * The real fix is to look at the *right* label: `formSubmitName` names the
 * control that a submit actually activates. The method then supplies a
 * second, weaker tier — "this changed state" — which is recorded for review
 * without necessarily gating.
 *
 * Uncertainty still resolves toward safety: a state change we cannot put any
 * name to at all is treated as irreversible.
 */
export type StepEffect = "read" | "state_changing" | "irreversible";

export function classifyEffect(
  input: { elementName?: string; formSubmitName?: string; requestMethod?: string },
  policy: PolicyConfig = loadPolicy()
): { effect: StepEffect; reason: string } {
  if (input.elementName && isRiskyByName(input.elementName, policy)) {
    return { effect: "irreversible", reason: `control name matches a risky keyword: "${input.elementName}"` };
  }
  if (input.formSubmitName && isRiskyByName(input.formSubmitName, policy)) {
    return {
      effect: "irreversible",
      reason: `submits a form whose submit control matches a risky keyword: "${input.formSubmitName}"`,
    };
  }

  const method = input.requestMethod?.toUpperCase();
  const stateChanging = Boolean(method && !SAFE_METHODS.has(method));
  if (!stateChanging) {
    return { effect: "read", reason: "no risky keyword and no state-changing request" };
  }

  if (!input.elementName && !input.formSubmitName) {
    return {
      effect: "irreversible",
      reason: `${method} request with no identifiable control — treated as irreversible`,
    };
  }
  return { effect: "state_changing", reason: `step caused a ${method} request` };
}

/**
 * Applied at *replay* time. The artifact records what a step *does* (its
 * effect); whether that requires authorization is a policy question owned by
 * the deployment, not a fact baked into the recording — the same separation
 * that keeps business outcomes at app level rather than per-capability.
 *
 * `irreversible` always requires explicit authorization. Default posture is
 * "block", not "confirm inline", because production replay has no human
 * present to confirm; authorization comes from the caller ahead of time,
 * e.g. because a human already approved the action in the calling product's
 * own UI, or via `--escalate-on-risky` to route it to one.
 *
 * `state_changing` is recorded but ungated by default. An institution that
 * wants every mutation authorized can set `gateStateChanging` in
 * allowlist.json; the default is off because in server-rendered legacy apps
 * nearly every step would otherwise be gated.
 */
export function checkStepAuthorization(
  effect: StepEffect,
  opts: { allowRisky: boolean; policy?: PolicyConfig }
): PolicyDecision {
  const policy = opts.policy ?? loadPolicy();
  if (effect === "irreversible" && !opts.allowRisky) {
    return { allowed: false, reason: "irreversible step requires explicit allowRisky authorization" };
  }
  if (effect === "state_changing" && policy.gateStateChanging && !opts.allowRisky) {
    return {
      allowed: false,
      reason: "state-changing step requires allowRisky because gateStateChanging is enabled",
    };
  }
  return { allowed: true, reason: "ok" };
}
