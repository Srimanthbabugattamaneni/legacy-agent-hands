import type { LlmProvider, ChatMessage, ToolSpec, ToolCall } from "./types.js";

type OllamaChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: { id?: string; function: { name: string; arguments: Record<string, unknown> | string } }[];
};

function toOllamaMessages(system: string, messages: ChatMessage[]): OllamaChatMessage[] {
  const out: OllamaChatMessage[] = [{ role: "system", content: system }];
  for (const m of messages) {
    if (m.role === "user") {
      out.push({ role: "user", content: m.content });
    } else if (m.role === "assistant") {
      out.push({
        role: "assistant",
        content: m.content,
        tool_calls: m.toolCalls.map((tc) => ({ id: tc.id, function: { name: tc.name, arguments: tc.input } })),
      });
    } else {
      out.push({ role: "tool", content: m.content });
    }
  }
  return out;
}

let callCounter = 0;

/**
 * Local, open-weight model via Ollama's native /api/chat tool-calling
 * endpoint (no API key, no external network call — everything runs
 * on-device). Weaker tool-calling reliability than a frontier hosted model
 * is expected and handled one layer up in discover.ts (a bounded nudge/
 * retry when a turn comes back with no tool call at all).
 */
export class OllamaProvider implements LlmProvider {
  readonly label: string;
  constructor(private opts: { model: string; baseUrl?: string }) {
    this.label = `ollama:${opts.model}`;
  }

  async step(system: string, messages: ChatMessage[], tools: ToolSpec[]) {
    const baseUrl = this.opts.baseUrl ?? process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";
    const res = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: this.opts.model,
        stream: false,
        messages: toOllamaMessages(system, messages),
        tools: tools.map((t) => ({
          type: "function",
          function: { name: t.name, description: t.description, parameters: t.input_schema },
        })),
      }),
    });
    if (!res.ok) {
      throw new Error(`Ollama request failed: ${res.status} ${await res.text()}`);
    }
    const data = (await res.json()) as { message?: OllamaChatMessage };
    const rawCalls = data.message?.tool_calls ?? [];
    const toolCalls: ToolCall[] = rawCalls.map((tc) => ({
      id: tc.id ?? `call_${++callCounter}`,
      name: tc.function.name,
      input:
        typeof tc.function.arguments === "string"
          ? (JSON.parse(tc.function.arguments) as Record<string, unknown>)
          : tc.function.arguments,
    }));
    return { toolCalls, assistantText: data.message?.content ?? "" };
  }
}
