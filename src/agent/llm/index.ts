import type { LlmProvider } from "./types.js";
import { AnthropicProvider } from "./anthropicProvider.js";
import { OllamaProvider } from "./ollamaProvider.js";

export * from "./types.js";

export function createProvider(opts: { provider?: string; model?: string } = {}): LlmProvider {
  const provider = opts.provider ?? process.env.LLM_PROVIDER ?? (process.env.ANTHROPIC_API_KEY ? "anthropic" : "ollama");

  if (provider === "anthropic") {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY is required for --provider anthropic");
    return new AnthropicProvider({ apiKey, model: opts.model ?? process.env.MODEL ?? "claude-sonnet-5" });
  }
  if (provider === "ollama") {
    return new OllamaProvider({ model: opts.model ?? process.env.MODEL ?? "llama3.1:8b" });
  }
  throw new Error(`unknown LLM provider: ${provider}`);
}
