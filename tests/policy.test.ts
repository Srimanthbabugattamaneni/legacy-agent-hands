import { describe, it, expect } from "vitest";
import {
  checkNavigation,
  checkActionType,
  isRiskyByName,
  checkStepAuthorization,
  classifyEffect,
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

});

describe("classifyEffect", () => {
  const policy = loadPolicy();

  it("marks a risky-sounding control irreversible", () => {
    expect(classifyEffect({ elementName: "Confirm & Open Account", requestMethod: "GET" }, policy).effect).toBe(
      "irreversible"
    );
  });

  it("marks Enter-in-a-field irreversible via the form's submit control, not the field", () => {
    // The actual bypass: pressing Enter submits the form, but the name in
    // hand is the *input's* ("Initial Deposit"). Reading the submit control's
    // name instead identifies what the step really commits. The first fix for
    // this treated every POST as irreversible, which was too blunt — see the
    // next case.
    const result = classifyEffect(
      { elementName: "Initial Deposit", formSubmitName: "Confirm & Open Account", requestMethod: "POST" },
      policy
    );
    expect(result.effect).toBe("irreversible");
    expect(result.reason).toMatch(/submit control/);
  });

  it("marks a reversible intermediate POST state_changing, not irreversible", () => {
    // "Continue -> review screen" POSTs but commits nothing. Gating it would
    // force --allow-risky on nearly every step of a legacy flow, which trains
    // callers to pass it always — the rubber-stamp failure the gate exists to
    // prevent.
    const result = classifyEffect(
      { elementName: "Continue", formSubmitName: "Continue", requestMethod: "POST" },
      policy
    );
    expect(result.effect).toBe("state_changing");
  });

  it("falls back to irreversible when state changed but nothing identifies the control", () => {
    expect(classifyEffect({ requestMethod: "POST" }, policy).effect).toBe("irreversible");
  });

  it("treats a plain GET on a harmless control as a read", () => {
    expect(classifyEffect({ elementName: "Search", formSubmitName: "Search", requestMethod: "GET" }, policy).effect).toBe("read");
    expect(classifyEffect({ elementName: "Search" }, policy).effect).toBe("read");
    expect(classifyEffect({}, policy).effect).toBe("read");
  });
});

describe("checkStepAuthorization", () => {
  const policy = loadPolicy();
  const strict = { ...policy, gateStateChanging: true };

  it("always gates an irreversible step", () => {
    expect(checkStepAuthorization("irreversible", { allowRisky: false, policy }).allowed).toBe(false);
    expect(checkStepAuthorization("irreversible", { allowRisky: true, policy }).allowed).toBe(true);
  });

  it("lets a state-changing step through by default", () => {
    expect(checkStepAuthorization("state_changing", { allowRisky: false, policy }).allowed).toBe(true);
  });

  it("gates a state-changing step when the institution opts in", () => {
    expect(checkStepAuthorization("state_changing", { allowRisky: false, policy: strict }).allowed).toBe(false);
    expect(checkStepAuthorization("state_changing", { allowRisky: true, policy: strict }).allowed).toBe(true);
  });

  it("never gates a read", () => {
    expect(checkStepAuthorization("read", { allowRisky: false, policy: strict }).allowed).toBe(true);
  });
});
