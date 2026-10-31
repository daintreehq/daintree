import { describe, expect, it } from "vitest";
import {
  listChoices,
  parseChoiceList,
  planChoice,
  planListedChoice,
  type ChoicePlan,
} from "../terminalChoice.js";

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
    expect(planChoice(screen, "Yes, I trust this folder")).toMatchObject({
      ok: true,
      keys: ["Down", "Enter"],
    });
  });

  it("only confirms when the wanted option is already highlighted", () => {
    const screen = ["› 1. Trust and continue", "  2. Quit", "  enter continue · esc quit"].join(
      "\n"
    );
    expect(planChoice(screen, "Trust and continue")).toMatchObject({ ok: true, keys: ["Enter"] });
  });

  it("moves up to an option above the highlight", () => {
    const screen = ["  Yes, I trust this folder", "> No, exit"].join("\n");
    expect(planChoice(screen, "yes, i trust")).toMatchObject({ ok: true, keys: ["Up", "Enter"] });
  });

  it("does not count a wrapped description as an option", () => {
    const screen = [
      "  › 1. Allow                   Run the tool",
      "                               and continue",
      "    2. Allow for this session  Run the tool",
      "                               and remember",
      "    3. Always allow            Run the tool",
    ].join("\n");
    expect(planChoice(screen, "Always allow")).toMatchObject({
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
    expect(planChoice(screen, "Yes, I trust this folder")).toMatchObject({
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
    expect(planChoice(screen, "Allow")).toMatchObject({ ok: true, keys: ["Up", "Enter"] });
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
    expect(planChoice(screen, "Yes")).toMatchObject({ ok: true, keys: ["Enter"] });
    expect(planChoice(screen, "No")).toMatchObject({ ok: true, keys: ["Down", "Down", "Enter"] });
    expect(planChoice(screen, "Yes, and remember")).toMatchObject({
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
    expect(planListedChoice(screen, "No")).toMatchObject({
      ok: true,
      keys: ["Down", "Down", "Enter"],
    });
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
    expect(planListedChoice(screen, "A")).toMatchObject({
      ok: true,
      keys: ["Up", "Up", "Up", "Up", "Enter"],
    });
  });

  it("matches an option row, never a description that repeats its label", () => {
    const screen = ["❯ 1. Allow", "  2. Deny", "     Allow", "", HINT].join("\n");
    expect(planListedChoice(screen, "Allow")).toMatchObject({ ok: true, keys: ["Enter"] });
    expect(planListedChoice(screen, "Deny")).toMatchObject({ ok: true, keys: ["Down", "Enter"] });
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
    expect(keys).toMatchObject([
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
    expect(planListedChoice(screen, "Use key [redacted]", masked)).toMatchObject({
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

describe("the question a list asks", () => {
  const permission = (command: string, highlighted: number) =>
    [
      "  Earlier output the agent printed",
      "────────────────────────────────────────",
      " Bash command",
      "",
      `   ${command}`,
      "   Remove the build directory",
      "",
      " Do you want to proceed?",
      ...["Yes", "Yes, and don't ask again for this command", "No"].map(
        (label, i) => `${i + 1 === highlighted ? " ❯" : "  "} ${i + 1}. ${label}`
      ),
      "",
      HINT,
    ].join("\n");
  const questionOf = (plan: ChoicePlan) => (plan.ok ? plan.question : null);

  it("stays the same wherever the highlight is", () => {
    const top = parseChoiceList(permission("rm -rf build", 1))!;
    const bottom = parseChoiceList(permission("rm -rf build", 3))!;
    expect(bottom.cursor).toBe(2);
    expect(bottom.question).toBe(top.question);
    expect(questionOf(planListedChoice(permission("rm -rf build", 3), "Yes"))).toBe(top.question);
  });

  it("differs for another command offering the same options", () => {
    const first = parseChoiceList(permission("rm -rf build", 1))!;
    const next = parseChoiceList(permission("git push --force", 1))!;
    expect(next.labels).toEqual(first.labels);
    expect(next.question).not.toBe(first.question);
  });

  it("reads up to the dialog's edge and never below the options", () => {
    const question = parseChoiceList(permission("rm -rf build", 1))!.question;
    expect(question).toContain("rm -rf build");
    expect(question).not.toContain("Earlier output");
    const changedAround = permission("rm -rf build", 1)
      .replace("Earlier output the agent printed", "Other output")
      .replace(HINT, " Esc to cancel · 3 tasks running");
    expect(parseChoiceList(changedAround)!.question).toBe(question);
  });

  it("keeps the command as drawn: a leading > or a changed indent is a different question", () => {
    const ask = (body: string[]) =>
      [
        "────────────────────────────────────────",
        " Bash command",
        "",
        ...body,
        "",
        " Do you want to proceed?",
        " ❯ 1. Yes",
        "   2. No",
        "",
        HINT,
      ].join("\n");
    const question = (body: string[]) => parseChoiceList(ask(body))!.question;
    expect(question(["   > /tmp/task.sh"])).not.toBe(question(["   /tmp/task.sh"]));
    expect(question(["   if ok:", "       run()"])).not.toBe(question(["   if ok:", "   run()"]));
  });

  it("reads past a divider inside the command, and the whole of a long one", () => {
    const heredoc = (target: string) =>
      permission("rm -rf build", 1).replace(
        "   rm -rf build",
        [`   cat > ${target} <<'EOF'`, "   ────────────────", "   EOF"].join("\n")
      );
    expect(parseChoiceList(heredoc("/tmp/cache"))!.question).not.toBe(
      parseChoiceList(heredoc("~/.ssh/config"))!.question
    );
    const long = (first: string) =>
      permission("rm -rf build", 1).replace(
        "   rm -rf build",
        [`   ${first}`, ...Array.from({ length: 24 }, (_, i) => `   step ${i}`)].join("\n")
      );
    expect(parseChoiceList(long("cd ~/scratch"))!.question).not.toBe(
      parseChoiceList(long("cd ~/prod"))!.question
    );
  });

  it("reads past a divider inside a boxed command", () => {
    const boxed = (target: string) =>
      [
        "╭────────────────────────────────────╮",
        `│ cat > ${target} <<'EOF'`.padEnd(37) + "│",
        "│ ────────────────".padEnd(37) + "│",
        "│ EOF".padEnd(37) + "│",
        "│".padEnd(37) + "│",
        "│ ● 1. Yes".padEnd(37) + "│",
        "│   2. No".padEnd(37) + "│",
        "│".padEnd(37) + "│",
        "│ Enter to confirm".padEnd(37) + "│",
        "╰────────────────────────────────────╯",
      ].join("\n");
    expect(parseChoiceList(boxed("/tmp/cache"))!.question).not.toBe(
      parseChoiceList(boxed("~/.ssh/config"))!.question
    );
  });

  it("keeps the looser plan's command rows as drawn, and its options the same wherever the highlight is", () => {
    const ask = (command: string, highlighted: 1 | 2) =>
      [
        " Bash command",
        `   ${command}`,
        " Do you want to proceed?",
        `${highlighted === 1 ? " ❯" : "  "} 1. Yes`,
        `${highlighted === 2 ? " ❯" : "  "} 2. No`,
        "",
        " Esc to cancel",
      ].join("\n");
    const question = (screen: string, label: string) => questionOf(planChoice(screen, label));
    expect(question(ask("> /tmp/task.sh", 2), "Yes")).not.toBe(
      question(ask("/tmp/task.sh", 2), "Yes")
    );
    expect(question(ask("> /tmp/task.sh", 1), "Yes")).toBe(
      question(ask("> /tmp/task.sh", 2), "Yes")
    );
    // A heredoc's indentation above options drawn at the same indent.
    const heredoc = (line: string, highlighted: 1 | 2) =>
      [
        " Write hello.txt?",
        "",
        "   cat > hello.txt <<'EOF'",
        line,
        "   EOF",
        "",
        `${highlighted === 1 ? " ❯" : "  "} No`,
        `${highlighted === 2 ? " ❯" : "  "} Yes`,
      ].join("\n");
    expect(question(heredoc("   hello", 1), "Yes")).not.toBe(
      question(heredoc("    hello", 2), "Yes")
    );
    expect(question(heredoc("   hello", 1), "Yes")).toBe(question(heredoc("   hello", 2), "Yes"));
    // A newer list below an older numbered dialog is asked about on its own words.
    const below = (command: string) =>
      ["Old?", "❯ 1. No", "  2. Yes", "", HINT, "", ` Run ${command}?`, " No", " Yes"].join("\n");
    expect(question(below("safe-command"), "Yes")).not.toBe(question(below("rm -rf ~"), "Yes"));
    // Options a blank row apart: the highlight leaving one is still no other question.
    const apart = (onNo: boolean) =>
      [
        " Trust this folder?",
        onNo ? " ❯ No, exit" : "   No, exit",
        "",
        onNo ? "   Yes, I trust this folder" : " ❯ Yes, I trust this folder",
      ].join("\n");
    expect(question(apart(false), "Yes, I trust this folder")).toBe(
      question(apart(true), "Yes, I trust this folder")
    );
  });

  it("counts the last option's wrapped rows", () => {
    const scope = (wrapped: string) =>
      ["Which scope?", "❯ 1. Cancel", "  2. Allow", `     ${wrapped}`, "", HINT].join("\n");
    expect(parseChoiceList(scope("for this file only"))!.question).not.toBe(
      parseChoiceList(scope("for all repositories permanently"))!.question
    );
  });

  it("is the same for the looser plan wherever the highlight is, and differs with the prompt", () => {
    const trust = (highlightNo: boolean, folder: string) =>
      [
        ` Claude Code'll be able to read, edit, and execute files in ${folder}.`,
        "",
        highlightNo ? " ❯ No, exit" : "   No, exit",
        highlightNo ? "   Yes, I trust this folder" : " ❯ Yes, I trust this folder",
        "",
        " Enter to confirm · Esc to cancel",
      ].join("\n");
    const before = questionOf(planChoice(trust(true, "~/api"), "Yes, I trust this folder"));
    const after = questionOf(planChoice(trust(false, "~/api"), "Yes, I trust this folder"));
    expect(after).toBe(before);
    expect(questionOf(planChoice(trust(true, "~/web"), "Yes, I trust this folder"))).not.toBe(
      before
    );
  });
});
