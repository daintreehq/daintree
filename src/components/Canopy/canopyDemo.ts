import type { AgentState } from "@shared/types/agent";
import type { CanopyCard, CanopyCategory } from "@shared/types/ipc/canopy";
import type { FleetRunRow } from "@shared/types/ipc/fleet";
import type { BuiltInAgentId } from "@shared/config/agentIds";
import { buildPilotGroups } from "@/components/Pilot/pilotRows";
import { buildCanopyInbox, type CanopyItem } from "./canopyModel";

/**
 * The inbox the panel shows someone who hasn't set Canopy up: made-up agents in
 * a made-up project, played through a loop of the moments Canopy is for — an
 * agent stopping for permission and rising to the top, the answer sending it
 * back to work, a run's progress filling, a finished run settling below, a
 * stalled one surfacing. Real rows, so the demo is the product.
 */

const PROJECT = "demo";
const MINUTE = 60_000;

interface DemoAgent {
  runId: string;
  agentId: BuiltInAgentId;
  title: string;
  worktree: string;
}

const AGENTS: readonly DemoAgent[] = [
  { runId: "demo-sdk", agentId: "codex", title: "Upgrade payments SDK", worktree: "payments-v18" },
  {
    runId: "demo-pages",
    agentId: "claude",
    title: "Paginate the recipes API",
    worktree: "pagination",
  },
  { runId: "demo-flaky", agentId: "gemini", title: "Flaky login test", worktree: "login-tests" },
  { runId: "demo-notes", agentId: "claude", title: "Release notes", worktree: "main" },
  { runId: "demo-auth", agentId: "opencode", title: "Auth middleware", worktree: "auth-refactor" },
];

interface DemoReading {
  state: AgentState;
  /** Minutes in this state. */
  for: number;
  category: CanopyCategory;
  priority: number;
  headline: string;
  summary: string;
  task: string;
  question?: string;
  options?: string[];
  action?: string;
  risk?: CanopyCard["risk"];
  progress?: number;
  steps?: { done: number; total: number };
  tests?: CanopyCard["tests"];
  changes?: CanopyCard["changes"];
  stalledFor?: number;
}

type DemoFrame = Record<string, DemoReading>;

const SDK_WORKING: DemoReading = {
  state: "working",
  for: 1,
  category: "working",
  priority: 5,
  task: "Upgrade the payments SDK to v18",
  headline: "Updating call sites for the v18 API",
  summary: "Rewriting the three checkout handlers that used the removed charges API.",
  progress: 35,
  steps: { done: 2, total: 6 },
};

const SDK_ASKING: DemoReading = {
  state: "waiting",
  for: 0,
  category: "approval",
  priority: 94,
  task: "Upgrade the payments SDK to v18",
  headline: "Allow npm install?",
  summary: "Wants to install the new SDK and update the lockfile before running the tests.",
  question: "Do you want to run npm install stripe@18?",
  options: ["Yes", "Yes, and don't ask again", "No"],
  action: "npm install stripe@18",
  risk: "caution",
};

const FLAKY: DemoReading = {
  state: "waiting",
  for: 3,
  category: "question",
  priority: 86,
  task: "Fix the flaky login test",
  headline: "Retry the test, or quarantine it?",
  summary: "The failure is a race in the session cookie; a real fix touches the auth fixture.",
  question: "Retry it three times in CI, or quarantine it until the fixture is fixed?",
  options: ["Retry in CI", "Quarantine"],
};

const NOTES: DemoReading = {
  state: "completed",
  for: 9,
  category: "finished",
  priority: 40,
  task: "Write the 0.4 release notes",
  headline: "Release notes written",
  summary: "Drafted CHANGELOG.md for 0.4 from the merged PRs; left for you to review.",
  progress: 100,
  changes: "uncommitted",
};

const AUTH_WORKING: DemoReading = {
  state: "working",
  for: 4,
  category: "working",
  priority: 5,
  task: "Split the auth middleware into session and token checks",
  headline: "Running the integration suite",
  summary: "Moved token checks into their own middleware; the suite is running.",
  progress: 60,
};

const AUTH_STALLED: DemoReading = {
  ...AUTH_WORKING,
  for: 14,
  priority: 70,
  category: "error",
  headline: "Stuck on the integration suite",
  summary: "Same screen for 12 minutes: the suite is waiting on a database that never started.",
  stalledFor: 12,
};

const pages = (progress: number, done: number): DemoReading => ({
  state: "working",
  for: 2,
  category: "working",
  priority: 5,
  task: "Add pagination to GET /recipes",
  headline: progress < 70 ? "Adding cursor parsing" : "Writing the pagination tests",
  summary:
    progress < 70
      ? "Parsing ?cursor= and ?limit= in the recipes route."
      : "Covering empty pages, the last page and a bad cursor.",
  progress,
  steps: { done, total: 5 },
});

