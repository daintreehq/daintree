/**
 * Canopy visual-review harness.
 *
 * Canopy is the overview of every agent Daintree runs, so it cannot be judged
 * on an empty app or on a handful of rows: the Needs you band, the identity
 * slots, the reader's attributed words and the answer choices in the pane only
 * exist when there is a fleet making them. This harness builds one — four real
 * agent terminals drawing realistic screens in the current project, and a
 * couple of dozen more runs spread over five projects — and writes a PNG of the
 * panel in every state that carries design weight.
 *
 * The four real agents are fake `claude` programs (`fakeCanopyAgent`), so the
 * pane shows a live terminal for them. Everything Canopy and the fleet say about
 * the runs is pushed as snapshots on the real broadcast channels, and main's own
 * broadcasts on those two channels are held back for the length of the run, so
 * a reading cannot land between the check and the shutter. The reader model is
 * never downloaded.
 *
 * Opt-in only, like its siblings:
 *
 *   DESIGN_CAPTURE_DIR=/abs/out npx playwright test --project=screenshots canopy-review
 *
 * Env knobs:
 *   DESIGN_CAPTURE_DIR   output directory (required)
 *   DAINTREE_SHOT_THEMES comma-separated themes for the cross-theme pass (default: a spread of eight)
 *   DAINTREE_SCREENSHOT_SCALE  device scale factor (default 2)
 */

import { test, expect, type Page, type ElectronApplication } from "@playwright/test";
import { execSync } from "child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { openAndOnboardProject } from "../helpers/project";
import { dismissBlockingPalette } from "../helpers/overlays";
import { getGridPanelIds } from "../helpers/panels";
import { setAppTheme } from "../helpers/theme";
import { SEL } from "../helpers/selectors";
import { T_LONG } from "../helpers/timeouts";
import { fakeAgentEnv } from "../helpers/fakeAgent";
import {
  installFakeCanopyAgent,
  setFakeCanopyScene,
  type FakeCanopyScene,
} from "../helpers/fakeCanopyAgent";

const OUT = process.env.DESIGN_CAPTURE_DIR ?? "";
const SCALE = process.env.DAINTREE_SCREENSHOT_SCALE ?? "2";
const THEMES = (
  process.env.DAINTREE_SHOT_THEMES ??
  "daintree,bondi,namib,redwoods,hokkaido,svalbard,serengeti,atacama"
)
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);
const AGENT_NAMES: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  gemini: "Gemini",
  opencode: "OpenCode",
  grok: "Grok",
};
const DIALOG = '[data-testid="canopy-dialog"]';
const ROWS = "[data-canopy-list] [data-canopy-card]";

const POLISH_CSS = `
  ::-webkit-scrollbar { display: none !important; width: 0 !important; height: 0 !important; }
  *, *::before, *::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
    caret-color: transparent !important;
  }
`;

const WORKSPACES = [
  { slug: "daintree", name: "Daintree", emoji: "🌴" },
  { slug: "daintree-website", name: "Daintree Website", emoji: "🌐" },
  { slug: "daintree-payments", name: "Daintree Payments", emoji: "💳" },
  { slug: "daintree-assistant", name: "Daintree Assistant", emoji: "🤖" },
  { slug: "assistant-backend", name: "Assistant Backend", emoji: "☁️" },
] as const;

const HEADER = [
  "▐▛███▜▌   Claude Code v9.9.9",
  "▝▜█████▛▘  Opus · Claude Max",
  "  ▘▘ ▝▝    ~/code/daintree",
  "",
];

