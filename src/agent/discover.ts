import path from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { BrowserSurface } from "../surface/browserSurface.js";
import type { NavigationGuard, Surface, SurfacePerception, SurfaceSession } from "../surface/types.js";
import { AGENT_TOOLS } from "./tools.js";
import { buildSystemPrompt, formatObservation } from "./promptBuilder.js";
import { compileArtifact } from "./compileArtifact.js";
import type { DiscoveryStepRecord } from "./types.js";
import type { CapabilityArtifact } from "../schema/artifact.js";
import type { Observation } from "../schema/observation.js";
import { checkNavigation } from "../safety/policy.js";
import { executeAction } from "./executeAction.js";
import { RunLogger, evidenceRoot, artifactsRoot } from "../util/logger.js";
import { newId, slugify } from "../util/ids.js";
import { createEscalation, waitForResolution, recordSessionDelta } from "../escalation/escalate.js";
import { resolveVersion } from "./versioning.js";
import { createProvider } from "./llm/index.js";
import type { ChatMessage, ToolCall, LlmProvider } from "./llm/types.js";

export type DiscoverOptions = {
  goal: string;
  targetUrl: string;
  name: string;
  description?: string;
  appId?: string;
  params: Record<string, string>;
  paramDescriptions?: Record<string, string>;
  outputDescriptions?: Record<string, string>;
  headless?: boolean;
  maxSteps?: number;
  provider?: string;
  model?: string;
  /**
   * Overrides for the two collaborators discovery owns. Both default to the
   * real thing; injecting them lets the loop be driven without a model or a
   * browser, which is how its stopping rules and escalation paths get tested
   * at all (see tests/agentLoop.test.ts).
   */
  llm?: LlmProvider;
  /**
   * Whether getting stuck should summon a human. On by default — that is the
   * point of the escalation path — but it blocks the run until an operator
   * responds or the timeout elapses, so an unattended caller (a batch
   * re-record, CI) needs to be able to say no and just get a failed result.
   */
  escalateWhenStuck?: boolean;
  /**
   * Wall-clock budget for the whole run. The step budget alone does not bound
   * elapsed time — a local model on a slow page can spend minutes per step —
   * and 3.1 lists timeout as a stopping condition in its own right.
   */
  timeoutMs?: number;
  createSurface?: (opts: { headless: boolean; guard: NavigationGuard }) => Promise<Surface>;
};

export type DiscoverResult = {
  status: "success" | "aborted";
  artifact?: CapabilityArtifact;
  artifactPath?: string;
  runDir: string;
};

const MAX_CONSECUTIVE_FAILURES = 3;
const MAX_ESCALATION_CYCLES = 2;
const MAX_NUDGE_ATTEMPTS = 3;
const NUDGE_MESSAGE =
  "You must call exactly one of the provided tools now — choose the single most appropriate one and call it with its required arguments. Do not just describe what you would do.";

