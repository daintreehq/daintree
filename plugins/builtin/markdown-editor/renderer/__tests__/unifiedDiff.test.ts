import { describe, expect, it } from "vitest";
import { parseDiff } from "react-diff-view";
import { unifiedDiff } from "../unifiedDiff";

/** Apply a unified diff produced by `unifiedDiff` back onto `before`. */
function apply(before: string, patch: string): string {
  const lines = before === "" ? [] : before.replace(/\n$/, "").split("\n");
  const out: string[] = [];
  let cursor = 0;
  for (const raw of patch.split("\n")) {
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      const start = Number(hunk[1]) - 1;
      while (cursor < start) out.push(lines[cursor++]!);
      continue;
    }
    if (raw.startsWith("diff ") || raw.startsWith("--- ") || raw.startsWith("+++ ") || raw === "") {
      continue;
    }
    const marker = raw[0];
    const line = raw.slice(1);
    if (marker === " ") {
      out.push(line);
      cursor++;
    } else if (marker === "-") {
      cursor++;
    } else if (marker === "+") {
      out.push(line);
    }
  }
  while (cursor < lines.length) out.push(lines[cursor++]!);
  return out.length === 0 ? "" : out.join("\n") + "\n";
}

describe("unifiedDiff (#12323)", () => {
  it("returns an empty string for identical texts", () => {
    expect(unifiedDiff("a\nb\n", "a\nb\n", { path: "x.md" })).toBe("");
  });

  it("produces a one-line hunk for a one-word change", () => {
    const patch = unifiedDiff("one\ntwo\nthree\n", "one\n2\nthree\n", { path: "doc.md" });
    expect(patch).toContain("--- a/doc.md");
    expect(patch).toContain("+++ b/doc.md");
    expect(patch).toContain("@@ -1,3 +1,3 @@");
    expect(patch).toContain("-two");
    expect(patch).toContain("+2");
    expect(patch.split("\n").filter((l) => l.startsWith("-") && !l.startsWith("---"))).toHaveLength(
      1
    );
  });

  it.each([
    ["insert at end", "a\nb\n", "a\nb\nc\n"],
    ["delete at start", "a\nb\nc\n", "b\nc\n"],
    ["replace everything", "x\ny\n", "p\nq\nr\n"],
    ["empty before", "", "new\n"],
    ["empty after", "gone\n", ""],
    ["no trailing newline", "a\nb", "a\nB"],
    [
      "two separate hunks",
      Array.from({ length: 20 }, (_, i) => `l${i}`).join("\n") + "\n",
      Array.from({ length: 20 }, (_, i) => (i === 2 ? "X" : i === 17 ? "Y" : `l${i}`)).join("\n") +
        "\n",
    ],
  ])("%s applies back onto the original", (_label, before, after) => {
    const patch = unifiedDiff(before, after, { path: "f.md" });
    const applied = apply(before, patch);
    const normalizedAfter = after === "" ? "" : after.replace(/\n?$/, "\n");
    expect(applied).toBe(normalizedAfter);
  });

  it("splits distant changes into separate hunks with three lines of context", () => {
    const before = Array.from({ length: 20 }, (_, i) => `l${i}`).join("\n") + "\n";
    const after = before.replace("l2\n", "X\n").replace("l17\n", "Y\n");
    const patch = unifiedDiff(before, after, { path: "f.md" });
    expect(patch.match(/^@@/gm)).toHaveLength(2);
  });

  it("parses with the same parser DiffViewer uses", () => {
    const patch = unifiedDiff("a\nb\nc\n", "a\nB\nc\nd\n", { path: "docs/plan.md" });
    const files = parseDiff(patch);
    expect(files).toHaveLength(1);
    expect(files[0]?.hunks).toHaveLength(1);
    const changes = files[0]!.hunks[0]!.changes.map((change) => change.type);
    expect(changes).toEqual(["normal", "delete", "insert", "normal", "insert"]);
  });
});
