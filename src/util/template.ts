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

/**
 * Tokenizes a URL *structurally* — only whole path segments and whole query
 * values are replaced, and the origin is never touched.
 *
 * Deliberately not the substring tokenize() above: a URL is positional, so
 * a blind replace corrupts it. With deposit="1", "/members/20001/new-subaccount"
 * would become "/members/2000{{deposit}}/new-subaccount"; with any param whose
 * value is "4000", "http://localhost:4000/" would lose its port. Matching whole
 * segments makes a false positive impossible: a segment either *is* the
 * parameter's value or it isn't.
 */
export function tokenizeUrl(url: string, paramLiterals: Record<string, string>): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url; // relative/malformed: leave it alone rather than fail compilation
  }

  const nameByLiteral = new Map<string, string>();
  for (const [name, literal] of Object.entries(paramLiterals)) {
    if (literal) nameByLiteral.set(literal, name);
  }

  const decode = (s: string): string => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  };

  const path = parsed.pathname
    .split("/")
    .map((segment) => {
      const name = nameByLiteral.get(decode(segment));
      return name ? `{{${name}}}` : segment;
    })
    .join("/");

  // Built by hand rather than via URLSearchParams, whose toString() would
  // percent-encode the braces and stop render() from ever matching the token.
  const search = parsed.search
    ? "?" +
      parsed.search
        .slice(1)
        .split("&")
        .map((pair) => {
          const eq = pair.indexOf("=");
          if (eq === -1) return pair;
          const name = nameByLiteral.get(decode(pair.slice(eq + 1)));
          return name ? `${pair.slice(0, eq)}={{${name}}}` : pair;
        })
        .join("&")
    : "";

  return `${parsed.origin}${path}${search}${parsed.hash}`;
}