const SCENES: Record<"approval" | "question" | "finished" | "working", FakeCanopyScene> = {
  approval: {
    box: false,
    lines: [
      ...HEADER,
      "> Bump the terminal fabric shard count and rerun the soak test",
      "",
      "⏺ Read(electron/services/pty/fabric.ts)",
      "  ⎿  Read 212 lines",
      "⏺ Update(electron/services/pty/fabric.ts)",
      "  ⎿  Updated electron/services/pty/fabric.ts with 4 additions and 1 removal",
      "",
      "⏺ Bash(npm run perf -- --scenario pty-soak)",
      "",
      "╭──────────────────────────────────────────────────────────╮",
      "│ Bash command                                             │",
      "│                                                          │",
      "│   npm run perf -- --scenario pty-soak                    │",
      "│   Run the PTY soak benchmark against the new shards      │",
      "│                                                          │",
      "│ Do you want to proceed?                                  │",
      "│ ❯ 1. Yes                                                 │",
      "│   2. Yes, and don't ask again for npm run perf           │",
      "│   3. No, and tell Claude what to do differently (esc)    │",
      "╰──────────────────────────────────────────────────────────╯",
    ],
  },
  question: {
    lines: [
      ...HEADER,
      "> Write the changelog entry for the Canopy band work, ask me about tone first",
      "",
      "⏺ Read(CHANGELOG.md)",
      "  ⎿  Read 340 lines",
      "",
      "⏺ Should the entry lead with the Needs you band, or with parks and snoozes",
      "  holding in Canopy? The band is the bigger change; the park fix is the one",
      "  people asked for.",
      "",
      "✻ Worked for 12s · done",
    ],
  },
  finished: {
    lines: [
      ...HEADER,
      "> Fix the worktree card's stale branch badge and run its tests",
      "",
      "⏺ The badge read the branch once on mount. It now follows the worktree",
      "  store, so a checkout in the terminal updates it.",
      "",
      "⏺ Bash(npm test -- src/components/Worktree)",
      "  ⎿  ✓ 48 passed",
      "",
      "⏺ All 48 tests pass. The change is not committed yet.",
      "",
      "✻ Worked for 2m 14s · done",
    ],
  },
  working: {
    working: true,
    spinner: "Refactoring",
    streamEveryMs: 60_000,
    lines: [
      ...HEADER,
      "> Move the assistant pane off-canvas with a transform instead of a width animation",
      "",
      "⏺ Read(src/components/HelpPanel/GlobalAssistantPane.tsx)",
      "  ⎿  Read 318 lines",
      "⏺ Update(src/components/HelpPanel/GlobalAssistantPane.tsx)",
      "  ⎿  Updated with 22 additions and 31 removals",
      "⏺ Bash(npm test -- src/components/HelpPanel)",
      "  ⎿  ✓ 31 passed",
      "",
    ],
    stream: [],
  },
};

function git(cmd: string, cwd: string): void {
  execSync(`git ${cmd}`, { cwd, stdio: "ignore" });
}

function createRepo(root: string, slug: string): string {
  const dir = path.join(root, slug);
  mkdirSync(dir, { recursive: true });
  git("init -b main", dir);
  git('config user.email "test@daintree.dev"', dir);
  git('config user.name "Daintree Test"', dir);
  writeFileSync(path.join(dir, "README.md"), `# ${slug}\n`);
  writeFileSync(path.join(dir, ".gitignore"), ".e2e canopy bin/\n");
  git("add -A", dir);
  git('commit -m "initial commit"', dir);
  return dir;
}

async function settle(page: Page, ms = 400): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
  );
  await page.waitForTimeout(ms); // timer: let the frozen frame paint before the shutter
}

const mins = (n: number, now: number) => now - n * 60_000;

async function ensureProjects(page: Page, dirs: string[]): Promise<Record<string, string>> {
  return page.evaluate(
    async ({ entries }) => {
      const out: Record<string, string> = {};
      for (const entry of entries) {
        const existing = (await window.electron.project.getAll()).find(
          (p: { path: string; id: string }) => p.path === entry.dir
        );
        const id = existing?.id ?? (await window.electron.project.add(entry.dir))?.id;
        if (!id) continue;
        await window.electron.project.update(id, {
          name: entry.name,
          emoji: entry.emoji,
          lastOpened: entry.lastOpened,
        });
        out[entry.slug] = id;
      }
      return out;
    },
    {
      entries: WORKSPACES.map((ws, i) => ({
        slug: ws.slug,
        name: ws.name,
        emoji: ws.emoji,
        dir: dirs[i]!,
        lastOpened: Date.now() - i * 90 * 60_000,
      })),
    }
  );
}

