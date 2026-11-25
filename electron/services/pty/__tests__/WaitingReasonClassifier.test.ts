import { describe, it, expect } from "vitest";
import {
  classifyApprovalKind,
  classifyWaitingReason,
  endsOnWorkingDialog,
  hasRateLimitMessage,
  hasWorkingDialog,
} from "../WaitingReasonClassifier.js";
import { findEmptyComposerRow } from "../PromptDetector.js";

describe("classifyWaitingReason", () => {
  describe("prompt detection", () => {
    it("returns prompt when isPromptDetected is true", () => {
      const lines = ["$ "];
      expect(classifyWaitingReason(lines, true)).toBe("prompt");
    });

    it("returns prompt as default when no patterns match", () => {
      const lines = ["some random output"];
      expect(classifyWaitingReason(lines, false)).toBe("prompt");
    });

    it("returns prompt for approval-like prose without a selector", () => {
      const lines = ["Waiting for approval..."];
      expect(classifyWaitingReason(lines, false)).toBe("prompt");
    });
  });

  describe("approval detection", () => {
    it("classifies y/n confirmation prompts as approval", () => {
      const lines = ["Allow this tool? [y/N]"];
      expect(classifyWaitingReason(lines, false)).toBe("approval");
    });

    it("classifies Claude-style numbered edit approval as approval", () => {
      const lines = [
        "Do you want to make this edit to src/index.ts?",
        "❯ 1. Yes",
        "  2. Yes, allow all edits during this session (shift+tab)",
        "  3. No, and tell Claude what to do differently (esc)",
      ];
      expect(classifyWaitingReason(lines, false)).toBe("approval");
    });

    it("classifies Gemini-style allow once/always selectors as approval", () => {
      const lines = ["Apply this change?", "● 1. Yes, allow once", "○ 2. Yes, allow always"];
      expect(classifyWaitingReason(lines, false)).toBe("approval");
    });

    it("classifies trust-directory dialogs as approval", () => {
      const lines = ["Do you trust this directory?", "Trust this directory and continue"];
      expect(classifyWaitingReason(lines, false)).toBe("approval");
    });

    it("approval beats the prompt flag — selector rows look prompt-like", () => {
      const lines = ["Do you want to proceed?", "❯ 1. Yes", "  2. No"];
      expect(classifyWaitingReason(lines, true)).toBe("approval");
    });

    it.each<[string, string[]]>([
      ["Claude", ["Which framework should I use?", "❯ 1. React", "  2. Vue", "  3. Svelte"]],
      ["Codex", ["Which framework?", "  1. React", "› 2. Vue"]],
      [
        "described",
        [
          "Which framework?",
          "❯ 1. React",
          "     Keep the existing stack",
          "  2. Vue",
          "     Smaller bundle",
          "Enter to select · Esc to cancel",
        ],
      ],
      [
        "boxed Gemini",
        ["│ Which framework?    │", "│ ● 1. React          │", "│   2. Vue            │"],
      ],
    ])("classifies a %s choice selector as approval, not question (#14475)", (_label, lines) => {
      expect(classifyWaitingReason(lines, true)).toBe("approval");
    });

    it.each<[string, string[]]>([
      ["a lone cursor-marked numbered row", ["Should I go ahead?", "❯ 1. Fix it"]],
      [
        "a numbered list echoed above a newer composer",
        ["› 1. Update the parser", "  2. Add coverage", "", "• Should I commit it?", "", "›"],
      ],
      [
        "a numbered reply above the composer",
        ["● 1. Fix it", "  2. Test it", "Which should I do first?", "────────", "❯ ", "────────"],
      ],
    ])("keeps %s a question", (_label, lines) => {
      expect(classifyWaitingReason(lines, false)).toBe("question");
    });

    it("approval beats question classification", () => {
      // Ends with "?" but the selector makes it an approval, not a free-form question.
      const lines = ["Do you want to run this command?", "(y/n)"];
      expect(classifyWaitingReason(lines, false)).toBe("approval");
    });

    it("unmarked numbered prose lists do not classify as approval", () => {
      // Agent final answers routinely contain numbered lists; without a
      // cursor glyph these are prose, not a selector.
      const lines = [
        "Here's what I found:",
        "1. No changes needed in the parser",
        "2. Yes, the cache is stale — cleared it",
        "3. Allowances in config were unused",
        "> ",
      ];
      expect(classifyWaitingReason(lines, true)).toBe("prompt");
    });
  });

  describe("error detection", () => {
    it.each([
      ["rate limit", "You've hit your rate limit. Try again at 3pm."],
      ["usage limit", "Usage limit reached — resets in 2 hours"],
      ["rate limit reached", "API Error: Rate limit reached"],
      ["passive rate limiting", "You are being rate limited."],
      ["past-tense passive rate limiting", "You have been rate limited."],
      ["usage limit hit", "You've hit your usage limit. Try again at 4pm."],
      ["usage limit exceeded", "Usage limit exceeded"],
      ["usage limit reached via auxiliary", "Your usage limit has been reached."],
      ["usage limit exhausted", "5-hour usage limit exhausted"],
      ["qualified usage limit", "You've hit your 5-hour usage limit."],
      ["plural rate limits", "You've hit your rate limits."],
      ["usage limit ran out", "You ran out of your usage limit."],
      ["box-framed usage limit", "│ You've hit your usage limit. Try again at 4pm."],
      ["box-cornered usage limit", "╰ You have reached your usage limit"],
      ["pointer-prefixed usage limit", "❯ You've hit your usage limit."],
      [
        "weekly limit banner",
        "  ⎿  You've hit your weekly limit · resets Oct 2 at 9pm (Europe/Lisbon)",
      ],
      ["weekly limit with curly apostrophe", "You’ve hit your weekly limit · resets Oct 2"],
      ["model limit banner", "You've hit your Opus limit · resets 3am"],
      ["unqualified limit with reset", "You've hit your limit · resets 2pm (America/New_York)"],
      ["legacy window-first banner", "5-hour limit reached ∙ resets 3pm"],
      ["quota", "Quota exceeded for this billing period"],
      ["overloaded", "API error: Overloaded. Please retry shortly."],
      ["auth", "Authentication failed. Run /login to reauthenticate."],
      ["invalid key", "Error: invalid API key provided"],
      ["network", "Network error: connection refused"],
      ["node errno", "request to https://api.example.com failed: ECONNRESET"],
      ["missing command", "zsh: command not found: rg"],
      ["merge conflict", "CONFLICT (content): Merge conflict in src/app.ts"],
    ])("classifies %s messages as error", (_name, line) => {
      expect(classifyWaitingReason([line], false)).toBe("error");
    });

    it("errors beat the prompt flag when the failure sits at the tail", () => {
      const lines = ["Rate limit exceeded. Waiting for reset.", "> "];
      expect(classifyWaitingReason(lines, true)).toBe("error");
    });

    it("stale errors above a settled prompt do not classify as error", () => {
      // The error scan is bounded to the last few non-empty lines — an old
      // failure further up must not relabel the wait as "error". The trailing
      // "Anything else…?" line classifies as a question (suppression is
      // scoped to the candidate lines, so the distant error doesn't veto it).
      const lines = [
        "Error: connection refused",
        "Retrying with backoff…",
        "Recovered. All checks green.",
        "Summary written to out.md",
        "Anything else you'd like me to do?",
        "> ",
      ];
      expect(classifyWaitingReason(lines, true)).toBe("question");
    });

    it("a real question after failure output still classifies as question", () => {
      // Suppression is scoped to the question candidates: the "failed" line
      // sits above the candidate window, so the trailing question survives.
      const lines = [
        "The build failed with 3 errors.",
        "I can fix them one at a time or rewrite the module.",
        "Option A keeps history; option B is cleaner.",
        "How should I proceed?",
      ];
      expect(classifyWaitingReason(lines, false)).toBe("question");
    });

    it("bare error:/failed lines stay prompt (precision guard)", () => {
      const lines = ["error: expected 2 arguments", "build failed"];
      expect(classifyWaitingReason(lines, false)).toBe("prompt");
    });

    it.each([
      [
        "available usage-limit resets",
        "• You have 2 usage limit resets available. Run /usage to use one.",
      ],
      ["exhausted usage-limit resets", "No usage limit resets available"],
      ["a usage-limit reset action", "Redeem usage limit reset"],
      [
        "remaining weekly allowance",
        "⚠ Heads up, you have less than 10% of your weekly limit left.",
      ],
      ["a plan without rate limits", "Your plan does not impose Codex rate limits"],
      ["rate-limit narration", "the API rate limits at 50 rpm"],
      ["a rate-limited endpoint", "I added retry logic because the endpoint is rate limited."],
      // An agent that just worked on limit handling narrates the limit
      // something *else* hit. A depletion verb near the phrase is not enough.
      ["a passing test name", "PASS retries when the client hit the API rate limit"],
      ["a zero-event summary", "No request exceeded the configured rate limit."],
      [
        "a negated finding",
        "I confirmed the client doesn't hit the API rate limit; all tests pass.",
      ],
      ["a conditional explanation", "If callers hit the per-model rate limit, the client retries."],
      [
        "a recovered third party",
        "I verified the mocked endpoint has been rate limited and recovered.",
      ],
      ["a hit-count metric", "rate limit hit count: 0"],
      ["a utilization reading", "usage limit has reached 80% utilization"],
      ["a passive description", "The code handles cases where the rate limit is reached."],
      ["a passive zero-event summary", "No usage limit was exceeded."],
      ["a passive test name", "PASS reports whether the rate limit was exceeded"],
      // Second person is not enough on its own — a real banner opens the line.
      ["a subordinate clause", "The test shows you exceeded the rate limit in the retry test."],
      ["a hypothetical", "If you exceeded the rate limit, I can add backoff."],
      ["a negated second person", "I don't think you hit your usage limit."],
      ["an unrelated object", "You reached the section on rate limits."],
      ["an unqualified limit without a reset", "You've hit your limit of 5 retries."],
      ["a mid-line weekly limit", "The banner says you've hit your weekly limit."],
    ])("keeps %s as prompt (precision guard)", (_name, line) => {
      expect(classifyWaitingReason([line], false)).toBe("prompt");
    });

    it("an agent asking whether the user is limited is a question, not an error", () => {
      expect(classifyWaitingReason(["Have you hit your usage limit?"], false)).toBe("question");
    });

    it("a benign limit notice above a real question still classifies as question", () => {
      // Stronger than asserting "prompt": the notice has to be rejected by the
      // error patterns AND question detection has to still fire, so this fails
      // both for a re-broadened error pattern and for a classifier that has
      // collapsed to its default.
      const lines = [
        "• You have 2 usage limit resets available. Run /usage to use one.",
        "What should I work on next?",
        "> ",
      ];
      expect(classifyWaitingReason(lines, true)).toBe("question");
    });

    it("a real error alongside a benign limit notice still classifies as error", () => {
      const lines = [
        "• You have 2 usage limit resets available. Run /usage to use one.",
        "Authentication failed. Run /login to reauthenticate.",
        "> ",
      ];
      expect(classifyWaitingReason(lines, true)).toBe("error");
    });

    it("Codex's post-interrupt tail stays prompt (precision guard)", () => {
      // The reset notice says the user *has* limit resets in reserve — the
      // opposite of a block — and the whole tail is exactly four non-empty
      // lines, so every one of them lands inside the error window.
      const lines = [
        "■ Conversation interrupted - tell the model what to do differently. Something went wrong? Hit `/feedback` to report the issue.",
        "• You have 2 usage limit resets available. Run /usage to use one.",
        "› Implement {feature}",
        "  gpt-5.6-sol medium · ~/Games/Packages/tilegen                Goal achieved (32m)",
      ];
      expect(classifyWaitingReason(lines, true)).toBe("prompt");
    });
  });

  describe("question detection", () => {
    it("detects line ending with question mark", () => {
      const lines = ["What file would you like me to edit?"];
      expect(classifyWaitingReason(lines, false)).toBe("question");
    });

    it("detects Wh-word questions without question mark", () => {
      const lines = ["Which approach do you prefer"];
      expect(classifyWaitingReason(lines, false)).toBe("question");
    });

    it("detects Should questions", () => {
      const lines = ["Should I continue with this approach"];
      expect(classifyWaitingReason(lines, false)).toBe("question");
    });

    it("suppresses question detection for help text", () => {
      const lines = ["Usage: command [options]", "What does this do?"];
      expect(classifyWaitingReason(lines, false)).toBe("prompt");
    });

    it("suppresses question detection for error output", () => {
      const lines = ["Error: something failed", "What went wrong?"];
      expect(classifyWaitingReason(lines, false)).toBe("prompt");
    });

    it("question beats the prompt flag when the question sits above the input box", () => {
      // Agents redraw their prompt chrome under the question — the question
      // is the salient signal for whoever drives the terminal next.
      const lines = ["What file?", "$ "];
      expect(classifyWaitingReason(lines, true)).toBe("question");
    });

    it("prose tail without a question stays prompt even with chrome rows", () => {
      const lines = ["All checks passed.", "> "];
      expect(classifyWaitingReason(lines, true)).toBe("prompt");
    });

    it("a wrapped row that starts with a question word is not a question (#13392)", () => {
      // A host assistant's 49-column pane, settled after launching two agents.
      // Read as a question, it blocked every completion notice it had asked for.
      const lines = [
        "  I'll check each commit myself as its notice",
        "  arrives, and reply to the hub once, after both",
        "  are verified.",
        "",
        "✻ Worked for 35s · done 3:44 PM",
        "",
        "─────────────────────────────────────────────────",
        "❯ ",
        "─────────────────────────────────────────────────",
        "  ⏵⏵ bypass permissions on (shift+tab to cycle)",
      ];
      expect(classifyWaitingReason(lines, true)).toBe("prompt");
    });

    it("a capitalised question word opens a question whatever sits above it", () => {
      for (const above of [
        "Next step",
        "- src/renderer.ts",
        "```",
        "└──────────┘",
        "⏺ Found two config files",
        "  I updated the config and reran the build",
      ]) {
        expect(classifyWaitingReason([above, "  Which file should I update", "❯ "], true)).toBe(
          "question"
        );
      }
    });

    it("a lowercase question word mid-sentence is not a question", () => {
      for (const lines of [
        ["  The helpers from utils.ts, etc.", "  are covered by tests.", "❯ "],
        ["  The constraints mean:", "  do the work after both complete.", "❯ "],
        ["  are covered by tests.", "❯ "],
      ]) {
        expect(classifyWaitingReason(lines, true)).toBe("prompt");
      }
    });

    it("a wrapped question that ends in a question mark is still a question", () => {
      const lines = [
        "  I can push the branch now, or would you rather",
        "  review the diff first?",
      ];
      expect(classifyWaitingReason(lines, true)).toBe("question");
    });
  });

  describe("ANSI stripping", () => {
    it("strips ANSI codes before matching question", () => {
      const lines = ["\x1b[36mWhat would you like to do?\x1b[0m"];
      expect(classifyWaitingReason(lines, false)).toBe("question");
    });
  });

  describe("edge cases", () => {
    it("handles empty lines array", () => {
      expect(classifyWaitingReason([], false)).toBe("prompt");
    });

    it("handles lines with only whitespace", () => {
      const lines = ["  ", "  ", "  "];
      expect(classifyWaitingReason(lines, false)).toBe("prompt");
    });
  });
});

