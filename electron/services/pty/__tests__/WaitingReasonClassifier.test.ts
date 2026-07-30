import { describe, it, expect } from "vitest";
import { classifyWaitingReason } from "../WaitingReasonClassifier.js";

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
