import { describe, expect, it } from "vitest";
import { glanceScreen } from "../canopyGlance.js";
import { prepareScreen } from "../canopyScreen.js";

const glance = (rows: string[], cols?: number) =>
  glanceScreen(prepareScreen(rows.join("\n"), cols).lines);

describe("glanceScreen", () => {
  it("takes Claude Code's recap, without its settings hint", () => {
    const g = glance(
      [
        "⏺ All 5 runs failed. Each run had the same 2 test failures:",
        "",
        "✻ Churned for 12s · done 8:54",
        "",
        "※ recap: You ran npm test five times sequentially. All five runs failed",
        "consistently. Next: fix the fractional scaling bugs. (disable recaps",
        "in /config)",
      ],
      72
    );
    expect(g.recap).toBe(
      "You ran npm test five times sequentially. All five runs failed consistently. Next: fix the fractional scaling bugs."
    );
    expect(g.said).toBe("All 5 runs failed. Each run had the same 2 test failures:");
  });

  it("ignores a recap from before the newest request", () => {
    const g = glance([
      "※ recap: Documented the endpoints.",
      "",
      "❯ now add a health check",
      "",
      "✻ Channeling…",
    ]);
    expect(g.recap).toBeNull();
  });

  it("reads Codex's report from the first bullet after its last tool call", () => {
    const g = glance(
      [
        "• Ran rtk git status --short --branch",
        "  └ * firstrun/fr-f",
        "    clean — nothing to commit",
        "",
        "• Committed as b923ea3: extracted toBaseAmount and fromBaseAmount, preserving",
        "  behavior.",
        "",
        "• Working tree is clean.",
        "",
        "Worked for 1m 22s • 08:55",
      ],
      80
    );
    expect(g.said).toBe(
      "Committed as b923ea3: extracted toBaseAmount and fromBaseAmount, preserving behavior."
    );
  });

  it("does not take a past-tense report for a tool call", () => {
    const g = glance([
      "⏺ Update(README.md)",
      "  ⎿  Updated README.md with 30 additions",
      "",
      "⏺ Added an API Endpoints section to README.md documenting both endpoints.",
      "",
      "✻ Brewed for 13s · done 8:54",
    ]);
    expect(g.said).toBe("Added an API Endpoints section to README.md documenting both endpoints.");
  });

  it("names the step a working agent is on, not Claude's whimsical spinner word", () => {
    const g = glance([
      "⏺ I'll examine the current rounding logic for cup amounts in src/units.ts.",
      "",
      "⏺ Reading 1 file… (ctrl+o to expand)",
      "  ⎿  src/units.ts",
      "",
      "✽ Twisting… (3s · ↓ 191 tokens · thought for 1s)",
    ]);
    expect(g.doing).toBe("Reading 1 file: src/units.ts");
    expect(g.said).toBe("I'll examine the current rounding logic for cup amounts in src/units.ts.");
  });

  it("prefers a spinner that names its step, and the checklist item in progress", () => {
    expect(glance(["✻ Running the settings tests… (12s · esc to interrupt)"]).doing).toBe(
      "Running the settings tests"
    );
    expect(
      glance([
        "⏺ Bash(npm test)",
        "",
        "✻ Channeling… (3s · esc to interrupt)",
        "  ⎿  ◼ Write the scale tests",
      ]).doing
    ).toBe("Write the scale tests");
  });

  it("takes no finished tool call for the step a working agent is on", () => {
    const g = glance([
      "• The server has no POST handlers yet; I'll add them with validation.",
      "",
      "• Ran rtk npm test",
      "  └ 14 passed",
      "",
      "• Working (22s • esc to interrupt)",
    ]);
    expect(g.doing).toBeNull();
    expect(g.said).toBe("The server has no POST handlers yet; I'll add them with validation.");
  });

  it("reads the command an approval would run, and no report from the dialog's hints", () => {
    const g = glance([
      "• Running rtk npm test",
      "",
      "Would you like to run the following command?",
      "",
      "$ rtk npm test",
      "",
      "› 1. Yes, proceed (y)",
      "2. No, and tell Codex what to do differently (esc)",
      "",
      "Press enter to confirm or esc to cancel",
    ]);
    expect(g.action).toBe("rtk npm test");
    expect(g.said).toBeNull();
  });

  it("takes no command from tool output above a dialog that runs none", () => {
    const g = glance([
      "• Ran cat RELEASING.md",
      "  └ $ npm publish --access public",
      "",
      "• Edited src/units.ts (+3 -1)",
      "",
      "Allow this edit?",
      "",
      "› 1. Yes",
      "2. No (esc)",
    ]);
    expect(g.action).toBeNull();
  });

  it("takes no `$` line that tool output drew above another call's dialog", () => {
    const g = glance([
      "• Ran cat RELEASING.md",
      "$ npm publish --access public",
      "• Edited src/units.ts (+3 -1)",
      "› 1. Yes",
      "2. No (esc)",
    ]);
    expect(g.action).toBeNull();
  });

  it("stays quick on a very long line", () => {
    const started = performance.now();
    glance(["⏺ Edited " + "/".repeat(20_000) + " with changes", "", "✻ Worked for 3s · done"]);
    expect(performance.now() - started).toBeLessThan(500);
  });

  it("says nothing for a banner's greeting", () => {
    const g = glance([">_ OpenAI Codex (v0.160.0)", "", "What are we getting into today?"]);
    expect(g).toEqual({ recap: null, said: null, doing: null, action: null });
  });
});
