import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import { app } from "../apps/mock-bank/server.js";
import { replay } from "../src/replay/replay.js";
import { compileArtifact } from "../src/agent/compileArtifact.js";
import type { CapabilityArtifact } from "../src/schema/artifact.js";

/**
 * End-to-end replay tests against the *real* mock-bank app over a real
 * Playwright browser — no LLM involved (replay never calls one), so this is
 * fast, deterministic, and safe to run in CI. Exercises the success,
 * business-outcome, and risky-step-blocked paths of the error taxonomy.
 */

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  // Bound to the fixed port the safety allowlist (src/safety/allowlist.json)
  // is configured for — an ephemeral port would be policy-blocked, which is
  // the allowlist doing exactly its job, just not what this test is after.
  const port = Number(process.env.MOCK_BANK_PORT ?? 4000);
  server = app.listen(port);
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    // Without this the EADDRINUSE surfaces as an unhandled exception with no
    // hint about the cause, and the README tells you to leave `npm run mock`
    // running — so following the README and then running the suite produced
    // a confusing crash.
    server.once("error", (err: NodeJS.ErrnoException) => {
      reject(
        err.code === "EADDRINUSE"
          ? new Error(
              `port ${port} is already in use — stop a running \`npm run mock\` before running the tests, ` +
                `or set MOCK_BANK_PORT (note: the safety allowlist pins localhost:4000, so a different ` +
                `port also needs src/safety/allowlist.json updated).`
            )
          : err
      );
    });
  });
  baseUrl = `http://localhost:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function lookupBalanceArtifact(): CapabilityArtifact {
  return {
    schemaVersion: "1.0",
    id: "test-lookup",
    name: "test-lookup-balance",
    version: 1,
    description: "Look up a member and read their savings balance.",
    goal: "look up a member and read current savings balance",
    createdAt: new Date().toISOString(),
    target: { appId: "mock-bank", entryUrl: `${baseUrl}/` },
    inputs: [{ name: "memberId", type: "string", description: "member id", required: true, sensitive: false }],
    outputs: [{ name: "savingsBalance", type: "string", description: "savings balance" }],
    steps: [
      {
        id: "s1",
        action: "fill",
        description: 'fill "Member ID" with memberId',
        locator: { primary: { strategy: "role", role: "textbox", name: "Member ID", nameMatch: "exact", nth: 0 }, fallbacks: [] },
        value: { kind: "param", name: "memberId" },
        risky: false,
      },
      {
        id: "s2",
        action: "click",
        description: "click Search",
        locator: { primary: { strategy: "role", role: "button", name: "Search", nameMatch: "exact", nth: 0 }, fallbacks: [] },
        risky: false,
        checkpoint: { description: "member detail shown", textContains: "Savings Balance" },
      },
      {
        id: "s3",
        action: "extract",
        description: "extract savings balance",
        locator: {
          primary: { strategy: "css", selector: 'xpath=//td[b[text()="Savings Balance"]]/following-sibling::td[1]', nth: 0 },
          fallbacks: [],
        },
        extractTo: "savingsBalance",
        risky: false,
      },
    ],
    successCheckpoint: { description: "balance extracted", textContains: "Savings Balance" },
  };
}

function openSubaccountArtifact(): CapabilityArtifact {
  return {
    schemaVersion: "1.0",
    id: "test-open",
    name: "test-open-subaccount",
    version: 1,
    description: "Open a new sub-account for a member.",
    goal: "open a new sub-account and reach confirmation",
    createdAt: new Date().toISOString(),
    target: { appId: "mock-bank", entryUrl: `${baseUrl}/members/{{memberId}}/new-subaccount` },
    inputs: [
      { name: "memberId", type: "string", description: "member id", required: true, sensitive: false },
      { name: "deposit", type: "string", description: "initial deposit", required: true, sensitive: false },
    ],
    outputs: [],
    steps: [
      {
        id: "s1",
        action: "select",
        description: "select account type",
        locator: { primary: { strategy: "role", role: "combobox", name: "Account Type", nameMatch: "exact", nth: 0 }, fallbacks: [] },
        value: { kind: "literal", value: "Savings" },
        risky: false,
      },
      {
        id: "s2",
        action: "fill",
        description: "fill initial deposit",
        locator: { primary: { strategy: "role", role: "textbox", name: "Initial Deposit", nameMatch: "exact", nth: 0 }, fallbacks: [] },
        value: { kind: "param", name: "deposit" },
        risky: false,
      },
      {
        id: "s3",
        action: "click",
        description: "click Continue",
        locator: { primary: { strategy: "role", role: "button", name: "Continue", nameMatch: "exact", nth: 0 }, fallbacks: [] },
        risky: false,
        checkpoint: { description: "review screen shown", textContains: "Review & Confirm New Sub-Account" },
      },
      {
        id: "s4",
        action: "click",
        description: "click Confirm & Open Account",
        locator: {
          primary: { strategy: "role", role: "button", name: "Confirm & Open Account", nameMatch: "exact", nth: 0 },
          fallbacks: [],
        },
        risky: true,
        checkpoint: { description: "success page shown", textContains: "Sub-Account Opened Successfully" },
      },
    ],
    successCheckpoint: { description: "account opened", textContains: "Sub-Account Opened Successfully" },
  };
}

describe("replay of a compiled artifact honors its declared parameters", () => {
  // The other tests in this file hand-author their artifacts with {{memberId}}
  // already templated, which silently assumes compileArtifact produces that
  // token. It didn't — entryUrl was passed through raw — so a whole class of
  // "declared parameter is ignored on replay" bugs was invisible here. This
  // test compiles the artifact the way discovery really does, then replays it
  // against a *different* member than the one it was recorded on.
  it("navigates to the member supplied at replay time, not the recorded one", async () => {
    const artifact = compileArtifact({
      id: "test-compiled",
      name: "test-compiled-member-detail",
      description: "read a member's name from their detail page",
      goal: "look up a member and read their name",
      appId: "mock-bank",
      entryUrl: `${baseUrl}/members/20001`, // recorded against Sam Whitfield
      steps: [
        {
          id: "s1",
          action: "extract",
          description: 'extract "memberName" from cell "Name"',
          locator: {
            primary: {
              strategy: "css",
              selector: 'xpath=//td[b[normalize-space(text())="Name"]]/following-sibling::td[1]',
              nth: 0,
            },
            fallbacks: [],
          },
          extractTo: "memberName",
          urlBefore: `${baseUrl}/members/20001`,
          urlAfter: `${baseUrl}/members/20001`,
          pageTextBefore: "",
          pageTextAfter: "",
          risky: false,
        },
      ],
      paramLiterals: { memberId: "20001" },
      outputsDeclared: { memberName: "Sam Whitfield" },
    });

    expect(artifact.target.entryUrl).toContain("{{memberId}}");

    const result = await replay({ artifact, params: { memberId: "10567" }, headless: true });
    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(result.outputs.memberName).toBe("Priya Natarajan");
      expect(result.outputs.memberName).not.toBe("Sam Whitfield");
    }
  }, 30000);
});

describe("allowlist enforcement covers navigation however it was triggered", () => {
  // Enforcement used to live only at call sites the orchestrator controlled:
  // checkNavigation ran on the entry URL and on discovery's navigate action,
  // and nowhere else. So a navigate step in a (tampered) artifact and any
  // click-driven navigation both escaped the allowlist entirely. It is now
  // enforced at the network layer, which is what these three tests pin.
  //
  // The off-allowlist origin used here (localhost:4999) is deliberately not
  // listening: if enforcement ever regresses, the test fails rather than
  // silently making a real outbound request.
  const OFF_ALLOWLIST_ORIGIN = "http://localhost:4999";

  function artifact(steps: CapabilityArtifact["steps"], entryUrl: string): CapabilityArtifact {
    return {
      schemaVersion: "1.0",
      id: "test-policy",
      name: "test-policy",
      version: 1,
      description: "policy enforcement fixture",
      goal: "policy enforcement fixture",
      createdAt: new Date().toISOString(),
      target: { appId: "mock-bank", entryUrl },
      inputs: [],
      outputs: [],
      steps,
      successCheckpoint: { description: "unreachable in these tests" },
    };
  }

  it("blocks a navigate step pointing outside the allowlist (tampered artifact)", async () => {
    const result = await replay({
      artifact: artifact(
        [
          {
            id: "s1",
            action: "navigate",
            description: "navigate off the allowlisted origin",
            url: { kind: "literal", value: `${OFF_ALLOWLIST_ORIGIN}/partner-portal` },
            risky: false,
          },
        ],
        `${baseUrl}/`
      ),
      params: {},
      headless: true,
    });

    expect(result.status).toBe("failure");
    if (result.status === "failure") {
      expect(result.errorClass).toBe("policy_blocked");
      expect(result.stepId).toBe("s1");
    }
  }, 30000);

  it("blocks a click onto a non-allowlisted route, and does not mask it as a business outcome", async () => {
    // /login is reachable by clicking "Log In Again" on the session-expired
    // page but matches no allowedRoutePattern. The page also carries the text
    // that maps to the session_timeout business outcome, so this pins the
    // precedence rule: a refused navigation is a guardrail breach, never a
    // business result.
    const result = await replay({
      artifact: artifact(
        [
          {
            id: "s1",
            action: "click",
            description: "click Log In Again",
            locator: {
              primary: { strategy: "role", role: "button", name: "Log In Again", nameMatch: "exact", nth: 0 },
              fallbacks: [],
            },
            risky: false,
          },
        ],
        `${baseUrl}/members/99999`
      ),
      params: {},
      headless: true,
    });

    expect(result.status).toBe("failure");
    if (result.status === "failure") {
      expect(result.errorClass).toBe("policy_blocked");
      expect(result.observed).toContain("/login");
    }
  }, 30000);

  it("blocks a click onto a different origin", async () => {
    const result = await replay({
      artifact: artifact(
        [
          {
            id: "s1",
            action: "click",
            description: "click the partner portal link",
            locator: {
              primary: { strategy: "role", role: "link", name: "Partner Credit Portal", nameMatch: "exact", nth: 0 },
              fallbacks: [],
            },
            risky: false,
          },
        ],
        `${baseUrl}/members/10234`
      ),
      params: {},
      headless: true,
    });

    expect(result.status).toBe("failure");
    if (result.status === "failure") {
      expect(result.errorClass).toBe("policy_blocked");
      expect(result.observed).toContain(OFF_ALLOWLIST_ORIGIN);
    }
  }, 30000);
});

describe("runtime conditions the recorded flow never saw", () => {
  it("reports an unexpected native dialog instead of silently swallowing it", async () => {
    // Dialogs are still auto-dismissed so a run can't hang, but a flow that
    // raises one the recording never saw has diverged, and continuing would
    // be acting on a guess. Before this, `unexpected_dialog` was declared in
    // the ErrorClass enum with nothing anywhere able to produce it.
    const result = await replay({
      artifact: {
        schemaVersion: "1.0",
        id: "test-dialog",
        name: "test-dialog",
        version: 1,
        description: "dialog fixture",
        goal: "dialog fixture",
        createdAt: new Date().toISOString(),
        target: { appId: "mock-bank", entryUrl: `${baseUrl}/members/10234/archive` },
        inputs: [],
        outputs: [],
        steps: [
          {
            id: "s1",
            action: "click",
            description: "click Archive Record",
            locator: {
              primary: { strategy: "role", role: "button", name: "Archive Record", nameMatch: "exact", nth: 0 },
              fallbacks: [],
            },
            risky: false,
          },
        ],
        successCheckpoint: { description: "unreachable" },
      },
      params: {},
      headless: true,
    });

    expect(result.status).toBe("failure");
    if (result.status === "failure") {
      expect(result.errorClass).toBe("unexpected_dialog");
      expect(result.observed).toContain("Archive this member record?");
    }
  }, 30000);

  it("fails a checkpoint whose text condition breaks even though its URL condition holds", async () => {
    // The schema allows both; verifyCheckpoint used to return on the first
    // one present, so a checkpoint like this asserted strictly less than it
    // claimed to.
    const result = await replay({
      artifact: {
        schemaVersion: "1.0",
        id: "test-both",
        name: "test-both",
        version: 1,
        description: "checkpoint fixture",
        goal: "checkpoint fixture",
        createdAt: new Date().toISOString(),
        target: { appId: "mock-bank", entryUrl: `${baseUrl}/members/10234` },
        inputs: [],
        outputs: [],
        steps: [
          {
            id: "s1",
            action: "extract",
            description: "read the member name",
            locator: {
              primary: {
                strategy: "css",
                selector: 'xpath=//td[b[normalize-space(text())="Name"]]/following-sibling::td[1]',
                nth: 0,
              },
              fallbacks: [],
            },
            extractTo: "memberName",
            risky: false,
            checkpoint: {
              description: "on the member page and showing a heading that isn't there",
              urlContains: "/members/10234", // true
              textContains: "Loan Origination History", // false, and not a business-outcome trigger
            },
          },
        ],
        successCheckpoint: { description: "unreachable" },
      },
      params: {},
      headless: true,
    });

    expect(result.status).toBe("failure");
    if (result.status === "failure") {
      expect(result.errorClass).toBe("checkpoint_failed");
      expect(result.expected).toContain("Loan Origination History");
    }
  }, 30000);

  it("passes an explicitly empty parameter through to the app instead of refusing to run", async () => {
    // "" is a value the caller chose to send, and the interesting one here:
    // it exercises the target's own validation, which is a business outcome
    // worth reporting rather than an error we refuse to attempt.
    const result = await replay({
      artifact: openSubaccountArtifact(),
      params: { memberId: "10234", deposit: "" },
      headless: true,
      allowRisky: true,
    });

    expect(result.status).toBe("business_outcome");
    if (result.status === "business_outcome") {
      expect(result.outcome).toBe("validation_error");
    }
  }, 30000);
});

describe("replay against the real mock-bank app", () => {
  it("succeeds for a known member and extracts the savings balance", async () => {
    const result = await replay({ artifact: lookupBalanceArtifact(), params: { memberId: "10234" }, headless: true });
    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(result.outputs.savingsBalance).toBe("$4231.09");
    }
  }, 30000);

  it("reports member_not_found as a business outcome, not a failure", async () => {
    const result = await replay({ artifact: lookupBalanceArtifact(), params: { memberId: "55555" }, headless: true });
    expect(result.status).toBe("business_outcome");
    if (result.status === "business_outcome") {
      expect(result.outcome).toBe("member_not_found");
    }
  }, 30000);

  it("reports permission_denied as a business outcome for a restricted member", async () => {
    const result = await replay({ artifact: lookupBalanceArtifact(), params: { memberId: "88888" }, headless: true });
    expect(result.status).toBe("business_outcome");
    if (result.status === "business_outcome") {
      expect(result.outcome).toBe("permission_denied");
    }
  }, 30000);

  it("reports session_timeout as a business outcome", async () => {
    const result = await replay({ artifact: lookupBalanceArtifact(), params: { memberId: "99999" }, headless: true });
    expect(result.status).toBe("business_outcome");
    if (result.status === "business_outcome") {
      expect(result.outcome).toBe("session_timeout");
    }
  }, 30000);

  it("recovers from a transient failure via retry-once", async () => {
    const result = await replay({ artifact: lookupBalanceArtifact(), params: { memberId: "77777" }, headless: true });
    expect(result.status).toBe("success");
  }, 30000);

  it("blocks a risky step without explicit authorization", async () => {
    const result = await replay({
      artifact: openSubaccountArtifact(),
      params: { memberId: "20001", deposit: "100" },
      headless: true,
      allowRisky: false,
    });
    expect(result.status).toBe("failure");
    if (result.status === "failure") {
      expect(result.errorClass).toBe("policy_blocked");
      expect(result.stepId).toBe("s4");
    }
  }, 30000);

  it("executes a risky step and completes when explicitly authorized", async () => {
    const result = await replay({
      artifact: openSubaccountArtifact(),
      params: { memberId: "20001", deposit: "100" },
      headless: true,
      allowRisky: true,
    });
    expect(result.status).toBe("success");
  }, 30000);

  it("reports validation_error as a business outcome for a too-small deposit", async () => {
    const result = await replay({
      artifact: openSubaccountArtifact(),
      params: { memberId: "10567", deposit: "5" },
      headless: true,
      allowRisky: true,
    });
    expect(result.status).toBe("business_outcome");
    if (result.status === "business_outcome") {
      expect(result.outcome).toBe("validation_error");
    }
  }, 30000);
});
