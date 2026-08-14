import type { ArtifactStep } from "../schema/artifact.js";
import type { SurfaceActions, SurfacePerception } from "../surface/types.js";
import { render } from "../util/template.js";
import { resolveValue } from "./params.js";

/**
 * Performs one recorded step against a surface. Deliberately knows nothing
 * about retries, checkpoints, policy, or how a run is reported — those are
 * the orchestrator's concerns, and keeping them out of here is what lets the
 * step vocabulary grow without touching the run loop.
 */
export async function execStep(
  surface: SurfaceActions & SurfacePerception,
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
