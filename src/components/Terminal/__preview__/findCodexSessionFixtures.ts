import type {
  CodexFolderSession,
  CodexFolderSessionsResult,
} from "@shared/types/ipc/agentSubagents";

/**
 * Session lists for the "Find session" popover harness.
 *
 * `agoMs` stands in for `updatedAt` so the ages read the same on every run;
 * the shim resolves it against the page's own clock.
 */
export interface FindSessionFixtureSession extends Omit<CodexFolderSession, "updatedAt"> {
  agoMs: number;
}

export interface FindSessionFixture {
  /** `pending` never answers, so the popover holds its loading state. */
  result: "ok" | "unavailable" | "pending";
  sessions?: FindSessionFixtureSession[];
  reason?: Extract<CodexFolderSessionsResult, { status: "unavailable" }>["reason"];
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const THREE: FindSessionFixtureSession[] = [
  {
    id: "0199a1f2-7c3e-7a10-9b4e-1c2d3e4f5a01",
    preview:
      "Tighten the retry loop in the session refresh path so a 401 from the token endpoint stops after one attempt instead of three.",
    agoMs: 4 * MIN,
  },
  {
    id: "0199a1f2-7c3e-7a10-9b4e-1c2d3e4f5a02",
    name: "Forge token banner port",
    preview:
      "Port the forge token banner to the shared InlineStatusBanner.\n\nKeep the dismiss behaviour and the docs link.",
    agoMs: 2 * HOUR + 12 * MIN,
  },
  {
    id: "0199a1f2-7c3e-7a10-9b4e-1c2d3e4f5a03",
    preview: "Why does the worktree sidebar flash empty for a frame after switching projects?",
    agoMs: 3 * DAY,
  },
];

/**
 * Twelve sessions whose first words are the same — the case a one-line,
 * 80-character preview turns into a column of identical rows.
 */
const MANY: FindSessionFixtureSession[] = [
  "src/services/agentResume.test.ts — the resume flag reconciliation case started failing after the preset refactor.",
  "src/components/Terminal/__tests__/FindCodexSessionAction.test.tsx — the sibling-held filter case times out on CI only.",
  "electron/services/codex/CodexSubagentService.test.ts — listThreadsInCwd returns the subagent threads too.",
  "src/store/panelStore.test.ts — addPanel drops the conversationCwd when the pane moves worktrees.",
  "shared/utils/agentFsm.test.ts — the waiting → working transition fires twice on a redraw.",
  "src/hooks/useDeferredLoading.test.ts — fake timers leak between cases and the gate never opens.",
  "electron/ipc/handlers/codex.test.ts — the find-sessions schema rejects a CODEX_HOME with spaces.",
  "src/components/Terminal/__tests__/RestoreRecoveryGate.test.tsx — the gate renders twice under StrictMode.",
  "src/utils/restoreRecovery.test.ts — resolveConversationSearchCwd ignores an empty conversationCwd.",
  "src/services/terminal/restoreRecoveryLaunch.test.ts — siblingHeldSessionIds counts the pane itself.",
  "e2e/full-terminal/session-restore.spec.ts — the lost-session banner never appears on Linux.",
  "src/components/ui/__tests__/popoverHeaders.contract.test.ts — the header contract flags a false positive.",
].map((tail, i) => ({
  id: `0199a1f3-0000-7000-8000-${String(i + 1).padStart(12, "0")}`,
  preview: `Fix the failing test in ${tail}\n\nRun only that file, not the whole suite.`,
  agoMs:
    [6 * MIN, 21 * MIN, 48 * MIN, 2 * HOUR, 5 * HOUR, 9 * HOUR, DAY, DAY + 3 * HOUR][i] ??
    (i - 5) * DAY,
}));

/**
 * The previews a real first message produces: leading blank lines, a fenced
 * block, a path with no break opportunities, a paragraph far past two lines,
 * a named thread whose name is long too, and a session with no preview at all.
 */
const LONG: FindSessionFixtureSession[] = [
  {
    id: "0199a1f4-0000-7000-8000-000000000001",
    preview:
      "\n\n   We need to rework how the lost-session banner decides between offering a resume and offering the session finder, because right now a pane whose conversation was claimed by a sibling gets the finder even though the finder will filter that very conversation out, which leaves the user looking at a list that can never contain the thing they came for. Start by reading restartStatus.ts and the restore election, then propose the smallest change.",
    agoMs: 3 * MIN,
  },
  {
    id: "0199a1f4-0000-7000-8000-000000000002",
    preview:
      '```ts\nexport function firstLine(value: string): string {\n  return value.trim().split("\\n")[0]?.trim() ?? "";\n}\n```\nThis helper drops everything after the first newline — replace it with something that keeps the first meaningful lines.',
    agoMs: 37 * MIN,
  },
  {
    id: "0199a1f4-0000-7000-8000-000000000003",
    preview:
      "/Users/dev/Projects/acme-platform/packages/session-store/src/internal/persistence/sqliteSessionJournalWriterImplementation.ts is leaking file handles",
    agoMs: 4 * HOUR,
  },
  {
    id: "0199a1f4-0000-7000-8000-000000000004",
    name: "Session journal compaction and the vacuum schedule for long-lived worktrees",
    preview:
      "Look at how the session journal grows on a worktree that has been open for a month and propose a compaction schedule.",
    agoMs: DAY + 2 * HOUR,
  },
  {
    id: "0199a1f4-0000-7000-8000-000000000005",
    preview: "",
    agoMs: 6 * DAY,
  },
];

export const FIND_SESSION_FIXTURES = {
  three: { result: "ok", sessions: THREE },
  many: { result: "ok", sessions: MANY },
  long: { result: "ok", sessions: LONG },
  empty: { result: "ok", sessions: [] },
  unavailable: { result: "unavailable", reason: "timeout" },
  loading: { result: "pending" },
} satisfies Record<string, FindSessionFixture>;

export type FindSessionFixtureName = keyof typeof FIND_SESSION_FIXTURES;

export function requireFindSessionFixture(name: string): FindSessionFixture {
  if (!(name in FIND_SESSION_FIXTURES)) throw new Error(`unknown fixture "${name}"`);
  return FIND_SESSION_FIXTURES[name as FindSessionFixtureName];
}
