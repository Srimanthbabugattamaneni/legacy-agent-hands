import { describe, it, expect } from "vitest";
import { compileArtifact } from "../src/agent/compileArtifact.js";
import type { DiscoveryStepRecord } from "../src/agent/types.js";

function record(partial: Partial<DiscoveryStepRecord> & Pick<DiscoveryStepRecord, "id" | "action">): DiscoveryStepRecord {
  return {
    description: "",
    urlBefore: "http://localhost:4000/",
    urlAfter: "http://localhost:4000/",
    pageTextBefore: "",
    pageTextAfter: "",
    effect: "read",
    ...partial,
  };
}

describe("compileArtifact", () => {
  it("turns a literal that matches a declared param into a param reference", () => {
    const steps: DiscoveryStepRecord[] = [
      record({
        id: "s1",
        action: "fill",
        description: 'fill textbox "Member ID" with "10234"',
        literalValue: "10234",
        pageTextBefore: "Member Lookup",
        pageTextAfter: "Member Lookup",
      }),
      record({ id: "s2", action: "extract", extractTo: "savingsBalance" }),
    ];
    const artifact = compileArtifact({
      id: "cap_1",
      name: "lookup-balance",
      description: "test",
      goal: "look up member 10234",
      appId: "mock-bank",
      entryUrl: "http://localhost:4000/",
      steps,
      paramLiterals: { memberId: "10234" },
      outputsDeclared: { savingsBalance: "$4231.09" },
    });

    expect(artifact.inputs).toEqual([
      { name: "memberId", type: "number", description: "Input parameter: memberId", required: true, sensitive: false },
    ]);
    expect(artifact.steps[0]!.value).toEqual({ kind: "param", name: "memberId" });
    expect(artifact.outputs[0]).toMatchObject({ name: "savingsBalance", type: "string" });
  });

  it("keeps a literal that doesn't match any declared param as-is", () => {
    const steps: DiscoveryStepRecord[] = [
      record({ id: "s1", action: "select", literalValue: "Savings" }),
    ];
    const artifact = compileArtifact({
      id: "cap_2",
      name: "open-subaccount",
      description: "test",
      goal: "open a sub-account",
      appId: "mock-bank",
      entryUrl: "http://localhost:4000/",
      steps,
      paramLiterals: { memberId: "20001" },
      outputsDeclared: {},
    });
    expect(artifact.steps[0]!.value).toEqual({ kind: "literal", value: "Savings" });
  });

  it("derives a checkpoint from newly-appeared page text, tokenizing known param literals", () => {
    const steps: DiscoveryStepRecord[] = [
      record({
        id: "s1",
        action: "click",
        pageTextBefore: "Member Lookup",
        pageTextAfter: "Member Lookup\nMember Detail\nMember ID\n10234\nSavings Balance\n$4231.09",
        urlBefore: "http://localhost:4000/",
        urlAfter: "http://localhost:4000/members/10234",
      }),
    ];
    const artifact = compileArtifact({
      id: "cap_3",
      name: "lookup-balance",
      description: "test",
      goal: "look up member 10234",
      appId: "mock-bank",
      entryUrl: "http://localhost:4000/",
      steps,
      paramLiterals: { memberId: "10234" },
      outputsDeclared: {},
    });
    const cp = artifact.steps[0]!.checkpoint;
    expect(cp?.textContains).toBeDefined();
    expect(cp?.textContains).not.toContain("10234");
  });

  it("prefers a digit-free stable line over a longer line with un-parameterized per-record data", () => {
    // Regression: the real mock-bank page renders a table row as one
    // tab-joined line ("Savings\tSV-10234-1\t$4231.09") that contains BOTH
    // the declared memberId param (tokenizable) AND a dollar balance that
    // isn't a declared param — picking "longest new line" chose that row,
    // producing a checkpoint hardcoded to one record's balance and failing
    // replay for every other member. A safe, generic candidate ("Member
    // Detail") must win instead.
    const steps: DiscoveryStepRecord[] = [
      record({
        id: "s1",
        action: "click",
        pageTextBefore: "Member Lookup",
        pageTextAfter: "Member Lookup\nMember Detail\nSavings\tSV-10234-1\t$4231.09",
        urlBefore: "http://localhost:4000/",
        urlAfter: "http://localhost:4000/members/10234",
      }),
    ];
    const artifact = compileArtifact({
      id: "cap_3b",
      name: "lookup-balance",
      description: "test",
      goal: "look up member 10234",
      appId: "mock-bank",
      entryUrl: "http://localhost:4000/",
      steps,
      paramLiterals: { memberId: "10234" },
      outputsDeclared: {},
    });
    expect(artifact.steps[0]!.checkpoint?.textContains).toBe("Member Detail");
  });

  it("refuses to persist a literal from a field flagged sensitive without a declared param", () => {
    const steps: DiscoveryStepRecord[] = [
      record({ id: "s1", action: "fill", literalValue: "hunter2", sensitive: true }),
    ];
    expect(() =>
      compileArtifact({
        id: "cap_4",
        name: "bad",
        description: "test",
        goal: "test",
        appId: "mock-bank",
        entryUrl: "http://localhost:4000/",
        steps,
        paramLiterals: {},
        outputsDeclared: {},
      })
    ).toThrow(/sensitive/);
  });

  it("tokenizes the entry URL so a declared param is honored on replay", () => {
    // Regression: entryUrl was passed through raw, so the discovery-time
    // member was frozen into the artifact and every replay silently ignored
    // memberId — navigating to (and, for open-subaccount, opening an account
    // against) the wrong member.
    const artifact = compileArtifact({
      id: "cap_6",
      name: "open-subaccount",
      description: "test",
      goal: "test",
      appId: "mock-bank",
      entryUrl: "http://localhost:4000/members/20001/new-subaccount",
      steps: [record({ id: "s1", action: "click" })],
      paramLiterals: { memberId: "20001", deposit: "100" },
      outputsDeclared: {},
    });
    expect(artifact.target.entryUrl).toBe("http://localhost:4000/members/{{memberId}}/new-subaccount");
  });

  it("tokenizes a recorded navigate step's URL", () => {
    const artifact = compileArtifact({
      id: "cap_7",
      name: "lookup",
      description: "test",
      goal: "test",
      appId: "mock-bank",
      entryUrl: "http://localhost:4000/",
      steps: [
        record({ id: "s1", action: "navigate", literalValue: "http://localhost:4000/members/20001" }),
      ],
      paramLiterals: { memberId: "20001" },
      outputsDeclared: {},
    });
    expect(artifact.steps[0]!.url).toEqual({
      kind: "literal",
      value: "http://localhost:4000/members/{{memberId}}",
    });
  });

  it("marks an input parameter sensitive when its field was flagged sensitive", () => {
    // Regression: InputParam.sensitive was hardcoded false, so the flag the
    // schema declares could never actually be true for any artifact.
    const artifact = compileArtifact({
      id: "cap_8",
      name: "login",
      description: "test",
      goal: "test",
      appId: "mock-bank",
      entryUrl: "http://localhost:4000/",
      steps: [
        record({ id: "s1", action: "fill", literalValue: "hunter2", sensitive: true }),
        record({ id: "s2", action: "fill", literalValue: "10234" }),
      ],
      paramLiterals: { password: "hunter2", memberId: "10234" },
      outputsDeclared: {},
    });
    const byName = Object.fromEntries(artifact.inputs.map((i) => [i.name, i.sensitive]));
    expect(byName.password).toBe(true);
    expect(byName.memberId).toBe(false);
  });

  it("never bakes an extracted (per-record) value into a checkpoint", () => {
    // The digit heuristic alone lets a member's name through — it has no
    // digits — which would persist PII into a committed artifact and break
    // replay for every other member.
    const artifact = compileArtifact({
      id: "cap_9",
      name: "lookup-balance",
      description: "test",
      goal: "test",
      appId: "mock-bank",
      entryUrl: "http://localhost:4000/",
      steps: [
        record({
          id: "s1",
          action: "click",
          pageTextBefore: "Member Lookup",
          // The PII line is deliberately the *shortest* zero-digit candidate,
          // so neither the digit ranking nor the shortest-wins tiebreak saves
          // it — only rejecting extracted values and deprioritising data rows
          // does. (A fixture where the safe line is shorter passes with or
          // without the fix, and so tests nothing.)
          pageTextAfter: "Member Lookup\nName\tBob Lee\nAccount Overview Details",
        }),
      ],
      paramLiterals: { memberId: "10234" },
      outputsDeclared: { memberName: "Bob Lee" },
    });
    const cp = artifact.steps[0]!.checkpoint;
    expect(cp?.textContains).not.toContain("Bob Lee");
    expect(cp?.textContains).toBe("Account Overview Details");
  });

  it("strips the observed value from a step description so no record data reaches the artifact", () => {
    // Regression: descriptions were passed through verbatim, so a committed
    // artifact carried `-> "Sam Whitfield (20001)"` — a member's name in a
    // reviewable file. The round-3 checkpoint PII filter never covered this
    // path. The value survives in the (redacted) run log for debugging.
    const artifact = compileArtifact({
      id: "cap_10",
      name: "lookup",
      description: "test",
      goal: "test",
      appId: "mock-bank",
      entryUrl: "http://localhost:4000/",
      steps: [
        record({
          id: "s1",
          action: "extract",
          description: 'extract "member" from cell "Member" -> "Sam Whitfield (20001)"',
          extractTo: "member",
        }),
      ],
      paramLiterals: { memberId: "20001" },
      outputsDeclared: { member: "Sam Whitfield (20001)" },
    });
    const description = artifact.steps[0]!.description;
    expect(description).toBe('extract "member" from cell "Member"');
    expect(description).not.toContain("Sam Whitfield");
  });

  it("leaves a repeated click alone, since clicking twice can be meaningful", () => {
    const locator = {
      primary: { strategy: "role" as const, role: "button", name: "Next", nameMatch: "exact" as const, nth: 0 },
      fallbacks: [],
    };
    const artifact = compileArtifact({
      id: "cap_12",
      name: "paged",
      description: "test",
      goal: "test",
      appId: "mock-bank",
      entryUrl: "http://localhost:4000/",
      steps: [
        record({ id: "s1", action: "click", locator }),
        record({ id: "s2", action: "click", locator }),
      ],
      paramLiterals: {},
      outputsDeclared: {},
    });
    expect(artifact.steps).toHaveLength(2);
  });

  it("collapses consecutive identical extract steps", () => {
    // The shipped recording repeated the same extract three times — model
    // repetition compiled verbatim. Harmless at replay, but noise in an
    // artifact whose whole point is being reviewable.
    const locator = {
      primary: { strategy: "css" as const, selector: "xpath=//td[b]/following-sibling::td[1]", nth: 0 },
      fallbacks: [],
    };
    const artifact = compileArtifact({
      id: "cap_11",
      name: "open-subaccount",
      description: "test",
      goal: "test",
      appId: "mock-bank",
      entryUrl: "http://localhost:4000/",
      steps: [
        record({ id: "s1", action: "extract", extractTo: "acct", locator }),
        record({ id: "s2", action: "extract", extractTo: "acct", locator }),
        record({ id: "s3", action: "extract", extractTo: "acct", locator }),
        record({ id: "s4", action: "extract", extractTo: "other", locator }),
      ],
      paramLiterals: {},
      outputsDeclared: { acct: "SA-1", other: "x" },
    });
    expect(artifact.steps.map((s) => s.extractTo)).toEqual(["acct", "other"]);
  });

  it("drops a declared output with no backing extract step, keeps one that has one", () => {
    // Regression: finish_success can claim an output was captured without
    // the agent ever calling extract for it (seen in practice — a weaker
    // model fabricated a value instead of extracting one). An artifact
    // must not promise an output replay can never actually produce.
    const steps: DiscoveryStepRecord[] = [
      record({ id: "s1", action: "extract", extractTo: "accountType", literalValue: undefined }),
    ];
    const artifact = compileArtifact({
      id: "cap_5",
      name: "open-subaccount",
      description: "test",
      goal: "test",
      appId: "mock-bank",
      entryUrl: "http://localhost:4000/",
      steps,
      paramLiterals: {},
      outputsDeclared: { accountType: "Savings", accountNumber: "[REDACTED]" },
    });
    expect(artifact.outputs.map((o) => o.name)).toEqual(["accountType"]);
  });
});
