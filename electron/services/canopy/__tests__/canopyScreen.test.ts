import { describe, expect, it } from "vitest";
import {
  isSecretPrompt,
  joinWrappedRows,
  prepareScreen,
  redactSecrets,
  sameScreenTail,
  scrolledSince,
} from "../canopyScreen.js";

describe("prepareScreen", () => {
  it("strips dialog frames and the agent's permanent input box and footer", () => {
    const raw = [
      "│ Do you want to proceed?                    │",
      "│ ❯ 1. Yes                                   │",
      "╰────────────────────────────────────────────╯",
      "› Ask Codex to do anything",
      "  100% context left · ? for shortcuts",
      "  ⏵⏵ accept edits on (shift+tab to cycle)   Context left: 41%",
    ].join("\n");
    const screen = prepareScreen(raw);
    expect(screen.lines).toEqual(["Do you want to proceed?", "❯ 1. Yes"]);
  });

  it("drops an empty input box's placeholder suggestion", () => {
    const screen = prepareScreen(
      [
        "⏺ Done. All tests pass.",
        '> Try "fix typecheck errors"',
        '❯ Try "refactor the auth module"',
        "❯ ",
        "› Find and fix a bug in @filename",
        "  ⏵⏵ auto mode on (shift+tab to cycle)  ● high · /effort",
        // The same bar once a shell is running, which drops the key hint.
        "  ⏵⏵ auto mode on · 1 shell",
        "  ⚠ Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker · restart",
      ].join("\n")
    );
    expect(screen.lines).toEqual(["⏺ Done. All tests pass."]);
  });

  it("keeps what the user actually typed into the box", () => {
    expect(prepareScreen("> deploy it to staging").lines).toEqual(["> deploy it to staging"]);
  });

  it("collapses blank runs and trims trailing blanks", () => {
    const screen = prepareScreen("one\n\n\n\ntwo\n\n\n");
    expect(screen.lines).toEqual(["one", "", "two"]);
  });

  it("treats a ticking spinner and timer as the same screen", () => {
    const a = prepareScreen("✻ Pondering… (38s · ↓ 2.1k tokens · esc to interrupt)");
    const b = prepareScreen("✶ Pondering… (1m 41s · ↓ 12.4k tokens · esc to interrupt)");
    const c = prepareScreen("✻ Editing… (41s · esc to interrupt)");
    expect(a.hash).toBe(b.hash);
    expect(a.hash).not.toBe(c.hash);
  });

  it("still sees a question that changed only by a number", () => {
    expect(prepareScreen("Delete backup1?").hash).not.toBe(prepareScreen("Delete backup2?").hash);
    // A question's numbers are what it asks, even ones shaped like a timer.
    expect(prepareScreen("Use a timeout of 5s?").hash).not.toBe(
      prepareScreen("Use a timeout of 60s?").hash
    );
  });

  it("reports the newest meaningful line, without the agent's bullet", () => {
    const screen = prepareScreen("⏺ Read(src/app.ts)\n⏺ Update(src/store/panelStore.ts)\n\n");
    expect(screen.activity).toBe("Update(src/store/panelStore.ts)");
  });

  it("never lets a credential reach the text that is sent", () => {
    const screen = prepareScreen(
      `export OPENAI_API_KEY=sk-proj-${"a".repeat(40)}\nAuthorization: Bearer ${"b".repeat(32)}`
    );
    expect(screen.text).not.toContain("a".repeat(40));
    expect(screen.text).not.toContain("b".repeat(32));
  });
});

