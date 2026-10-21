import { describe, expect, it } from "vitest";
import { listChoices, planChoice, planListedChoice } from "../terminalChoice.js";

describe("planChoice", () => {
  it("moves down past the highlighted default on Claude's trust dialog", () => {
    const screen = [
      " Claude Code'll be able to read, edit, and execute files here.",
      "",
      " ❯ No, exit",
      "   Yes, I trust this folder",
      "",
      " Enter to confirm · Esc to cancel",
    ].join("\n");
    expect(planChoice(screen, "Yes, I trust this folder")).toEqual({
      ok: true,
      keys: ["Down", "Enter"],
    });
  });

  it("only confirms when the wanted option is already highlighted", () => {
    const screen = ["› 1. Trust and continue", "  2. Quit", "  enter continue · esc quit"].join(
      "\n"
    );
    expect(planChoice(screen, "Trust and continue")).toEqual({ ok: true, keys: ["Enter"] });
  });

  it("moves up to an option above the highlight", () => {
    const screen = ["  Yes, I trust this folder", "> No, exit"].join("\n");
    expect(planChoice(screen, "yes, i trust")).toEqual({ ok: true, keys: ["Up", "Enter"] });
  });

  it("does not count a wrapped description as an option", () => {
    const screen = [
      "  › 1. Allow                   Run the tool",
      "                               and continue",
      "    2. Allow for this session  Run the tool",
      "                               and remember",
      "    3. Always allow            Run the tool",
    ].join("\n");
    expect(planChoice(screen, "Always allow")).toEqual({
      ok: true,
      keys: ["Down", "Down", "Enter"],
    });
  });

  it("matches option rows, not headings or echoed text that contain the label", () => {
    const screen = [
      "Yes, I trust this folder is the safe choice here",
      "❯ 1. No, exit",
      "  2. Yes, I trust this folder",
      "",
      "> answered: Yes, I trust this folder",
    ].join("\n");
    expect(planChoice(screen, "Yes, I trust this folder")).toEqual({
      ok: true,
      keys: ["Down", "Enter"],
    });
  });

  it("takes an exact label over a longer one, and the newest dialog over an old one", () => {
    const screen = [
      "  › 1. Allow                   Run the tool",
      "    2. Allow for this session  Run the tool",
      "",
      "  1. Allow                     Run the tool",
      "  › 2. Allow for this session  Run the tool",
    ].join("\n");
    expect(planChoice(screen, "Allow")).toEqual({ ok: true, keys: ["Up", "Enter"] });
  });

  it("refuses a label two options fit equally well", () => {
    const screen = ["❯ Yes, once", "  Yes, always", "  No"].join("\n");
    expect(planChoice(screen, "Yes")).toMatchObject({ ok: false });
  });

  it("refuses rather than guessing when the label or the highlight is missing", () => {
    expect(planChoice("❯ No, exit\n  Maybe", "Yes")).toMatchObject({ ok: false });
    expect(planChoice("No, exit\nYes, I trust this folder", "Yes")).toMatchObject({ ok: false });
  });

  it("reads a choice Gemini CLI draws inside a box", () => {
    const screen = [
      " ╭─────────────────────────────────────────────────────────────╮",
      " │ Do you trust this folder?                                   │",
      " │                                                             │",
      " │ ● 1. Yes                                                    │",
      " │   2. Yes, and remember the directories as trusted           │",
      " │   3. No                                                     │",
      " ╰─────────────────────────────────────────────────────────────╯",
    ].join("\n");
    expect(planChoice(screen, "Yes")).toEqual({ ok: true, keys: ["Enter"] });
    expect(planChoice(screen, "No")).toEqual({ ok: true, keys: ["Down", "Down", "Enter"] });
    expect(planChoice(screen, "Yes, and remember")).toEqual({
      ok: true,
      keys: ["Down", "Enter"],
    });
  });

  it("leaves a row that only starts with a bar alone", () => {
    const screen = ["❯ No", "│ Yes"].join("\n");
    expect(planChoice(screen, "Yes")).toEqual({
      ok: false,
      reason: 'No option "Yes" is on the screen.',
    });
  });
});