describe("classifyWaitingReason with the input row known (#16093)", () => {
  const RULE = "─".repeat(60);
  const CLAUDE_PROMPT = [/^\s*>\s*/, /^\s*❯\s*/];
  const classify = (lines: string[]) =>
    classifyWaitingReason(lines, true, undefined, findEmptyComposerRow(lines, CLAUDE_PROMPT));

  it("reads a limit banner above the input row as an error", () => {
    const lines = [
      "● Refactoring the parser.",
      "  ⎿  You've hit your weekly limit · resets Oct 2 at 9pm (Europe/Lisbon)",
      "     /upgrade to increase your usage limit.",
      "",
      RULE,
      "❯ ",
      RULE,
      "  ⏵⏵ accept edits on (shift+tab to cycle)",
    ];
    expect(classify(lines)).toBe("error");
  });

  it("keeps the banner an error after Escape cancels the auto-continue", () => {
    // Cancelling the wait doesn't bring the quota back.
    const lines = [
      "  ⎿  You've hit your weekly limit · resets Oct 2 at 9pm (Europe/Lisbon)",
      "     /upgrade to increase your usage limit.",
      "",
      "  ⎿  Automatic continue cancelled · /rate-limit-options to re-arm",
      "",
      RULE,
      "❯ ",
      RULE,
      "  ⏵⏵ accept edits on (shift+tab to cycle)",
    ];
    expect(classify(lines)).toBe("error");
  });

  it("reads a banner a narrow pane wrapped over several rows", () => {
    const lines = [
      "● Refactoring the parser.",
      "  ⎿  You've hit your weekly limit · resets",
      "     Oct 2 at 9pm (Europe/Lisbon)",
      "     /upgrade to increase your usage",
      "     limit.",
      "",
      RULE,
      "❯ ",
      RULE,
      "  ⏵⏵ accept edits on",
    ];
    expect(classify(lines)).toBe("error");
  });

  it("keeps a footer below the input row out of a finished turn", () => {
    const lines = [
      "● The parser now handles empty input, and its tests pass.",
      "",
      RULE,
      "❯ ",
      RULE,
      "  Usage limit reached · continuing automatically at 10am · esc to cancel",
    ];
    expect(classify(lines)).toBe("prompt");
    // The same screen with no input row found reads as it always has.
    expect(classifyWaitingReason(lines, true)).toBe("error");
  });

  it.each([
    "API Error: Rate limit reached",
    "Claude usage limit reached. Your limit will reset at 5pm.",
  ])("still reads %s in the transcript as an error", (banner) => {
    expect(
      classify(["● Working.", `  ⎿  ${banner}`, "", RULE, "❯ ", RULE, "  ? for shortcuts"])
    ).toBe("error");
  });

  it.each([
    ["names an error code", ["● Added retry handling for ECONNRESET and ETIMEDOUT."]],
    [
      "follows a recovered failure",
      [
        "  ⎿  Error: connect ECONNREFUSED 127.0.0.1:5432",
        "● Started Postgres; the tests pass now.",
      ],
    ],
    ["mentions an auth failure", ["● The 401 now reads as unauthorized instead of crashing."]],
  ])("reads a finished turn that %s as a prompt wait", (_label, transcript) => {
    const lines = [...transcript, "", RULE, "❯ ", RULE, "  ⏵⏵ accept edits on"];
    expect(classify(lines)).toBe("prompt");
  });

  it("reads a boxed input row the same way", () => {
    const box = (inner: string) => `│ ${inner.padEnd(58)} │`;
    const lines = [
      "● Done.",
      "",
      `╭${"─".repeat(60)}╮`,
      box(">"),
      `╰${"─".repeat(60)}╯`,
      "  Usage limit reached · continuing automatically at 10am",
    ];
    expect(classify(lines)).toBe("prompt");
  });

  it("leaves approval and question detection to the whole tail", () => {
    expect(
      classify([
        "Do you want to make this edit to parser.ts?",
        "❯ 1. Yes",
        "  2. No",
        "",
        RULE,
        "❯ ",
        RULE,
      ])
    ).toBe("approval");
    expect(classify(["Should I also update the docs?", "", RULE, "❯ ", RULE])).toBe("question");
  });

  it("reads a dialog drawn below the input row", () => {
    expect(
      classify([
        "● Done.",
        RULE,
        "❯ ",
        RULE,
        "Do you want to make this edit to parser.ts?",
        "❯ 1. Yes",
        "  2. No",
      ])
    ).toBe("approval");
    expect(classify(["● Done.", RULE, "❯ ", RULE, "Should I also update the docs?"])).toBe(
      "question"
    );
  });
});

