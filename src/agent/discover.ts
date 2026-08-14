import path from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { BrowserSurface } from "../surface/browserSurface.js";
import { AGENT_TOOLS } from "./tools.js";
import { buildSystemPrompt, formatObservation } from "./promptBuilder.js";
import { compileArtifact } from "./compileArtifact.js";
import type { DiscoveryStepRecord } from "./types.js";
import type { CapabilityArtifact } from "../schema/artifact.js";
import type { ActionType } from "../schema/artifact.js";
import type { Observation } from "../schema/observation.js";
import { checkActionType, checkNavigation, classifyRisk } from "../safety/policy.js";
import { RunLogger } from "../util/logger.js";
import { newId, slugify } from "../util/ids.js";
import { createEscalation, waitForResolution } from "../escalation/escalate.js";
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
  const provider = createProvider({ provider: opts.provider, model: opts.model });

  const nav = checkNavigation(opts.targetUrl);
  if (!nav.allowed) throw new Error(`policy blocked starting navigation: ${nav.reason}`);

  const runId = `discover-${slugify(opts.name)}-${Date.now()}`;
  const logger = new RunLogger(path.join(process.cwd(), "evidence"), runId);
  logger.log("discovery_started", { goal: opts.goal, targetUrl: opts.targetUrl, params: opts.params, provider: provider.label });

  const maxSteps = opts.maxSteps ?? 20;
  const headless = opts.headless ?? process.env.HEADLESS === "true";

  const surface = await BrowserSurface.create({ headless, guard: (url) => checkNavigation(url) });
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
      messages.push({ role: "user", content: formatObservation(observation, step, maxSteps) });

      const toolUse = await nextToolCall(provider, system, messages, logger);

      if (!toolUse) {
        consecutiveFailures++;
        logger.log("no_tool_use_after_nudges", { consecutiveFailures });
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          const resolved = await handleEscalation({
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
      logger.log("agent_action", { tool: toolUse.name, input: toolUse.input });

      if (toolUse.name === "finish_success") {
        const input = toolUse.input as { summary: string; outputs?: Record<string, string | number | boolean> };
        logger.log("discovery_success", { summary: input.summary, outputs: input.outputs ?? {} });

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

        const artifactsDir = path.join(process.cwd(), "artifacts");
        mkdirSync(artifactsDir, { recursive: true });
        const decision = resolveVersion(artifact, artifactsDir);
        if (decision.disposition !== "unchanged") {
          writeFileSync(decision.artifactPath, JSON.stringify(decision.artifact, null, 2));
        }
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

/** Anthropic's tool_choice:"any" forces a tool call every turn; open models
 * served via Ollama have no equivalent hard guarantee and sometimes reply
 * with plain text instead. Nudge and retry a bounded number of times before
 * treating the turn as a failed action (folded into the same
 * consecutive-failure escalation path as a failed click/fill). */
async function nextToolCall(
  provider: LlmProvider,
  system: string,
  messages: ChatMessage[],
  logger: RunLogger
): Promise<ToolCall | undefined> {
  for (let attempt = 0; attempt < MAX_NUDGE_ATTEMPTS; attempt++) {
    const response = await provider.step(system, messages, AGENT_TOOLS);
    messages.push({ role: "assistant", content: response.assistantText, toolCalls: response.toolCalls });
    if (response.toolCalls.length > 0) return response.toolCalls[0];
    logger.log("no_tool_use", { attempt, assistantText: response.assistantText });
    if (attempt < MAX_NUDGE_ATTEMPTS - 1) {
      messages.push({ role: "user", content: NUDGE_MESSAGE });
    }
  }
  return undefined;
}

async function handleEscalation(input: {
  reason: "discovery_stuck";
  goalOrCapability: string;
  detail: string;
  surface: BrowserSurface;
  logger: RunLogger;
}) {
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
  const resolved = await waitForResolution(req.id);
  if (resolved) input.logger.log("escalation_resolved", { escalationId: req.id, humanNotes: resolved.humanNotes });
  else input.logger.log("escalation_timeout", { escalationId: req.id });
  return resolved;
}

async function executeAction(
  surface: BrowserSurface,
  toolUse: ToolCall,
  params: Record<string, string>,
  beforeObs: Observation
): Promise<{ ok: boolean; error?: string; record?: DiscoveryStepRecord; observationAfter?: Observation }> {
  const actionTypeMap: Record<string, ActionType> = {
    navigate: "navigate",
    click: "click",
    fill: "fill",
    select: "select",
    press_key: "press_key",
    extract: "extract",
  };
  const action = actionTypeMap[toolUse.name];
  if (!action) return { ok: false, error: `unknown tool ${toolUse.name}` };

  const policyCheck = checkActionType(action);
  if (!policyCheck.allowed) return { ok: false, error: `policy: ${policyCheck.reason}` };

  // `beforeObs` is exactly the observation already shown to the model this
  // turn (not a fresh re-snapshot) — refs it chose are guaranteed to
  // resolve against the same element mapping it actually saw, and
  // Surface.resolveElementToLocator() reads the locator metadata that
  // observation call already cached, so no extra DOM snapshot is needed
  // just to act.
  const urlBefore = beforeObs.url;

  try {
    if (action === "navigate") {
      const input = toolUse.input as { url: string };
      const navCheck = checkNavigation(input.url);
      if (!navCheck.allowed) return { ok: false, error: `policy: ${navCheck.reason}` };
      await surface.navigate(input.url);
      const afterObs = await surface.observe();
      return {
        ok: true,
        observationAfter: afterObs,
        record: {
          id: newId("step"),
          action,
          description: `navigate to ${input.url}`,
          literalValue: input.url,
          urlBefore,
          urlAfter: afterObs.url,
          pageTextBefore: beforeObs.pageText,
          pageTextAfter: afterObs.pageText,
          risky: false,
        },
      };
    }

    const input = toolUse.input as { ref?: string; value?: string; key?: string; outputKey?: string };
    const ref = input.ref;
    if (!ref && action !== "press_key") return { ok: false, error: "missing ref" };
    const el = ref ? beforeObs.elements.find((e) => e.ref === ref) : undefined;
    if (ref && !el) return { ok: false, error: `unknown ref ${ref} (stale observation?)` };

    const locator = ref ? surface.resolveElementToLocator(ref) : undefined;
    let literalValue: string | undefined;
    let extractTo: string | undefined;
    let description = "";

    if (action === "click") {
      await surface.click(locator!);
      description = `click ${el?.role} "${el?.name}"`;
    } else if (action === "fill") {
      literalValue = input.value ?? "";
      await surface.fill(locator!, literalValue);
      description = `fill ${el?.role} "${el?.name}" with ${JSON.stringify(paramize(literalValue, params))}`;
    } else if (action === "select") {
      literalValue = input.value ?? "";
      await surface.select(locator!, literalValue);
      description = `select "${literalValue}" in ${el?.role} "${el?.name}"`;
    } else if (action === "press_key") {
      await surface.pressKey(locator, input.key ?? "Enter");
      description = `press ${input.key}`;
    } else if (action === "extract") {
      extractTo = input.outputKey ?? "value";
      const text = await surface.extractText(locator!);
      description = `extract "${extractTo}" from ${el?.role} "${el?.name}" -> ${JSON.stringify(text)}`;
    }

    // Classified from what the step actually did, not only what the control
    // was called — pressing Enter in a form field submits it while the name
    // available here is the input's, not the submit button's.
    const navigation = surface.takeNavigation();
    const risk = classifyRisk({ elementName: el?.name, requestMethod: navigation?.method });
    const risky = risk.risky;

    const dialog = surface.takeDialog();
    if (dialog) {
      return {
        ok: false,
        error: `unexpected ${dialog.type} dialog appeared and was dismissed: ${JSON.stringify(dialog.message)}`,
      };
    }

    // A click on a link leaving the allowlist is refused at the network
    // layer and raises nothing, so drain it explicitly. Reported back as a
    // failed action, which routes it into the existing consecutive-failure
    // path and, if the agent keeps trying, on to a human.
    const violation = surface.takePolicyViolation();
    if (violation) {
      return { ok: false, error: `policy: blocked navigation to ${violation.url} (${violation.reason})` };
    }

    const afterObs = await surface.observe();
    return {
      ok: true,
      observationAfter: afterObs,
      record: {
        id: newId("step"),
        action,
        description,
        locator,
        literalValue,
        sensitive: el?.sensitive,
        extractTo,
        urlBefore,
        urlAfter: afterObs.url,
        pageTextBefore: beforeObs.pageText,
        pageTextAfter: afterObs.pageText,
        risky,
      },
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function paramize(literal: string, params: Record<string, string>): string {
  const name = Object.entries(params).find(([, v]) => v === literal)?.[0];
  return name ? `{{${name}}}` : literal;
}
