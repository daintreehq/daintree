import { describe, expect, it } from "vitest";
import { foldFileName } from "../fileNameFold.js";

describe("foldFileName", () => {
  it.each([
    ["ASCII case", "README.md", "readme.md"],
    ["the long s APFS folds to s", "ſettings.json", "settings.json"],
    ["a full-width letter", ".ｇit", ".git"],
    ["a ligature", "ﬁle", "file"],
    ["sharp s", "straße", "strasse"],
    ["capital sharp s, which needs a second round", "STRAẞE", "strasse"],
    ["decomposed accents", "café", "café"],
  ])("folds %s", (_label, name, expected) => {
    expect(foldFileName(name)).toBe(expected);
  });

  it("is stable, so a folded name folds to itself", () => {
    for (const name of ["STRAẞE", "ſettings.json", "MixedＡ"]) {
      const once = foldFileName(name);
      expect(foldFileName(once)).toBe(once);
    }
  });
});
