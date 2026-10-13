import { describe, expect, it } from "vitest";
import { matchesTokens, queryTokens } from "../hostProjectSearch";

describe("host project search", () => {
  it("lets each word of a query match a different field", () => {
    const fields = ["pagesugar", "/home/greg/pagesugar", "linux-box"];
    expect(matchesTokens(queryTokens("pagesugar linux"), fields)).toBe(true);
    expect(matchesTokens(queryTokens("pagesugar mac"), fields)).toBe(false);
  });

  it("ignores case and surrounding space, and matches everything when blank", () => {
    expect(queryTokens("  PageSugar   Linux ")).toEqual(["pagesugar", "linux"]);
    expect(matchesTokens(queryTokens("   "), ["anything"])).toBe(true);
    expect(matchesTokens(queryTokens("SUGAR"), ["pagesugar"])).toBe(true);
  });
});
