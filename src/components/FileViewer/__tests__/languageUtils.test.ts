import { describe, expect, it } from "vitest";
import { getLanguageForFile } from "../languageUtils";

describe("getLanguageForFile", () => {
  it.each(["src/index.ts", "src/index.mts", "src/index.cts", "C:\\src\\index.MTS"])(
    "maps %s to typescript",
    (path) => {
      expect(getLanguageForFile(path)).toBe("typescript");
    }
  );

  it("keeps tsx distinct", () => {
    expect(getLanguageForFile("a.tsx")).toBe("tsx");
  });
});
