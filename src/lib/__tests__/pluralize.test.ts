import { describe, expect, it } from "vitest";
import { pluralize, pluralNoun } from "../pluralize";

describe("pluralize", () => {
  it("uses the singular for exactly one and the plural for every other count", () => {
    expect(pluralize(1, "file")).toBe("1 file");
    for (const n of [0, 2, 17]) expect(pluralize(n, "file")).toBe(`${n} files`);
  });

  it("takes an irregular plural or a phrase whose verb agrees", () => {
    expect(pluralize(3, "patch", "patches")).toBe("3 patches");
    expect(pluralize(1, "terminal is", "terminals are")).toBe("1 terminal is");
    expect(pluralize(2, "terminal is", "terminals are")).toBe("2 terminals are");
  });

  it("groups large counts the way the locale does", () => {
    expect(pluralize(12345, "line")).toBe(`${(12345).toLocaleString()} lines`);
    expect(pluralize(12345, "line")).not.toBe("12345 lines");
  });
});

describe("pluralNoun", () => {
  it("returns only the noun, agreeing with the count", () => {
    expect(pluralNoun(1, "session")).toBe("session");
    expect(pluralNoun(0, "session")).toBe("sessions");
  });
});
