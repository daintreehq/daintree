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

const HINT = " Esc to cancel · Tab to amend";

describe("listChoices", () => {
  it("lists a Claude permission dialog's options in order, without the heading or footer", () => {
    const screen = [
      " Do you want to proceed?",
      " ❯ 1. Yes",
      "   2. Yes, and don't ask again for this command",
      "   3. No, and tell Claude what to do differently (esc)",
      "",
      HINT,
    ].join("\n");
    expect(listChoices(screen)).toEqual([
      "Yes",
      "Yes, and don't ask again for this command",
      "No, and tell Claude what to do differently (esc)",
    ]);
  });

  it("keeps a wrapped option one option, with a checklist drawn beneath the dialog", () => {
    const screen = [
      "Do you want to make this edit to units.ts?",
      "❯ 1. Yes",
      "  2. Yes, and switch to accept edits (auto-approve file edits and common file",
      "  commands) for this session (shift+tab)",
      "  3. No",
      "",
      HINT,
      "",
      "  6 tasks (4 done, 1 in progress, 1 open)",
      "  ◼ Fix test failures",
      "  ✔ Update README",
    ].join("\n");
    expect(listChoices(screen)).toEqual([
      "Yes",
      "Yes, and switch to accept edits (auto-approve file edits and common file",
      "No",
    ]);
    expect(planListedChoice(screen, "No")).toEqual({ ok: true, keys: ["Down", "Down", "Enter"] });
  });

  it("reads Codex's approval, whose other options sit left of the highlight", () => {
    const screen = [
      "Would you like to run the following command?",
      "",
      "$ rtk npm test",
      "",
      "› 1. Yes, proceed (y)",
      "2. No, and tell Codex what to do differently (esc)",
      "",
      "Press enter to confirm or esc to cancel",
    ].join("\n");
    expect(listChoices(screen)).toEqual([
      "Yes, proceed (y)",
      "No, and tell Codex what to do differently (esc)",
    ]);
  });

  it("skips the description column", () => {
    const screen = [
      "  › 1. Allow                   Run the tool",
      "                               and continue",
      "    2. Allow for this session  Run the tool",
      "    3. Always allow            Run the tool",
      "",
      "  enter to confirm",
    ].join("\n");
    expect(listChoices(screen)).toEqual(["Allow", "Allow for this session", "Always allow"]);
  });

  it("reads a boxed dialog from inside its frame", () => {
    const screen = [
      "╭─────────────────────────────╮",
      "│ Allow execution?            │",
      "│ ● 1. Yes, allow once        │",
      "│   2. Yes, allow always      │",
      "│   3. No                     │",
      "│ (Use Enter to select)       │",
      "╰─────────────────────────────╯",
    ].join("\n");
    expect(listChoices(screen)).toEqual(["Yes, allow once", "Yes, allow always", "No"]);
  });
});

describe("listChoices refuses what isn't a dialog asking now", () => {
  it("doesn't take a quote above a numbered list for a dialog", () => {
    const screen = ["> Summary", "  1. Keep files", "  2. Delete files", "", HINT].join("\n");
    expect(listChoices(screen)).toEqual([]);
  });

  it("offers nothing from an old dialog once the input box is back below it", () => {
    const screen = ["  1. Yes", "❯ 2. No", "", HINT, "", "❯ "].join("\n");
    expect(listChoices(screen)).toEqual([]);
  });

  it("offers nothing for a composer, one line or several, numbered or not", () => {
    expect(listChoices(["› Write tests for the parser", "", HINT].join("\n"))).toEqual([]);
    expect(
      listChoices(["❯ Write tests for the parser", "  and run the suite", "", HINT].join("\n"))
    ).toEqual([]);
    const draft = ["─".repeat(40), "❯ 1. fix the parser", "  2. add tests", "─".repeat(40), HINT];
    expect(listChoices(draft.join("\n"))).toEqual([]);
  });

  it("offers nothing for an unnumbered list, which a composer can't be told from", () => {
    expect(listChoices(["❯ No, exit", "  Yes, I trust this folder", "", HINT].join("\n"))).toEqual(
      []
    );
  });

  it("offers nothing without the dialog's key hint under it", () => {
    expect(listChoices(["❯ 1. Yes", "  2. No"].join("\n"))).toEqual([]);
    expect(listChoices(["❯ 1. Yes", "  2. No", "", "esc to interrupt"].join("\n"))).toEqual([]);
  });

  it("offers nothing while a newer list below has no highlight drawn yet", () => {
    const screen = ["❯ 1. Yes", "  2. No", "", HINT, "", "  1. Allow", "  2. Deny"].join("\n");
    expect(listChoices(screen)).toEqual([]);
  });

  it("refuses a list that skips a number, and labels that repeat", () => {
    expect(listChoices(["❯ 1. Yes", "  3. No", "", HINT].join("\n"))).toEqual([]);
    expect(listChoices(["❯ 1. Yes", "  2. yes", "", HINT].join("\n"))).toEqual([]);
  });

  it("offers nothing for an echoed answer or an empty screen", () => {
    expect(listChoices("> answered: Yes, I trust this folder")).toEqual([]);
    expect(listChoices("")).toEqual([]);
  });
});

