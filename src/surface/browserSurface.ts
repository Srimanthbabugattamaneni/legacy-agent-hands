import { chromium, type Browser, type BrowserContext, type Page, type Locator } from "playwright";
import type { Surface, NavigationGuard, PolicyViolation, NavigationInfo, DialogInfo } from "./types.js";
import { ElementNotFoundError, PolicyViolationError } from "./types.js";
import type { LocatorDescriptor, LocatorStrategy } from "../schema/locator.js";
import type { Observation } from "../schema/observation.js";
import { collectInteractiveElements, type RawElementInfo } from "./domSnapshot.js";

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** tsx/esbuild's dev transform injects `__name(fn, "fn")` calls after named
 * function declarations (to preserve `.name` through bundling) — those
 * reference a helper that only exists in the Node-side module scope, so a
 * function serialized via toString() and evaluated inside the page throws
 * `__name is not defined`. Strip them before handing the source to
 * page.evaluate(). */
function evalInPage<T>(page: Page, fn: () => T): Promise<T> {
  const src = fn.toString().replace(/__name\([^)]*\);?/g, "");
  return page.evaluate(`(${src})()`) as Promise<T>;
}

export class BrowserSurface implements Surface {
  private lastElements = new Map<string, RawElementInfo>();
  private navigation: NavigationInfo | undefined;
  private violation: PolicyViolation | undefined;
  private dialog: DialogInfo | undefined;

  private constructor(
    private browser: Browser,
    private context: BrowserContext,
    private page: Page,
    private guard: NavigationGuard
  ) {
    page.on("response", (res) => {
      const request = res.request();
      if (request.resourceType() === "document") {
        this.navigation = { status: res.status(), method: request.method() };
      }
    });
    // Legacy apps sometimes throw native dialogs the artifact didn't
    // anticipate. Still auto-dismissed so a run can never hard-hang on one,
    // but now recorded too: an unexpected dialog means the flow diverged
    // from what was recorded, which the caller needs to hear about rather
    // than have silently swallowed.
    page.on("dialog", (dialog) => {
      this.dialog = { type: dialog.type(), message: dialog.message() };
      void dialog.dismiss();
    });
  }

  /**
   * `guard` is required, deliberately. Making it optional (or defaulting it
   * to allow-all) is how the allowlist came to cover only the navigations
   * the orchestration layer happened to know about — any future caller that
   * forgot to pass one would silently reopen that hole.
   */
  static async create(opts: { headless: boolean; guard: NavigationGuard }): Promise<BrowserSurface> {
    const browser = await chromium.launch({ headless: opts.headless });
    const context = await browser.newContext();
    const surface = new BrowserSurface(browser, context, await context.newPage(), opts.guard);
    await surface.installNavigationGuard();
    return surface;
  }

  /**
   * Enforces the allowlist at the network layer, so the guarantee holds no
   * matter how navigation was triggered — a declared navigate step, a click
   * on a link, a form submission, or a JS redirect. Checking only at call
   * sites the orchestrator controls (which is what this used to do) misses
   * every one of those but the first.
   *
   * Only document navigations are gated. Subresources continue immediately:
   * legacy vendor apps routinely pull CSS/images from another host, and
   * blocking those would break pages for reasons unrelated to navigation.
   * That leaves subresource egress ungated — an accepted limit, recorded in
   * REPORT.md §6.
   *
   * Installed on the context before the first navigation, so it also
   * constrains a human who takes over the live session during an escalation
   * handoff. That is deliberate: the allowlist is a property of the
   * automation session, not of the agent alone.
   */
  private async installNavigationGuard(): Promise<void> {
    await this.context.route("**/*", (route) => {
      const request = route.request();
      if (!request.isNavigationRequest() || request.resourceType() !== "document") {
        void route.continue();
        return;
      }
      const url = request.url();
      const decision = this.guard(url);
      if (decision.allowed) {
        void route.continue();
        return;
      }
      // A blocked click produces no exception anywhere — the navigation just
      // never happens — so record it for the caller to drain.
      this.violation = { url, reason: decision.reason };
      void route.abort();
    });
  }

