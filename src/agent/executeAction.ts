import type { ActionType } from "../schema/artifact.js";
import type { Observation } from "../schema/observation.js";
import type { LocatorDescriptor } from "../schema/locator.js";
import type { Surface } from "../surface/types.js";
import { checkActionType, checkNavigation, classifyEffect } from "../safety/policy.js";
import type { DiscoveryStepRecord } from "./types.js";
import type { ToolCall } from "./llm/types.js";
import { newId } from "../util/ids.js";

export type ActionOutcome = {
  ok: boolean;
  error?: string;
  record?: DiscoveryStepRecord;
  observationAfter?: Observation;
};

/**
 * Carries out one tool call the model chose, and turns it into the record
 * that artifact compilation later consumes. Split out of the discovery loop
 * because the two change for different reasons: this file changes when the
 * *action vocabulary* or effect classification changes, the loop changes when
 * the conversation, escalation, or stopping rules do.
 */
export async function executeAction(
  surface: Surface,
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

  // Latched surface signals must be drained exactly once per action, on
  // every path. The navigate branch used to return before draining and a
  // thrown error skipped it entirely, so a dialog raised by one action was
  // reported against the *next* one.
  let drained = false;
  const drainSignals = () => {
    if (drained) return { dialog: undefined, violation: undefined, navigation: undefined };
    drained = true;
    return {
      navigation: surface.takeNavigation(),
      dialog: surface.takeDialog(),
      violation: surface.takePolicyViolation(),
    };
  };

  try {
    let locator: LocatorDescriptor | undefined;
    let literalValue: string | undefined;
    let extractTo: string | undefined;
    let description = "";
    let elementName: string | undefined;
    let formSubmitName: string | undefined;
    let sensitive: boolean | undefined;

    if (action === "navigate") {
      const input = toolUse.input as { url: string };
      const navCheck = checkNavigation(input.url);
      if (!navCheck.allowed) return { ok: false, error: `policy: ${navCheck.reason}` };
      await surface.navigate(input.url);
      literalValue = input.url;
      description = `navigate to ${input.url}`;
    } else {
      const input = toolUse.input as { ref?: string; value?: string; key?: string; outputKey?: string };
      const ref = input.ref;
      if (!ref && action !== "press_key") return { ok: false, error: "missing ref" };
      const el = ref ? beforeObs.elements.find((e) => e.ref === ref) : undefined;
      if (ref && !el) return { ok: false, error: `unknown ref ${ref} (stale observation?)` };

      locator = ref ? surface.resolveElementToLocator(ref) : undefined;
      elementName = el?.name;
      sensitive = el?.sensitive;
      // For a keypress with no element reference, the form that would be
      // submitted is the one containing whatever currently has focus — the
      // only way to name what such a step actually does.
      formSubmitName = el?.formSubmitName ?? (ref ? undefined : await surface.activeFormSubmitName());

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
    }

    const { navigation, dialog, violation } = drainSignals();

    if (dialog) {
      return {
        ok: false,
        error: `unexpected ${dialog.type} dialog appeared and was dismissed: ${JSON.stringify(dialog.message)}`,
      };
    }
    // A click on a link leaving the allowlist is refused at the network
    // layer and raises nothing, so surface it explicitly. Reported back as a
    // failed action, which routes it into the existing consecutive-failure
    // path and, if the agent keeps trying, on to a human.
    if (violation) {
      return { ok: false, error: `policy: blocked navigation to ${violation.url} (${violation.reason})` };
    }

    const { effect } = classifyEffect({ elementName, formSubmitName, requestMethod: navigation?.method });

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
        sensitive,
        extractTo,
        urlBefore,
        urlAfter: afterObs.url,
        pageTextBefore: beforeObs.pageText,
        pageTextAfter: afterObs.pageText,
        effect,
      },
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    // No-op when the action already drained; the point is that a failed or
    // short-circuited action never leaves a signal latched for the next one
    // to be blamed for.
    drainSignals();
  }
}

function paramize(literal: string, params: Record<string, string>): string {
  const name = Object.entries(params).find(([, v]) => v === literal)?.[0];
  return name ? `{{${name}}}` : literal;
}