describe("planListedChoice", () => {
  it("moves within the lowest dialog, not toward an older highlight above it", () => {
    const screen = [
      "❯ 1. Old",
      "  2. Old alternative",
      "",
      "  1. A",
      "  2. B",
      "  3. C",
      "  4. D",
      "❯ 5. E",
      "",
      HINT,
    ].join("\n");
    expect(listChoices(screen)).toEqual(["A", "B", "C", "D", "E"]);
    expect(planListedChoice(screen, "A")).toEqual({
      ok: true,
      keys: ["Up", "Up", "Up", "Up", "Enter"],
    });
  });

  it("matches an option row, never a description that repeats its label", () => {
    const screen = ["❯ 1. Allow", "  2. Deny", "     Allow", "", HINT].join("\n");
    expect(planListedChoice(screen, "Allow")).toEqual({ ok: true, keys: ["Enter"] });
    expect(planListedChoice(screen, "Deny")).toEqual({ ok: true, keys: ["Down", "Enter"] });
  });

  it("takes only a whole label, so text beside an empty composer presses nothing", () => {
    expect(planListedChoice("Previous output\n❯ ", "Previous output")).toMatchObject({
      ok: false,
    });
    const dialog = ["❯ 1. Yes", "  2. Yes, and don't ask again", "", HINT].join("\n");
    expect(planListedChoice(dialog, "Yes, and")).toMatchObject({ ok: false });
  });

  it("plans every listed label onto its own row", () => {
    const screen = [
      "   1. Yes",
      " ❯ 2. Yes, and don't ask again for this command",
      "   3. No, and tell Claude what to do differently (esc)",
      "",
      HINT,
    ].join("\n");
    const keys = listChoices(screen).map((label) => planListedChoice(screen, label));
    expect(keys).toEqual([
      { ok: true, keys: ["Up", "Enter"] },
      { ok: true, keys: ["Enter"] },
      { ok: true, keys: ["Down", "Enter"] },
    ]);
  });
});

describe("listed choices as they were shown", () => {
  const masked = (label: string) => label.replace(/\d{4,}/g, "[redacted]");

  it("offers each label as shown and presses the raw option it was shown for", () => {
    const screen = ["❯ 1. Yes", "  2. Use key 123456", "  3. No", "", HINT].join("\n");
    expect(listChoices(screen, masked)).toEqual(["Yes", "Use key [redacted]", "No"]);
    expect(planListedChoice(screen, "Use key [redacted]", masked)).toEqual({
      ok: true,
      keys: ["Down", "Enter"],
    });
    // The raw label never reached the asker, so it answers nothing.
    expect(planListedChoice(screen, "Use key 123456", masked)).toMatchObject({ ok: false });
  });

  it("offers and answers nothing when two options read the same once shown", () => {
    const screen = ["❯ 1. Use key 123456", "  2. Use key 987654", "  3. No", "", HINT].join("\n");
    expect(listChoices(screen, masked)).toEqual([]);
    const plan = planListedChoice(screen, "No", masked);
    expect(plan).toMatchObject({ ok: false });
    expect(JSON.stringify(plan)).not.toMatch(/123456|987654/);
  });
});
