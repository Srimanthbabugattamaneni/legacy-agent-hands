/**
 * Provider-agnostic chat/tool-use contract. `src/agent/discover.ts` only
 * talks to this interface, so swapping the model behind the discovery loop
 * is a matter of adding one adapter rather than touching the loop. The
 * shipped implementation runs an open-weight model locally through Ollama,
 * which keeps the system free of API keys and outbound calls; a hosted
 * provider would be another file implementing this same interface.
 */

export type JsonSchema = {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
};

export type ToolSpec = {
  name: string;
  description: string;
  input_schema: JsonSchema;
};

export type ToolCall = {
  id: string;
  name: string;
  input: Record<string, unknown>;
};

export type ChatMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls: ToolCall[] }
  | { role: "tool"; toolCallId: string; toolName: string; content: string; isError?: boolean };

export interface LlmProvider {
  readonly label: string;
  /** Runs one model turn given the full conversation so far and returns the
   * tool call(s) it chose. The agent loop expects exactly one; providers
   * whose models sometimes reply with no tool call at all should return an
   * empty array rather than throwing, so the loop can nudge and retry. */
  step(system: string, messages: ChatMessage[], tools: ToolSpec[]): Promise<{ toolCalls: ToolCall[]; assistantText: string }>;
}
