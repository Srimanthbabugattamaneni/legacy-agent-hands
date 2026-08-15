import type { ArtifactStep } from "../schema/artifact.js";
import type { SurfaceActions, SurfacePerception } from "../surface/types.js";
import { render } from "../util/template.js";

export type CheckpointResult = { pass: boolean; expected: string; observed: string };

/**
 * Asserts that the surface actually reached the state a step claimed to
 * produce — the difference between "the click returned" and "the click
 * worked".
 */
export async function verifyCheckpoint(
  surface: SurfacePerception & SurfaceActions,
  checkpoint: NonNullable<ArtifactStep["checkpoint"]>,
  params: Record<string, string>
): Promise<CheckpointResult> {
  // Every condition present is checked and they must all hold. Returning on
  // the first one present meant a checkpoint carrying both urlContains and
  // textContains — which the schema allows — silently verified only the URL,
  // so it asserted less than it claimed to.
  const checks: { pass: boolean; expected: string; observed: string }[] = [];

  if (checkpoint.urlContains) {
    const expected = render(checkpoint.urlContains, params);
    const observed = surface.currentUrl();
    checks.push({ pass: observed.includes(expected), expected: `URL contains "${expected}"`, observed });
  }
  if (checkpoint.textContains) {
    const expected = render(checkpoint.textContains, params);
    const observation = await surface.observe();
    checks.push({
      pass: observation.pageText.includes(expected),
      expected: `page text contains "${expected}"`,
      observed: observation.pageText.slice(0, 200),
    });
  }
  if (checkpoint.locatorVisible) {
    try {
      await surface.waitFor(checkpoint.locatorVisible, 3000);
      checks.push({ pass: true, expected: "locator visible", observed: "visible" });
    } catch {
      checks.push({ pass: false, expected: "locator visible", observed: "not found" });
    }
  }

  if (checks.length === 0) return { pass: true, expected: "(no assertion)", observed: "(no assertion)" };
  // Report the first failure so the error names the condition that broke.
  return checks.find((c) => !c.pass) ?? { pass: true, expected: checks.map((c) => c.expected).join(" AND "), observed: "all conditions held" };
}
