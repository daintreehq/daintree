import { describe, expect, it } from "vitest";
import { CLAUDE_RESTART_REFUSAL_HEADS, findClaudeRestartRefusal } from "../claudeRestartLines.js";

/** What follows `/restart` in a Claude Code pane: its echo, then its result under the gutter. */
const answered = (...result: string[]) =>
  ["❯ /restart", ...result, "", "─".repeat(60), "❯ ", "─".repeat(60), "  ? for shortcuts"].join(
    "\n"
  );

// Full lines as Claude Code 2.1.328 prints them, with the parts it fills in
// (a folder, a version) given real-looking values.
const REFUSALS = [
  "Can't restart automatically. Type /restart at the prompt.",
  "Can't restart while work is running in the background. Wait for it to finish or stop it in /tasks, then try again.",
  "Can't restart while Remote Control is connected. Disconnect it, then try again.",
  "Can't restart this session. It isn't saved to disk, so there's nothing to resume.",
  "Can't restart this session here. Its folder, /Users/me/code/app, can't be found. Open it again, then try again.",
  "Can't restart. The installed version wasn't found. Run claude update, then try again.",
  "Can't restart on the installed version. Version 2.1.329 is on hold, so this session keeps 2.1.328.",
];

describe("findClaudeRestartRefusal", () => {
  it("knows every refusal head the shipped CLI prints", () => {
    // Written out here, not read from the list: a head dropped from it must fail.
    expect([...CLAUDE_RESTART_REFUSAL_HEADS].sort()).toEqual(
      [
        "Can't restart automatically.",
        "Can't restart while work is running in the background.",
        "Can't restart while Remote Control is connected.",
        "Can't restart this session. It isn't saved to disk,",
        "Can't restart this session here.",
        "Can't restart. The installed version wasn't found.",
        "Can't restart on the installed version.",
      ].sort()
    );
  });

  it.each(REFUSALS)("quotes %s exactly as drawn", (line) => {
    expect(findClaudeRestartRefusal(answered(`  ⎿  ${line}`))).toBe(line);
  });

  it("joins a refusal Claude wrapped onto rows indented to its first word", () => {
    const text = answered(
      "  ⎿  Can't restart this session here. Its folder,",
      "     /Users/me/code/a-very-long-project-name, can't be found.",
      "     Open it again, then try again."
    );
    expect(findClaudeRestartRefusal(text)).toBe(
      "Can't restart this session here. Its folder, /Users/me/code/a-very-long-project-name, can't be found. Open it again, then try again."
    );
  });

  it("stops a wrapped refusal at the next thing Claude draws", () => {
    const text = [
      "  ⎿  Can't restart automatically. Type /restart at the prompt.",
      "     ⎿  something else",
    ].join("\n");
    expect(findClaudeRestartRefusal(text)).toBe(
      "Can't restart automatically. Type /restart at the prompt."
    );
  });

  it("reads one printed without the gutter, and with a typographic apostrophe", () => {
    expect(
      findClaudeRestartRefusal("Can’t restart automatically. Type /restart at the prompt.")
    ).toBe("Can’t restart automatically. Type /restart at the prompt.");
  });

  it("names the first refusal when two are on screen", () => {
    const text = answered(`  ⎿  ${REFUSALS[1]}`, `  ⎿  ${REFUSALS[0]}`);
    expect(findClaudeRestartRefusal(text)).toBe(REFUSALS[1]);
  });

  it.each([
    ["a successful update", "  ⎿  Successfully updated from 2.1.328 to version 2.1.329"],
    ["a resumed session", "  ⎿  Session resumed"],
    [
      "an agent reply that opens the same way",
      "⏺ Can't restart the dev server until the port frees.",
    ],
    ["the phrase mid-sentence", "  ⎿  It said it can't restart right now."],
    ["a longer word", "  ⎿  Can't restarting"],
  ])("finds nothing in %s", (_name, row) => {
    expect(findClaudeRestartRefusal(answered(row))).toBeNull();
  });

  it("finds nothing in empty output", () => {
    expect(findClaudeRestartRefusal("")).toBeNull();
  });

  it("reads only below the last echo of the command", () => {
    const text = ["❯ /restart", `  ⎿  ${REFUSALS[0]}`, "❯ /restart", `  ⎿  ${REFUSALS[1]}`].join(
      "\n"
    );
    expect(findClaudeRestartRefusal(text)).toBe(REFUSALS[1]);
    expect(findClaudeRestartRefusal(text.split("\n").slice(0, 3).join("\n"))).toBeNull();
  });

  it.each([
    ["a boxed result", "│ ⎿  ", "│    "],
    ["a result at another indent", "⎿ ", "  "],
  ])("joins the wrap of %s", (_name, gutter, indent) => {
    const text = answered(
      `${gutter}Can't restart this session here. Its folder,`,
      `${indent}/a/b, can't be found.`
    );
    expect(findClaudeRestartRefusal(text)).toBe(
      "Can't restart this session here. Its folder, /a/b, can't be found."
    );
  });

  it("stops a wrap at a row in another column", () => {
    const text = [
      "  ⎿  Can't restart automatically. Type /restart at the prompt.",
      "  unrelated",
    ].join("\n");
    expect(findClaudeRestartRefusal(text)).toBe(
      "Can't restart automatically. Type /restart at the prompt."
    );
  });

  it("reads a typographic apostrophe under the gutter too", () => {
    expect(findClaudeRestartRefusal(answered("  ⎿  Can’t restart while it runs."))).toBe(
      "Can’t restart while it runs."
    );
  });

  it.each([
    ["an unknown head without the gutter", "Can't restart the dev server until the port frees."],
    ["the phrase mid-sentence, capitalised", "  ⎿  It said Can't restart right now."],
  ])("finds nothing in %s", (_name, row) => {
    expect(findClaudeRestartRefusal(answered(row))).toBeNull();
  });

  it("reads nothing from the composer, where a draft can read /restart too", () => {
    const text = [
      "❯ /restart",
      `  ⎿  ${REFUSALS[0]}`,
      "",
      "─".repeat(60),
      "❯ /restart",
      "─".repeat(60),
    ].join("\n");
    expect(findClaudeRestartRefusal(text)).toBe(REFUSALS[0]);
  });

  it("takes a rule above the echo for transcript, not the composer", () => {
    const text = ["─".repeat(60), "❯ /restart", `  ⎿  ${REFUSALS[0]}`].join("\n");
    expect(findClaudeRestartRefusal(text)).toBe(REFUSALS[0]);
  });

  it("reads a long rule followed by text in linear time", () => {
    const row = `${"─".repeat(20_000)}x`;
    const started = performance.now();
    expect(findClaudeRestartRefusal([row, row, row].join("\n"))).toBeNull();
    expect(performance.now() - started).toBeLessThan(500);
  });
});