  /** Exposes the live Playwright Page for the escalation/operator handoff —
   * the same session a human takes over, never a fresh one. */
  get livePage(): Page {
    return this.page;
  }

  async observe(): Promise<Observation> {
    const raw = await evalInPage(this.page, collectInteractiveElements);
    this.lastElements = new Map(raw.map((r) => [r.ref, r]));
    const pageText = await evalInPage(this.page, () =>
      document.body.innerText.trim().replace(/\n{3,}/g, "\n\n").slice(0, 3000)
    );
    return {
      url: this.page.url(),
      title: await this.page.title(),
      pageText,
      elements: raw.map((r) => ({
        ref: r.ref,
        tag: r.tag,
        role: r.role,
        name: r.name,
        text: r.text,
        value: r.value,
        placeholder: r.placeholder,
        href: r.href,
        type: r.type,
        checked: r.checked,
        disabled: r.disabled,
        sensitive: r.sensitive,
      })),
    };
  }

  resolveElementToLocator(ref: string): LocatorDescriptor {
    const raw = this.lastElements.get(ref);
    if (!raw) throw new Error(`unknown element ref (stale observation?): ${ref}`);

    // A label/value data cell: the cell's own text *is* the value, which
    // changes per record, so it can't be its own locator (that's the whole
    // point of recording once and replaying for different inputs). Locate
    // it via the adjacent label instead, which is stable across records.
    if (raw.label) {
      const lbl = escapeXPathLiteral(raw.label);
      return {
        primary: {
          strategy: "css",
          selector: `xpath=//td[b[normalize-space(text())=${lbl}]]/following-sibling::td[1]`,
          nth: 0,
        },
        fallbacks: [{ strategy: "css", selector: raw.cssPath, nth: 0 }],
        reasoning:
          "value cells are keyed off their stable adjacent label via XPath, not their own " +
          "(per-record, changing) text; a structural CSS path is the fallback if the label " +
          "markup itself changes.",
      };
    }

    const strategies: LocatorStrategy[] = [];
    const hasUsableName = raw.name && raw.role !== "generic";

    if (hasUsableName) {
      strategies.push({ strategy: "role", role: raw.role, name: raw.name, nameMatch: "exact", nth: raw.nth });
    }
    if (raw.id) {
      strategies.push({ strategy: "css", selector: `#${cssEscape(raw.id)}`, nth: 0 });
    }
    if (raw.name && raw.name.length <= 80) {
      strategies.push({ strategy: "text", text: raw.name, exact: false, nth: raw.nth });
    }
    strategies.push({ strategy: "css", selector: raw.cssPath, nth: 0 });

    const [primary, ...fallbacks] = strategies;
    return {
      primary: primary!,
      fallbacks,
      reasoning:
        "role+accessible-name is preferred as the most tenant/version-stable strategy; " +
        "id and text are secondary; a structural CSS path is the last-resort fallback " +
        "since it breaks the moment layout changes.",
    };
  }

  private async resolveLocator(descriptor: LocatorDescriptor): Promise<Locator> {
    const candidates = [descriptor.primary, ...descriptor.fallbacks];
    for (const s of candidates) {
      const loc = this.buildLocator(s);
      try {
        const count = await loc.count();
        if (count >= 1) return loc;
      } catch {
        // malformed selector etc — try next strategy
      }
    }
    throw new ElementNotFoundError(descriptor);
  }

  private buildLocator(s: LocatorStrategy): Locator {
    switch (s.strategy) {
      case "role":
        return this.page
          .getByRole(s.role as Parameters<Page["getByRole"]>[0], {
            name: s.nameMatch === "exact" ? s.name : new RegExp(escapeRegExp(s.name), "i"),
          })
          .nth(s.nth);
      case "label":
        return this.page.getByLabel(s.label).nth(s.nth);
      case "text":
        return this.page.getByText(s.text, { exact: s.exact }).nth(s.nth);
      case "css":
        return this.page.locator(s.selector).nth(s.nth);
      case "testid":
        return this.page.getByTestId(s.testId);
    }
  }