describe("redactSecrets", () => {
  it("keeps the label of an assignment and drops its value", () => {
    expect(redactSecrets("password: hunter22")).toBe("password: [redacted]");
    expect(redactSecrets("token=abcdef123456")).toBe("token=[redacted]");
  });

  it("catches prefixed environment names and quoted JSON values", () => {
    expect(redactSecrets("export OPENAI_API_KEY=abcdefgh12345")).toBe(
      "export OPENAI_API_KEY=[redacted]"
    );
    expect(redactSecrets('{"token":"abcdef123456"}')).not.toContain("abcdef123456");
  });

  it("drops known key shapes wherever they appear", () => {
    const ghp = `ghp_${"x".repeat(36)}`;
    expect(redactSecrets(`cloning with ${ghp} now`)).toBe("cloning with [redacted] now");
    expect(redactSecrets("key AKIAABCDEFGHIJKLMNOP")).toBe("key [redacted]");
  });

  it("leaves ordinary output alone", () => {
    const text = "Tests  212 passed (212)\nDuration  9.41s";
    expect(redactSecrets(text)).toBe(text);
  });
});

describe("isSecretPrompt", () => {
  it.each([
    "Password:",
    "Enter passphrase for key '/Users/dev/.ssh/id_ed25519':",
    "Paste your token:",
  ])("recognises %s", (prompt) => expect(isSecretPrompt(prompt)).toBe(true));

  it.each(["Do you want to proceed?", "Which approach do you want?", null])(
    "does not flag %s",
    (prompt) => expect(isSecretPrompt(prompt)).toBe(false)
  );

  it("drops Claude Code's manual-mode footer, so it is never a row's activity", () => {
    const screen = prepareScreen(["⏺ Done.", "", "⏸ manual mode on · ← for agents"].join("\n"));
    expect(screen.activity).toBe("Done.");
  });

  it("reads how much context is left from each agent's own footer", () => {
    const left = (footer: string) => prepareScreen(["⏺ Done.", "", footer].join("\n")).contextLeft;
    expect(left("GPT-6.1-Sol medium · ~/code/api · 42% context left")).toBe(42);
    expect(left("Context left until auto-compact: 12%")).toBe(12);
    expect(left("Grok 4.7 (xhigh) · always-approve · 20K / 256K (8%) · ctrl+o transcript")).toBe(
      92
    );
    expect(left("BUILD  16.4K (13%) · $0.02 · ctrl+p cmd")).toBe(87);
    expect(left("? for shortcuts")).toBeNull();
  });

  it("keeps a screen the same when a cut-off status line shifts as its timer grows", () => {
    const at = (line: string) => prepareScreen(["• Ran rtk proxy sleep 900", line].join("\n")).hash;
    expect(
      at(
        "• Waiting for background terminal (9m 41s • esc to interrupt) · 1 background terminal running · /ps to view · …"
      )
    ).toBe(
      at(
        "• Waiting for background terminal (10m 02s • esc to interrupt) · 1 background terminal running · /ps to view ·…"
      )
    );
  });
});

describe("scrolledSince", () => {
  const history = [
    "❯ Fix the checkout tests",
    "• Ran pnpm test",
    "└ 3 failed",
    "• Edited src/discounts.ts",
    "• Ran pnpm test",
    "└ 2 failed",
    "• Edited test/checkout.test.ts (+0 -38)",
    "• Ran pnpm test",
    "└ 58 passed",
    "Worked for 3m 12s",
  ];

  it("returns what scrolled away between the last screen and this one", () => {
    const previous = [
      "❯ Fix the checkout tests",
      "• Ran pnpm test",
      "└ 3 failed",
      "◦ Working (40s • esc to interrupt)",
    ];
    const current = ["• Ran pnpm test", "└ 58 passed", "Worked for 3m 12s"];
    expect(scrolledSince(previous, history, current)).toBe(
      [
        "• Edited src/discounts.ts",
        "• Ran pnpm test",
        "└ 2 failed",
        "• Edited test/checkout.test.ts (+0 -38)",
      ].join("\n")
    );
  });

  it("is null when the last screen's rows are still on this one", () => {
    const previous = ["• Edited test/checkout.test.ts (+0 -38)", "• Ran pnpm test", "└ 58 passed"];
    const current = history.slice(5);
    expect(scrolledSince(previous, history, current)).toBeNull();
  });

  it("is null when the last screen cannot be found in what was read", () => {
    expect(
      scrolledSince(["a redrawn", "full-screen", "frame"], history, history.slice(-3))
    ).toBeNull();
  });

  it("matches a working screen whose timer has ticked on", () => {
    const previous = ["• Ran pnpm test", "└ 3 failed", "◦ Working (40s • esc to interrupt)"];
    const withTimer = [
      ...history.slice(0, 3),
      "◦ Working (41s • esc to interrupt)",
      ...history.slice(3),
    ];
    expect(scrolledSince(previous, withTimer, history.slice(-3))).toBe(
      [
        "• Edited src/discounts.ts",
        "• Ran pnpm test",
        "└ 2 failed",
        "• Edited test/checkout.test.ts (+0 -38)",
      ].join("\n")
    );
  });
});

