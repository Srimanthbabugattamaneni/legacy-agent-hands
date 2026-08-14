import { describe, it, expect } from "vitest";
import { replay } from "../src/replay/replay.js";
import type { Surface, NavigationInfo, PolicyViolation, DialogInfo } from "../src/surface/types.js";
import type { LocatorDescriptor } from "../src/schema/locator.js";
import type { CapabilityArtifact } from "../src/schema/artifact.js";
import type { Observation } from "../src/schema/observation.js";

/**
 * The heterogeneity story in REPORT §4 rests on one claim: the replay engine
 * depends on the `Surface` abstraction, not on a browser. That claim was
 * false — every consumer typed against the concrete `BrowserSurface`, so the
 * interface was documentation rather than a seam, and a desktop or
 * frameset implementation would not have dropped in.
 *
 * This test is the claim made checkable: a Surface implemented over a plain
 * in-memory state machine, with no DOM, no Playwright, and no network,
 * driving the real replay engine end to end. If someone reintroduces a
 * concrete dependency above the seam, this stops compiling.
 */
class FakeSurface implements Surface {
  readonly visited: string[] = [];
  readonly actions: string[] = [];
  private url = "about:blank";
  private text = "";

  constructor(private pages: Record<string, string>) {}

  async navigate(url: string): Promise<void> {
    this.visited.push(url);
    this.url = url;
    this.text = this.pages[url] ?? "Not Found";
  }
  async observe(): Promise<Observation> {
    return { url: this.url, title: "fake", pageText: this.text, elements: [] };
  }
  async extractText(locator: LocatorDescriptor): Promise<string> {
    // The fake keys extraction off the locator itself, which is all the
    // engine ever gives it — proof the engine passes durable descriptors
    // rather than anything browser-shaped.
    const key = JSON.stringify(locator.primary);
    return key.includes("Balance") ? "$1234.56" : this.text;
  }
  currentUrl(): string {
    return this.url;
  }
  resolveElementToLocator(): LocatorDescriptor {
    throw new Error("not used by replay");
  }
  async activeFormSubmitName(): Promise<string | undefined> {
    return undefined;
  }
  async click(): Promise<void> {
    this.actions.push("click");
  }
  async fill(_l: LocatorDescriptor, value: string): Promise<void> {
    this.actions.push(`fill:${value}`);
  }
  async select(): Promise<void> {
    this.actions.push("select");
  }
  async check(): Promise<void> {
    this.actions.push("check");
  }
  async pressKey(): Promise<void> {
    this.actions.push("press");
  }
  async waitFor(): Promise<void> {}
  takeNavigation(): NavigationInfo | undefined {
    return undefined;
  }
  takePolicyViolation(): PolicyViolation | undefined {
    return undefined;
  }
  takeDialog(): DialogInfo | undefined {
    return undefined;
  }
  async screenshot(): Promise<void> {}
  async close(): Promise<void> {}
}

function artifact(): CapabilityArtifact {
  return {
    schemaVersion: "1.1",
    id: "seam",
    name: "test-seam",
    version: 1,
    description: "read a balance from a non-browser surface",
    goal: "read a balance",
    createdAt: new Date().toISOString(),
    target: { appId: "mock-bank", entryUrl: "http://localhost:4000/members/{{memberId}}" },
    inputs: [{ name: "memberId", type: "string", description: "member id", required: true, sensitive: false }],
    outputs: [{ name: "savingsBalance", type: "string", description: "balance" }],
    steps: [
      {
        id: "s1",
        action: "extract",
        description: "read the savings balance",
        locator: { primary: { strategy: "text", text: "Savings Balance", exact: true, nth: 0 }, fallbacks: [] },
        extractTo: "savingsBalance",
        effect: "read",
      },
    ],
    successCheckpoint: { description: "detail page reached", textContains: "Member Detail" },
  };
}

describe("the replay engine runs against any Surface, not just a browser", () => {
  it("completes a capability on an in-memory surface with no DOM at all", async () => {
    const fake = new FakeSurface({ "http://localhost:4000/members/10234": "Member Detail" });

    const result = await replay({
      artifact: artifact(),
      params: { memberId: "10234" },
      createSurface: async () => fake,
    });

    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(result.outputs.savingsBalance).toBe("$1234.56");
    }
    // Parameter substitution reached the surface as a resolved URL.
    expect(fake.visited).toEqual(["http://localhost:4000/members/10234"]);
  });

  it("reports a failed checkpoint identically on a non-browser surface", async () => {
    const fake = new FakeSurface({ "http://localhost:4000/members/10234": "Access Denied For Reasons" });

    const result = await replay({
      artifact: artifact(),
      params: { memberId: "10234" },
      createSurface: async () => fake,
    });

    // The engine's contract holds regardless of what implements the surface:
    // a business outcome is still matched from page text.
    expect(result.status).toBe("business_outcome");
    if (result.status === "business_outcome") {
      expect(result.outcome).toBe("permission_denied");
    }
  });
});
