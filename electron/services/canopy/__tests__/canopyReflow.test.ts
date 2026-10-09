import { describe, expect, it } from "vitest";
import { reflowPrint, sameAfterReflow } from "../canopyReflow.js";

/** Word-wraps `text` at `cols`, the way an agent re-wraps its output for a new width. */
function wrap(text: string, cols: number): string {
  const rows: string[] = [];
  for (const line of text.split("\n")) {
    let row = "";
    for (const word of line.split(" ")) {
      if (row !== "" && row.length + 1 + word.length > cols) {
        rows.push(row);
        row = word;
      } else {
        row = row === "" ? word : `${row} ${word}`;
      }
    }
    rows.push(row);
  }
  return rows.join("\n");
}

/** Cuts every row longer than `cols` at the edge with an ellipsis, as Claude Code does its tool lines. */
function cut(text: string, cols: number): string {
  return text
    .split("\n")
    .map((row) => (row.length > cols ? `${row.slice(0, cols - 2)}…)` : row))
    .join("\n");
}

const REPORT = [
  "⏺ I traced the failing install to a stale lockfile entry for esbuild, which pins a platform binary that no longer exists upstream.",
  "⏺ Bash(npm install --no-audit --prefer-offline --registry https://registry.npmjs.org/ esbuild@0.25.4)",
  "  ⎿  added 1 package in 3s",
  "⏺ The install passes now. Want me to commit the lockfile change?",
].join("\n");

/** Claude Code's way: tool calls cut at the edge, prose wrapped. */
function screen(body: string, cols: number): string {
  const rule = "─".repeat(cols);
  const rows = body
    .split("\n")
    .map((line) => (line.startsWith("⏺ Bash(") ? cut(line, cols) : wrap(line, cols)));
  return [...rows, "", rule, "❯ ", rule, "  ⏵⏵ accept edits on"].join("\n");
}

describe("sameAfterReflow", () => {
  it("reads a screen re-wrapped and re-cut for another width as the same screen", () => {
    expect(screen(REPORT, 64)).toContain("…)");
    expect(sameAfterReflow(reflowPrint(screen(REPORT, 120)), reflowPrint(screen(REPORT, 64)))).toBe(
      true
    );
    expect(sameAfterReflow(reflowPrint(screen(REPORT, 64)), reflowPrint(screen(REPORT, 140)))).toBe(
      true
    );
  });

  it("reads a taller or shorter pane, showing more or less of what came before, as the same", () => {
    const earlier = "⏺ Read 4 files and ran the unit tests for the installer.\n";
    expect(
      sameAfterReflow(reflowPrint(screen(REPORT, 100)), reflowPrint(screen(earlier + REPORT, 100)))
    ).toBe(true);
    expect(
      sameAfterReflow(reflowPrint(screen(earlier + REPORT, 100)), reflowPrint(screen(REPORT, 100)))
    ).toBe(true);
  });

  it("tells a prompt that changed by a word from the same prompt redrawn", () => {
    const changed = REPORT.replace("commit the lockfile", "revert the lockfile");
    expect(
      sameAfterReflow(reflowPrint(screen(REPORT, 120)), reflowPrint(screen(changed, 64)))
    ).toBe(false);
    const command = REPORT.replace("esbuild@0.25.4", "esbuild@0.25.5");
    expect(
      sameAfterReflow(reflowPrint(screen(REPORT, 140)), reflowPrint(screen(command, 140)))
    ).toBe(false);
  });

  it("counts new output at the bottom as a change, whatever the width", () => {
    const more = `${REPORT}\n⏺ Committed as 3f2a91c.`;
    expect(sameAfterReflow(reflowPrint(screen(REPORT, 100)), reflowPrint(screen(more, 80)))).toBe(
      false
    );
  });

  it("never matches two different screens", () => {
    const other = "⏺ Running the migration against the staging database now.\n  ⎿  42 rows updated";
    expect(sameAfterReflow(reflowPrint(screen(REPORT, 100)), reflowPrint(screen(other, 100)))).toBe(
      false
    );
  });

  it("ignores a ticking timer, as the screen's hash does", () => {
    const at = (s: number) => `${REPORT}\n\n✻ Testing… (${s}s · esc to interrupt)`;
    expect(sameAfterReflow(reflowPrint(screen(at(12), 120)), reflowPrint(screen(at(15), 80)))).toBe(
      true
    );
  });

  it("reads a much taller pane, with whole screens more of what came before, as the same", () => {
    const earlier = Array.from(
      { length: 12 },
      (_, i) => `⏺ Read src/recipes/step${i}.ts and checked its rounding against the fixtures.`
    ).join("\n");
    expect(
      sameAfterReflow(
        reflowPrint(screen(REPORT, 100)),
        reflowPrint(screen(`${earlier}\n${REPORT}`, 100))
      )
    ).toBe(true);
  });

  it("tells a question whose first word changed from the same question shorn at the top", () => {
    const ask = (verb: string) =>
      `${verb} the production migration now, or wait for the release window tonight?`;
    expect(
      sameAfterReflow(
        reflowPrint(screen(ask("Commit"), 100)),
        reflowPrint(screen(ask("Revert"), 64))
      )
    ).toBe(false);
  });

  it("never lets a cut line excuse a change before the cut", () => {
    const approval = (command: string) =>
      `⏺ Bash(${command} -- --reporter=verbose src/recipes/scaleRecipe.test.ts)\nDo you want to proceed?\n❯ 1. Yes\n  2. No`;
    expect(
      sameAfterReflow(
        reflowPrint(screen(approval("npm test"), 40)),
        reflowPrint(screen(approval("npm build"), 40))
      )
    ).toBe(false);
  });

  it("keeps the spaces between a command's words", () => {
    expect(
      sameAfterReflow(
        reflowPrint("⏺ Bash(cat a b)\nDo you want to proceed?"),
        reflowPrint("⏺ Bash(cat ab)\nDo you want to proceed?")
      )
    ).toBe(false);
  });
});
