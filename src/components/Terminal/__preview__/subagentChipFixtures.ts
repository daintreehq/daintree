import type {
  AgentSubagent,
  AgentSubagentTranscriptResult,
  SubagentProvider,
} from "@shared/types/ipc/agentSubagents";

// Type-only imports, on purpose: the capture spec imports this catalogue under
// Playwright's Node loader, where anything reaching Vite-only code fails.

/**
 * One scenario for the subagent chip harness: which agent the pane runs, what
 * the list lookup answers, and how each child's transcript read behaves.
 */
export interface SubagentChipFixture {
  what: string;
  provider: SubagentProvider;
  /** Pane width in CSS px. 560 is the common 2x2 grid pane; 360 is the pressure case. */
  width: number;
  subagents: Array<Omit<AgentSubagent, "createdAt" | "updatedAt"> & { agoMs: number }>;
  /** `hang` never answers, so the in-flight state can be photographed. */
  transcript: "ok" | "long" | "empty" | "unavailable" | "hang";
  /** Every list call after the first never answers — the popover's refreshing state. */
  hangRefresh?: boolean;
}

const minute = 60_000;

const CODEX_FLEET: SubagentChipFixture["subagents"] = [
  {
    id: "019a-meitner",
    label: "Meitner",
    role: "reviewer",
    preview: "Review the session refresh diff for token replay and expiry edge cases",
    model: "gpt-6-sol",
    depth: null,
    status: { type: "working" },
    agoMs: 12_000,
  },
  {
    id: "019a-kant",
    label: "Kant",
    role: "worker",
    preview: "Run the auth test suite and report failures",
    model: "gpt-6-sol",
    depth: null,
    status: { type: "blocked", reason: "approval" },
    agoMs: 2 * minute,
  },
  {
    id: "019a-hopper",
    label: "Hopper",
    role: "explorer",
    preview: "Find every caller of rotateToken across electron/ and src/",
    model: null,
    depth: null,
    status: { type: "idle" },
    agoMs: 6 * minute,
  },
  {
    id: "019a-noether",
    label: "Noether",
    role: "worker",
    preview: "Migrate the billing reconciliation worker off the legacy cron scheduler",
    model: "gpt-6-astra",
    depth: null,
    status: { type: "error" },
    agoMs: 14 * minute,
  },
  {
    id: "019a-lovelace",
    label: null,
    role: null,
    preview: "Summarise open questions in docs/architecture/terminal-lifecycle.md",
    model: null,
    depth: null,
    status: { type: "unknown", reason: "not-loaded" },
    agoMs: 41 * minute,
  },
];

const CLAUDE_ONE: SubagentChipFixture["subagents"] = [
  {
    id: "a81c4d2e",
    label: "Audit IPC handlers for missing sender validation",
    role: "general-purpose",
    preview: "Read electron/ipc/handlers and list every handler that skips the sender check",
    model: "claude-sonnet-5",
    depth: 1,
    status: { type: "completed" },
    agoMs: 3 * minute,
  },
];

function denseFleet(): SubagentChipFixture["subagents"] {
  const names = [
    "Meitner",
    "Kant",
    "Hopper",
    "Noether",
    "Curie",
    "Turing",
    "Lamarr",
    "Franklin",
    "Babbage",
    "Ramanujan",
    "Hypatia",
    "Galois",
    "Euler",
    "Shannon",
  ];
  const statuses: AgentSubagent["status"][] = [
    { type: "working" },
    { type: "idle" },
    { type: "blocked", reason: "input" },
    { type: "idle" },
    { type: "error" },
    { type: "unknown", reason: "stale" },
  ];
  return names.map((name, index) => ({
    id: `019b-${name.toLowerCase()}`,
    label: name,
    role: index % 3 === 0 ? "reviewer" : "worker",
    preview: `Shard ${index + 1} of the flaky-test sweep: re-run and bisect src/**/__tests__`,
    model: null,
    depth: null,
    status: statuses[index % statuses.length]!,
    agoMs: (index + 1) * 3 * minute,
  }));
}