async function launchClaude(page: Page): Promise<string> {
  const before = new Set(await getGridPanelIds(page));
  await dismissBlockingPalette(page);
  await page.locator(SEL.agent.trayButton).click();
  await page.locator(SEL.agent.launcherRow("Claude")).first().click();
  let id: string | undefined;
  await expect
    .poll(
      async () => {
        id = (await getGridPanelIds(page)).find((candidate) => !before.has(candidate));
        return id !== undefined;
      },
      { timeout: T_LONG, intervals: [250] }
    )
    .toBe(true);
  return id!;
}

/**
 * Hold main's own fleet and Canopy broadcasts back, so only what this harness
 * pushes reaches the panel. Every webContents' `send` is wrapped once; the
 * harness's pushes go through the original.
 */
async function freezeBroadcasts(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ webContents, app: electronApp }) => {
    const g = globalThis as unknown as { __canopyShotFrozen?: boolean };
    if (g.__canopyShotFrozen) return;
    g.__canopyShotFrozen = true;
    const held = new Set(["fleet:snapshot-updated", "canopy:snapshot-updated"]);
    const wrap = (wc: Electron.WebContents) => {
      const marked = wc as unknown as { __shotOriginalSend?: Electron.WebContents["send"] };
      if (marked.__shotOriginalSend) return;
      const original = wc.send.bind(wc);
      marked.__shotOriginalSend = original;
      wc.send = (channel: string, ...args: unknown[]) => {
        if (held.has(channel)) return;
        original(channel, ...args);
      };
    };
    for (const wc of webContents.getAllWebContents()) wrap(wc);
    electronApp.on("web-contents-created", (_e, wc) => wrap(wc));
  });
}

async function push(app: ElectronApplication, channel: string, payload: unknown): Promise<void> {
  await app.evaluate(
    ({ webContents }, { channel, payload }) => {
      for (const wc of webContents.getAllWebContents()) {
        if (wc.isDestroyed()) continue;
        const send =
          (wc as unknown as { __shotOriginalSend?: Electron.WebContents["send"] })
            .__shotOriginalSend ?? wc.send.bind(wc);
        send(channel, payload);
      }
    },
    { channel, payload }
  );
}

interface Real {
  approval: string;
  question: string;
  finished: string;
  working: string;
}

interface RunSpec {
  run: Record<string, unknown>;
  card?: Record<string, unknown>;
  unread?: boolean;
}

function card(
  runId: string,
  spawnedAt: number,
  now: number,
  fields: Record<string, unknown>
): Record<string, unknown> {
  return {
    runId,
    spawnedAt,
    revision: 3,
    confidence: 0.92,
    attentionProbability: 0.2,
    attentionScore: null,
    priority: 20,
    stage: "described",
    wordsFromEarlierRead: false,
    priorityFromEarlierRead: false,
    wordsCategory: null,
    describing: false,
    task: null,
    progress: null,
    steps: null,
    tests: "unknown",
    changes: "unknown",
    headline: null,
    summary: null,
    question: null,
    options: [],
    secretPrompt: false,
    risk: "none",
    riskReason: null,
    action: null,
    handledAt: null,
    activity: null,
    glance: { recap: null, said: null, doing: null, action: null },
    statusLine: null,
    contextLeft: null,
    stalledSince: null,
    observedAt: now,
    ...fields,
  };
}

/**
 * The fleet: the four real agents first, then the rest of a busy afternoon
 * spread over five projects. Each run carries the reading Canopy would hold.
 */
