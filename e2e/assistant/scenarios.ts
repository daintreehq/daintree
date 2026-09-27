import { expect } from "@playwright/test";
import type { Scenario } from "./harness";
import { INVENTORY_PROJECT } from "./projects";

/**
 * The workflows the assistant is measured on, one per runbook family. Each is
 * a user's messages against a seeded project and a check against what the run
 * left behind: the open panes, what the assistant said, its transcript metrics
 * and every reply its waits returned. Match text against `answer`, not
 * `finalText`: the screen also shows the user's prompt, whose words a check
 * would otherwise find there.
 */

const FACTS_QUERY = `I need you to ask Claude, Anti-Gravity, Grok and Codex each to give you one interesting fact. You don't have to explore the codebase. Just ask each one to give you one interesting fact off the top of its head, not related to the codebase. Specifically say that.

Next you need to:

1.  Choose the two best and give them each one point.
2.  For each agent that you already have open, send it the interesting fact from the other agents and ask it to choose which is the best.
3.  Each one of those will give one of the agents another point.
4.  Tally everything up and tell me which agent gave the most interesting fact.

Encourage each agent to respond quite quickly and give something that is completely unique that it doesn't think that any of the other agents will give. And have each agent also choose a runner-up and use those runner-ups if you ever need to do a tiebreaker.`;

const FACT_WORKERS = ["claude", "antigravity", "grok", "codex"];