export async function runDiscovery(opts: DiscoverOptions): Promise<DiscoverResult> {
  const provider = opts.llm ?? createProvider({ provider: opts.provider, model: opts.model });

  const nav = checkNavigation(opts.targetUrl);
  if (!nav.allowed) throw new Error(`policy blocked starting navigation: ${nav.reason}`);

  const runId = `discover-${slugify(opts.name)}-${Date.now()}`;
  const logger = new RunLogger(evidenceRoot(), runId);
  logger.log("discovery_started", { goal: opts.goal, targetUrl: opts.targetUrl, params: opts.params, provider: provider.label });

  const maxSteps = opts.maxSteps ?? 20;
  const escalateWhenStuck = opts.escalateWhenStuck ?? true;
  const deadline = Date.now() + (opts.timeoutMs ?? Number(process.env.DISCOVERY_TIMEOUT_MS ?? 10 * 60 * 1000));
  const headless = opts.headless ?? process.env.HEADLESS === "true";

  const createSurface = opts.createSurface ?? ((o) => BrowserSurface.create(o));
  const surface = await createSurface({ headless, guard: (url) => checkNavigation(url) });
  const system = buildSystemPrompt(opts.goal, opts.targetUrl);
  const messages: ChatMessage[] = [];
  const stepRecords: DiscoveryStepRecord[] = [];
  let consecutiveFailures = 0;
  let escalationCycles = 0;

  try {
    await surface.navigate(opts.targetUrl);
    let observation = await surface.observe();
    logger.log("observation", { url: observation.url, title: observation.title });

    for (let step = 0; step < maxSteps; step++) {
      if (Date.now() > deadline) {
        logger.log("discovery_aborted", { reason: "timeout", stepsTaken: step });
        await handleEscalation({
          enabled: escalateWhenStuck,
          reason: "discovery_stuck",
          goalOrCapability: opts.goal,
          detail: `wall-clock timeout reached after ${step} steps`,
          surface,
          logger,
        });
        return { status: "aborted", runDir: logger.dir };
      }
      messages.push({ role: "user", content: formatObservation(observation, step, maxSteps) });

      const chosen = await nextToolCall(provider, system, messages, logger);
      const toolUse = chosen?.toolCall;

      if (!toolUse) {
        consecutiveFailures++;
        logger.log("no_tool_use_after_nudges", { consecutiveFailures });
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          const resolved = await handleEscalation({
            enabled: escalateWhenStuck,
            reason: "discovery_stuck",
            goalOrCapability: opts.goal,
            detail: `model did not choose a tool after ${MAX_NUDGE_ATTEMPTS} nudges, ${MAX_CONSECUTIVE_FAILURES} times in a row`,
            surface,
            logger,
          });
          escalationCycles++;
          if (!resolved || escalationCycles > MAX_ESCALATION_CYCLES) {
            logger.log("discovery_aborted", { reason: resolved ? "max_escalations" : "escalation_timeout" });
            return { status: "aborted", runDir: logger.dir };
          }
          consecutiveFailures = 0;
          observation = await surface.observe();
        }
        continue;
      }
      // The rationale is logged alongside the action because evidence has to
      // answer "why", not just "what" — a reviewer debugging a bad recording
      // needs the model's stated reason for the step, not only the step.
      // Redaction still applies: this goes through RunLogger like everything
      // else, so a model that echoes a member's details cannot leak them here.
      logger.log("agent_action", {
        tool: toolUse.name,
        input: toolUse.input,
        rationale:
          // The acting tools carry `reason`; the finishing tools carry their
          // own summary/reason field, so the log reads uniformly either way.
          (toolUse.input as { reason?: string; summary?: string }).reason ||
          (toolUse.input as { summary?: string }).summary ||
          chosen?.rationale ||
          "(model gave no stated reason)",
      });

      if (toolUse.name === "finish_success") {
        const input = toolUse.input as { summary: string; outputs?: Record<string, string | number | boolean> };
        logger.log("discovery_success", { summary: input.summary, outputs: input.outputs ?? {} });

        // A model can declare success having done nothing — and then
        // compilation rejects the empty step list. That is a failed run, not
        // a crash: callers get a structured result, and the reason lands in
        // the evidence log rather than as an unhandled schema error.
        if (stepRecords.length === 0) {
          logger.log("discovery_aborted", {
            reason: "finish_success_without_steps",
            summary: input.summary,
          });
          return { status: "aborted", runDir: logger.dir };
        }

        const artifactId = newId(slugify(opts.name));
        const artifact = compileArtifact({
          id: artifactId,
          name: opts.name,
          description: opts.description ?? input.summary,
          goal: opts.goal,
          appId: opts.appId ?? "mock-bank",
          entryUrl: opts.targetUrl,
          steps: stepRecords,
          paramLiterals: opts.params,
          paramDescriptions: opts.paramDescriptions,
          outputsDeclared: input.outputs ?? {},
          outputDescriptions: opts.outputDescriptions,
        });

        const artifactsDir = artifactsRoot();
        mkdirSync(artifactsDir, { recursive: true });
        const decision = resolveVersion(artifact, artifactsDir);
        if (decision.disposition !== "unchanged") {
          writeFileSync(decision.artifactPath, JSON.stringify(decision.artifact, null, 2));
        }
        // The compiled capability is also written beside its own run log, so
        // /evidence holds a self-contained demonstration — artifact plus the
        // run that produced it — rather than making a reviewer cross-reference
        // /artifacts, where the file will have moved on after a re-record.
        writeFileSync(
          logger.artifactPath("capability.json"),
          JSON.stringify(decision.artifact, null, 2)
        );
        await surface.screenshot(logger.artifactPath("final.png"));
        logger.log("artifact_written", {
          artifactPath: decision.artifactPath,
          version: decision.artifact.version,
          disposition: decision.disposition,
          archivedPath: decision.archivedPath,
        });
        if (decision.disposition === "bumped") {
          console.log(`  previous version archived to ${path.relative(process.cwd(), decision.archivedPath!)}`);
        }

        return {
          status: "success",
          artifact: decision.artifact,
          artifactPath: decision.artifactPath,
          runDir: logger.dir,
        };
      }

      if (toolUse.name === "finish_stuck") {
        const input = toolUse.input as { reason: string };
        const resolved = await handleEscalation({
          enabled: escalateWhenStuck,
          reason: "discovery_stuck",
          goalOrCapability: opts.goal,
          detail: input.reason,
          surface,
          logger,
        });
        messages.push({
          role: "tool",
          toolCallId: toolUse.id,
          toolName: toolUse.name,
          content: resolved
            ? `A human operator intervened. Notes: ${resolved.humanNotes}. Continue toward the goal from the current page state.`
            : "No human operator responded in time. Try a different approach if possible, or call finish_stuck again to give up.",
        });
        escalationCycles++;
        if (!resolved || escalationCycles > MAX_ESCALATION_CYCLES) {
          logger.log("discovery_aborted", { reason: resolved ? "max_escalations" : "escalation_timeout" });
          return { status: "aborted", runDir: logger.dir };
        }
        observation = await surface.observe();
        continue;
      }

      // Regular action tool.
      const actionResult = await executeAction(surface, toolUse, opts.params, observation);
      const toolResultContent = actionResult.ok
        ? "ok"
        : `error: ${actionResult.error}. Consider trying a different ref or approach.`;
      messages.push({
        role: "tool",
        toolCallId: toolUse.id,
        toolName: toolUse.name,
        content: toolResultContent,
        isError: !actionResult.ok,
      });

      if (actionResult.ok && actionResult.record) {
        stepRecords.push(actionResult.record);
        consecutiveFailures = 0;
      } else {
        consecutiveFailures++;
        logger.log("action_failed", { tool: toolUse.name, error: actionResult.error, consecutiveFailures });
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          const resolved = await handleEscalation({
            enabled: escalateWhenStuck,
            reason: "discovery_stuck",
            goalOrCapability: opts.goal,
            detail: `${MAX_CONSECUTIVE_FAILURES} consecutive failed actions; last error: ${actionResult.error}`,
            surface,
            logger,
          });
          escalationCycles++;
          if (!resolved || escalationCycles > MAX_ESCALATION_CYCLES) {
            logger.log("discovery_aborted", { reason: resolved ? "max_escalations" : "escalation_timeout" });
            return { status: "aborted", runDir: logger.dir };
          }
          consecutiveFailures = 0;
        }
      }

      // Reuse the state the action already observed on its way out rather
      // than re-snapshotting the DOM a third time for the same page state.
      observation = actionResult.observationAfter ?? (await surface.observe());
      logger.log("observation", { url: observation.url, title: observation.title });
    }

    logger.log("discovery_aborted", { reason: "max_steps" });
    // Step budget is exhausted either way; still raise the escalation so a
    // human gets visibility and can capture context/notes for a retry.
    await handleEscalation({
      enabled: escalateWhenStuck,
      reason: "discovery_stuck",
      goalOrCapability: opts.goal,
      detail: "max steps reached without a finish_success/finish_stuck call",
      surface,
      logger,
    });
    return { status: "aborted", runDir: logger.dir };
  } finally {
    await surface.close();
  }
}

