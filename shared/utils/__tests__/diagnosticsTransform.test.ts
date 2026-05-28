import { describe, it, expect } from "vitest";
import {
  applyReplacements,
  filterLogEntriesByTime,
  filterSections,
  PREBUILT_REDACTIONS,
  type ReplacementRule,
} from "../diagnosticsTransform.js";

describe("applyReplacements", () => {
  it("applies a literal rule by default (no kind)", () => {
    const rules: ReplacementRule[] = [{ find: "secret", replace: "[X]" }];
    expect(applyReplacements("a secret and secret", rules)).toBe("a [X] and [X]");
  });

  it("treats kind:'literal' the same as the default", () => {
    const rules: ReplacementRule[] = [{ kind: "literal", find: "a.b", replace: "X" }];
    // Literal: the "." is not a wildcard, so "axb" is untouched.
    expect(applyReplacements("a.b axb", rules)).toBe("X axb");
  });

  it("applies a regex rule globally", () => {
    const rules: ReplacementRule[] = [{ kind: "regex", find: "\\d+", replace: "#" }];
    expect(applyReplacements("a1 b22 c333", rules)).toBe("a# b# c#");
  });

  it("silently skips an uncompilable regex pattern without throwing", () => {
    const rules: ReplacementRule[] = [
      { kind: "regex", find: "(", replace: "X" },
      { kind: "regex", find: "b", replace: "B" },
    ];
    // Bad pattern skipped; the valid one still applies.
    expect(applyReplacements("a b c", rules)).toBe("a B c");
  });

  it("skips rules with an empty find", () => {
    const rules: ReplacementRule[] = [{ find: "", replace: "X" }];
    expect(applyReplacements("unchanged", rules)).toBe("unchanged");
  });

  it("applies rules in order (earlier rules see the original, later see prior output)", () => {
    const rules: ReplacementRule[] = [
      { kind: "regex", find: "foo", replace: "bar" },
      { find: "bar", replace: "baz" },
    ];
    expect(applyReplacements("foo", rules)).toBe("baz");
  });
});

describe("PREBUILT_REDACTIONS", () => {
  const apply = (id: string, input: string): string => {
    const preset = PREBUILT_REDACTIONS.find((p) => p.id === id);
    if (!preset) throw new Error(`no preset ${id}`);
    return applyReplacements(input, preset.rules);
  };

  it("strips email addresses", () => {
    expect(apply("email", "contact greg@example.com now")).toBe("contact [REDACTED] now");
  });

  it("strips IPv4 addresses", () => {
    expect(apply("ip", "host 192.168.1.42 down")).toBe("host [REDACTED] down");
  });

  it("strips full and compressed IPv6 addresses", () => {
    expect(apply("ip", "addr 2001:0db8:85a3:0000:0000:8a2e:0370:7334 ok")).toBe(
      "addr [REDACTED] ok"
    );
    expect(apply("ip", "loopback ::1 here")).toBe("loopback [REDACTED] here");
  });

  it("does not mangle HH:MM:SS timestamps as IPv6", () => {
    expect(apply("ip", "at 12:34:56 today")).toBe("at 12:34:56 today");
  });

  it("strips POSIX absolute file paths", () => {
    expect(apply("filepath", "open /Users/greg/secret/file.log please")).toBe(
      "open [REDACTED] please"
    );
  });

  it("strips Windows drive-letter paths", () => {
    expect(apply("filepath", "open C:\\Users\\greg\\file.log please")).toBe(
      "open [REDACTED] please"
    );
  });

  it("every prebuilt rule compiles as a valid global regex", () => {
    for (const preset of PREBUILT_REDACTIONS) {
      for (const rule of preset.rules) {
        expect(rule.kind).toBe("regex");
        expect(() => new RegExp(rule.find, "g")).not.toThrow();
      }
    }
  });
});

describe("filterSections", () => {
  it("removes sections explicitly disabled, keeps the rest", () => {
    const payload = { a: 1, b: 2, c: 3 };
    expect(filterSections(payload, { a: true, b: false })).toEqual({ a: 1, c: 3 });
  });
});

describe("filterLogEntriesByTime", () => {
  const payload = () => ({
    logs: {
      totalEntries: 3,
      recentEntries: [
        { id: "1", timestamp: 100, message: "old" },
        { id: "2", timestamp: 200, message: "mid" },
        { id: "3", timestamp: 300, message: "new" },
      ],
    },
  });

  it("is a no-op when startMs is null", () => {
    const p = payload();
    expect(filterLogEntriesByTime(p, null)).toBe(p);
  });

  it("drops entries older than the cutoff", () => {
    const result = filterLogEntriesByTime(payload(), 200) as {
      logs: { recentEntries: Array<{ id: string }> };
    };
    expect(result.logs.recentEntries.map((e) => e.id)).toEqual(["2", "3"]);
  });

  it("does not mutate the input payload", () => {
    const p = payload();
    filterLogEntriesByTime(p, 300);
    expect(p.logs.recentEntries).toHaveLength(3);
  });

  it("keeps entries lacking a numeric timestamp rather than dropping them", () => {
    const p = { logs: { recentEntries: [{ id: "x" }, { id: "y", timestamp: 50 }] } };
    const result = filterLogEntriesByTime(p, 100) as {
      logs: { recentEntries: Array<{ id: string }> };
    };
    expect(result.logs.recentEntries.map((e) => e.id)).toEqual(["x"]);
  });

  it("tolerates a missing or non-array logs section", () => {
    expect(filterLogEntriesByTime({}, 100)).toEqual({});
    expect(filterLogEntriesByTime({ logs: { error: "failed" } }, 100)).toEqual({
      logs: { error: "failed" },
    });
  });
});
