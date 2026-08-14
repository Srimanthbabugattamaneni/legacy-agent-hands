import { describe, it, expect } from "vitest";
import { redactText, redactDeep, isSensitiveFieldName } from "../src/safety/redact.js";

describe("redact", () => {
  it("redacts an SSN pattern", () => {
    expect(redactText("SSN on file: 123-45-6789")).toContain("[REDACTED:ssn]");
    expect(redactText("SSN on file: 123-45-6789")).not.toContain("123-45-6789");
  });

  it("redacts a bearer token / API key", () => {
    const out = redactText("Authorization: Bearer abcdef1234567890");
    expect(out).toContain("[REDACTED:bearer_token]");
  });

  it("leaves ordinary text untouched", () => {
    expect(redactText("Member 10234 has status active")).toBe("Member 10234 has status active");
  });

  it("does not mistake a 13-digit epoch timestamp for a card number", () => {
    // Regression: the old pattern matched any 13-digit run, so every run id
    // (which embeds Date.now()) was redacted — the evidence log destroyed its
    // own evidenceDir pointer in 13 committed files.
    const dir = "/evidence/replay-open-subaccount-1786720224866";
    expect(redactText(dir)).toBe(dir);
    expect(redactText(String(Date.now()))).toBe(String(Date.now()));
  });

  it("still redacts real card numbers, separated or not", () => {
    // False negatives are the dangerous direction for a redactor, so the
    // fix must not narrow to separator-grouped forms only.
    for (const pan of [
      "4111111111111111", // Visa, unseparated
      "4111 1111 1111 1111", // Visa, spaced
      "4111-1111-1111-1111", // Visa, dashed
      "5555555555554444", // Mastercard
      "378282246310005", // Amex, 15 digits
      "6011111111111117", // Discover
    ]) {
      expect(redactText(`card on file: ${pan}`)).toContain("[REDACTED:credit_card]");
      expect(redactText(`card on file: ${pan}`)).not.toContain(pan);
    }
  });

  it("rejects digit runs that fail the Luhn check", () => {
    expect(redactText("4111111111111112")).toBe("4111111111111112");
  });

  it("flags common sensitive field names", () => {
    expect(isSensitiveFieldName("password")).toBe(true);
    expect(isSensitiveFieldName("accountNumber")).toBe(true);
    expect(isSensitiveFieldName("memberId")).toBe(false);
  });

  it("deep-redacts nested objects, masking sensitive keys entirely", () => {
    const out = redactDeep({
      memberId: "10234",
      password: "hunter2",
      nested: { ssn: "123-45-6789", note: "email me at ops@example.com" },
    }) as Record<string, unknown>;
    expect(out.memberId).toBe("10234");
    expect(out.password).toBe("[REDACTED]");
    expect((out.nested as Record<string, unknown>).ssn).toBe("[REDACTED]");
    expect((out.nested as Record<string, unknown>).note).toContain("[REDACTED:email]");
  });
});