export const FIXTURES = {
  "codex-mixed": {
    what: "Codex pane with five children across every status it reports",
    provider: "codex",
    width: 560,
    subagents: CODEX_FLEET,
    transcript: "ok",
  },
  "codex-long-transcript": {
    what: "an expanded child with a long, truncated transcript",
    provider: "codex",
    width: 560,
    subagents: CODEX_FLEET,
    transcript: "long",
  },
  "codex-transcript-empty": {
    what: "an expanded child that has recorded no messages yet",
    provider: "codex",
    width: 560,
    subagents: CODEX_FLEET,
    transcript: "empty",
  },
  "codex-transcript-unavailable": {
    what: "an expanded child whose transcript read failed",
    provider: "codex",
    width: 560,
    subagents: CODEX_FLEET,
    transcript: "unavailable",
  },
  "codex-transcript-loading": {
    what: "an expanded child whose transcript read has not answered",
    provider: "codex",
    width: 560,
    subagents: CODEX_FLEET,
    transcript: "hang",
  },
  "codex-refreshing": {
    what: "the popover while a manual refresh is in flight",
    provider: "codex",
    width: 560,
    subagents: CODEX_FLEET,
    transcript: "ok",
    hangRefresh: true,
  },
  "claude-single": {
    what: "Claude pane with one completed child (singular copy, depth, long label)",
    provider: "claude",
    width: 560,
    subagents: CLAUDE_ONE,
    transcript: "ok",
  },
  "codex-dense": {
    what: "fourteen children — the list scrolls",
    provider: "codex",
    width: 560,
    subagents: denseFleet(),
    transcript: "ok",
  },
  "codex-narrow": {
    what: "a 360px pane — the header is under pressure",
    provider: "codex",
    width: 360,
    subagents: CODEX_FLEET,
    transcript: "ok",
  },
} satisfies Record<string, SubagentChipFixture>;

export type SubagentChipFixtureName = keyof typeof FIXTURES;

export function isFixtureName(value: string): value is SubagentChipFixtureName {
  return Object.hasOwn(FIXTURES, value);
}

const LONG_REPLY = [
  "Checked the refresh path end to end.",
  "",
  "1. `rotate()` runs before the expiry check in `refresh()`, so a token that is still valid gets rotated on every call. That doubles the write load on the session table and breaks the replay window, because the old nonce is retired early.",
  "2. `session.ts:48` compares `expiresAt > Date.now()` where it means `<`. Inverted, the fast path returns an expired session.",
  "3. The replay test only asserts the status code, not that the nonce was consumed, so it passes either way.",
  "",
  "Suggested fix: flip the comparison, move rotation behind it, and assert `nonces.has(old) === false` in the test.",
].join("\n");

export function transcriptFor(
  fixture: SubagentChipFixture,
  subagentId: string
): AgentSubagentTranscriptResult | null {
  switch (fixture.transcript) {
    case "hang":
      return null;
    case "unavailable":
      return { status: "unavailable", reason: "timeout" };
    case "empty":
      return { status: "ok", subagentId, messages: [], truncated: false };
    case "long":
      return {
        status: "ok",
        subagentId,
        truncated: true,
        messages: [
          {
            role: "task",
            text: "Review the session refresh diff for token replay and expiry edge cases. Report anything that would let an expired or replayed token through.",
          },
          { role: "reply", text: LONG_REPLY },
          { role: "task", text: "Also check the tests cover the inverted comparison." },
          { role: "reply", text: LONG_REPLY },
        ],
      };
    case "ok":
    default:
      return {
        status: "ok",
        subagentId,
        truncated: false,
        messages: [
          {
            role: "task",
            text: "Review the session refresh diff for token replay and expiry edge cases.",
          },
          {
            role: "reply",
            text: "Found two problems: the expiry comparison in session.ts:48 is inverted, and rotation runs before the check. Details in the thread.",
          },
        ],
      };
  }
}
