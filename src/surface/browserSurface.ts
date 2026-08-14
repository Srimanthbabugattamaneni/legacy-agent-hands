import { chromium, type Browser, type BrowserContext, type Page, type Locator } from "playwright";
import type { Surface } from "./types.js";
import { ElementNotFoundError } from "./types.js";
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
  private lastStatus: number | undefined;

  private constructor(private browser: Browser, private context: BrowserContext, private page: Page) {
    page.on("response", (res) => {
      if (res.request().resourceType() === "document") {
        this.lastStatus = res.status();
      }
    });
    // Legacy apps sometimes throw native dialogs the artifact didn't
    // anticipate; auto-dismiss so the loop never hard-hangs, and let
    // callers detect the surprise via lastResponseStatus()/text mismatches.
    page.on("dialog", (dialog) => {
      void dialog.dismiss();
    });
  }

  static async create(opts: { headless: boolean }): Promise<BrowserSurface> {
    const browser = await chromium.launch({ headless: opts.headless });
    const context = await browser.newContext();
    const page = await context.newPage();
    return new BrowserSurface(browser, context, page);
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

  lastResponseStatus(): number | undefined {
    return this.lastStatus;
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
