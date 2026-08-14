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
