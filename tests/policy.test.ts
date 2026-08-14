import { describe, it, expect } from "vitest";
import { checkNavigation, checkActionType, isRiskyByName, checkRiskyStep, loadPolicy } from "../src/safety/policy.js";

describe("safety policy", () => {
  const policy = loadPolicy();

  it("allows navigation within the allowlisted origin and route", () => {
    expect(checkNavigation("http://localhost:4000/members/10234", policy).allowed).toBe(true);
  });

  it("blocks navigation to a disallowed origin", () => {
    const result = checkNavigation("http://evil.example.com/", policy);
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/origin/);
  });

  it("blocks navigation to a route outside the allowlist", () => {
    const result = checkNavigation("http://localhost:4000/admin/danger", policy);
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/route/);
  });

  it("rejects a malformed URL", () => {
    expect(checkNavigation("not-a-url", policy).allowed).toBe(false);
  });

  it("allows allowlisted action types and blocks unlisted ones", () => {
    expect(checkActionType("click", policy).allowed).toBe(true);
    // @ts-expect-error deliberately invalid action type for this test
    expect(checkActionType("os_exec", policy).allowed).toBe(false);
  });

  it("flags risky-sounding control names", () => {
    expect(isRiskyByName("Confirm & Open Account", policy)).toBe(true);
    expect(isRiskyByName("Search", policy)).toBe(false);
  });

  it("blocks a risky step unless explicitly authorized", () => {
    expect(checkRiskyStep(true, false).allowed).toBe(false);
    expect(checkRiskyStep(true, true).allowed).toBe(true);
    expect(checkRiskyStep(false, false).allowed).toBe(true);
  });
});
