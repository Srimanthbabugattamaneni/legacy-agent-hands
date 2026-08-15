import path from "node:path";
import type { CapabilityArtifact, ArtifactStep } from "../schema/artifact.js";
import type { ReplayResult, ErrorClass } from "../schema/result.js";
import { BrowserSurface } from "../surface/browserSurface.js";
import { checkActionType, checkNavigation, checkStepAuthorization } from "../safety/policy.js";
import { loadBusinessOutcomes, matchBusinessOutcome } from "./businessOutcomes.js";
import { render } from "../util/template.js";
import { coerceParams } from "./params.js";
import { execStep } from "./executor.js";
import { verifyCheckpoint } from "./checkpoint.js";
import { RunLogger, evidenceRoot } from "../util/logger.js";
import { slugify } from "../util/ids.js";
import { createEscalation, waitForResolution, recordSessionDelta } from "../escalation/escalate.js";
import { ElementNotFoundError, PolicyViolationError } from "../surface/types.js";
import type {
  NavigationGuard,
  Surface,
  SurfacePerception,
  SurfaceSession,
} from "../surface/types.js";

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
  /**
   * How to obtain the surface. Defaults to a real browser; overridable so the
   * engine can be driven against any Surface implementation. This is what
   * makes the seam in §4 real rather than asserted — the replay engine has no
   * compile-time dependency on the browser beyond this default.
   */
  createSurface?: (opts: { headless: boolean; guard: NavigationGuard }) => Promise<Surface>;
};



export async function replay(opts: ReplayOptions): Promise<ReplayResult> {
  const { artifact } = opts;
  const params = coerceParams(artifact, opts.params);
  const runId = `replay-${slugify(artifact.name)}-${Date.now()}`;
  const logger = new RunLogger(evidenceRoot(), runId);
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
  // The guard enforces the allowlist at the network layer for the whole
  // session, covering navigations this loop never initiates (clicks, form
  // submits, redirects) as well as the ones it does.
  const createSurface = opts.createSurface ?? ((o) => BrowserSurface.create(o));
  const surface = await createSurface({ headless, guard: (url) => checkNavigation(url) });
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

      const riskyCheck = checkStepAuthorization(step.effect, { allowRisky: opts.allowRisky ?? false });
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
          expected: `step authorized for effect "${step.effect}"`,
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

      // Drained before any business-outcome matching, deliberately. A blocked
      // click leaves the page exactly where it was, so a policy violation on
      // e.g. the session-expired page would otherwise be reported as the
      // "session_timeout" business outcome and the guardrail breach would
      // never surface. A refused navigation is never a business result.
      const violation = surface.takePolicyViolation();
      if (violation) {
        logger.log("policy_blocked", { stepId: step.id, url: violation.url, reason: violation.reason });
        return finish({
          ...base,
          status: "failure",
          errorClass: "policy_blocked",
          stepId: step.id,
          expected: "navigation stays within the allowlist",
          observed: `blocked navigation to ${violation.url} (${violation.reason})`,
          finishedAt: new Date().toISOString(),
        });
      }

      // Also drained before business-outcome matching: the dialog was
      // dismissed to keep the run from hanging, so the page underneath may
      // look perfectly ordinary. A flow that raised a dialog the recording
      // never saw has diverged, and continuing would be acting on a guess.
      const dialog = surface.takeDialog();
      if (dialog) {
        logger.log("unexpected_dialog", { stepId: step.id, type: dialog.type, message: dialog.message });
        return finish({
          ...base,
          status: "failure",
          errorClass: "unexpected_dialog",
          stepId: step.id,
          expected: "no native dialog (the recorded run raised none here)",
          observed: `${dialog.type} dialog: ${dialog.message}`,
          finishedAt: new Date().toISOString(),
        });
      }

      if (outcome.status === "hard_failure") {
        // A guardrail refusal is never a business result, so it must not be
        // reclassified as one. This matters for the *thrown* path (a navigate
        // step's pre-check raises rather than latching a violation): the page
        // is still whatever it was, so a session-expired or access-denied
        // page underneath would otherwise swallow the breach — the same
        // masking already guarded against for latched violations above.
        const maskable = outcome.errorClass !== "policy_blocked" && outcome.errorClass !== "unexpected_dialog";
        const pageText = (await surface.observe()).pageText;
        const bo = maskable ? matchBusinessOutcome(pageText, outcomeRules) : undefined;
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
    surface: SurfaceSession & SurfacePerception;
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
    const before = { url: input.surface.currentUrl(), title: (await input.surface.observe()).title };
    const resolved = await waitForResolution(req.id);
    if (resolved) {
      recordSessionDelta(req.id, before, {
        url: input.surface.currentUrl(),
        title: (await input.surface.observe()).title,
      });
    }
    return resolved;
  }

  async function runStepWithRetry(
    surface: Surface,
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

    // Read-and-clear, so this reflects only what *this* step caused. The
    // previous sticky accessor let a step that never navigated (a fill, a
    // select) inherit an earlier 5xx and trigger the reload below in the
    // middle of a form, discarding everything already typed.
    const status = surface.takeNavigation()?.status;
    // Only a `read` step is safe to recover by reloading: reloading a page
    // that a POST produced re-submits that POST, which is exactly the
    // double-application hazard the retry is supposed to avoid. This used to
    // key on `risky`, which let merely state-changing steps be reloaded.
    if (status && status >= 500 && step.effect === "read") {
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
      const retryStatus = surface.takeNavigation()?.status;
      if (retryStatus && retryStatus >= 500) {
        return { status: "hard_failure", errorClass: "transient_load_failure", error: `HTTP ${retryStatus} persisted after retry` };
      }
    } else if (status && status >= 500) {
      return {
        status: "hard_failure",
        errorClass: "transient_load_failure",
        error: `HTTP ${status} on a ${step.effect} step (not auto-retried)`,
      };
    }

    return { status: "ok" };
  }

  function classify(err: unknown): { status: "hard_failure"; errorClass: ErrorClass; error: string } {
    if (err instanceof PolicyViolationError) {
      // A navigate step whose URL is outside the allowlist — the case a
      // tampered or mis-recorded artifact produces.
      return { status: "hard_failure", errorClass: "policy_blocked", error: err.message };
    }
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