  async navigate(url: string): Promise<void> {
    // Pre-check so a declared navigation fails with a typed, explanatory
    // error instead of the bare net::ERR_ABORTED the route handler would
    // otherwise surface. The interceptor still backstops this.
    const decision = this.guard(url);
    if (!decision.allowed) {
      throw new PolicyViolationError(url, decision.reason);
    }
    await this.page.goto(url, { waitUntil: "domcontentloaded" });
  }

  async click(locator: LocatorDescriptor): Promise<void> {
    const loc = await this.resolveLocator(locator);
    await Promise.all([
      this.page.waitForLoadState("domcontentloaded", { timeout: 8000 }).catch(() => {}),
      loc.click({ timeout: 8000 }),
    ]);
  }

  async fill(locator: LocatorDescriptor, value: string): Promise<void> {
    const loc = await this.resolveLocator(locator);
    await loc.fill(value, { timeout: 8000 });
  }

  async select(locator: LocatorDescriptor, value: string): Promise<void> {
    const loc = await this.resolveLocator(locator);
    await loc.selectOption(value, { timeout: 8000 });
  }

  async check(locator: LocatorDescriptor, checked: boolean): Promise<void> {
    const loc = await this.resolveLocator(locator);
    await loc.setChecked(checked, { timeout: 8000 });
  }

  async pressKey(locator: LocatorDescriptor | undefined, key: string): Promise<void> {
    if (locator) {
      const loc = await this.resolveLocator(locator);
      await loc.press(key, { timeout: 8000 });
    } else {
      await this.page.keyboard.press(key);
    }
  }

  async waitFor(locator: LocatorDescriptor, timeoutMs = 8000): Promise<void> {
    const candidates = [locator.primary, ...locator.fallbacks];
    const perStrategy = Math.max(1000, Math.floor(timeoutMs / candidates.length));
    for (const s of candidates) {
      try {
        await this.buildLocator(s).waitFor({ state: "visible", timeout: perStrategy });
        return;
      } catch {
        // try next strategy
      }
    }
    throw new ElementNotFoundError(locator);
  }

  async extractText(locator: LocatorDescriptor): Promise<string> {
    const loc = await this.resolveLocator(locator);
    try {
      const text = (await loc.innerText({ timeout: 5000 })).trim();
      if (text) return text;
    } catch {
      // fall through to value-based extraction
    }
    return (await loc.inputValue({ timeout: 5000 })).trim();
  }

  currentUrl(): string {
    return this.page.url();
  }

  async screenshot(destPath: string): Promise<void> {
    await this.page.screenshot({ path: destPath, fullPage: true });
  }

  takeNavigation(): NavigationInfo | undefined {
    const recorded = this.navigation;
    this.navigation = undefined;
    return recorded;
  }

  takeDialog(): DialogInfo | undefined {
    const recorded = this.dialog;
    this.dialog = undefined;
    return recorded;
  }

  takePolicyViolation(): PolicyViolation | undefined {
    const recorded = this.violation;
    this.violation = undefined;
    if (recorded) return recorded;

    // Same-document History API navigation (pushState/replaceState) never
    // issues a request, so the interceptor cannot see it. Re-checking the
    // settled URL catches that case.
    const current = this.page.url();
    // Blank/error pages are browser states, not navigations the session
    // chose; flagging them would be a false positive (a fresh page sits on
    // about:blank, and an aborted goto can land on chrome-error://).
    if (!current || current === "about:blank" || current.startsWith("chrome-error://")) {
      return undefined;
    }
    const decision = this.guard(current);
    return decision.allowed ? undefined : { url: current, reason: decision.reason };
  }

  async close(): Promise<void> {
    await this.browser.close();
  }
}

/** Node-side CSS.escape equivalent (there is no `CSS` global outside a browser). */
function cssEscape(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
}

/** XPath has no escape sequence for quotes inside string literals; a value
 * containing both quote types needs concat(). Our labels are plain words,
 * so the common cases (no quotes, or only one quote type) cover it. */
function escapeXPathLiteral(s: string): string {
  if (!s.includes('"')) return `"${s}"`;
  if (!s.includes("'")) return `'${s}'`;
  const parts = s.split('"').map((p) => `"${p}"`);
  return `concat(${parts.join(`,'"',`)})`;
}
