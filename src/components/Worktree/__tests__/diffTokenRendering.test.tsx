// @vitest-environment jsdom
import { deserialize, serialize } from "node:v8";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Diff, Hunk, parseDiff } from "react-diff-view";
import type { HunkData, HunkTokens, ViewType } from "react-diff-view";
import { runDiffTokenize } from "../diffTokenizer";

// The token tree is holey everywhere a hunk doesn't render. This drives the
// real react-diff-view table, not a mock, to prove its per-line lookups find
// every line they render after the clone a worker response goes through.

const HUNK_LINES = (at: number) => [
  `@@ -${at},4 +${at},4 @@`,
  `   const ctx_${at} = resolve(${at});`,
  `-  const value = legacyCompute(${at}, { retries: 3 });`,
  `+  const value = compute(${at}, { retries: 3, backoff: "expo" });`,
  "   const done = aggregate(value);",
  "   const tail = finish(done);",
];

const DIFF = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  ...HUNK_LINES(1),
  ...HUNK_LINES(5_000),
  "",
].join("\n");

async function clonedTokens(hunks: HunkData[]): Promise<HunkTokens> {
  const result = await runDiffTokenize({
    hunks,
    language: "typescript",
    highlight: true,
    extraRanges: null,
  });
  expect(result.tokens).not.toBeNull();
  return deserialize(serialize(result.tokens)) as HunkTokens;
}

describe("sparse token trees in the real diff table", () => {
  for (const viewType of ["unified", "split"] as ViewType[]) {
    it(`highlights every rendered line in the ${viewType} view`, async () => {
      const hunks = parseDiff(DIFF)[0]!.hunks;
      const tokens = await clonedTokens(hunks);
      // Holey: far fewer entries than the 5,003-line extent.
      expect(tokens.new.length).toBe(5_003);
      expect(Object.keys(tokens.new).length).toBe(8);

      const { container } = render(
        <Diff viewType={viewType} diffType="modify" hunks={hunks} tokens={tokens}>
          {(rendered) => rendered.map((hunk) => <Hunk key={hunk.content} hunk={hunk} />)}
        </Diff>
      );

      const cells = [...container.querySelectorAll("td.diff-code:not(.diff-code-omit)")];
      const contents = hunks.flatMap((hunk) => hunk.changes.map((change) => change.content));
      // Split view draws a context line on both sides.
      const contextLines = hunks.flatMap((hunk) => hunk.changes).filter((c) => c.type === "normal");
      expect(cells.length).toBe(
        viewType === "split" ? contents.length + contextLines.length : contents.length
      );
      for (const cell of cells) {
        expect(contents).toContain(cell.textContent);
        expect(cell.querySelector(".token.keyword")?.textContent, cell.textContent ?? "").toBe(
          "const"
        );
      }

      // The deep pair carries its word-level edit marks, on the deep lines.
      const deepEdits = cells.filter(
        (cell) => cell.textContent?.includes("5000") && cell.querySelector(".diff-code-edit")
      );
      expect(deepEdits.length).toBe(2);
    });
  }
});