/** Some tool-calling APIs can force a tool call every turn; a local model
 * served through Ollama offers no such guarantee and sometimes replies with
 * prose instead. Nudge and retry a bounded number of times before treating
 * the turn as a failed action (folded into the same consecutive-failure
 * escalation path as a failed click or fill). */
async function nextToolCall(
  provider: LlmProvider,
  system: string,
  messages: ChatMessage[],
  logger: RunLogger
): Promise<{ toolCall: ToolCall; rationale: string } | undefined> {
  for (let attempt = 0; attempt < MAX_NUDGE_ATTEMPTS; attempt++) {
    const response = await provider.step(system, messages, AGENT_TOOLS);
    messages.push({ role: "assistant", content: response.assistantText, toolCalls: response.toolCalls });
    if (response.toolCalls.length > 0) {
      return { toolCall: response.toolCalls[0]!, rationale: response.assistantText };
    }
    logger.log("no_tool_use", { attempt, assistantText: response.assistantText });
    if (attempt < MAX_NUDGE_ATTEMPTS - 1) {
      messages.push({ role: "user", content: NUDGE_MESSAGE });
    }
  }
  return undefined;
}

async function handleEscalation(input: {
  enabled: boolean;
  reason: "discovery_stuck";
  goalOrCapability: string;
  detail: string;
  surface: SurfaceSession & SurfacePerception;
  logger: RunLogger;
}) {
  if (!input.enabled) {
    input.logger.log("escalation_skipped", { detail: input.detail });
    return undefined;
  }
  const screenshotPath = input.logger.artifactPath(`escalation-${Date.now()}.png`);
  await input.surface.screenshot(screenshotPath).catch(() => {});
  const req = createEscalation({
    reason: input.reason,
    goalOrCapability: input.goalOrCapability,
    currentStepDescription: input.surface.currentUrl(),
    detail: input.detail,
    screenshotPath,
  });
  input.logger.log("escalation_raised", { escalationId: req.id, detail: input.detail });
  console.log(`\n[ESCALATION ${req.id}] ${input.detail}`);
  console.log(`  A live, non-headless browser window is open for this run — you can operate it directly.`);
  console.log(`  Run \`npm run operator\` and open http://localhost:4100/escalations/${req.id} for context, then submit Resume.\n`);
  const before = { url: input.surface.currentUrl(), title: (await input.surface.observe()).title };
  const resolved = await waitForResolution(req.id);
  if (resolved) {
    recordSessionDelta(req.id, before, {
      url: input.surface.currentUrl(),
      title: (await input.surface.observe()).title,
    });
  }
  if (resolved) input.logger.log("escalation_resolved", { escalationId: req.id, humanNotes: resolved.humanNotes });
  else input.logger.log("escalation_timeout", { escalationId: req.id });
  return resolved;
}


