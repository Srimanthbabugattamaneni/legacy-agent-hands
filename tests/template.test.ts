import { describe, it, expect } from "vitest";
import { tokenize, render, tokenizeUrl } from "../src/util/template.js";

describe("template tokenize/render", () => {
  it("tokenizes a known literal into a {{param}} reference", () => {
    expect(tokenize("/members/10234", { memberId: "10234" })).toBe("/members/{{memberId}}");
  });

  it("round-trips tokenize -> render back to the original", () => {
    const original = "http://localhost:4000/members/10234/new-subaccount";
    const tokenized = tokenize(original, { memberId: "10234" });
    expect(render(tokenized, { memberId: "10234" })).toBe(original);
    expect(render(tokenized, { memberId: "99999" })).toBe(
      "http://localhost:4000/members/99999/new-subaccount"
    );
  });

  it("leaves text with no matching literal unchanged", () => {
    expect(tokenize("No matching member found", { memberId: "10234" })).toBe("No matching member found");
  });
});

describe("tokenizeUrl", () => {
  it("replaces a whole path segment that equals a declared param", () => {
    expect(
      tokenizeUrl("http://localhost:4000/members/20001/new-subaccount", { memberId: "20001" })
    ).toBe("http://localhost:4000/members/{{memberId}}/new-subaccount");
  });

  it("round-trips through render() to a different member", () => {
    const tokenized = tokenizeUrl("http://localhost:4000/members/20001/new-subaccount", { memberId: "20001" });
    expect(render(tokenized, { memberId: "10567" })).toBe("http://localhost:4000/members/10567/new-subaccount");
  });

  it("never partially matches inside a segment", () => {
    // deposit="1" must not turn /members/20001/ into /members/2000{{deposit}}/
    expect(tokenizeUrl("http://localhost:4000/members/20001/new-subaccount", { deposit: "1" })).toBe(
      "http://localhost:4000/members/20001/new-subaccount"
    );
  });

  it("never rewrites the origin, even when a param value matches the port", () => {
    expect(tokenizeUrl("http://localhost:4000/members/20001", { port: "4000", memberId: "20001" })).toBe(
      "http://localhost:4000/members/{{memberId}}"
    );
  });

  it("tokenizes a whole query-string value without percent-encoding the token", () => {
    const out = tokenizeUrl("http://localhost:4000/members?q=20001&sort=asc", { memberId: "20001" });
    expect(out).toBe("http://localhost:4000/members?q={{memberId}}&sort=asc");
    expect(render(out, { memberId: "55555" })).toBe("http://localhost:4000/members?q=55555&sort=asc");
  });

  it("leaves a malformed/relative URL alone instead of failing compilation", () => {
    expect(tokenizeUrl("/members/20001", { memberId: "20001" })).toBe("/members/20001");
  });
});