export const SCENARIOS: Scenario[] = [
  {
    id: "question",
    project: INVENTORY_PROJECT,
    messages: ["How do I switch Daintree to a light theme?"],
    timeoutMs: 5 * 60_000,
    check: ({ workers, metrics }) => {
      expect(workers, "a question launched agents").toEqual([]);
      expect(metrics.runbookQueries, "a question searched the runbooks").toEqual([]);
    },
  },
  {
    id: "ask-one",
    project: INVENTORY_PROJECT,
    messages: [
      "Ask Claude to read this project and tell me in one sentence what it does, then close it.",
    ],
    timeoutMs: 10 * 60_000,
    check: ({ answer, metrics }) => {
      // Closed as asked, so it is gone from the terminal list by now.
      expect(metrics.launched, "Claude was never launched").toContain("claude");
      expect(answer, "the answer never reached the user").toMatch(/stock|warehouse|inventor/i);
    },
  },
  {
    id: "same-question",
    project: INVENTORY_PROJECT,
    messages: [
      "Ask Claude and Codex the same question: which function in src/ is the most likely to cause a bug, and why? Bring both answers back side by side.",
    ],
    timeoutMs: 12 * 60_000,
    check: ({ answer, metrics }) => {
      expect(metrics.launched).toEqual(expect.arrayContaining(["claude", "codex"]));
      expect(answer).toMatch(/applyMovement|parseCsv/);
    },
  },
  {
    id: "facts-vote",
    project: INVENTORY_PROJECT,
    messages: [FACTS_QUERY, "Great. Now close every agent except the winner."],
    timeoutMs: 30 * 60_000,
    check: ({ workers, answer, instructions, metrics }) => {
      // Losers are closed by the follow-up, so launches come from the transcript.
      const launchCalls = metrics.toolCalls.filter((c) =>
        /agent[._]launch/.test(`${c.name} ${c.input}`)
      );
      for (const agent of FACT_WORKERS) {
        expect(
          launchCalls.some((c) => c.input.includes(`"${agent}"`) || c.input.includes(`'${agent}'`)),
          `no ${agent} agent was launched`
        ).toBe(true);
      }
      expect(answer, "the assistant never reported a tally").toMatch(/point/i);
      // Every reply a wait returned on a done marker carries the marker's
      // summary, which survives a screen the quote cannot read (#12847), and
      // none of the waits ran out or went unread.
      for (const reply of metrics.replies) {
        expect(reply.outcome, `${reply.terminalId}'s wait did not come back`).not.toMatch(
          /^(timeout|unread)$/
        );
        if (reply.outcome === "handback") {
          expect(reply.handback, `${reply.terminalId} came back without its summary`).toBeTruthy();
        }
      }
      expect(
        metrics.replies.filter((r) => r.outcome === "handback").length,
        "fewer done markers came back than facts were asked for"
      ).toBeGreaterThanOrEqual(FACT_WORKERS.length);
      // The assistant's instructions name the agent ids a launch accepts.
      expect(instructions).toContain("`antigravity`");
      expect(
        workers.filter((t) => !t.isTrashed).length,
        "more than the winner is still open"
      ).toBeLessThanOrEqual(2);
    },
  },
  {
    id: "multi-worktree",
    project: INVENTORY_PROJECT,
    messages: [
      "Make two new worktrees: in one, have Claude make parseCsv handle quoted commas; in the other, have Codex make applyMovement refuse to take stock below zero. Tell me when both have a change ready.",
      "Which of the two is done, and what did each change?",
    ],
    timeoutMs: 25 * 60_000,
    check: ({ worktreeCount, metrics }) => {
      expect(worktreeCount, "two worktrees were not created").toBeGreaterThanOrEqual(3);
      expect(metrics.launched).toEqual(expect.arrayContaining(["claude", "codex"]));
    },
  },
  {
    id: "review-relay",
    project: INVENTORY_PROJECT,
    messages: [
      "Ask Codex to review src/stock.js for bugs without changing anything, then pass its findings to Claude and have Claude fix them here. Tell me what changed.",
    ],
    timeoutMs: 20 * 60_000,
    check: ({ metrics }) => {
      expect(metrics.launched).toEqual(expect.arrayContaining(["claude", "codex"]));
      expect(
        // Relayed by a send, or in the fixer's launch prompt.
        metrics.toolCalls.some((c) =>
          /sendCommand|agent[._]launch[\s\S]*claude[\s\S]*(?:finding|review)/i.test(
            `${c.name} ${c.input}`
          )
        ),
        "the findings were never relayed"
      ).toBe(true);
    },
  },
  {
    id: "debate",
    project: INVENTORY_PROJECT,
    messages: [
      "Have Claude and Codex debate whether this project should replace parseCsv with a CSV library. Two rounds each, short answers, then summarise where they landed.",
    ],
    timeoutMs: 15 * 60_000,
    check: ({ answer, metrics }) => {
      expect(metrics.launched).toEqual(expect.arrayContaining(["claude", "codex"]));
      expect(answer).toMatch(/librar/i);
    },
  },
  {
    id: "cleanup",
    project: INVENTORY_PROJECT,
    messages: [
      "Start Claude and Codex and ask each for a one-line summary of README.md.",
      "Thanks. Close all the agents now.",
    ],
    timeoutMs: 12 * 60_000,
    check: ({ workers, metrics }) => {
      expect(metrics.launched).toEqual(expect.arrayContaining(["claude", "codex"]));
      expect(
        workers.filter((t) => !t.isTrashed),
        "agents were left open"
      ).toEqual([]);
    },
  },
  {
    id: "worktree-task",
    project: INVENTORY_PROJECT,
    messages: [
      "Make a new worktree to stop shipments from taking stock below zero, and start Codex on it. Tell me when it has a fix.",
    ],
    timeoutMs: 25 * 60_000,
    check: ({ worktreeCount, metrics }) => {
      expect(worktreeCount, "no worktree was created").toBeGreaterThan(1);
      expect(metrics.launched).toContain("codex");
    },
  },
  {
    id: "rename",
    project: INVENTORY_PROJECT,
    messages: ["Start Codex with no task.", "Rename its tab to reviewer."],
    timeoutMs: 8 * 60_000,
    check: ({ workers }) => {
      expect(workers.some((t) => /reviewer/i.test(t.title ?? ""))).toBe(true);
    },
  },
  {
    id: "close-agents",
    project: INVENTORY_PROJECT,
    messages: ["Start Claude, Codex and Gemini with no task.", "Close all three."],
    timeoutMs: 8 * 60_000,
    check: ({ workers, metrics }) => {
      // Closed by the follow-up, so launches come from the transcript.
      const launches = metrics.toolCalls
        .filter((c) => /agent[._]launch/.test(`${c.name} ${c.input}`))
        .map((c) => c.input)
        .join(" ");
      for (const agent of ["claude", "codex", "gemini"]) {
        expect(launches, `${agent} was never launched`).toContain(agent);
      }
      expect(workers, "agents were left open").toEqual([]);
    },
  },
  {
    id: "plain-worktree",
    project: INVENTORY_PROJECT,
    messages: ["Make a new worktree for experimenting with sorting. Don't start any agents in it."],
    timeoutMs: 5 * 60_000,
    check: ({ workers, worktreeCount }) => {
      expect(worktreeCount, "no worktree was created").toBeGreaterThanOrEqual(2);
      expect(workers, "agents were started").toEqual([]);
    },
  },
  {
    id: "explore",
    project: INVENTORY_PROJECT,
    messages: ["Without launching any agents, tell me which commands src/cli.js supports."],
    timeoutMs: 5 * 60_000,
    check: ({ workers, answer }) => {
      expect(workers, "agents were launched").toEqual([]);
      expect(answer).toMatch(/report/);
    },
  },
  {
    id: "interview",
    project: INVENTORY_PROJECT,
    messages: [
      "Interview Codex about how it would add a `restock` command to this CLI: ask it three short questions one at a time, then summarise its plan for me.",
    ],
    timeoutMs: 15 * 60_000,
    check: ({ answer, metrics }) => {
      expect(metrics.launched).toContain("codex");
      expect(answer).toMatch(/restock/i);
    },
  },
  {
    id: "verify-work",
    project: INVENTORY_PROJECT,
    messages: [
      "Ask Claude to add a test for belowReorderPoint, then check its work yourself by running the tests, and tell me whether they pass.",
    ],
    timeoutMs: 15 * 60_000,
    check: ({ answer, metrics }) => {
      expect(metrics.launched).toContain("claude");
      expect(answer).toMatch(/pass|fail/i);
    },
  },
  {
    id: "recipe",
    project: {
      ...INVENTORY_PROJECT,
      ".daintree/recipes/pair.json": JSON.stringify(
        {
          id: "inrepo-pair",
          name: "Pair",
          terminals: [
            { type: "claude", title: "Claude", env: {} },
            { type: "codex", title: "Codex", env: {} },
          ],
          createdAt: 1775381905486,
          showInEmptyState: false,
        },
        null,
        2
      ),
    },
    messages: ["Make a new worktree for the CSV quoting work and set it up with the Pair recipe."],
    timeoutMs: 10 * 60_000,
    approveConfirms: true,
    check: ({ workers, worktreeCount }) => {
      expect(worktreeCount, "no worktree was created").toBeGreaterThanOrEqual(2);
      expect(workers.length, "the recipe opened no agents").toBeGreaterThanOrEqual(2);
    },
  },
  {
    id: "memory",
    project: INVENTORY_PROJECT,
    messages: ["Remember for this project that we always use tabs, not spaces, in JavaScript."],
    timeoutMs: 5 * 60_000,
    check: ({ workers, answer }) => {
      expect(workers, "agents were launched").toEqual([]);
      expect(answer, "the assistant never confirmed the rule").toMatch(/tab/i);
    },
  },
  {
    id: "status",
    project: INVENTORY_PROJECT,
    messages: ["Start Codex writing a test for parseCsv.", "What are my agents doing right now?"],
    timeoutMs: 12 * 60_000,
    // "Right now" means while Codex is still at it.
    settleOnAssistant: true,
    check: ({ metrics }) => {
      expect(metrics.launched).toContain("codex");
    },
  },
  {
    id: "watch-outcome",
    project: INVENTORY_PROJECT,
    messages: [
      "Start Claude on making applyMovement reject a movement with no sku, and tell me when it finishes and what it changed.",
    ],
    timeoutMs: 12 * 60_000,
    check: ({ answer, metrics }) => {
      expect(metrics.launched).toContain("claude");
      expect(answer).toMatch(/sku/i);
    },
  },
  {
    id: "usage",
    project: INVENTORY_PROJECT,
    messages: ["How much of my Claude and Codex usage do I have left?"],
    timeoutMs: 8 * 60_000,
    check: ({ answer }) => {
      expect(answer).toMatch(/usage|limit/i);
    },
  },
  {
    id: "diagnostics",
    project: INVENTORY_PROJECT,
    messages: ["Daintree feels sluggish today. What can you check for me?"],
    timeoutMs: 6 * 60_000,
    check: ({ workers, answer }) => {
      expect(workers, "agents were launched").toEqual([]);
      expect(answer, "the assistant never answered").not.toBe("");
    },
  },
  {
    id: "context-bundle",
    project: INVENTORY_PROJECT,
    messages: ["Make me a context bundle of src/ that I can paste into another chat."],
    timeoutMs: 6 * 60_000,
    check: ({ workers, answer }) => {
      expect(workers, "agents were launched").toEqual([]);
      expect(answer, "the assistant never answered").not.toBe("");
    },
  },
  {
    id: "competition",
    project: INVENTORY_PROJECT,
    messages: [
      "Have Claude and Codex compete: each writes its own clearer version of belowReorderPoint in its own worktree. Compare the two and tell me which is better.",
    ],
    timeoutMs: 20 * 60_000,
    check: ({ worktreeCount, metrics }) => {
      expect(worktreeCount, "the entrants did not get worktrees").toBeGreaterThanOrEqual(3);
      expect(metrics.launched).toEqual(expect.arrayContaining(["claude", "codex"]));
    },
  },
  {
    id: "answer-waiting",
    project: INVENTORY_PROJECT,
    messages: [
      "Ask Claude to suggest two ways to stop stock going negative, and to wait for me to pick one before it changes anything.",
      "Tell Claude to go with the first one.",
    ],
    timeoutMs: 15 * 60_000,
    check: ({ metrics }) => {
      expect(metrics.launched).toContain("claude");
      expect(
        metrics.toolCalls.some((c) => /sendCommand/.test(`${c.name} ${c.input}`)),
        "the pick was never relayed"
      ).toBe(true);
    },
  },
  {
    id: "relocate",
    project: INVENTORY_PROJECT,
    messages: [
      "Start Claude here and ask it to wait for instructions.",
      "Actually, move Claude to a new worktree called csv-quotes and have it make parseCsv handle quoted commas there.",
    ],
    timeoutMs: 15 * 60_000,
    check: ({ worktreeCount, metrics }) => {
      expect(worktreeCount, "no worktree was created").toBeGreaterThanOrEqual(2);
      expect(metrics.launched).toContain("claude");
    },
  },
];