describe("listChoices", () => {
  it("lists a permission dialog's options in order, without the heading or footer", () => {
    const screen = [
      " Do you want to proceed?",
      " ❯ 1. Yes",
      "   2. Yes, and don't ask again for this command",
      "   3. No, and tell Claude what to do differently (esc)",
      "",
      " Enter to confirm · Esc to cancel",
    ].join("\n");
    expect(listChoices(screen)).toEqual([
      "Yes",
      "Yes, and don't ask again for this command",
      "No, and tell Claude what to do differently (esc)",
    ]);
  });

  it("skips wrapped descriptions and the description column", () => {
    const screen = [
      "  › 1. Allow                   Run the tool",
      "                               and continue",
      "    2. Allow for this session  Run the tool",
      "    3. Always allow            Run the tool",
    ].join("\n");
    expect(listChoices(screen)).toEqual(["Allow", "Allow for this session", "Always allow"]);
  });

  it("reads a boxed dialog from inside its frame", () => {
    const screen = [
      "│ Allow execution?            │",
      "│ ● 1. Yes, allow once        │",
      "│   2. Yes, allow always      │",
      "│   3. No                     │",
    ].join("\n");
    expect(listChoices(screen)).toEqual(["Yes, allow once", "Yes, allow always", "No"]);
  });

  it("lists only labels a press can reach, every one of them", () => {
    const screen = ["❯ No, exit", "  Yes, I trust this folder"].join("\n");
    const labels = listChoices(screen);
    expect(labels).toEqual(["No, exit", "Yes, I trust this folder"]);
    for (const label of labels) expect(planChoice(screen, label).ok).toBe(true);
  });

  it("offers nothing for a lone highlighted row, an echoed answer or a screen with no list", () => {
    expect(listChoices("> answered: Yes, I trust this folder")).toEqual([]);
    expect(listChoices("Working on it…\n\n> ")).toEqual([]);
    expect(listChoices("")).toEqual([]);
  });

  it("keeps a short label beside a longer one it prefixes, since each matches exactly", () => {
    const screen = ["❯ Yes", "  Yes, always", "  No"].join("\n");
    expect(listChoices(screen)).toEqual(["Yes", "Yes, always", "No"]);
  });
});

describe("listChoices refuses what isn't the current list", () => {
  it("doesn't take a quote above a numbered list for a list", () => {
    const screen = ["> Summary", "  1. Keep files", "  2. Delete files"].join("\n");
    expect(listChoices(screen)).toEqual([]);
  });

  it("offers nothing from an old dialog once the input box is back below it", () => {
    const screen = ["  1. Yes", "❯ 2. No", "", "❯ "].join("\n");
    expect(listChoices(screen)).toEqual([]);
  });

  it("offers nothing when the composer holds text", () => {
    const screen = ["  1. Yes", "❯ 2. No", "", "› Write tests for the parser"].join("\n");
    expect(listChoices(screen)).toEqual([]);
  });

  it("offers nothing while a newer list below has no highlight drawn yet", () => {
    const screen = ["❯ 1. Yes", "  2. No", "", "  1. Allow", "  2. Deny"].join("\n");
    expect(listChoices(screen)).toEqual([]);
  });

  it("refuses a numbered list that skips a number, and labels that repeat", () => {
    expect(listChoices(["❯ 1. Yes", "  3. No"].join("\n"))).toEqual([]);
    expect(listChoices(["❯ Yes", "  yes"].join("\n"))).toEqual([]);
  });
});

describe("planListedChoice", () => {
  it("moves within the lowest list, not toward an older highlight above it", () => {
    const screen = ["❯ Old", "  Old alternative", "", "  A", "  B", "  C", "  D", "❯ E"].join("\n");
    expect(listChoices(screen)).toEqual(["A", "B", "C", "D", "E"]);
    expect(planListedChoice(screen, "A")).toEqual({
      ok: true,
      keys: ["Up", "Up", "Up", "Up", "Enter"],
    });
  });

  it("matches an option row, never a description that repeats its label", () => {
    const screen = ["❯ 1. Allow", "  2. Deny", "     Allow"].join("\n");
    expect(planListedChoice(screen, "Allow")).toEqual({ ok: true, keys: ["Enter"] });
    expect(planListedChoice(screen, "Deny")).toEqual({ ok: true, keys: ["Down", "Enter"] });
  });

  it("takes only a whole label, so text beside an empty composer presses nothing", () => {
    expect(planListedChoice("Previous output\n❯ ", "Previous output")).toMatchObject({ ok: false });
    const dialog = ["❯ 1. Yes", "  2. Yes, and don't ask again"].join("\n");
    expect(planListedChoice(dialog, "Yes, and")).toMatchObject({ ok: false });
  });

  it("plans every listed label onto its own row", () => {
    const screen = [
      " ❯ 1. Yes",
      "   2. Yes, and don't ask again for this command",
      "   3. No, and tell Claude what to do differently (esc)",
    ].join("\n");
    const keys = listChoices(screen).map((label) => planListedChoice(screen, label));
    expect(keys).toEqual([
      { ok: true, keys: ["Enter"] },
      { ok: true, keys: ["Down", "Enter"] },
      { ok: true, keys: ["Down", "Down", "Enter"] },
    ]);
  });
});
