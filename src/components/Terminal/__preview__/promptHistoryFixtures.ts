import type { PromptHistoryEntry } from "@/store/commandHistoryStore";

/**
 * Fixtures for the prompt history palette review harness.
 *
 * Modelled on what an agent composer actually accumulates: short one-liners,
 * prompts pasted in as several paragraphs, one that opens with a blank line,
 * one that is a single enormous line, a markdown checklist, a fenced code
 * block, and a fleet broadcast — across three agents plus a prompt whose agent
 * was never recorded. Timestamps are relative to page load so "5m ago" reads
 * as it would in the app.
 */

export const PROJECT_ID = "proj-daintree";
export const OTHER_PROJECT_ID = "proj-helios";
export const TERMINAL_ID = "term-preview";

const NOW = Date.now();
const minutes = (n: number) => NOW - n * 60_000;
const hours = (n: number) => minutes(n * 60);
const days = (n: number) => hours(n * 24);

function entry(
  id: string,
  prompt: string,
  agentId: string | null,
  addedAt: number,
  extra: Partial<PromptHistoryEntry> = {}
): PromptHistoryEntry {
  return { id, prompt, agentId, addedAt, ...extra };
}

const LONG_LINE =
  "Go through every forge provider we ship (GitHub, GitLab, Gitea, Bitbucket) and make the retry backoff use full jitter with an exponential cap of thirty seconds, then add a test per provider that pins the cap and asserts that two concurrent retries never land in the same hundred-millisecond window, because right now the rate limiter sees them as a burst and locks us out for an hour";

export const PROJECT_HISTORY: PromptHistoryEntry[] = [
  entry("h-1", "fix the failing typecheck in the worktree sidebar", "claude", minutes(2)),
  entry(
    "h-2",
    "The pane resize handler loses the scroll position when the composer grows.\n\nRepro:\n1. Scroll up in a Codex pane\n2. Paste a three-line draft\n3. The viewport jumps to the top\n\nFind the cause, don't just clamp it.",
    "codex",
    minutes(14)
  ),
  entry("h-3", LONG_LINE, "claude", minutes(48)),
  entry(
    "h-4",
    "\n\n  rebase onto develop and resolve the conflicts in the palette store",
    "gemini",
    hours(3)
  ),
  entry(
    "h-5",
    "- [ ] audit every palette row for bare `rounded`\n- [ ] swap legacy daintree-* aliases\n- [ ] re-run the text ramp",
    "claude",
    hours(7)
  ),
  entry(
    "h-6",
    "```ts\nexport const retry = (n: number) => Math.min(30_000, 2 ** n * 100);\n```\nwhy does this overflow at n = 40?",
    null,
    days(1)
  ),
  entry("h-7", "run the full test suite and tell me what failed", "codex", days(2), {
    armedIds: ["t1", "t2", "t3", "t4"],
    targetSpec: { scope: "current", stateFilter: "all" },
  }),
  entry("h-8", "summarise the diff", "claude", days(4)),
  entry("h-9", "write the changelog entry for the release", "gemini", days(13)),
];

export const OTHER_PROJECT_HISTORY: PromptHistoryEntry[] = [
  entry("o-1", "add a dark mode toggle to the Helios dashboard header", "claude", minutes(6)),
  entry("o-2", "why is the streaming tokens chart dropping frames?", "codex", hours(5)),
  // A duplicate of a prompt in the main project, so global scope's de-dupe is visible.
  entry("o-3", "summarise the diff", "claude", days(3)),
];

export interface PromptHistoryFixture {
  history: Record<string, PromptHistoryEntry[]>;
}

const FIXTURES: Record<string, PromptHistoryFixture> = {
  populated: {
    history: { [PROJECT_ID]: PROJECT_HISTORY, [OTHER_PROJECT_ID]: OTHER_PROJECT_HISTORY },
  },
  empty: { history: {} },
};

export const FIXTURE_NAMES = Object.keys(FIXTURES);

export function requireFixture(name: string): PromptHistoryFixture {
  const fixture = FIXTURES[name];
  if (!fixture) throw new Error(`unknown prompt-history fixture "${name}"`);
  return fixture;
}