function buildFleet(
  real: Real,
  spawned: Record<string, number>,
  ids: Record<string, string>,
  now: number
): RunSpec[] {
  const w = (slug: string) => ids[slug] ?? slug;
  const at = (n: number) => mins(n, now);
  const spec = (
    run: Record<string, unknown>,
    fields: Record<string, unknown> | null,
    unread = false
  ): RunSpec => {
    const spawnedAt = (run.spawnedAt as number) ?? at(60);
    // The pane goes by its agent's name; the agent names its own task in the
    // terminal title, as Claude Code and Codex do.
    const agentId = (run.agentId as string | undefined) ?? "claude";
    const full = {
      spawnedAt,
      ...run,
      agentId,
      title: AGENT_NAMES[agentId] ?? agentId,
      lastObservedTitle: run.title,
    };
    return {
      run: full,
      card: fields ? card(run.runId as string, spawnedAt, now, fields) : undefined,
      unread,
    };
  };
  return [
    spec(
      {
        runId: real.approval,
        spawnedAt: spawned[real.approval],
        workspaceId: w("daintree"),
        agentState: "waiting",
        waitingReason: "approval",
        since: at(4),
        title: "Terminal fabric shard soak",
        cwd: "/repos/daintree-pty-fabric",
      },
      {
        category: "approval",
        priority: 94,
        attentionProbability: 0.97,
        task: "Bump the fabric shard count and rerun the soak test",
        headline: "Allow npm run perf?",
        summary: "Wants to run the PTY soak benchmark against the new shard count.",
        question: "Do you want to proceed?",
        options: ["Yes", "Yes, and don't ask again for npm run perf", "No"],
        action: "npm run perf -- --scenario pty-soak",
        glance: {
          recap: "Bumped the shard count in fabric.ts",
          said: null,
          doing: null,
          action: "npm run perf -- --scenario pty-soak",
        },
      },
      true
    ),
    spec(
      {
        runId: real.question,
        spawnedAt: spawned[real.question],
        workspaceId: w("daintree"),
        agentState: "waiting",
        waitingReason: "question",
        since: at(9),
        title: "Changelog for the Canopy band",
        cwd: "/repos/daintree-changelog",
        canopy: {
          kind: "asked",
          quote: "Should the entry lead with the Needs you band, or with parks and snoozes?",
          readAt: at(8),
        },
      },
      {
        category: "question",
        priority: 82,
        attentionProbability: 0.9,
        task: "Write the changelog entry for the Canopy band work",
        headline: "Lead with the band, or with parks?",
        summary: "Asks which change the changelog entry should open with.",
        question:
          "Should the entry lead with the Needs you band, or with parks and snoozes holding in Canopy?",
        glance: {
          recap: null,
          said: "Should the entry lead with the Needs you band, or with parks and snoozes holding in Canopy?",
          doing: null,
          action: null,
        },
      },
      true
    ),
    spec(
      {
        runId: "s-err",
        workspaceId: w("daintree-payments"),
        agentId: "gemini",
        agentState: "waiting",
        waitingReason: "error",
        since: at(21),
        spawnedAt: at(30),
        title: "Invoice reconciliation job",
        cwd: "/repos/payments-reconcile",
      },
      {
        category: "error",
        priority: 76,
        attentionProbability: 0.85,
        task: "Make the nightly reconciliation idempotent",
        headline: "Stopped on a migration error",
        summary: "The ledger migration fails on duplicate invoice ids; it needs a decision.",
        tests: "failing",
        changes: "uncommitted",
      },
      true
    ),
    spec(
      {
        runId: "s-appr2",
        workspaceId: w("assistant-backend"),
        agentId: "codex",
        agentState: "waiting",
        waitingReason: "approval",
        since: at(2),
        spawnedAt: at(18),
        title: "Together rate-limit backoff",
        cwd: "/repos/assistant-backend-rate-limit",
      },
      {
        category: "approval",
        priority: 90,
        attentionProbability: 0.95,
        task: "Add jittered backoff to the Together client",
        headline: "Allow git push?",
        summary: "Wants to push the backoff branch to origin.",
        action: "git push -u origin rate-limit-backoff",
        risk: "caution",
        riskReason: "Pushes to a shared remote",
      }
    ),
    spec(
      {
        runId: real.finished,
        spawnedAt: spawned[real.finished],
        workspaceId: w("daintree"),
        agentState: "completed",
        since: at(6),
        title: "Worktree card branch badge",
        cwd: "/repos/daintree-branch-badge",
      },
      {
        category: "finished",
        priority: 62,
        attentionProbability: 0.7,
        task: "Fix the worktree card's stale branch badge",
        headline: "Badge follows checkouts; 48 tests pass",
        summary: "The branch badge now follows the worktree store. Not committed yet.",
        tests: "passing",
        changes: "uncommitted",
      },
      true
    ),
    spec(
      {
        runId: "s-fin2",
        workspaceId: w("daintree-website"),
        agentState: "completed",
        since: at(14),
        spawnedAt: at(50),
        title: "Pricing page copy pass",
        cwd: "/repos/daintree-website",
      },
      {
        category: "finished",
        priority: 58,
        attentionProbability: 0.6,
        task: "Tighten the pricing page copy",
        headline: "Copy pass done, pushed for review",
        summary: "Rewrote the three tier blurbs and the FAQ. Pushed to copy-pass.",
        tests: "not_run",
        changes: "pushed",
      }
    ),
    spec(
      {
        runId: real.working,
        spawnedAt: spawned[real.working],
        workspaceId: w("daintree"),
        agentState: "working",
        since: at(3),
        title: "Off-canvas assistant pane",
        cwd: "/repos/daintree-offcanvas",
      },
      {
        category: "working",
        priority: 24,
        task: "Move the assistant pane off-canvas with a transform",
        headline: "Refactoring the pane's show and hide",
        summary: "Swapped the width animation for a transform; tests pass so far.",
        progress: 60,
        steps: { done: 3, total: 5, current: "Run the HelpPanel tests" },
        tests: "passing",
        changes: "uncommitted",
      }
    ),
    spec(
      {
        runId: "s-w2",
        workspaceId: w("daintree"),
        agentState: "working",
        since: at(33),
        spawnedAt: at(40),
        title: "Assistant CLI version update",
        cwd: "/repos/daintree-cli-version",
      },
      {
        category: "working",
        priority: 18,
        headline: "Updating the bundled CLI versions",
        summary: "Bumping the pinned agent CLIs and regenerating the registry snapshot.",
        progress: 40,
      }
    ),
    spec(
      {
        runId: "s-stall",
        workspaceId: w("daintree"),
        agentState: "working",
        since: at(47),
        spawnedAt: at(50),
        quietSince: at(12),
        title: "Memory benchmark rerun",
        cwd: "/repos/daintree-memory-bench",
        canopy: {
          kind: "stalled",
          quote: "Waiting for the GPU process to settle…",
          readAt: at(1),
          stalledSince: at(12),
        },
      },
      {
        category: "working",
        priority: 48,
        headline: "No new output for 12 minutes",
        summary: "Last line says it's waiting for the GPU process to settle.",
        stalledSince: at(12),
      }
    ),
    spec(
      {
        runId: "s-w3",
        workspaceId: w("daintree-website"),
        agentId: "opencode",
        agentState: "working",
        since: at(8),
        spawnedAt: at(20),
        title: "Docs search index",
        cwd: "/repos/daintree-website-docs-search",
      },
      {
        category: "working",
        priority: 15,
        headline: "Rebuilding the docs search index",
        summary: "Indexing 412 pages; about two thirds through.",
        progress: 66,
      }
    ),
    spec(
      {
        runId: "s-w4",
        workspaceId: w("daintree-payments"),
        agentId: "codex",
        agentState: "working",
        since: at(38),
        spawnedAt: at(45),
        title: "Stripe webhook retry backoff",
        cwd: "/repos/payments-webhook-retry",
      },
      {
        category: "working",
        priority: 20,
        headline: "Writing retry tests for the webhook handler",
        summary: "Covering 429 and 5xx retries with a fake clock.",
        steps: { done: 2, total: 4, current: "Write the 5xx retry test" },
      }
    ),
    spec(
      {
        runId: "s-w5",
        workspaceId: w("daintree-assistant"),
        agentState: "working",
        since: at(37),
        spawnedAt: at(40),
        title: "Custom commands mirroring",
        cwd: "/repos/daintree-assistant",
      },
      {
        category: "working",
        priority: 17,
        headline: "Mirroring slash commands into the assistant",
        summary: "Reading the command registry and generating the assistant's tool list.",
      }
    ),
    spec(
      {
        runId: "s-w6",
        workspaceId: w("assistant-backend"),
        agentState: "working",
        since: at(10),
        spawnedAt: at(12),
        title: "Usage metering schema",
        cwd: "/repos/assistant-backend-metering",
      },
      {
        category: "working",
        priority: 16,
        headline: "Drafting the metering tables",
        summary: "Adding a usage_events table and a daily rollup view.",
      }
    ),
    spec(
      {
        runId: "s-park",
        workspaceId: w("daintree-assistant"),
        agentId: "opencode",
        agentState: "waiting",
        waitingReason: "prompt",
        since: at(90),
        spawnedAt: at(120),
        title: "Alt-screen corruption repro",
        cwd: "/repos/daintree-assistant-altscreen",
        park: { parkedAt: at(55), note: "waiting on the xterm 6.1 beta" },
      },
      {
        category: "question",
        priority: 70,
        headline: "Asks whether to pin xterm 6.0",
        summary: "Wants to know whether to pin xterm 6.0 until the beta lands.",
      }
    ),
    spec(
      {
        runId: "s-snooze",
        workspaceId: w("assistant-backend"),
        agentId: "grok",
        agentState: "waiting",
        waitingReason: "question",
        since: at(65),
        spawnedAt: at(70),
        title: "Billing export format",
        cwd: "/repos/assistant-backend-billing",
        snooze: { snoozedAt: at(15), snoozedUntil: now + 45 * 60_000 },
      },
      {
        category: "question",
        priority: 72,
        headline: "CSV or Parquet for the export?",
        summary: "Asks which format the billing export should write.",
      }
    ),
    spec(
      {
        runId: "s-idle",
        workspaceId: w("daintree-payments"),
        agentState: "idle",
        since: at(130),
        spawnedAt: at(180),
        title: "Refund flow spike",
        cwd: "/repos/payments-refunds",
      },
      {
        category: "idle",
        priority: 8,
        headline: "Idle at the prompt",
        summary: "Finished the spike notes and stopped.",
      }
    ),
    spec(
      {
        runId: "s-exited",
        workspaceId: w("assistant-backend"),
        agentState: "exited",
        since: at(140),
        spawnedAt: at(200),
        title: "Deploy smoke check",
        cwd: "/repos/assistant-backend",
      },
      null
    ),
  ];
}

