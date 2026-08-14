import path from "node:path";
import type { CapabilityArtifact, ArtifactStep } from "../schema/artifact.js";
import type { ReplayResult, ErrorClass } from "../schema/result.js";
import { BrowserSurface } from "../surface/browserSurface.js";
import { checkActionType, checkNavigation, checkRiskyStep } from "../safety/policy.js";
import { loadBusinessOutcomes, matchBusinessOutcome } from "./businessOutcomes.js";
import { render } from "../util/template.js";
import { RunLogger } from "../util/logger.js";
import { slugify } from "../util/ids.js";
import { createEscalation, waitForResolution } from "../escalation/escalate.js";
import { ElementNotFoundError } from "../surface/types.js";

export type ReplayOptions = {
  artifact: CapabilityArtifact;
  params: Record<string, string | number | boolean>;
  headless?: boolean;
  /** Explicit caller authorization to execute steps recorded as risky. */
  allowRisky?: boolean;
  /** If a risky step is blocked, raise a human escalation instead of just failing. */
  escalateOnRisky?: boolean;
  /** If a hard failure occurs, raise a human escalation instead of just failing. */
  escalateOnHardFailure?: boolean;
};

function coerceParams(artifact: CapabilityArtifact, supplied: Record<string, string | number | boolean>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const input of artifact.inputs) {
    const value = supplied[input.name];
    if (value === undefined || value === null || value === "") {
      if (input.required) throw new Error(`missing required input parameter: ${input.name}`);
      continue;
    }
    out[input.name] = String(value);
  }
  return out;
}

function resolveValue(ref: { kind: "literal"; value: string } | { kind: "param"; name: string }, params: Record<string, string>): string {
  return ref.kind === "literal" ? ref.value : params[ref.name] ?? "";
}

