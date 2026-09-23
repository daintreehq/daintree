import { describe, expect, it } from "vitest";
import { toHintPhrase } from "../AppPaletteDialog";

describe("toHintPhrase", () => {
  it("drops only the sentence-case capital, never a name later in the label", () => {
    const phrase = toHintPhrase("Launch GitHub Copilot");
    expect(phrase.charAt(0)).toBe("l");
    expect(phrase.slice(1)).toBe("Launch GitHub Copilot".slice(1));
  });

  it("leaves a leading word alone when its capitals are its own", () => {
    for (const label of ["GitHub: open issue", "CLI settings", "OpenCode"]) {
      expect(toHintPhrase(label)).toBe(label);
    }
  });
});
