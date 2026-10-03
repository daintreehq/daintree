import type { FleetRunRow, FleetSnapshot } from "@shared/types/ipc/fleet";
import type { TriageCard, TriageSnapshot } from "@shared/types/ipc/triage";
import type { Project } from "@shared/types/project";

/**
 * Fixtures for the triage panel's review harness. Type-import-only, so the
 * screenshot spec can read the fixture names under Playwright's Node loader.
 */

export const TRIAGE_FIXTURES = [
  "fleet",
  "describing",
  "unconfigured",
  "read-error",
  "calm",
  "empty",
  "long",
] as const;

export type TriageFixture = (typeof TRIAGE_FIXTURES)[number];

export function isTriageFixture(value: string | null): value is TriageFixture {
  return value !== null && (TRIAGE_FIXTURES as readonly string[]).includes(value);
}

const MIN = 60_000;

const DAINTREE = "a".repeat(64);
const ASSISTANT = "b".repeat(64);
const WEBSITE = "c".repeat(64);

export function projectsFor(now: number): Project[] {
  return [
    {
      id: DAINTREE,
      path: "/Users/dev/code/daintree",
      name: "Daintree",
      emoji: "🌳",
      color: "green",
      lastOpened: now - 1 * MIN,
    },
    {
      id: ASSISTANT,
      path: "/Users/dev/code/assistant",
      name: "Assistant",
      emoji: "🧭",
      color: "blue",
      lastOpened: now - 30 * MIN,
    },
    {
      id: WEBSITE,
      path: "/Users/dev/code/website",
      name: "Website",
      emoji: "🪴",
      color: "orange",
      lastOpened: now - 90 * MIN,
    },
  ];
}

export const CURRENT_WORKSPACE_ID = DAINTREE;

interface RunSpec {
  runId: string;
  workspaceId: string;
  agentId: FleetRunRow["agentId"];
  agentState: FleetRunRow["agentState"];
  waitingReason?: FleetRunRow["waitingReason"];
  title: string;
  cwd: string;
  sinceMin: number;
  quietMin?: number;
}

function run(spec: RunSpec, now: number): FleetRunRow {
  return {
    runId: spec.runId,
    workspaceId: spec.workspaceId,
    agentId: spec.agentId,
    launchAgentId: spec.agentId,
    everDetectedAgent: true,
    agentState: spec.agentState,
    ...(spec.waitingReason ? { waitingReason: spec.waitingReason } : {}),
    since: now - spec.sinceMin * MIN,
    spawnedAt: now - 120 * MIN,
    title: spec.title,
    titleMode: "user",
    cwd: spec.cwd,
    ...(spec.quietMin !== undefined ? { quietSince: now - spec.quietMin * MIN } : {}),
  };
}

type CardSpec = Partial<TriageCard> & Pick<TriageCard, "runId" | "category">;

function card(spec: CardSpec, runs: FleetRunRow[], now: number): TriageCard {
  const owner = runs.find((r) => r.runId === spec.runId)!;
  return {
    spawnedAt: owner.spawnedAt,
    revision: 3,
    confidence: 0.92,
    attentionProbability: 0.9,
    attentionScore: null,
    priority: 90,
    stage: "described",
    describing: false,
    headline: null,
    summary: null,
    question: null,
    options: [],
    secretPrompt: false,
    activity: null,
    observedAt: now - 2_000,
    ...spec,
  };
}

const DT = "/Users/dev/code/daintree";
const DT_WT = "/Users/dev/code/daintree-worktrees/feature-ai-summary";

