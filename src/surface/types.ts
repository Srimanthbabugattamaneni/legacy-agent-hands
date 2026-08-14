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
  lastResponseStatus(): number | undefined;
  close(): Promise<void>;
}

export class ElementNotFoundError extends Error {
  constructor(descriptor: LocatorDescriptor) {
    super(`no element resolved for locator: ${JSON.stringify(descriptor)}`);
    this.name = "ElementNotFoundError";
  }
}
