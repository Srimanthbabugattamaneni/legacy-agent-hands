import type { Page, Locator } from "playwright";
import type { LocatorDescriptor, LocatorStrategy } from "../schema/locator.js";
import type { RawElementInfo } from "./domSnapshot.js";
import { ElementNotFoundError } from "./types.js";

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

/**
 * Turning observed elements into durable locators, and durable locators back
 * into live handles. Extracted from BrowserSurface because it changes for its
 * own reasons — a new targeting strategy, a different robustness ordering —
 * none of which are reasons the surface's perception, action, or session
 * handling would change.
 */
export class LocatorResolver {
  constructor(private page: Page) {}

  describe(raw: RawElementInfo | undefined, ref: string): LocatorDescriptor {
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

  async resolve(descriptor: LocatorDescriptor): Promise<Locator> {
    const candidates = [descriptor.primary, ...descriptor.fallbacks];
    for (const s of candidates) {
      const loc = this.build(s);
      try {
        const count = await loc.count();
        if (count >= 1) return loc;
      } catch {
        // malformed selector etc — try next strategy
      }
    }
    throw new ElementNotFoundError(descriptor);
  }

  build(s: LocatorStrategy): Locator {
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
}
