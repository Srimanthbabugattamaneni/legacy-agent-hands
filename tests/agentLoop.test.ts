import { describe, it, expect } from "vitest";
import { runDiscovery } from "../src/agent/discover.js";
import type { LlmProvider, ToolCall } from "../src/agent/llm/types.js";
import type { Surface, NavigationInfo, PolicyViolation, DialogInfo } from "../src/surface/types.js";
import type { LocatorDescriptor } from "../src/schema/locator.js";
import type { Observation } from "../src/schema/observation.js";

/**
 * The discovery loop had no tests: every path through it needed a live model
 * and a live browser, so its stopping rules were only ever exercised by hand.
 * Both collaborators sit behind interfaces, so a scripted provider and an
 * in-memory surface can drive the real loop deterministically — no model, no
 * browser, no network.
 *
 * This is also what keeps `LlmProvider` honest now that the repo ships a
 * single provider. An abstraction with one implementation and no test is
 * decorative; this one is exercised against an implementation that is
 * emphatically not Ollama.
 */

/** Replays a fixed script of tool calls, one per turn. */
class ScriptedProvider implements LlmProvider {
  readonly label = "scripted";
  readonly turns: number[] = [];
  private i = 0;
  constructor(private script: (ToolCall | null)[]) {}

  async step() {
    const next = this.script[this.i++] ?? null;
    this.turns.push(this.i);
    return { toolCalls: next ? [next] : [], assistantText: next ? "" : "let me think about it" };
  }
}

class MemorySurface implements Surface {
  private url = "http://localhost:4000/";
  constructor(private pageText = "Member Lookup") {}
  async observe(): Promise<Observation> {
    return {
      url: this.url,
      title: "fake",
      pageText: this.pageText,
      elements: [
        { ref: "e0", tag: "input", role: "textbox", name: "Member ID", sensitive: false },
        { ref: "e1", tag: "button", role: "button", name: "Search", sensitive: false, formSubmitName: "Search" },
      ],
    };
  }
  async extractText(): Promise<string> {
    return "$4231.09";
  }
  currentUrl(): string {
    return this.url;
  }
  resolveElementToLocator(): LocatorDescriptor {
    return { primary: { strategy: "role", role: "button", name: "Search", nameMatch: "exact", nth: 0 }, fallbacks: [] };
  }
  async activeFormSubmitName(): Promise<string | undefined> {
    return undefined;
  }
  async navigate(url: string): Promise<void> {
    this.url = url;
  }
  async click(): Promise<void> {
    this.pageText = "Member Detail\nSavings Balance\t$4231.09";
  }
  async fill(): Promise<void> {}
  async select(): Promise<void> {}
  async check(): Promise<void> {}
  async pressKey(): Promise<void> {}
  async waitFor(): Promise<void> {}
  takeNavigation(): NavigationInfo | undefined {
    return { status: 200, method: "GET" };
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

const call = (name: string, input: Record<string, unknown>): ToolCall => ({ id: `t_${name}`, name, input });

function baseOpts(llm: LlmProvider) {
  return {
    goal: "look up a member and read the savings balance",
    targetUrl: "http://localhost:4000/",
    name: `test-agentloop-${Date.now()}`,
    params: { memberId: "10234" },
    llm,
    createSurface: async () => new MemorySurface(),
    headless: true,
    // Unattended: a stuck run should return a failed result, not block
    // waiting for an operator who will never arrive.
    escalateWhenStuck: false,
  };
}

describe("the discovery loop runs against any LlmProvider", () => {
  it("records the steps the model chose and compiles a capability", async () => {
    const llm = new ScriptedProvider([
      call("fill", { ref: "e0", value: "10234" }),
      call("click", { ref: "e1" }),
      call("extract", { ref: "e1", outputKey: "savingsBalance" }),
      call("finish_success", { summary: "read the balance", outputs: { savingsBalance: "$4231.09" } }),
    ]);

    const result = await runDiscovery(baseOpts(llm));

    expect(result.status).toBe("success");
    expect(result.artifact?.steps.map((s) => s.action)).toEqual(["fill", "click", "extract"]);
    // The declared output survives because an extract step backs it.
    expect(result.artifact?.outputs.map((o) => o.name)).toEqual(["savingsBalance"]);
    // The value the model supplied was matched to the declared parameter.
    expect(result.artifact?.steps[0]!.value).toEqual({ kind: "param", name: "memberId" });
  }, 30000);

  it("stops at maxSteps instead of looping forever when the model never finishes", async () => {
    // A model that keeps acting without ever calling finish_success is the
    // dead-end case the step budget exists for.
    const llm = new ScriptedProvider(Array.from({ length: 20 }, () => call("click", { ref: "e1" })));

    const result = await runDiscovery({ ...baseOpts(llm), maxSteps: 3 });

    expect(result.status).toBe("aborted");
  }, 30000);

  it("nudges a model that replies without calling a tool rather than treating it as fatal", async () => {
    // Ollama has no equivalent of a forced tool choice, so a turn can come
    // back as prose. The loop nudges and carries on.
    const llm = new ScriptedProvider([
      null,
      call("click", { ref: "e1" }),
      call("finish_success", { summary: "done", outputs: {} }),
    ]);

    const result = await runDiscovery({ ...baseOpts(llm), maxSteps: 5 });

    expect(result.status).toBe("success");
    expect(llm.turns.length).toBeGreaterThan(2); // the nudge really happened
  }, 30000);

  it("reports a model that claims success without doing anything, instead of throwing", async () => {
    // compileArtifact rejects an empty step list, so this used to escape as
    // an unhandled schema error rather than a structured result.
    const llm = new ScriptedProvider([call("finish_success", { summary: "I have completed the task" })]);

    const result = await runDiscovery(baseOpts(llm));

    expect(result.status).toBe("aborted");
  }, 30000);
});
