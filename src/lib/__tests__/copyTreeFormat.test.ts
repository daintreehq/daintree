import { describe, expect, it } from "vitest";
import { folderIncludePattern } from "../copyTreeFormat";

describe("folderIncludePattern", () => {
  it("appends the recursive glob to a plain folder path", () => {
    expect(folderIncludePattern("src/panels")).toBe("src/panels/**");
  });

  it("escapes minimatch character classes so bracketed names match literally", () => {
    // Unescaped, `src/[draft]` is a character class matching `src/d` — the
    // copy would silently pick up a sibling instead of the chosen folder.
    expect(folderIncludePattern("src/[draft]")).toBe("src/\\[draft\\]/**");
  });

  it("escapes a leading negation so the pattern cannot invert", () => {
    expect(folderIncludePattern("!important")).toBe("\\!important/**");
  });

  it("escapes braces, extglobs and wildcards", () => {
    expect(folderIncludePattern("a{b,c}")).toBe("a\\{b,c\\}/**");
    expect(folderIncludePattern("cache+(old)")).toBe("cache\\+\\(old\\)/**");
    expect(folderIncludePattern("v*?")).toBe("v\\*\\?/**");
  });
});
