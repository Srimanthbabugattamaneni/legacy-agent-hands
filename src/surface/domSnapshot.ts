/** Extra locator-resolution metadata captured alongside each ObservedElement,
 * kept surface-side only (never sent to the LLM, never persisted directly —
 * it's the raw material resolveElementToLocator() turns into a
 * LocatorDescriptor). */
export type RawElementInfo = {
  ref: string;
  tag: string;
  role: string;
  name: string;
  text?: string;
  value?: string;
  placeholder?: string;
  href?: string;
  type?: string;
  checked?: boolean;
  disabled?: boolean;
  sensitive: boolean;
  id?: string;
  cssPath: string;
  nth: number;
  /** For a label/value table-cell pair (the common legacy "<td><b>Label</b>
   * </td><td>Value</td>" layout) — the label text, used to build a locator
   * keyed on the stable label instead of the value, which changes per
   * record and would otherwise be unusable as its own locator. */
  label?: string;
};

/**
 * Runs inside the page (via page.evaluate). Must be fully self-contained —
 * no imports, no closures over Node-side values. Walks interactive elements
 * in DOM order and computes, for each: an inferred ARIA role (matching the
 * native HTML->ARIA mapping Playwright's own getByRole relies on), a
 * best-effort accessible name, and a structural CSS path fallback. This is
 * the entire "how do we perceive a page with no test IDs" strategy.
 */
export function collectInteractiveElements(): RawElementInfo[] {
  const SENSITIVE_NAME = /pass(word)?|ssn|social.?security|cvv|cvc|pin\b/i;

  function isVisible(el: Element): boolean {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    return true;
  }

  function labelFor(el: Element): string {
    const id = el.getAttribute("id");
    if (id) {
      const escaped = window.CSS && CSS.escape ? CSS.escape(id) : id;
      const lbl = document.querySelector(`label[for="${escaped}"]`);
      if (lbl && lbl.textContent) return lbl.textContent.trim();
    }
    const closestLabel = el.closest("label");
    if (closestLabel && closestLabel.textContent) return closestLabel.textContent.trim();
    return "";
  }

  function inferRole(el: Element): string {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === "a") return el.hasAttribute("href") ? "link" : "generic";
    if (tag === "button") return "button";
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "input") {
      const type = (el.getAttribute("type") || "text").toLowerCase();
      if (type === "submit" || type === "button" || type === "reset") return "button";
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      return "textbox";
    }
    return "generic";
  }

  function accessibleName(el: Element, role: string): string {
    const ariaLabel = el.getAttribute("aria-label");
    if (ariaLabel) return ariaLabel.trim();
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const ref = document.getElementById(labelledBy);
      if (ref && ref.textContent) return ref.textContent.trim();
    }
    const fromLabel = labelFor(el);
    if (fromLabel) return fromLabel;
    if (role === "textbox") {
      const placeholder = el.getAttribute("placeholder");
      if (placeholder) return placeholder.trim();
    }
    const tag = el.tagName.toLowerCase();
    if (tag === "input") {
      const value = (el as HTMLInputElement).value;
      const type = (el.getAttribute("type") || "").toLowerCase();
      if ((type === "submit" || type === "button") && value) return value.trim();
    }
    const text = (el.textContent || "").trim().replace(/\s+/g, " ");
    if (text) return text.slice(0, 120);
    const title = el.getAttribute("title");
    if (title) return title.trim();
    const alt = el.getAttribute("alt");
    if (alt) return alt.trim();
    return "";
  }

  function cssPath(el: Element): string {
    const parts: string[] = [];
    let node: Element | null = el;
    while (node && node.tagName.toLowerCase() !== "body" && node.parentElement) {
      const tag = node.tagName.toLowerCase();
      const siblings = Array.from(node.parentElement.children).filter(
        (c) => c.tagName === node!.tagName
      );
      const idx = siblings.indexOf(node) + 1;
      parts.unshift(`${tag}:nth-of-type(${idx})`);
      node = node.parentElement;
    }
    return `body > ${parts.join(" > ")}`;
  }

  const candidates = Array.from(
    document.querySelectorAll("a[href], button, input, select, textarea")
  ).filter(isVisible);

  const nameCounts = new Map<string, number>();
  const results: RawElementInfo[] = [];

  candidates.forEach((el, i) => {
    const role = inferRole(el);
    const name = accessibleName(el, role);
    const key = `${role}|${name}`;
    const nth = nameCounts.get(key) ?? 0;
    nameCounts.set(key, nth + 1);

    const tag = el.tagName.toLowerCase();
    const type = el.getAttribute("type") || undefined;
    const id = el.getAttribute("id") || undefined;
    const sensitive = type === "password" || SENSITIVE_NAME.test(name) || (id ? SENSITIVE_NAME.test(id) : false);

    let value: string | undefined;
    if (tag === "input" || tag === "textarea") value = (el as HTMLInputElement).value;
    if (tag === "select") {
      const sel = el as HTMLSelectElement;
      value = sel.options[sel.selectedIndex]?.text;
    }

    let checked: boolean | undefined;
    if (tag === "input" && (type === "checkbox" || type === "radio")) {
      checked = (el as HTMLInputElement).checked;
    }

    results.push({
      ref: `e${i}`,
      tag,
      role,
      name,
      text: (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 200) || undefined,
      value: sensitive ? undefined : value,
      placeholder: el.getAttribute("placeholder") || undefined,
      href: (el as HTMLAnchorElement).href || undefined,
      type,
      checked,
      disabled: (el as HTMLInputElement).disabled || undefined,
      sensitive,
      id,
      cssPath: cssPath(el),
      nth,
    });
  });

  // Legacy back-office pages mostly display data as "<td><b>Label</b></td>
  // <td>Value</td>" table rows — the value itself carries no interactive
  // affordance, so it's invisible to the candidates query above even though
  // it's exactly what a "look up X and read Y" goal needs to extract. Expose
  // each such value cell as a readable ref, named after its (stable) label
  // rather than its (per-record) value.
  const rows = Array.from(document.querySelectorAll("tr"));
  let labelCellIndex = 0;
  for (const row of rows) {
    const cells = Array.from(row.children).filter((c) => c.tagName.toLowerCase() === "td");
    if (cells.length < 2) continue;
    const labelCell = cells[0]!;
    const valueCell = cells[1]!;
    const isLabel =
      labelCell.children.length === 1 &&
      labelCell.children[0]!.tagName.toLowerCase() === "b" &&
      (labelCell.textContent || "").trim().length > 0;
    if (!isLabel || !isVisible(valueCell)) continue;
    // Skip if the value cell is just a wrapper around an already-listed
    // interactive element (e.g. a button cell) — nothing new to expose.
    if (valueCell.querySelector("a[href], button, input, select, textarea")) continue;
    // Skip a header row (both cells bold) — that's "Type | Account #",
    // not a real label/value pair.
    const valueLooksLikeLabel = valueCell.children.length === 1 && valueCell.children[0]!.tagName.toLowerCase() === "b";
    if (valueLooksLikeLabel) continue;

    const label = (labelCell.textContent || "").trim().replace(/\s+/g, " ");
    const text = (valueCell.textContent || "").trim().replace(/\s+/g, " ").slice(0, 200);
    results.push({
      ref: `c${labelCellIndex++}`,
      tag: "td",
      role: "cell",
      name: label,
      text: text || undefined,
      value: text || undefined,
      sensitive: SENSITIVE_NAME.test(label),
      cssPath: cssPath(valueCell),
      nth: 0,
      label,
    });
  }

  return results;
}