const PAGES_DONE: DemoReading = {
  state: "completed",
  for: 0,
  category: "finished",
  priority: 40,
  task: "Add pagination to GET /recipes",
  headline: "Pagination added and committed",
  summary: "Cursor pagination on GET /recipes with 12 new tests; all 48 pass.",
  progress: 100,
  tests: "passing",
  changes: "committed",
};

/** Each frame is the whole fleet at one moment; the loop starts over after the last. */
const FRAMES: readonly DemoFrame[] = [
  {
    "demo-sdk": SDK_WORKING,
    "demo-pages": pages(40, 2),
    "demo-flaky": FLAKY,
    "demo-notes": NOTES,
    "demo-auth": AUTH_WORKING,
  },
  {
    "demo-sdk": SDK_ASKING,
    "demo-pages": pages(40, 2),
    "demo-flaky": FLAKY,
    "demo-notes": NOTES,
    "demo-auth": AUTH_WORKING,
  },
  {
    "demo-sdk": { ...SDK_WORKING, progress: 55, steps: { done: 3, total: 6 } },
    "demo-pages": pages(80, 4),
    "demo-flaky": FLAKY,
    "demo-notes": NOTES,
    "demo-auth": AUTH_WORKING,
  },
  {
    "demo-sdk": { ...SDK_WORKING, progress: 70, steps: { done: 4, total: 6 } },
    "demo-pages": PAGES_DONE,
    "demo-flaky": FLAKY,
    "demo-notes": NOTES,
    "demo-auth": AUTH_STALLED,
  },
];

export const CANOPY_DEMO_FRAME_COUNT = FRAMES.length;

/** The frame where an agent is asking, and the option the demo answers it with next. */
export const CANOPY_DEMO_ANSWER = { frame: 1, runId: "demo-sdk", option: "Yes" } as const;

export function canopyDemoItems(frame: number, nowMs: number): CanopyItem[] {
  const readings = FRAMES[((frame % FRAMES.length) + FRAMES.length) % FRAMES.length]!;
  const runs: FleetRunRow[] = [];
  const cards = new Map<string, CanopyCard>();
  for (const agent of AGENTS) {
    const reading = readings[agent.runId];
    if (!reading) continue;
    const since = nowMs - reading.for * MINUTE;
    runs.push({
      runId: agent.runId,
      workspaceId: PROJECT,
      spawnedAt: nowMs - 60 * MINUTE,
      cwd: `/demo/${agent.worktree}`,
      agentId: agent.agentId,
      agentState: reading.state,
      ...(reading.category === "approval" ? { waitingReason: "approval" as const } : {}),
      title: agent.title,
      since,
    });
    cards.set(agent.runId, cardFor(agent, reading, nowMs));
  }
  const groups = buildPilotGroups(runs, {
    workspaces: new Map([[PROJECT, { kind: "project", name: "recipes", emoji: "🍳" }]]),
    currentWorkspaceId: PROJECT,
    nowMs,
  });
  // Looked at a minute ago, as a user at their desk would have: a busy run
  // nobody has seen in an hour would rise for that alone.
  const seen = new Map(
    runs.map((run) => [
      run.runId,
      { runId: run.runId, spawnedAt: run.spawnedAt, at: nowMs - MINUTE },
    ])
  );
  return buildCanopyInbox(groups, cards, undefined, new Map(), seen, nowMs);
}

function cardFor(agent: DemoAgent, reading: DemoReading, nowMs: number): CanopyCard {
  return {
    runId: agent.runId,
    spawnedAt: nowMs - 60 * MINUTE,
    revision: 1,
    category: reading.category,
    confidence: 0.95,
    attentionProbability: reading.priority / 100,
    attentionScore: reading.priority,
    priority: reading.priority,
    task: reading.task,
    risk: reading.risk ?? "unknown",
    riskReason: null,
    action: reading.action ?? null,
    progress: reading.progress ?? null,
    steps: reading.steps ? { ...reading.steps, current: null } : null,
    tests: reading.tests ?? "unknown",
    changes: reading.changes ?? "unknown",
    handledAt: null,
    wordsFromEarlierRead: false,
    priorityFromEarlierRead: false,
    stage: "described",
    wordsCategory: reading.category,
    describing: false,
    headline: reading.headline,
    summary: reading.summary,
    question: reading.question ?? null,
    options: reading.options ?? [],
    secretPrompt: false,
    activity: null,
    glance: { recap: null, said: null, doing: null, action: null },
    statusLine: null,
    contextLeft: null,
    stalledSince: reading.stalledFor === undefined ? null : nowMs - reading.stalledFor * MINUTE,
    observedAt: nowMs,
  };
}