describe("prepareScreen placeholders", () => {
  it("drops other CLIs' empty-input placeholders", () => {
    const screen = prepareScreen(
      ["Done.", ">  Enter @ to mention files or / for commands", "Ask about your codebase"].join(
        "\n"
      )
    );
    expect(screen.lines).toEqual(["Done."]);
  });
});

describe("sameScreenTail", () => {
  it("matches a screen whose first line is the tail of one wrapped above it", () => {
    const screen = prepareScreen(["  behavior.", "", "Worked for 1m 22s • 08:55"].join("\n"), 80);
    const history = [
      "• Committed as b923ea3: extracted toBaseAmount and fromBaseAmount, preserving",
      "  behavior.",
      "",
      "Worked for 1m 22s • 08:55",
    ].join("\n");
    expect(sameScreenTail(screen, history)).toBe(true);
  });
});

describe("joinWrappedRows", () => {
  it("puts a question an agent wrapped back together", () => {
    const rows = [
      "2. Should I keep the Ingredient, Amount, Unit columns, or use a",
      "   different layout?",
      "",
      "Worked for 28s • 08:54",
    ];
    expect(joinWrappedRows(rows, 66)).toEqual([
      "2. Should I keep the Ingredient, Amount, Unit columns, or use a different layout?",
      "",
      "Worked for 28s • 08:54",
    ]);
  });

  it("leaves short rows, new bullets and list items apart", () => {
    const rows = ["⏺ Done.", "  Tests pass.", "- one", "- two", "• Ran npm test"];
    expect(joinWrappedRows(rows, 40)).toEqual(rows);
  });

  it("joins a path broken mid-word without a space", () => {
    expect(
      joinWrappedRows(["  ⎿  /private/tmp/claude-501/canopy-", "     demo-wt-fr-a"], 36)
    ).toEqual(["  ⎿  /private/tmp/claude-501/canopy-demo-wt-fr-a"]);
  });

  it("leaves a finished sentence and a new capitalised line apart, and log lines too", () => {
    const rows = [
      "Press enter to continue to the browser or esc to cancel.",
      "Welcome to Kiro CLI, let's get you started",
      "2026-10-06 09:12:01 GET /recipes 200 3ms from 127.0.0.1 user-agent curl/8",
      "2026-10-06 09:12:02 GET /recipes 200 2ms from 127.0.0.1 user-agent curl/8",
    ];
    expect(joinWrappedRows(rows, 56)).toEqual(rows);
  });

  it("keeps the space when a row of prose ends exactly at the edge", () => {
    expect(joinWrappedRows(["• One two three four", "  five six"], 20)).toEqual([
      "• One two three four five six",
    ]);
  });

  it("keeps the space between two plain words that fill the row together", () => {
    expect(
      joinWrappedRows(
        ["• These changes improve input validation", "  consistently across all forms."],
        40
      )
    ).toEqual(["• These changes improve input validation consistently across all forms."]);
  });

  it("starts a new line after a row the terminal already wrapped whole", () => {
    const rows = ["x".repeat(50), "  continues nothing"];
    expect(joinWrappedRows(rows, 40)).toEqual(rows);
  });

  it("joins nothing without the pane's width", () => {
    const rows = ["a long row that may well have wrapped at the edge of", "  the pane"];
    expect(joinWrappedRows(rows, undefined)).toEqual(rows);
  });
});
