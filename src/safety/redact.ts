/**
 * Redaction for anything that leaves the process boundary: artifact JSON,
 * evidence logs, and escalation payloads. Regulated financial data must
 * never be persisted verbatim (spec 3.4), so this is applied unconditionally
 * on the write path — not opt-in.
 */

const SENSITIVE_FIELD_NAME = /pass(word)?|ssn|social.?security|token|secret|api.?key|pin\b|cvv|cvc|account.?number|routing.?number|card.?number/i;

/** Luhn check digit — every real PAN satisfies it, and it rejects ~90% of
 * arbitrary digit runs of the same length. */
function passesLuhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * A digit run is only treated as a card number if it also *behaves* like
 * one: 13-19 digits, Luhn-valid, and a major-network IIN prefix (3-6 covers
 * Amex/Visa/Mastercard/Discover/JCB/Diners).
 *
 * The pattern alone matched any 13-digit run — including the epoch-ms
 * timestamp in every run id, which meant the evidence log redacted its own
 * `evidenceDir` pointer into uselessness.
 *
 * Note what this deliberately does *not* do: require separator grouping
 * (\d{4}-\d{4}-...). That would drop unseparated `4111111111111111`, and for
 * a redactor guarding regulated data a false negative is far worse than a
 * false positive — a missed PAN is a leak, a spurious match is only noise.
 */
function looksLikeCardNumber(match: string): boolean {
  const digits = match.replace(/[ -]/g, "");
  if (digits.length < 13 || digits.length > 19) return false;
  if (!/^[3-6]/.test(digits)) return false;
  return passesLuhn(digits);
}

const PATTERNS: { name: string; re: RegExp; validate?: (match: string) => boolean }[] = [
  { name: "ssn", re: /\b\d{3}-\d{2}-\d{4}\b/g },
  { name: "credit_card", re: /\b\d(?:[ -]?\d){12,18}\b/g, validate: looksLikeCardNumber },
  { name: "email", re: /\b[\w.+-]+@[\w-]+\.[a-z]{2,}\b/gi },
  { name: "bearer_token", re: /\b(sk-[a-zA-Z0-9_-]{10,}|Bearer\s+[a-zA-Z0-9._-]{10,})\b/g },
];

export function isSensitiveFieldName(name: string): boolean {
  return SENSITIVE_FIELD_NAME.test(name);
}

export function redactText(input: string): string {
  let out = input;
  for (const { name, re, validate } of PATTERNS) {
    out = out.replace(re, (match) => (validate && !validate(match) ? match : `[REDACTED:${name}]`));
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
