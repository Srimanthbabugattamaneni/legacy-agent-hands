import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export type BusinessOutcomeRule = { outcome: string; textContains: string; detail: string };

/**
 * Business outcomes are a property of the *target application*, not of any
 * one capability — "member not found" can be hit by lookup-balance,
 * open-subaccount, or any future capability against this same app. Keyed by
 * appId so the same catalog is reused across every capability recorded
 * against a given vendor product, and can be extended per tenant (3.7).
 */
export function loadBusinessOutcomes(appId: string): BusinessOutcomeRule[] {
  const all = JSON.parse(readFileSync(path.join(__dirname, "business-outcomes.json"), "utf-8")) as Record<
    string,
    BusinessOutcomeRule[]
  >;
  return all[appId] ?? [];
}

export function matchBusinessOutcome(pageText: string, rules: BusinessOutcomeRule[]): BusinessOutcomeRule | undefined {
  return rules.find((r) => pageText.includes(r.textContains));
}