function canopySnapshot(
  specs: RunSpec[],
  now: number,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    sequence: 1_000_000_000 + Math.floor(now / 1000),
    mode: "on",
    activated: true,
    model: { id: "daintreehq/canopy-reader-17m", status: "ready" },
    dispositions: [],
    seen: [],
    reads: specs.map((s) => ({
      runId: s.run.runId,
      spawnedAt: s.run.spawnedAt,
      turn: 2,
      readTurn: s.unread ? 1 : 2,
      markedUnreadAt: null,
      version: 1,
    })),
    scope: null,
    active: true,
    busy: false,
    refreshedAt: now - 20_000,
    cards: specs.filter((s) => s.card).map((s) => s.card),
    glances: [],
    lastError: null,
    failedRuns: [],
    reader: { model: "Light", inFlight: 0, readMs: 180 },
    ...overrides,
  };
}

function fleetSnapshot(specs: RunSpec[], now: number): Record<string, unknown> {
  return {
    runs: specs.map((s) => s.run),
    changedAt: now,
    degraded: false,
    lastSuccessfulAt: now,
  };
}

async function shoot(page: Page, name: string): Promise<void> {
  await settle(page, 500);
  const dialog = page.locator(DIALOG).first();
  await dialog.waitFor({ state: "visible", timeout: 8000 });
  const box = await dialog.boundingBox();
  if (!box) throw new Error(`${name}: the Canopy panel has no box`);
  const file = path.join(OUT, `${name}.png`);
  const viewport = page.viewportSize() ?? { width: 1680, height: 1050 };
  const pad = 24;
  const x = Math.max(0, box.x - pad);
  const y = Math.max(0, box.y - pad);
  await page.screenshot({
    path: file,
    type: "png",
    animations: "disabled",
    caret: "hide",
    clip: {
      x,
      y,
      width: Math.min(box.width + pad * 2, viewport.width - x),
      height: Math.min(box.height + pad * 2, viewport.height - y),
    },
  });
  if (!existsSync(file)) throw new Error(`${name}: no file written`);
}