function fleetRuns(now: number): FleetRunRow[] {
  return [
    run(
      {
        runId: "t-approval-edit",
        workspaceId: DAINTREE,
        agentId: "claude",
        agentState: "waiting",
        waitingReason: "approval",
        title: "Migrate settings store",
        cwd: DT_WT,
        sinceMin: 4,
      },
      now
    ),
    run(
      {
        runId: "t-approval-yn",
        workspaceId: ASSISTANT,
        agentId: "gemini",
        agentState: "waiting",
        waitingReason: "approval",
        title: "Plugin system audit",
        cwd: "/Users/dev/code/assistant",
        sinceMin: 2,
      },
      now
    ),
    run(
      {
        runId: "t-question",
        workspaceId: DAINTREE,
        agentId: "codex",
        agentState: "waiting",
        waitingReason: "question",
        title: "Testing strategy",
        cwd: DT,
        sinceMin: 6,
      },
      now
    ),
    run(
      {
        runId: "t-secret",
        workspaceId: WEBSITE,
        agentId: "opencode",
        agentState: "waiting",
        waitingReason: "question",
        title: "Deploy preview",
        cwd: "/Users/dev/code/website",
        sinceMin: 1,
      },
      now
    ),
    run(
      {
        runId: "t-error",
        workspaceId: DAINTREE,
        agentId: "grok",
        agentState: "waiting",
        waitingReason: "error",
        title: "Worktree management",
        cwd: DT,
        sinceMin: 9,
      },
      now
    ),
    run(
      {
        runId: "t-finished",
        workspaceId: DAINTREE,
        agentId: "claude",
        agentState: "completed",
        title: "Architecture overview",
        cwd: DT,
        sinceMin: 12,
      },
      now
    ),
    run(
      {
        runId: "t-working",
        workspaceId: DAINTREE,
        agentId: "claude",
        agentState: "working",
        title: "Fix flaky watcher test",
        cwd: DT_WT,
        sinceMin: 3,
      },
      now
    ),
    run(
      {
        runId: "t-working-quiet",
        workspaceId: ASSISTANT,
        agentId: "codex",
        agentState: "working",
        title: "Session export",
        cwd: "/Users/dev/code/assistant",
        sinceMin: 25,
        quietMin: 14,
      },
      now
    ),
    run(
      {
        runId: "t-idle",
        workspaceId: DAINTREE,
        agentId: "claude",
        agentState: "idle",
        title: "Claude Code",
        cwd: DT_WT,
        sinceMin: 40,
      },
      now
    ),
  ];
}

function fleetCards(runs: FleetRunRow[], now: number): TriageCard[] {
  return [
    card(
      {
        runId: "t-approval-edit",
        category: "approval",
        headline: "Approve the edit to electron/store.ts",
        summary: "Adds a triageProviderKeys entry to the store schema and bumps its migration.",
        question: "Do you want to make this edit to store.ts?",
        options: [
          "Yes",
          "Yes, allow all edits during this session",
          "No, and tell Claude what to do differently",
        ],
      },
      runs,
      now
    ),
    card(
      {
        runId: "t-approval-yn",
        category: "approval",
        headline: "Debug the failed research extension?",
        summary: "The extension failed to start because SERPER_API_KEY is missing.",
        question:
          "Would you like me to help debug the 'internal-research-tools' extension failure?",
        options: ["No", "Yes"],
      },
      runs,
      now
    ),
    card(
      {
        runId: "t-question",
        category: "question",
        headline: "Which test layer should it start with?",
        summary: "Mapped the unit, contract and E2E suites; wants a starting point before writing.",
        question: "Should I start with the contract tests or the E2E buckets?",
      },
      runs,
      now
    ),
    card(
      {
        runId: "t-secret",
        category: "question",
        headline: "Wants the deploy token",
        summary: "The preview deploy needs a Vercel token to continue.",
        question: "Enter your Vercel token:",
        secretPrompt: true,
      },
      runs,
      now
    ),
    card(
      {
        runId: "t-error",
        category: "error",
        headline: "Grok stopped on an API error",
        summary: "The turn failed with a 429 from the provider and the agent exited its loop.",
      },
      runs,
      now
    ),
    card(
      {
        runId: "t-finished",
        category: "finished",
        headline: "Architecture overview written",
        summary: "Summarised Daintree's main, renderer and shared layers with file locations.",
      },
      runs,
      now
    ),
    card(
      {
        runId: "t-working",
        category: "working",
        stage: "classified",
        activity: "Reading src/components/Triage/TriageView.tsx",
      },
      runs,
      now
    ),
    card(
      {
        runId: "t-working-quiet",
        category: "working",
        stage: "classified",
        activity: "Running npm test -- electron/services/session",
      },
      runs,
      now
    ),
    card({ runId: "t-idle", category: "idle", stage: "classified", activity: null }, runs, now),
  ];
}

