import { describe, expect, it } from "vitest";
import { digestHistory } from "../canopyDigest.js";

describe("digestHistory", () => {
  it("lifts the user's wrapped request from a Claude echo, not npm's script banner", () => {
    const raw = [
      "❯ The unit rounding tests fail (cups and scaled amounts lose fractions). Fix src/units.ts",
      "so amounts keep sensible fractions, make npm test pass, and commit the fix.",
      "",
      "⏺ Bash(npm test)",
      "  ⎿  > pantry@0.3.0 test",
      "     > node --test test/*.test.ts",
      "> pantry@0.3.0 test",
    ].join("\n");
    expect(digestHistory(raw, "claude").requests).toEqual([
      "The unit rounding tests fail (cups and scaled amounts lose fractions). Fix src/units.ts so amounts keep sensible fractions, make npm test pass, and commit the fix.",
    ]);
  });

  it("keeps the requests in order and skips a draft in the input box", () => {
    const raw = [
      "❯ Add recipe search with tests and commit.",
      "",
      "• Working (3s • esc to interrupt)",
      "❯ Continue where you left off: commit the search changes.",
      "",
      "• Ran git status",
      "────────────────────────────────────────",
      "❯ half typed draft",
      "────────────────────────────────────────",
    ].join("\n");
    expect(digestHistory(raw, "claude").requests).toEqual([
      "Add recipe search with tests and commit.",
      "Continue where you left off: commit the search changes.",
    ]);
  });

  it("counts Claude's checklist from its summary line", () => {
    const raw = [
      "6 tasks (4 done, 1 in progress, 1 open)",
      "◼ Run tests and verify all pass",
      "◻ Commit changes with proper message",
      "✔ Create src/router.ts with handler functions",
    ].join("\n");
    expect(digestHistory(raw, "claude").todo).toEqual({
      done: 4,
      total: 6,
      current: "Run tests and verify all pass",
    });
  });

  it("counts a bare checklist when no summary line is drawn", () => {
    const raw = [
      "  ⎿  ☒ Read the tests",
      "     ☒ Fix units.ts",
      "     ◼ Run npm test",
      "     ☐ Commit",
    ].join("\n");
    expect(digestHistory(raw, "claude").todo).toEqual({
      done: 2,
      total: 4,
      current: "Run npm test",
    });
  });

  it("counts the items Claude folds away under a bare checklist", () => {
    const raw = [
      "· Run tests and verify all pass… (1m 1s · ↓ 7.0k tokens · thinking)",
      "⎿ \u00a0◼ Run tests and verify all pass",
      "◻ Commit changes with proper message",
      "✔ Create src/router.ts with handler functions",
      "✔ Refactor src/server.ts to use router",
      "✔ Create test/server.test.ts with comprehensive tests",
      "… +1 completed",
    ].join("\n");
    expect(digestHistory(raw, "claude").todo).toEqual({
      done: 4,
      total: 6,
      current: "Run tests and verify all pass",
    });
  });

  it("reads Codex's numbered plan across the blank rows between its steps", () => {
    const raw = [
      "Plan:",
      "",
      "1. Add pagination parsing to src/server.ts.",
      "",
      "2. Add node:test coverage.",
      "",
      "3. Run npm test and commit.",
      "",
      "Step 1 is in progress.",
      "",
      "• Ran rtk proxy node --version",
    ].join("\n");
    expect(digestHistory(raw, "claude").plan).toEqual([
      "Plan:",
      "1. Add pagination parsing to src/server.ts.",
      "2. Add node:test coverage.",
      "3. Run npm test and commit.",
      "Step 1 is in progress.",
    ]);
  });

  it("reads each agent's own echo, and none for an agent whose echo is unknown", () => {
    expect(digestHistory("› Add pagination to GET /recipes", "codex").requests).toEqual([
      "Add pagination to GET /recipes",
    ]);
    // Codex's echo glyph is not Claude's: a Claude-style row is not a request there.
    expect(digestHistory("❯ not a codex echo", "codex").requests).toEqual([]);
    expect(
      digestHistory(
        [
          "> Explain the router",
          "",
          "✦ The router maps…",
          "> pantry@0.3.0 test",
          "> node --test",
        ].join("\n"),
        "gemini"
      ).requests
    ).toEqual(["Explain the router"]);
    expect(digestHistory("┃ fix the build", "opencode").requests).toBeNull();
  });

  it("redacts secrets in what it lifts", () => {
    const raw = "❯ Use OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwx to call the API";
    expect(digestHistory(raw, "claude").requests?.[0]).not.toContain("abcdefghijklmnop");
  });

  it("takes the newest checklist, not an older summary further up", () => {
    const raw = [
      "6 tasks (4 done, 1 in progress, 1 open)",
      "◼ Old step",
      "⏺ Moving on.",
      "✔ One",
      "✔ Two",
      "✔ Three",
      "◼ Four",
    ].join("\n");
    expect(digestHistory(raw, "claude").todo).toEqual({ done: 3, total: 4, current: "Four" });
  });

  it("drops a checklist and plan drawn before the newest request", () => {
    const raw = [
      "❯ Fix the rounding bug and commit",
      "3 tasks (3 done, 0 open)",
      "✔ a",
      "✔ b",
      "✔ c",
      "❯ Now add a GET /units endpoint with tests",
      "⏺ Looking at the router first.",
    ].join("\n");
    expect(digestHistory(raw, "claude").todo).toBeNull();
    expect(
      digestHistory(["Plan:", "1. Old", "› New request here", "• Ran ls"].join("\n"), "codex").plan
    ).toEqual([]);
  });

  it("redacts the checklist item it passes on", () => {
    const raw = [
      "2 tasks (0 done, 1 in progress, 1 open)",
      "◼ Configure TOKEN=abcdef1234567890",
      "◻ Ship",
    ].join("\n");
    expect(digestHistory(raw, "claude").todo?.current).not.toContain("abcdef1234567890");
  });
});
