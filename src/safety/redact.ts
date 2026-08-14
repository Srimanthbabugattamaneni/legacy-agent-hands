/**
 * Redaction for anything that leaves the process boundary: artifact JSON,
 * evidence logs, and escalation payloads. Regulated financial data must
 * never be persisted verbatim (spec 3.4), so this is applied unconditionally
 * on the write path — not opt-in.
 */

const SENSITIVE_FIELD_NAME = /pass(word)?|ssn|social.?security|token|secret|api.?key|pin\b|cvv|cvc|account.?number|routing.?number|card.?number/i;

const PATTERNS: { name: string; re: RegExp }[] = [
  { name: "ssn", re: /\b\d{3}-\d{2}-\d{4}\b/g },
  { name: "credit_card", re: /\b(?:\d[ -]*?){13,16}\b/g },
  { name: "email", re: /\b[\w.+-]+@[\w-]+\.[a-z]{2,}\b/gi },
  { name: "bearer_token", re: /\b(sk-[a-zA-Z0-9_-]{10,}|Bearer\s+[a-zA-Z0-9._-]{10,})\b/g },
];

export function isSensitiveFieldName(name: string): boolean {
  return SENSITIVE_FIELD_NAME.test(name);
}

export function redactText(input: string): string {
  let out = input;
  for (const { name, re } of PATTERNS) {
    out = out.replace(re, `[REDACTED:${name}]`);
  }
  return out;
}

/** Deep-redacts string values in a plain JSON-ish object/array, and fully
 * masks any value whose key looks sensitive regardless of content. */
export function redactDeep<T>(value: T): T {
  if (typeof value === "string") {
    return redactText(value) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => redactDeep(v)) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = isSensitiveFieldName(k) ? "[REDACTED]" : redactDeep(v);
    }
    return out as T;
  }
  return value;
}