describe("hasRateLimitMessage (#12797)", () => {
  it.each([
    "■ You've hit your usage limit. Upgrade to Pro or try again at 3:40 PM.",
    "Claude usage limit reached. Your limit will reset at 5pm.",
    "\x1b[31m⚠ You've been rate limited\x1b[0m",
    "Error: 429 Too Many Requests",
    "quota exceeded for this model",
    "│ 429: Too Many Requests",
    "  ⎿  You've hit your weekly limit · resets Oct 2 at 9pm (Europe/Lisbon)",
    "  ⎿  You’ve hit your weekly limit · resets Oct 2 at 9pm (Europe/Lisbon)",
    "You've hit your weekly limit · resets Oct 2",
    "You've hit your session limit · resets 6pm",
    "You've hit your Sonnet limit · resets Oct 3 at 1am",
    "You've hit your limit · resets 2pm (America/New_York)",
    "Session limit reached ∙ resets 6pm",
    "  ⎿  You’ve been rate limited",
    "  ⎿  You've hit your weekly limit",
    "You've hit your Opus limit. Try again at 3am.",
  ])("sees a rate-limit banner: %s", (line) => {
    expect(hasRateLimitMessage(["some output", line, "> "])).toBe(true);
  });

  it.each([
    "the API rate limits at 50 rpm",
    "Have you hit your usage limit?",
    "You have 2 usage limit resets available",
    "Error: unauthorized",
    "API overloaded, retrying",
    "Credit balance is too low",
    "Retry with backoff when the API returns 429 Too Many Requests",
    "The handler maps quota exceeded errors to a friendly message",
    "You've hit your limit of 5 retries",
    "Have you hit your weekly limit?",
    "⚠ Heads up, you have less than 10% of your weekly limit left.",
    "I checked whether the session limit reached its cap",
    "  ⎿  I checked whether the session limit reached its cap",
    "PASS Session limit reached ∙ resets 6pm",
    "  ⎿  You've hit your limit of 5 retries · resets Oct 2",
    "The banner says you've hit your weekly limit · resets Oct 2",
    "If you've hit your weekly limit · resets Oct 2",
    "You have reached your session limit of 10 tool calls; increase maxIterations.",
    "- You've hit your weekly limit without a reset is detected — passed",
  ])("does not treat other failures or prose as a rate limit: %s", (line) => {
    expect(hasRateLimitMessage([line])).toBe(false);
  });

  it("only looks at the tail of the viewport", () => {
    const lines = [
      "You've hit your usage limit.",
      ...Array.from({ length: 12 }, (_, i) => `row ${i}`),
    ];
    expect(hasRateLimitMessage(lines)).toBe(false);
  });

  it("keeps classifying a rate-limit banner as an error wait", () => {
    expect(classifyWaitingReason(["You've hit your usage limit."], true)).toBe("error");
    expect(classifyWaitingReason(["request failed: too many requests"], true)).toBe("error");
  });

  it("sees a Claude approval dialog through the task checklist drawn beneath it", () => {
    const lines = [
      "Do you want to make this edit to units.ts?",
      "❯ 1. Yes",
      "  2. Yes, and switch to accept edits (auto-approve file edits and common file",
      "  commands) for this session (shift+tab)",
      "  3. No",
      "",
      " Esc to cancel · Tab to amend",
      "",
      "  6 tasks (4 done, 1 in progress, 1 open)",
      "  ◼ Fix test failures",
      "  ◻ Commit changes",
      "  ✔ Run npm test to identify failures",
      "  ✔ Refactor src/server.ts to use router",
      "  ✔ Create test/server.test.ts with comprehensive tests",
      "  ✔ Update README",
      "   … +1 completed",
    ];
    expect(classifyWaitingReason(lines, true)).toBe("approval");
  });

  it("does not read a finished turn's checklist as the question it ends on", () => {
    const lines = [
      "⏺ Done. Should I also push the branch?",
      "",
      "  2 tasks (2 done, 0 open)",
      "  ✔ Fix the bug",
      "  ✔ Commit the fix",
    ];
    expect(classifyWaitingReason(lines, true)).toBe("question");
  });

  it("does not bring back an answered approval from above the old window", () => {
    const lines = [
      "Do you want to proceed?",
      "❯ 1. Yes",
      "  2. No",
      ...Array.from({ length: 12 }, () => ""),
      "⏺ Done.",
      "",
      "  2 tasks (2 done, 0 open)",
      "  ✔ Fix the bug",
      "  ✔ Commit the fix",
      "❯ ",
    ];
    expect(classifyWaitingReason(lines, true)).toBe("prompt");
  });

  it("reads a screen not yet filled over the caller's own window, blank rows included", () => {
    const lines = [
      "Do you trust the files in this folder?",
      "❯ 1. Yes, proceed",
      "  2. No, exit",
      ...Array.from({ length: 35 }, () => ""),
    ];
    // The boot scan's 50 rows reach the dialog; the 12-row window never did.
    expect(classifyWaitingReason(lines, false, 50)).toBe("approval");
    expect(classifyWaitingReason(lines, false)).toBe("prompt");
  });

  it("reads the caller's own window when it is wider than its own", () => {
    const lines = [
      "Do you want to proceed?",
      "❯ 1. Yes",
      "  2. No",
      ...Array.from({ length: 12 }, () => ""),
      "  Esc to cancel",
    ];
    expect(classifyWaitingReason(lines, true)).toBe("prompt");
    expect(classifyWaitingReason(lines, true, 16)).toBe("approval");
  });

  it("keeps a dialog's own checkbox rows", () => {
    const lines = ["Allow this tool?", "❯ ☐ Allow once", "  ☐ Always allow"];
    expect(classifyWaitingReason(lines, true)).toBe("approval");
  });
});

