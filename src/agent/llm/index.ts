import type { LlmProvider } from "./types.js";
import { OllamaProvider } from "./ollamaProvider.js";

export * from "./types.js";

/**
 * Resolves the model that drives discovery.
 *
 * The system ships with one provider: an open-weight model served locally by
 * Ollama. That is a deliberate choice, not a limitation — discovery is the
 * only place a model is involved at all (replay never calls one), so running
 * it locally means the whole system needs no API key, no account, and makes
 * no network egress, which matters when the surface being driven is a bank's
 * back office.
 *
 * The `LlmProvider` interface is what keeps that from being a lock-in:
 * `discover.ts` only ever calls `provider.step()`, so a hosted provider is a
 * new adapter file plus a branch here, with nothing above it changing.
 * `tests/agentLoop.test.ts` proves the loop runs against an arbitrary
 * implementation of the interface rather than against Ollama specifically.
 */
export function createProvider(opts: { provider?: string; model?: string } = {}): LlmProvider {
  const provider = opts.provider ?? process.env.LLM_PROVIDER ?? "ollama";
  if (provider !== "ollama") {
    throw new Error(
      `unknown LLM provider: ${provider}. This build ships the local Ollama provider only — ` +
        `add an adapter implementing LlmProvider in src/agent/llm/ to support another.`
    );
  }
  return new OllamaProvider({ model: opts.model ?? process.env.MODEL ?? "llama3.1:8b" });
}