export async function replay(opts: ReplayOptions): Promise<ReplayResult> {
  const { artifact } = opts;
  const params = coerceParams(artifact, opts.params);
  const runId = `replay-${slugify(artifact.name)}-${Date.now()}`;
  const logger = new RunLogger(path.join(process.cwd(), "evidence"), runId);
  const startedAt = new Date().toISOString();
  logger.log("replay_started", { artifactId: artifact.id, version: artifact.version, params: opts.params });

  const base = {
    artifactId: artifact.id,
    artifactVersion: artifact.version,
    startedAt,
    evidenceDir: logger.dir,
  };

  const entryUrl = render(artifact.target.entryUrl, params);
  const navCheck = checkNavigation(entryUrl);
  if (!navCheck.allowed) {
    return finish({ ...base, status: "failure", errorClass: "policy_blocked", stepId: "entry", expected: "allowlisted entry URL", observed: navCheck.reason, finishedAt: new Date().toISOString() });
  }

  const headless = opts.headless ?? true;
  const surface = await BrowserSurface.create({ headless });
  const outcomeRules = loadBusinessOutcomes(artifact.target.appId);
  const outputs: Record<string, string | number | boolean> = {};

  function finish(result: ReplayResult): ReplayResult {
    logger.log("replay_finished", { result });
    return result;
  }

  try {
    await surface.navigate(entryUrl);

    for (const step of artifact.steps) {
      logger.log("step_started", { stepId: step.id, action: step.action, description: step.description });

      const riskyCheck = checkRiskyStep(step.risky, opts.allowRisky ?? false);
      if (!riskyCheck.allowed) {
        if (opts.escalateOnRisky) {
          const resolution = await raiseEscalation({
            reason: "risky_action_needs_confirmation",
            goalOrCapability: `${artifact.name} v${artifact.version}`,
            currentStepDescription: step.description,
            detail: riskyCheck.reason,
            surface,
            logger,
          });
          if (resolution) {
            return finish({
              ...base,
              status: "escalated",
              escalationId: resolution.id,
              stepId: step.id,
              reason: riskyCheck.reason,
              resolution: resolution.humanNotes,
              finishedAt: new Date().toISOString(),
            });
          }
        }
        return finish({
          ...base,
          status: "failure",
          errorClass: "policy_blocked",
          stepId: step.id,
          expected: "risky step authorized via allowRisky",
          observed: "not authorized",
          finishedAt: new Date().toISOString(),
        });
      }

      const actionCheck = checkActionType(step.action);
      if (!actionCheck.allowed) {
        return finish({
          ...base,
          status: "failure",
          errorClass: "policy_blocked",
          stepId: step.id,
          expected: "allowlisted action type",
          observed: actionCheck.reason,
          finishedAt: new Date().toISOString(),
        });
      }

      const outcome = await runStepWithRetry(surface, step, params, outputs);

      if (outcome.status === "hard_failure") {
        const pageText = (await surface.observe()).pageText;
        const bo = matchBusinessOutcome(pageText, outcomeRules);
        if (bo) {
          logger.log("business_outcome", { outcome: bo.outcome, stepId: step.id });
          return finish({ ...base, status: "business_outcome", outcome: bo.outcome, detail: bo.detail, stepId: step.id, finishedAt: new Date().toISOString() });
        }
        logger.log("step_failed", { stepId: step.id, errorClass: outcome.errorClass, error: outcome.error });
        if (opts.escalateOnHardFailure) {
          const resolution = await raiseEscalation({
            reason: "replay_unrecoverable",
            goalOrCapability: `${artifact.name} v${artifact.version}`,
            currentStepDescription: step.description,
            detail: `${outcome.errorClass}: ${outcome.error}`,
            surface,
            logger,
          });
          if (resolution) {
            return finish({ ...base, status: "escalated", escalationId: resolution.id, stepId: step.id, reason: outcome.error, resolution: resolution.humanNotes, finishedAt: new Date().toISOString() });
          }
        }
        return finish({
          ...base,
          status: "failure",
          errorClass: outcome.errorClass,
          stepId: step.id,
          expected: step.description,
          observed: outcome.error,
          finishedAt: new Date().toISOString(),
        });
      }

      // business outcome check even on a "successful" step action (e.g. a
      // validation error rendered on the same page, no exception thrown)
      const pageText = (await surface.observe()).pageText;
      const bo = matchBusinessOutcome(pageText, outcomeRules);
      if (bo) {
        logger.log("business_outcome", { outcome: bo.outcome, stepId: step.id });
        return finish({ ...base, status: "business_outcome", outcome: bo.outcome, detail: bo.detail, stepId: step.id, finishedAt: new Date().toISOString() });
      }

      if (step.checkpoint) {
        const ok = await verifyCheckpoint(surface, step.checkpoint, params);
        if (!ok.pass) {
          logger.log("checkpoint_failed", { stepId: step.id, expected: ok.expected, observed: ok.observed });
          if (opts.escalateOnHardFailure) {
            const resolution = await raiseEscalation({
              reason: "replay_unrecoverable",
              goalOrCapability: `${artifact.name} v${artifact.version}`,
              currentStepDescription: step.description,
              detail: `checkpoint failed: expected ${ok.expected}, observed ${ok.observed}`,
              surface,
              logger,
            });
            if (resolution) {
              return finish({ ...base, status: "escalated", escalationId: resolution.id, stepId: step.id, reason: "checkpoint_failed", resolution: resolution.humanNotes, finishedAt: new Date().toISOString() });
            }
          }
          return finish({
            ...base,
            status: "failure",
            errorClass: "checkpoint_failed",
            stepId: step.id,
            expected: ok.expected,
            observed: ok.observed,
            finishedAt: new Date().toISOString(),
          });
        }
      }

      logger.log("step_succeeded", { stepId: step.id });
    }

    const finalCheck = await verifyCheckpoint(surface, artifact.successCheckpoint, params);
    if (!finalCheck.pass) {
      return finish({
        ...base,
        status: "failure",
        errorClass: "checkpoint_failed",
        stepId: "success_checkpoint",
        expected: finalCheck.expected,
        observed: finalCheck.observed,
        finishedAt: new Date().toISOString(),
      });
    }

    await surface.screenshot(logger.artifactPath("final.png")).catch(() => {});
    return finish({ ...base, status: "success", outputs, finishedAt: new Date().toISOString() });
  } finally {
    await surface.close();
  }

  async function raiseEscalation(input: {
    reason: "risky_action_needs_confirmation" | "replay_unrecoverable";
    goalOrCapability: string;
    currentStepDescription: string;
    detail: string;
    surface: BrowserSurface;
    logger: RunLogger;
  }) {
    const screenshotPath = input.logger.artifactPath(`escalation-${Date.now()}.png`);
    await input.surface.screenshot(screenshotPath).catch(() => {});
    const req = createEscalation({
      reason: input.reason,
      goalOrCapability: input.goalOrCapability,
      currentStepDescription: input.currentStepDescription,
      detail: input.detail,
      screenshotPath,
    });
    input.logger.log("escalation_raised", { escalationId: req.id, detail: input.detail });
    console.log(`\n[ESCALATION ${req.id}] ${input.detail}`);
    console.log(`  A live browser window is open for this replay run — operate it directly if needed.`);
    console.log(`  Run \`npm run operator\` and open http://localhost:4100/escalations/${req.id}\n`);
    return waitForResolution(req.id);
  }

  async function runStepWithRetry(
    surface: BrowserSurface,
    step: ArtifactStep,
    params: Record<string, string>,
    outputs: Record<string, string | number | boolean>
  ): Promise<{ status: "ok" } | { status: "hard_failure"; errorClass: ErrorClass; error: string }> {
    const attempt = () => execStep(surface, step, params, outputs);
    try {
      await attempt();
    } catch (err) {
      return classify(err);
    }

    const status = surface.lastResponseStatus();
    if (status && status >= 500 && !step.risky) {
      logger.log("transient_retry", { stepId: step.id, status });
      await new Promise((r) => setTimeout(r, 500));
      // Retry by reloading the page the action already landed on, not by
      // re-running the action itself — the action (e.g. a form submit)
      // already happened; what failed transiently was loading its result,
      // and re-submitting a form on retry could resubmit stale/lost state
      // (as it did here: retrying the click re-submitted an empty form).
      try {
        await surface.navigate(surface.currentUrl());
      } catch (err) {
        return classify(err);
      }
      const retryStatus = surface.lastResponseStatus();
      if (retryStatus && retryStatus >= 500) {
        return { status: "hard_failure", errorClass: "transient_load_failure", error: `HTTP ${retryStatus} persisted after retry` };
      }
    } else if (status && status >= 500 && step.risky) {
      return { status: "hard_failure", errorClass: "transient_load_failure", error: `HTTP ${status} on a risky step (not auto-retried)` };
    }

    return { status: "ok" };
  }

  function classify(err: unknown): { status: "hard_failure"; errorClass: ErrorClass; error: string } {
    if (err instanceof ElementNotFoundError) {
      return { status: "hard_failure", errorClass: "element_not_found", error: err.message };
    }
    const message = err instanceof Error ? err.message : String(err);
    if (/timeout/i.test(message)) {
      return { status: "hard_failure", errorClass: "transient_load_failure", error: message };
    }
    return { status: "hard_failure", errorClass: "unknown", error: message };
  }
}

