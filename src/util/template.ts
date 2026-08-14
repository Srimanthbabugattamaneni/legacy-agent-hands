/** Replaces occurrences of known literal values with {{paramName}} tokens,
 * so a value recorded once at discovery time (e.g. a literal member ID that
 * appears inside a URL or a checkpoint's expected text) generalizes to
 * whatever value is supplied at replay time instead of staying hardcoded. */
export function tokenize(text: string, paramLiterals: Record<string, string>): string {
  let out = text;
  for (const [name, literal] of Object.entries(paramLiterals)) {
    if (!literal) continue;
    out = out.split(literal).join(`{{${name}}}`);
  }
  return out;
}

/** Inverse of tokenize(): substitutes {{paramName}} tokens with the actual
 * runtime parameter values supplied to a replay invocation. */
export function render(template: string, params: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => params[name] ?? `{{${name}}}`);
}
