import { describe, it, expect } from "vitest";
import {
  checkNavigation,
  checkActionType,
  isRiskyByName,
  checkRiskyStep,
  classifyRisk,
  loadPolicy,
} from "../src/safety/policy.js";

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

describe("classifyRisk", () => {
  const policy = loadPolicy();

  it("flags a risky-sounding control name", () => {
    expect(classifyRisk({ elementName: "Confirm & Open Account", requestMethod: "GET" }, policy).risky).toBe(true);
  });

  it("flags a state-changing request even when the control name looks harmless", () => {
    // The bypass this closes: pressing Enter in a form field submits the
    // form, but the only name available is the *input's* ("Initial Deposit"),
    // never the submit button's — so an irreversible action compiled as
    // risky: false and replayed with no authorization.
    const result = classifyRisk({ elementName: "Initial Deposit", requestMethod: "POST" }, policy);
    expect(result.risky).toBe(true);
    expect(result.reason).toMatch(/POST/);
  });

  it("flags a state-changing request with no element at all (press_key without a ref)", () => {
    expect(classifyRisk({ requestMethod: "POST" }, policy).risky).toBe(true);
  });

  it("leaves an ordinary GET navigation on a harmless control unflagged", () => {
    expect(classifyRisk({ elementName: "Search", requestMethod: "GET" }, policy).risky).toBe(false);
    expect(classifyRisk({ elementName: "Search" }, policy).risky).toBe(false);
    expect(classifyRisk({}, policy).risky).toBe(false);
  });
});
