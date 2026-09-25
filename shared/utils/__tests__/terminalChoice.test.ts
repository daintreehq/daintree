import { describe, expect, it } from "vitest";
import { planChoice } from "../terminalChoice.js";

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

  it("refuses rather than guessing when the label or the highlight is missing", () => {
    expect(planChoice("❯ No, exit\n  Maybe", "Yes")).toMatchObject({ ok: false });
    expect(planChoice("No, exit\nYes, I trust this folder", "Yes")).toMatchObject({ ok: false });
  });
});
