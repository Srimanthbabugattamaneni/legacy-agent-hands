import type { ToolSpec } from "./llm/types.js";

/**
 * The agent's action vocabulary. Every acting tool takes a `reason`, because
 * evidence must answer *why* a step was taken and not only what it was: a
 * tool-calling model returns no prose alongside a call, so requesting the
 * rationale as part of the call is the only way to capture it.
 * Deliberately structured (act on a `ref`
 * from the latest observation) rather than screenshot+coordinates — this is
 * the "bias toward an approach that would still work with no clean DOM"
 * call from spec 3.1: ref-based actions still work when the surface is a
 * table-laid-out legacy page, because refs come from the accessibility
 * role/name computation, not from visual layout.
 */
export const AGENT_TOOLS: ToolSpec[] = [
  {
    name: "navigate",
    description: "Navigate the browser to an absolute URL.",
    input_schema: {
      type: "object",
      properties: {
        reason: { type: "string", description: "One short sentence: why this step advances the goal." },
        url: { type: "string" },
      },
      required: ["url", "reason"],
    },
  },
  {
    name: "click",
    description: "Click the element with the given ref from the most recent observation.",
    input_schema: {
      type: "object",
      properties: {
        reason: { type: "string", description: "One short sentence: why this step advances the goal." },
        ref: { type: "string" },
      },
      required: ["ref", "reason"],
    },
  },
  {
    name: "fill",
    description: "Type a value into the text input/textarea with the given ref, replacing its current content.",
    input_schema: {
      type: "object",
      properties: {
        reason: { type: "string", description: "One short sentence: why this step advances the goal." },
        ref: { type: "string" },
        value: { type: "string" },
      },
      required: ["ref", "value", "reason"],
    },
  },
  {
    name: "select",
    description: "Choose an option (by its value or visible text) in the <select> with the given ref.",
    input_schema: {
      type: "object",
      properties: {
        reason: { type: "string", description: "One short sentence: why this step advances the goal." },
        ref: { type: "string" },
        value: { type: "string" },
      },
      required: ["ref", "value", "reason"],
    },
  },
  {
    name: "press_key",
    description: "Press a keyboard key (e.g. 'Enter'), optionally scoped to a specific ref.",
    input_schema: {
      type: "object",
      properties: {
        reason: { type: "string", description: "One short sentence: why this step advances the goal." },
        ref: { type: "string" },
        key: { type: "string" },
      },
      required: ["key", "reason"],
    },
  },
  {
    name: "extract",
    description:
      "Read the current text/value of the element with the given ref and record it under outputKey as a named result the capability will return to its caller.",
    input_schema: {
      type: "object",
      properties: {
        reason: { type: "string", description: "One short sentence: why this step advances the goal." },
        ref: { type: "string" },
        outputKey: { type: "string" },
      },
      required: ["ref", "outputKey", "reason"],
    },
  },
  {
    name: "finish_success",
    description:
      "Call this once the goal has been verifiably achieved based on what is currently visible on the page. Include every value you extracted as outputs.",
    input_schema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "One sentence describing what was accomplished." },
        outputs: {
          type: "object",
          description: "Key/value pairs of results the capability should return to its caller.",
          additionalProperties: { type: ["string", "number", "boolean"] },
        },
      },
      required: ["summary"],
    },
  },
  {
    name: "finish_stuck",
    description:
      "Call this if you cannot safely or reliably make further progress toward the goal (e.g. an unexpected page state, a dead end, or an action that seems risky/irreversible and you are unsure it's authorized). This raises a request for a human operator.",
    input_schema: {
      type: "object",
      properties: { reason: { type: "string" } },
      required: ["reason"],
    },
  },
];
