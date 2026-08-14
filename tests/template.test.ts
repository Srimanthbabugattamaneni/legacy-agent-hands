import { describe, it, expect } from "vitest";
import { tokenize, render } from "../src/util/template.js";

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