async function rowCount(page: Page): Promise<number> {
  return page.locator(ROWS).count();
}

async function expectRows(page: Page, atLeast: number, label: string): Promise<void> {
  await expect
    .poll(() => rowCount(page), { timeout: 10_000, message: `${label}: rows on screen` })
    .toBeGreaterThanOrEqual(atLeast);
}

async function selectRow(page: Page, runId: string): Promise<void> {
  const row = page.locator(`${ROWS}[id$="${runId}"], ${ROWS}[data-run-id="${runId}"]`).first();
  if ((await row.count()) === 0) throw new Error(`no row for ${runId}`);
  await row.click();
  await settle(page, 600);
}

async function openCanopy(page: Page): Promise<void> {
  if ((await page.locator(DIALOG).count()) > 0) return;
  await page.keyboard.press(process.platform === "darwin" ? "Meta+E" : "Control+Shift+O");
  await page.locator(DIALOG).first().waitFor({ state: "visible", timeout: 8000 });
}

async function closeCanopy(page: Page): Promise<void> {
  for (let i = 0; i < 3 && (await page.locator(DIALOG).count()) > 0; i++) {
    await page.keyboard.press("Escape").catch(() => {});
    await settle(page, 250);
  }
}

test("canopy review — the inbox with a fleet", async () => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DESIGN_CAPTURE_DIR is required for the canopy-review capture",
  });
  test.skip(!OUT, "Set DESIGN_CAPTURE_DIR to run this capture");
  test.setTimeout(15 * 60_000);
  mkdirSync(OUT, { recursive: true });

  const repoRoot = mkdtempSync(path.join(tmpdir(), "daintree-canopyshot-repos-"));
  const userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-canopyshot-"));
  const dirs = WORKSPACES.map((ws) => createRepo(repoRoot, ws.slug));
  const binDir = installFakeCanopyAgent(dirs[0]!);

  let ctx: AppContext | undefined;
  try {
    ctx = await launchApp({
      userDataDir,
      screenshotScale: SCALE,
      windowSize: { width: 1680, height: 1050 },
      env: fakeAgentEnv(binDir),
      extraArgs: ["--disable-gpu", "--in-process-gpu", "--disable-breakpad", "--noerrdialogs"],
    });
    const app = ctx.app;
    const page = await openAndOnboardProject(app, ctx.window, dirs[0]!, WORKSPACES[0]!.name);
    const ids = await ensureProjects(page, dirs);

    const real: Real = {
      approval: await launchClaude(page),
      question: await launchClaude(page),
      finished: await launchClaude(page),
      working: await launchClaude(page),
    };
    for (const key of Object.keys(real) as (keyof Real)[]) {
      setFakeCanopyScene(binDir, real[key], SCENES[key]);
    }

    // Main's fleet knows each terminal's incarnation; Canopy's cards and the
    // pane's watch both key off it.
    let spawned: Record<string, number> = {};
    await expect
      .poll(
        async () => {
          spawned = await page.evaluate(async (want: string[]) => {
            const snap = (await window.electron.fleet.getSnapshot()) as {
              runs: { runId: string; spawnedAt: number }[];
            } | null;
            const out: Record<string, number> = {};
            for (const run of snap?.runs ?? []) {
              if (want.includes(run.runId)) out[run.runId] = run.spawnedAt;
            }
            return out;
          }, Object.values(real));
          return Object.keys(spawned).length;
        },
        { timeout: T_LONG, intervals: [500] }
      )
      .toBe(4);

    await settle(page, 3000);
    await freezeBroadcasts(app);

    const now = Date.now();
    const specs = buildFleet(real, spawned, ids, now);
    const fleet = fleetSnapshot(specs, now);
    const canopy = canopySnapshot(specs, now);

    const inject = async (f = fleet, c = canopy) => {
      await push(app, "fleet:snapshot-updated", f);
      await push(app, "canopy:snapshot-updated", c);
      await settle(page, 400);
    };

    await page.addStyleTag({ content: POLISH_CSS }).catch(() => {});
    await inject();
    await openCanopy(page);
    await inject();
    await expectRows(page, 10, "populated");
    await page.mouse.move(2, 2);

    // 01 — the panel as it opens: the top of the band selected.
    await shoot(page, "01-populated");

    // 02..04 — each real agent selected, so the pane shows its terminal.
    await selectRow(page, real.question);
    await page.mouse.move(2, 2);
    await shoot(page, "02-question-selected");
    await selectRow(page, real.finished);
    await page.mouse.move(2, 2);
    await shoot(page, "03-finished-selected");
    await selectRow(page, real.working);
    await page.mouse.move(2, 2);
    await shoot(page, "04-working-selected");
    await selectRow(page, real.approval);
    await page.mouse.move(2, 2);
    await shoot(page, "05-approval-selected");

    // 06 — a synthetic row selected: the pane with no live terminal behind it.
    await selectRow(page, "s-err");
    await page.mouse.move(2, 2);
    await shoot(page, "06-error-selected");

    // 07 — the row menu.
    const menuRow = page.locator(`${ROWS}[id$="s-fin2"], ${ROWS}[data-run-id="s-fin2"]`).first();
    await menuRow.click({ button: "right" });
    await settle(page, 500);
    await shoot(page, "07-row-menu");
    await page.keyboard.press("Escape");
    await settle(page, 300);

    // 08 — search narrowing the list.
    const search = page.locator(`${DIALOG} input[type="search"], ${DIALOG} input`).first();
    await search.click();
    await search.fill("payments");
    await settle(page, 500);
    await page.mouse.move(2, 2);
    await shoot(page, "08-search");
    await search.fill("");
    await settle(page, 300);

    // 09 — nothing needs you: every ask answered, everything else at work.
    const calm = specs.map((s) =>
      s.card && ["approval", "question", "error", "finished"].includes(s.card.category as string)
        ? {
            ...s,
            unread: false,
            run: {
              ...s.run,
              agentState: "working",
              waitingReason: undefined,
              canopy: undefined,
            },
            card: { ...s.card, category: "working", priority: 20, question: null, options: [] },
          }
        : s
    );
    await inject(fleetSnapshot(calm, now), canopySnapshot(calm, now));
    await page.mouse.move(2, 2);
    await shoot(page, "09-all-clear");

    // 10 — the reader off: the observed list.
    await inject(
      fleet,
      canopySnapshot(specs, now, {
        activated: false,
        model: undefined,
        reader: undefined,
        cards: [],
      })
    );
    await page.mouse.move(2, 2);
    await shoot(page, "10-reader-off");

    // 11 — a smaller window.
    await inject();
    await closeCanopy(page);
    await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      win?.setSize(1280, 800);
    });
    await settle(page, 800);
    await openCanopy(page);
    await inject();
    await page.mouse.move(2, 2);
    await shoot(page, "11-narrow");
    await closeCanopy(page);
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setSize(1680, 1050);
    });
    await settle(page, 800);

    // Theme pass: the populated panel in each theme.
    const themeDir = path.join(OUT, "themes");
    mkdirSync(themeDir, { recursive: true });
    for (const theme of THEMES) {
      await setAppTheme(page, theme);
      await page.addStyleTag({ content: POLISH_CSS }).catch(() => {});
      await dismissBlockingPalette(page).catch(() => {});
      await settle(page, 1500);
      await inject();
      await openCanopy(page);
      await inject();
      await expectRows(page, 10, `theme ${theme}`);
      await page.mouse.move(2, 2);
      await settle(page, 600);
      const dialog = page.locator(DIALOG).first();
      const box = await dialog.boundingBox();
      if (!box) throw new Error(`theme ${theme}: no panel`);
      const file = path.join(themeDir, `${theme}.png`);
      await page.screenshot({
        path: file,
        type: "png",
        animations: "disabled",
        caret: "hide",
        clip: box,
      });
      await closeCanopy(page);
    }

    const written = readdirSync(OUT).filter((f) => f.endsWith(".png")).length;
    const themed = readdirSync(themeDir).filter((f) => f.endsWith(".png")).length;
    if (written < 11 || themed < THEMES.length) {
      throw new Error(
        `expected 11 states and ${THEMES.length} themes, got ${written} and ${themed}`
      );
    }
  } finally {
    if (ctx) await closeApp(ctx.app).catch(() => {});
    for (const dir of [repoRoot, userDataDir]) {
      if (!existsSync(dir)) continue;
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch (error) {
        console.warn(`[canopy-shots] could not remove ${dir}:`, String(error).split("\n")[0]);
      }
    }
  }
});