function snapshot(cards: TriageCard[], now: number, extra: Partial<TriageSnapshot> = {}) {
  return {
    configured: true,
    missingKeys: [],
    active: true,
    busy: false,
    refreshedAt: now - 3_000,
    describerModel: "gpt-oss-120b",
    cards,
    lastError: null,
    ...extra,
  } satisfies TriageSnapshot;
}

function fleet(runs: FleetRunRow[], now: number): FleetSnapshot {
  return { runs, changedAt: now - 5_000, degraded: false, lastSuccessfulAt: now - 1_000 };
}

export interface TriageScene {
  fleet: FleetSnapshot;
  triage: TriageSnapshot;
}

export function sceneFor(fixture: TriageFixture, now: number): TriageScene {
  const runs = fleetRuns(now);
  const cards = fleetCards(runs, now);
  switch (fixture) {
    case "fleet":
      return { fleet: fleet(runs, now), triage: snapshot(cards, now) };
    case "describing":
      return {
        fleet: fleet(runs, now),
        triage: snapshot(
          cards.map((c) =>
            c.category === "approval" || c.category === "question" || c.category === "finished"
              ? { ...c, stage: "classified", describing: true, headline: null, summary: null }
              : c
          ),
          now,
          { busy: true }
        ),
      };
    case "unconfigured":
      return {
        fleet: fleet(runs, now),
        triage: snapshot([], now, {
          configured: false,
          missingKeys: ["TYPESAFE_API_KEY", "CEREBRAS_API_KEY"],
          refreshedAt: null,
        }),
      };
    case "read-error":
      return {
        // One run moved after its card was read, so its words are kept but its menu is not.
        fleet: fleet(
          runs.map((r) => (r.runId === "t-approval-yn" ? { ...r, since: now } : r)),
          now
        ),
        triage: snapshot(
          cards.filter((c) => c.runId !== "t-question"),
          now,
          { lastError: "The describer timed out after 8s" }
        ),
      };
    case "calm": {
      const calm = runs.filter((r) => r.agentState === "working" || r.agentState === "idle");
      return {
        fleet: fleet(calm, now),
        triage: snapshot(
          cards.filter((c) => calm.some((r) => r.runId === c.runId)),
          now
        ),
      };
    }
    case "empty":
      return { fleet: fleet([], now), triage: snapshot([], now) };
    case "long": {
      const longRuns = runs.map((r) =>
        r.runId === "t-approval-edit"
          ? {
              ...r,
              title:
                "Migrate the settings store to the new schema and backfill every profile's provider keys",
              cwd: "/Users/dev/code/daintree-worktrees/feature-settings-store-migration-backfill",
            }
          : r
      );
      return {
        fleet: fleet(longRuns, now),
        triage: snapshot(
          cards.map((c) =>
            c.runId === "t-approval-edit"
              ? {
                  ...c,
                  headline:
                    "Approve a multi-file edit that rewrites the store schema and its migration chain",
                  summary:
                    "Touches electron/store.ts, scripts/perf/lib/migrationFixture.ts and three tests; the migration renames triageKeys to triageProviderKeys across every saved profile.",
                  question:
                    "Do you want to make this edit to electron/store.ts, scripts/perf/lib/migrationFixture.ts and electron/services/triage/triageKeyStore.ts?",
                  options: [
                    "Yes",
                    "Yes, and don't ask again for edits to files under electron/services/triage this session",
                    "No, and tell Claude what to do differently (esc)",
                  ],
                }
              : c
          ),
          now
        ),
      };
    }
  }
}