describe("Claude Code's unnumbered select dialogs (#16209)", () => {
  const AUTOCOMPACT = [
    "Want to autocompact at 400k tokens instead? Your model doesn't change. Switch back any",
    "time with /autocompact.",
    "",
    "❯ Keep auto (1m tokens)",
    "  Autocompact at ‹ 400k › tokens",
    "↑/↓ choose · ←/→ change size · enter confirm · esc not now",
  ];
  const classify = (lines: string[], agentId?: string) =>
    classifyWaitingReason(lines, true, undefined, undefined, agentId);

  it("reads the autocompact choice in a Claude pane as an approval wait", () => {
    expect(classify(AUTOCOMPACT, "claude")).toBe("approval");
  });

  it("reads it through colour and trailing blank rows", () => {
    const coloured = AUTOCOMPACT.map((row) =>
      row.startsWith("❯") ? `\x1b[36m${row}\x1b[39m` : row
    );
    expect(classify([...coloured, "", ""], "claude")).toBe("approval");
  });

  it("keeps the footer to the agent whose config names it", () => {
    expect(classify(AUTOCOMPACT, "codex")).toBe("prompt");
    expect(classify(AUTOCOMPACT, "gemini")).toBe("prompt");
    expect(classify(AUTOCOMPACT)).toBe("prompt");
  });

  it("reads prose that mentions the footer's words as a prompt", () => {
    const prose = [
      "Claude's select dialogs end with a footer like",
      "  ↑/↓ choose · enter confirm · esc not now",
      "which Daintree now reads.",
      "",
      "❯ ",
    ];
    expect(classify(prose, "claude")).toBe("prompt");
  });

  it("reads a dismissed dialog with the composer back below it as a prompt", () => {
    const rule = "─".repeat(40);
    expect(classify([...AUTOCOMPACT, "", rule, "❯ ", rule], "claude")).toBe("prompt");
  });
});