async function execStep(
  surface: BrowserSurface,
  step: ArtifactStep,
  params: Record<string, string>,
  outputs: Record<string, string | number | boolean>
): Promise<void> {
  switch (step.action) {
    case "navigate": {
      const url = render(step.url ? resolveValue(step.url, params) : "", params);
      await surface.navigate(url);
      return;
    }
    case "click":
      await surface.click(step.locator!);
      return;
    case "fill":
      await surface.fill(step.locator!, resolveValue(step.value!, params));
      return;
    case "select":
      await surface.select(step.locator!, resolveValue(step.value!, params));
      return;
    case "check":
      await surface.check(step.locator!, resolveValue(step.value!, params) === "true");
      return;
    case "press_key":
      await surface.pressKey(step.locator, resolveValue(step.value!, params));
      return;
    case "wait_for":
      await surface.waitFor(step.locator!);
      return;
    case "extract": {
      const text = await surface.extractText(step.locator!);
      if (step.extractTo) outputs[step.extractTo] = text;
      return;
    }
  }
}

async function verifyCheckpoint(
  surface: BrowserSurface,
  checkpoint: NonNullable<ArtifactStep["checkpoint"]>,
  params: Record<string, string>
): Promise<{ pass: boolean; expected: string; observed: string }> {
  if (checkpoint.urlContains) {
    const expected = render(checkpoint.urlContains, params);
    const observed = surface.currentUrl();
    return { pass: observed.includes(expected), expected: `URL contains "${expected}"`, observed };
  }
  if (checkpoint.textContains) {
    const expected = render(checkpoint.textContains, params);
    const observation = await surface.observe();
    return {
      pass: observation.pageText.includes(expected),
      expected: `page text contains "${expected}"`,
      observed: observation.pageText.slice(0, 200),
    };
  }
  if (checkpoint.locatorVisible) {
    try {
      await surface.waitFor(checkpoint.locatorVisible, 3000);
      return { pass: true, expected: "locator visible", observed: "visible" };
    } catch {
      return { pass: false, expected: "locator visible", observed: "not found" };
    }
  }
  return { pass: true, expected: "(no assertion)", observed: "(no assertion)" };
}
