import type { FleetRunRow, FleetSnapshot } from "@shared/types/ipc/fleet";
import type { CanopyCard, CanopySeen, CanopySnapshot } from "@shared/types/ipc/canopy";
import type { Project } from "@shared/types/project";

/**
 * Fixtures for the canopy panel's review harness. Type-import-only, so the
 * screenshot spec can read the fixture names under Playwright's Node loader.
 */

export const CANOPY_FIXTURES = [
  "fleet",
  "describing",
  "off",
  "read-error",
  "calm",
  "empty",
  "long",
] as const;

export type CanopyFixture = (typeof CANOPY_FIXTURES)[number];

export function isCanopyFixture(value: string | null): value is CanopyFixture {
  return value !== null && (CANOPY_FIXTURES as readonly string[]).includes(value);
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

type CardSpec = Partial<CanopyCard> & Pick<CanopyCard, "runId" | "category">;

/**
 * What the two readers made of each fixture run: the classifier's probability
 * that it needs a person, and the describer's score. Spread across the range so
 * the inbox orders and draws its priority the way a real fleet would.
 */
/** What the describer said each run is working on overall. */
const TASKS: Record<string, string> = {
  "t-approval-edit": "Migrate the settings store",
  "t-approval-yn": "Audit the plugin system",
  "t-question": "Plan the testing strategy",
  "t-secret": "Deploy the website preview",
  "t-error": "Tidy up worktree management",
  "t-finished": "Write the architecture overview",
  "t-finished-pr": "Close plugin feedback gaps and open the PR",
  "t-working": "Fix the flaky watcher tests",
  "t-working-unseen": "Port the docs site to Astro",
  "t-working-quiet": "Export saved sessions",
};

const READINGS: Record<string, { attentionProbability: number; attentionScore: number | null }> = {
  "t-approval-edit": { attentionProbability: 0.96, attentionScore: 94 },
  "t-question": { attentionProbability: 0.93, attentionScore: 88 },
  "t-approval-yn": { attentionProbability: 0.82, attentionScore: 74 },
  "t-secret": { attentionProbability: 0.88, attentionScore: 81 },
  "t-error": { attentionProbability: 0.74, attentionScore: 66 },
  "t-finished": { attentionProbability: 0.61, attentionScore: 48 },
  "t-finished-pr": { attentionProbability: 0.9, attentionScore: 58 },
  "t-working-quiet": { attentionProbability: 0.31, attentionScore: null },
  "t-working": { attentionProbability: 0.08, attentionScore: 4 },
  "t-working-unseen": { attentionProbability: 0.06, attentionScore: 3 },
  "t-idle": { attentionProbability: 0.12, attentionScore: null },
};

function card(spec: CardSpec, runs: FleetRunRow[], now: number): CanopyCard {
  const owner = runs.find((r) => r.runId === spec.runId)!;
  const reading = READINGS[spec.runId] ?? { attentionProbability: 0.9, attentionScore: 90 };
  const priority = Math.round(
    reading.attentionScore === null ? reading.attentionProbability * 100 : reading.attentionScore
  );
  return {
    spawnedAt: owner.spawnedAt,
    revision: 3,
    confidence: 0.92,
    ...reading,
    priority,
    task: TASKS[spec.runId] ?? null,
    risk: "unknown",
    riskReason: null,
    action: null,
    progress: null,
    steps: null,
    tests: "unknown",
    changes: "unknown",
    handledAt: null,
    stage: "described",
    // The state the words were written for: a run only classified has none.
    wordsCategory: spec.stage === "classified" ? null : spec.category,
    describing: false,
    wordsFromEarlierRead: false,
    priorityFromEarlierRead: false,
    headline: null,
    summary: null,
    question: null,
    options: [],
    secretPrompt: false,
    activity: null,
    glance: { recap: null, said: null, doing: null, action: null },
    statusLine: null,
    contextLeft: null,
    stalledSince: null,
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
        runId: "t-finished-pr",
        workspaceId: DAINTREE,
        agentId: "claude",
        agentState: "waiting",
        title: "Plugin feedback",
        cwd: "/Users/dev/code/daintree-worktrees/feature-further-plugin-improvements",
        sinceMin: 24,
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
        runId: "t-working-unseen",
        workspaceId: WEBSITE,
        agentId: "codex",
        agentState: "working",
        title: "Astro docs port",
        cwd: "/Users/dev/code/website",
        sinceMin: 22,
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

function fleetCards(runs: FleetRunRow[], now: number): CanopyCard[] {
  return [
    card(
      {
        runId: "t-approval-edit",
        category: "approval",
        headline: "Review the edit to electron/store.ts",
        progress: 40,
        steps: { done: 2, total: 5, current: "Bump the store migration" },
        risk: "caution",
        riskReason: "Rewrites every saved profile's schema",
        summary: "Adds an editorPreferences entry to the store schema and bumps its migration.",
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
        headline: "Choose contract or E2E tests first",
        progress: 70,
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
        headline: "Enter the Vercel token in the terminal",
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
        progress: 30,
        tests: "not_run",
        changes: "uncommitted",
        summary: "The turn failed with a 429 from the provider and the agent exited its loop.",
      },
      runs,
      now
    ),
    card(
      {
        runId: "t-finished-pr",
        category: "finished",
        headline: "Review PR #13163 on GitHub",
        progress: 100,
        tests: "passing",
        changes: "pushed",
        summary:
          "All feedback fixes applied, committed, pushed, and PR opened against develop; CI and your review are next.",
      },
      runs,
      now
    ),
    card(
      {
        runId: "t-finished",
        category: "finished",
        headline: "Read the architecture overview",
        progress: 100,
        changes: "none",
        // Answered from the panel three minutes ago: out of the queue until it says more.
        handledAt: now - 3 * 60_000,
        priority: 0,
        summary: "Summarised Daintree's main, renderer and shared layers with file locations.",
      },
      runs,
      now
    ),
    card(
      {
        runId: "t-working",
        category: "working",
        headline: "Rewriting the wait in watcher.test.ts",
        progress: 60,
        summary:
          "Reproduced the flake on file add; three of the five failing cases pass with the new wait.",
        activity: "Reading src/components/Canopy/CanopyView.tsx",
      },
      runs,
      now
    ),
    card(
      {
        runId: "t-working-unseen",
        category: "working",
        headline: "Converting the guides to Astro content collections",
        progress: 45,
        summary:
          "Moved 14 of 31 guide pages and their frontmatter; the sidebar config is next, then the redirects.",
        activity: "Editing src/content/guides/getting-started.md",
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

/**
 * When the user last looked at each run: one working agent a minute ago, one
 * not for eighteen — which ranks it above the routine finished work — and the
 * rest not since Daintree started.
 */
function seenFor(now: number): CanopySeen[] {
  const spawnedAt = now - 120 * MIN;
  return [
    { runId: "t-working", spawnedAt, at: now - 1 * MIN },
    { runId: "t-working-unseen", spawnedAt, at: now - 18 * MIN },
    { runId: "t-approval-edit", spawnedAt, at: now - 2 * MIN },
  ];
}

function snapshot(cards: CanopyCard[], now: number, extra: Partial<CanopySnapshot> = {}) {
  return {
    activated: true,
    // The beta's free tier, as most people run it: the standing notice shows.
    tier: "free" as const,
    dispositions: [],
    seen: seenFor(now),
    scope: null,
    active: true,
    busy: false,
    refreshedAt: now - 3_000,
    cards,
    lastError: null,
    failedRuns: [],
    glances: [],
    ...extra,
  } satisfies CanopySnapshot;
}

function fleet(runs: FleetRunRow[], now: number): FleetSnapshot {
  return { runs, changedAt: now - 5_000, degraded: false, lastSuccessfulAt: now - 1_000 };
}

export interface CanopyScene {
  fleet: FleetSnapshot;
  canopy: CanopySnapshot;
}

export function sceneFor(fixture: CanopyFixture, now: number): CanopyScene {
  const runs = fleetRuns(now);
  const cards = fleetCards(runs, now);
  switch (fixture) {
    case "fleet":
      return { fleet: fleet(runs, now), canopy: snapshot(cards, now) };
    case "describing":
      return {
        fleet: fleet(runs, now),
        canopy: snapshot(
          cards.map((c) =>
            c.category === "approval" || c.category === "question" || c.category === "finished"
              ? {
                  ...c,
                  stage: "classified",
                  describing: true,
                  headline: null,
                  summary: null,
                  risk: "unknown",
                  riskReason: null,
                  action: null,
                }
              : c
          ),
          now,
          { busy: true }
        ),
      };
    case "off":
      return {
        fleet: fleet(runs, now),
        canopy: snapshot([], now, { activated: false, refreshedAt: null }),
      };
    case "read-error":
      return {
        // One run moved after its card was read, so its words are kept but its menu is not.
        fleet: fleet(
          runs.map((r) => (r.runId === "t-approval-yn" ? { ...r, since: now } : r)),
          now
        ),
        canopy: snapshot(
          cards.filter((c) => c.runId !== "t-question"),
          now,
          { lastError: "The describer timed out after 8s", failedRuns: ["t-approval-yn"] }
        ),
      };
    case "calm": {
      const calm = runs.filter((r) => r.agentState === "working" || r.agentState === "idle");
      return {
        fleet: fleet(calm, now),
        canopy: snapshot(
          cards.filter((c) => calm.some((r) => r.runId === c.runId)),
          now
        ),
      };
    }
    case "empty":
      return { fleet: fleet([], now), canopy: snapshot([], now) };
    case "long": {
      const longRuns = runs.map((r) =>
        r.runId === "t-approval-edit"
          ? {
              ...r,
              title:
                "Migrate the settings store to the new schema and backfill every profile's editor preferences",
              cwd: "/Users/dev/code/daintree-worktrees/feature-settings-store-migration-backfill",
            }
          : r
      );
      return {
        fleet: fleet(longRuns, now),
        canopy: snapshot(
          cards.map((c) =>
            c.runId === "t-approval-edit"
              ? {
                  ...c,
                  headline:
                    "Approve a multi-file edit that rewrites the store schema and its migration chain",
                  summary:
                    "Touches electron/store.ts, scripts/perf/lib/migrationFixture.ts and three tests; the migration renames editorPrefs to editorPreferences across every saved profile.",
                  question:
                    "Do you want to make this edit to electron/store.ts, scripts/perf/lib/migrationFixture.ts and electron/services/editor/editorPreferences.ts?",
                  options: [
                    "Yes",
                    "Yes, and don't ask again for edits to files under electron/services/editor this session",
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

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

/**
 * A believable bottom of the screen for a fixture run, built from its own card:
 * the agent's last line, the prompt or menu it is asking, and its input line.
 * The live pane writes it as the stream's snapshot, so the pane shows a
 * terminal rather than a black box.
 */
export function previewScreenFor(card: CanopyCard): string {
  const lines: string[] = [];
  const blank = () => lines.push("");
  blank();
  if (card.summary) lines.push(`${DIM}⏺${RESET} ${card.summary}`);
  blank();
  if (card.question) {
    lines.push(`${BOLD}${card.question}${RESET}`);
    blank();
    card.options.forEach((option, index) =>
      lines.push(`${index === 0 ? "❯" : " "} ${index + 1}. ${option}`)
    );
    if (card.options.length === 0) lines.push("❯ ");
  } else if (card.activity) {
    lines.push(`${DIM}✻${RESET} ${card.activity}… ${DIM}(esc to interrupt)${RESET}`);
    blank();
    lines.push("❯ ");
  } else if (card.headline) {
    lines.push(`${DIM}✻ ${card.headline}${RESET}`);
    blank();
    lines.push("❯ ");
  } else {
    lines.push("❯ ");
  }
  return lines.join("\r\n");
}