describe("Codex's safety-buffering picker (#18167)", () => {
  // Codex 0.171's picker at 80 columns, from its own snapshot: the turn runs on
  // behind it, and its footer says so.
  const PICKER = [
    "  Giving this request a little extra thought",
    "  If you'd rather not wait, retry with a faster model. It may be less capable",
    "  of handling complex requests.",
    "",
    "",
    "› 1. Retry with a faster model",
    "  2. Dismiss and keep waiting",
    "  3. Learn more",
    "",
    "  No action is required. Codex will keep waiting, and this menu will close when",
    "  the response is ready.",
    "",
  ];

  it("reads the open picker in a Codex pane as a menu over a running turn", () => {
    expect(hasWorkingDialog("codex")).toBe(true);
    expect(endsOnWorkingDialog(["• Ran npm test", "", ...PICKER], "codex")).toBe(true);
  });

  it("reads it through colour and a narrow pane's wrap", () => {
    const narrow = [
      "\x1b[1m  Giving this request a little extra\x1b[22m",
      "\x1b[1m  thought\x1b[22m",
      "",
      "",
      "\x1b[36m› 1. Dismiss and keep waiting\x1b[39m",
      "  2. Learn more",
      "",
      "\x1b[2m  No action is required. Codex will\x1b[22m",
      "\x1b[2m  keep waiting, and this menu will\x1b[22m",
      "\x1b[2m  close when the response is ready.\x1b[22m",
    ];
    expect(endsOnWorkingDialog(narrow, "codex")).toBe(true);
  });

  it("keeps the picker to the agent whose config names it", () => {
    expect(hasWorkingDialog("claude")).toBe(false);
    expect(endsOnWorkingDialog(PICKER, "claude")).toBe(false);
    expect(endsOnWorkingDialog(PICKER, undefined)).toBe(false);
  });

  it("never reads the working status a dismissed picker leaves behind", () => {
    const status = [
      "• Working (42s • esc to interrupt)",
      "  Giving this request a little extra thought",
      "",
      "› Ask Codex to do anything",
    ];
    expect(endsOnWorkingDialog(status, "codex")).toBe(false);
  });

  it("leaves the stop-and-retry confirmation a choice the person answers", () => {
    const confirmation = [
      "•   Stop this attempt and retry?",
      "",
      "    This will stop the current attempt and retry in a new thread.",
      "",
      "  › 1. Keep waiting",
      "    2. Stop and retry",
    ];
    expect(endsOnWorkingDialog(confirmation, "codex")).toBe(false);
    expect(classifyWaitingReason(confirmation, true, undefined, undefined, "codex")).toBe(
      "approval"
    );
  });
});

