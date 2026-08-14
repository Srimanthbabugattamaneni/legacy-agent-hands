import type { LocatorDescriptor } from "../schema/locator.js";
import type { Observation } from "../schema/observation.js";

/**
 * The seam between "how we perceive/act on a surface" and "the recorded
 * flow" (spec 3.7). Everything above this interface — the discovery agent,
 * the replay engine, artifact compilation — is surface-agnostic. Today the
 * only implementation is BrowserSurface (Playwright/DOM). A legacy
 * frameset/table app is still a Surface (same interface, a fussier
 * observe() and locator strategy set favoring `text`/`css` over `role`). A
 * native desktop app would implement the same interface against the OS
 * accessibility API (UIAutomation/AXAPI) instead of a DOM — `role`/`name`
 * carry over almost unchanged since desktop accessibility trees use the
 * same concepts; `css` would be replaced by a control-index-path fallback.
 * Nothing above this seam would need to change.
 */
/**
 * Decides whether the session is permitted to navigate to a URL. Injected
 * rather than imported so `src/surface` keeps no dependency on `src/safety`:
 * policy sits *above* this seam, and a desktop Surface would enforce the
 * same contract against its own navigation primitives. Structurally
 * identical to the PolicyDecision returned by `checkNavigation`.
 */
export type NavigationGuard = (url: string) => { allowed: boolean; reason: string };

export type PolicyViolation = { url: string; reason: string };

/** The document response a step caused, if it caused one. `method` is what
 * makes effect-based risk classification possible: a non-GET navigation is
 * a state change regardless of what the activated control was labelled. */
export type NavigationInfo = { status: number; method: string };

/** A native dialog (alert/confirm/prompt) the page raised. */
export type DialogInfo = { type: string; message: string };

export class PolicyViolationError extends Error {
  constructor(readonly url: string, readonly reason: string) {
    super(`navigation blocked by policy: ${url} (${reason})`);
    this.name = "PolicyViolationError";
  }
}

export interface Surface {
  observe(): Promise<Observation>;
  navigate(url: string): Promise<void>;
  click(locator: LocatorDescriptor): Promise<void>;
  fill(locator: LocatorDescriptor, value: string): Promise<void>;
  select(locator: LocatorDescriptor, value: string): Promise<void>;
  check(locator: LocatorDescriptor, checked: boolean): Promise<void>;
  pressKey(locator: LocatorDescriptor | undefined, key: string): Promise<void>;
  waitFor(locator: LocatorDescriptor, timeoutMs?: number): Promise<void>;
  extractText(locator: LocatorDescriptor): Promise<string>;
  currentUrl(): string;
  screenshot(destPath: string): Promise<void>;
  /** Maps a ref from the most recent observe() into a durable, replayable
   * LocatorDescriptor — this is what gets written into an artifact step. */
  resolveElementToLocator(ref: string): LocatorDescriptor;
  /**
   * Read-and-clear: the document response caused since the last call, or
   * undefined if this step caused no navigation. Read-and-clear rather than
   * a sticky `lastResponseStatus()` on purpose — a sticky value let a
   * non-navigating step (a fill, a select) inherit the previous step's
   * status, so a lingering 5xx could trigger a spurious page reload in the
   * middle of filling a form and wipe everything typed so far.
   */
  takeNavigation(): NavigationInfo | undefined;
  /**
   * Read-and-clear: returns a navigation the policy guard blocked since the
   * last call, if any. Callers drain this after every action, because a
   * blocked *click* fails silently — the page simply stays put — so there is
   * no exception for the orchestration layer to catch.
   */
  takePolicyViolation(): PolicyViolation | undefined;
  /**
   * Read-and-clear: a native dialog the page raised since the last call.
   * Dialogs are still auto-dismissed so a run can never hang on one, but an
   * unanticipated dialog means the flow diverged from what was recorded, so
   * it must be reportable rather than silently swallowed.
   */
  takeDialog(): DialogInfo | undefined;
  close(): Promise<void>;
}

export class ElementNotFoundError extends Error {
  constructor(descriptor: LocatorDescriptor) {
    super(`no element resolved for locator: ${JSON.stringify(descriptor)}`);
    this.name = "ElementNotFoundError";
  }
}