describe("a CLI's folder-trust prompt (#18170)", () => {
  const CLAUDE_TRUST = [
    "Accessing workspace:",
    "",
    " /repo/wt-1",
    "",
    " Quick safety check: Is this a project you created or one you trust?",
    "",
    " Claude Code'll be able to read, edit, and execute files here.",
    "",
    " ❯ 1. Yes, I trust this folder",
    "   2. No, exit",
    "",
    " Enter to confirm · Esc to cancel",
  ];
  const CODEX_TRUST = [
    "> You are in /Users/me/proj",
    "",
    "  Do you trust the contents of this directory? Working with untrusted contents comes with higher risk of prompt injection.",
    "",
    "› 1. Yes, continue",
    "  2. No, quit",
    "",
    "  Press enter to continue",
  ];
  const TOOL_APPROVAL = [
    "─".repeat(60),
    " Bash command",
    "",
    "   npm test",
    "   Run the tests",
    "",
    " Do you want to proceed?",
    " ❯ 1. Yes",
    "   2. No, and tell Claude what to do differently (esc)",
  ];

  it("classifies Claude's unnumbered trust prompt as an approval by its open option", () => {
    const unnumbered = [" ❯ No, exit", "   Yes, I trust this folder", "", " Enter to confirm"];
    expect(classifyWaitingReason(unnumbered, false, 12, undefined, "claude")).toBe("approval");
    // Without the CLI that draws it, it is just a highlighted row.
    expect(classifyWaitingReason(unnumbered, false)).toBe("prompt");
  });

  it("reads Claude's option quoted in a reply above an empty input row as a prompt", () => {
    const rule = "─".repeat(40);
    const quoted = [
      "⏺ The first option reads:",
      "  Yes, I trust this folder",
      "",
      rule,
      "❯ ",
      rule,
    ];
    expect(classifyWaitingReason(quoted, true, 12, undefined, "claude")).toBe("prompt");
    expect(classifyApprovalKind(quoted, "claude")).toBeUndefined();
  });

  it("names Claude's trust prompt, numbered or not, wherever its highlight is", () => {
    expect(classifyApprovalKind(CLAUDE_TRUST, "claude")).toBe("trust");
    const unnumbered = [
      " Claude Code'll be able to read, edit, and execute files here.",
      "",
      " ❯ No, exit",
      "   Yes, I trust this folder",
      "",
      " Enter to confirm · Esc to cancel",
    ];
    expect(classifyApprovalKind(unnumbered, "claude")).toBe("trust");
    const ascii = CLAUDE_TRUST.map((row) => row.replace("❯", ">"));
    expect(classifyApprovalKind(ascii, "claude")).toBe("trust");
  });

  it("names the trust prompt older Claude builds ask outright", () => {
    const older = [
      "╭──────────────────────────────────────────────╮",
      "│ Do you trust the files in this folder?       │",
      "│                                              │",
      "│ /Users/me/proj                               │",
      "│                                              │",
      "│ ❯ 1. Yes, proceed                            │",
      "│   2. No, exit                                │",
      "╰──────────────────────────────────────────────╯",
      "   Enter to confirm · Esc to exit",
    ];
    expect(classifyWaitingReason(older, false)).toBe("approval");
    expect(classifyApprovalKind(older, "claude")).toBe("trust");
  });

  it("names Codex's trust prompt by its question over numbered options", () => {
    expect(classifyWaitingReason(CODEX_TRUST, false)).toBe("approval");
    expect(classifyApprovalKind(CODEX_TRUST, "codex")).toBe("trust");
  });

  it("names the trust prompt Codex 0.156 and later draws", () => {
    const current = [
      "> Folder access",
      "  /Users/me/proj",
      "",
      "  Trust this folder? Codex can read, edit, and run files here, subject to your",
      "  permission settings. Continue only if you trust these files.",
      "",
      "› 1. Trust and continue",
      "  2. Quit",
      "",
      "  enter continue · esc quit",
    ];
    expect(classifyWaitingReason(current, false, current.length, undefined, "codex")).toBe(
      "approval"
    );
    expect(classifyApprovalKind(current, "codex")).toBe("trust");
    // Its header and question drawn as one block.
    const tight = [...current.slice(0, 2), ...current.slice(3)];
    expect(classifyApprovalKind(tight, "codex")).toBe("trust");
    // Either option alone, without the question above it, is not the prompt.
    expect(classifyApprovalKind(current.slice(5), "codex")).toBeUndefined();
  });

  it("reads it through colour, blank rows under it and a long checklist", () => {
    const coloured = CLAUDE_TRUST.map((row) =>
      row.includes("❯") ? `\x1b[36m${row}\x1b[39m` : row
    );
    const checklist = [
      "  10 tasks (1 done, 9 open)",
      ...Array.from({ length: 10 }, (_, i) => `  ◻ Task ${i}`),
    ];
    expect(classifyApprovalKind([...coloured, "", "", ...checklist], "claude")).toBe("trust");
  });

  it("names nothing for a tool approval or any other selector", () => {
    expect(classifyApprovalKind(TOOL_APPROVAL, "claude")).toBeUndefined();
    expect(
      classifyApprovalKind(
        ["Choose a theme", "❯ 1. Dark mode", "  2. Light mode", "", "Enter to confirm"],
        "claude"
      )
    ).toBeUndefined();
  });

  it("keeps each CLI's wording to that CLI", () => {
    expect(classifyApprovalKind(CLAUDE_TRUST, "codex")).toBeUndefined();
    expect(classifyApprovalKind(CODEX_TRUST, "claude")).toBeUndefined();
    expect(classifyApprovalKind(CLAUDE_TRUST, "gemini")).toBeUndefined();
    expect(classifyApprovalKind(CLAUDE_TRUST, undefined)).toBeUndefined();
    expect(classifyApprovalKind(CLAUDE_TRUST, "constructor")).toBeUndefined();
  });

  it("names nothing once a newer dialog or input box is drawn under an old trust prompt", () => {
    const old = [" ❯ 1. Yes, I trust this folder", "   2. No, exit", ""];
    expect(classifyApprovalKind([...old, ...TOOL_APPROVAL], "claude")).toBeUndefined();
    // A frame with no highlight of its own still closes the prompt above it.
    const rule = "─".repeat(40);
    expect(classifyApprovalKind([...old, rule, "❯ ", rule], "claude")).toBeUndefined();
  });

  it("names nothing for the option's words inside another option or a continuation row", () => {
    expect(
      classifyApprovalKind(
        [" Do you want to proceed?", " ❯ 1. Run: Yes, I trust this folder", "   2. No"],
        "claude"
      )
    ).toBeUndefined();
    expect(
      classifyApprovalKind(
        [" Do you want to proceed?", " ❯ 1. Yes", "      Yes, I trust this folder", "   2. No"],
        "claude"
      )
    ).toBeUndefined();
  });

  it("names a prompt whose question or option a narrow pane wrapped", () => {
    expect(
      classifyApprovalKind(
        [
          "  Do you trust the contents of this",
          "  directory?",
          "",
          "› 1. Yes, continue",
          "  2. No, quit",
        ],
        "codex"
      )
    ).toBe("trust");
    expect(
      classifyApprovalKind([" ❯ 1. Yes, I trust this", "   folder", "   2. No, exit"], "claude")
    ).toBe("trust");
  });

  it("names nothing for the wording quoted in a command a tool approval shows", () => {
    const quoted = [
      "─".repeat(60),
      " Bash command",
      "",
      '   rg -n "Yes, I trust this folder" src',
      "   Find the trust option",
      "",
      " Do you want to proceed?",
      " ❯ 1. Yes",
      "   2. No",
    ];
    expect(classifyApprovalKind(quoted, "claude")).toBeUndefined();
  });

  it("names nothing for the wording in a heredoc a tool approval shows", () => {
    const heredoc = [
      "─".repeat(60),
      " Bash command",
      "",
      "   cat <<'END' > fixture.txt",
      "   Yes, I trust this folder",
      "   Do you trust the files in this folder?",
      "   END",
      "",
      " Do you want to proceed?",
      " ❯ 1. Yes",
      "   2. No",
    ];
    expect(classifyApprovalKind(heredoc, "claude")).toBeUndefined();
    const codex = [
      "Would you like to run the following command?",
      "",
      "  $ cat <<'EOF'",
      "  Do you trust the contents of this directory?",
      "  EOF",
      "",
      "› 1. Yes, proceed (y)",
      "  2. No, and tell Codex what to do differently (esc)",
    ];
    expect(classifyApprovalKind(codex, "codex")).toBeUndefined();
    // A blank row puts the quoted question at the top of the block over the options.
    const spaced = [...codex.slice(0, 3), "", ...codex.slice(3)];
    expect(classifyApprovalKind(spaced, "codex")).toBeUndefined();
  });

  it("names Codex's prompt drawn with its question against its options", () => {
    const tight = [
      "> You are in /Users/me/Library/Application Support/Daintree/",
      "  help-sessions/9630935fa5c2fbb7.codex",
      "  Do you trust the contents of this directory?",
      "› 1. Yes, continue",
      "  2. No, quit",
    ];
    expect(classifyApprovalKind(tight, "codex")).toBe("trust");
  });

  it("names nothing for a lone highlighted row that starts with the option's words", () => {
    const echoed = ["Authentication failed", "> Yes, I trust this plan"];
    expect(classifyApprovalKind(echoed, "claude")).toBeUndefined();
    expect(classifyWaitingReason(echoed, false, 12, undefined, "claude")).toBe("error");
    const draft = [
      "Do you trust the contents of this design?",
      "",
      "› Yes, continue reviewing",
      "",
      "  ⏎ send   ⌃J newline",
    ];
    expect(classifyApprovalKind(draft, "codex")).toBeUndefined();
  });

  it("names nothing for an old trust prompt above a newer dialog drawn without a highlight", () => {
    const rows = [
      " ❯ 1. Yes, I trust this folder",
      "   2. No, exit",
      ...Array.from({ length: 5 }, () => ""),
      " Do you want to proceed?",
      "   1. Yes",
      "   2. No",
    ];
    expect(classifyApprovalKind(rows, "claude")).toBeUndefined();
  });

  it("names Codex's prompt with either version's question over either version's options", () => {
    const hybrid = [
      "  Do you trust the contents of this directory?",
      "",
      "› 1. Trust and continue",
      "  2. Quit",
    ];
    expect(classifyApprovalKind(hybrid, "codex")).toBe("trust");
  });

  it("names nothing for Codex's question typed into its input row", () => {
    const draft = ["› Do you trust the contents of this directory?", "", "  ⏎ send   ⌃J newline"];
    expect(classifyApprovalKind(draft, "codex")).toBeUndefined();
  });

  it("names nothing for a prompt scrolled above the rows it reads", () => {
    const scrolled = [
      ...CLAUDE_TRUST.slice(0, 10),
      ...Array.from({ length: 12 }, (_, i) => `output line ${i}`),
      " ❯ 1. Yes",
      "   2. No",
    ];
    expect(classifyApprovalKind(scrolled, "claude")).toBeUndefined();
  });
});
