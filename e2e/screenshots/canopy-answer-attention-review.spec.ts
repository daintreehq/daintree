/**
 * Canopy window, answer-attention review (#16637): a run whose Decisions
 * answer stopped on its way in sits in Needs you with "Answer needs
 * attention", and its pane has to say so and lead to the list that deals
 * with it.
 *
 * Two fake Claude terminals run in one project, so the pane shows a live
 * terminal: one whose answer needs attention, one asking an ordinary question
 * for comparison. A few synthetic runs fill the list. Everything the fleet
 * and Canopy say is pushed on the real broadcast channels with main's own
 * broadcasts on them held back, and the Decisions ops the attention list reads
 * are answered in main from a table, so the renderer under review reads
 * everything through the seams it always does.
 *
 *   DAINTREE_SHOT_CANOPY_ANSWER=1 DESIGN_CAPTURE_DIR=/abs/dir \
 *     ./node_modules/.bin/playwright test --project=screenshots canopy-answer-attention-review --workers=1
 *
 * Env knobs:
 *   DAINTREE_SHOT_CANOPY_ANSWER  required: any truthy value runs the capture
 *   DESIGN_CAPTURE_DIR           required: output directory (never the repo)
 *   DAINTREE_SHOT_THEMES         themes for the cross-theme pass (default daintree,bondi,namib,redwoods,hokkaido,svalbard)
 *   DAINTREE_SCREENSHOT_SCALE    device scale factor (default 2)
 *
 * Output: <dir>/<state>.png and <dir>/attention--<theme>.png. Each frame is
 * checked for what it drove after its settle and before it is written, and
 * where the keyboard lands each time the list closes is asserted, not just
 * that it left <body>. The run fails if any expected file is missing.
 */

import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { execSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { openAndOnboardProject } from "../helpers/project";
import { dismissBlockingPalette } from "../helpers/overlays";
import { getGridPanelIds } from "../helpers/panels";
import { SEL } from "../helpers/selectors";
import { T_LONG } from "../helpers/timeouts";
import { fakeAgentEnv } from "../helpers/fakeAgent";
import {
  installFakeCanopyAgent,
  setFakeCanopyScene,
  type FakeCanopyScene,
} from "../helpers/fakeCanopyAgent";
import type { DecisionsAttentionItem } from "../../shared/types/decisionsAttention";

const ENABLED = !!process.env.DAINTREE_SHOT_CANOPY_ANSWER;
const OUT = process.env.DESIGN_CAPTURE_DIR ? path.resolve(process.env.DESIGN_CAPTURE_DIR) : "";
const SCALE = process.env.DAINTREE_SCREENSHOT_SCALE ?? "2";
const THEMES = (
  process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi,namib,redwoods,hokkaido,svalbard"
)
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

const CANOPY_SIZE = { width: 1440, height: 900 };
const NARROW_SIZE = { width: 980, height: 760 };
const ROWS = "[data-canopy-list] [data-canopy-card]";
const DETAIL = "[data-canopy-detail]";
const DIALOG = '[data-testid="decisions-attention-dialog"]';
/** The pane's route to the attention list. */
const REVIEW = "[data-canopy-answer-attention] button";

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
  { slug: "helios", name: "Helios", emoji: "☀️" },
  { slug: "helios-billing", name: "Helios Billing", emoji: "💳" },
  { slug: "helios-docs", name: "Helios Docs", emoji: "📚" },
] as const;

const HEADER = [
  "▐▛███▜▌   Claude Code v9.9.9",
  "▝▜█████▛▘  Opus · Claude Max",
  "  ▘▘ ▝▝    ~/code/helios",
  "",
];

const SCENES: Record<"restarted" | "question", FakeCanopyScene> = {
  // The terminal was restarted after the agent asked through Decisions: a
  // fresh session at its prompt, with no idea an answer is on its way.
  restarted: {
    lines: [
      ...HEADER,
      "> /resume",
      "",
      "⏺ Resumed the session from 11:42. Picking up the token refresh retry work.",
      "",
      "⏺ Read(src/auth/tokenRefresh.ts)",
      "  ⎿  Read 96 lines",
      "",
      "⏺ I asked you on your phone whether to retry once on a 401 before signing",
      "  the user out. I'll wait for that answer before changing the retry path.",
      "",
      "✻ Worked for 8s · done",
    ],
  },
  question: {
    lines: [
      ...HEADER,
      "> Write the release notes for the billing export, ask me about tone first",
      "",
      "⏺ Read(CHANGELOG.md)",
      "  ⎿  Read 340 lines",
      "",
      "⏺ Should the notes lead with the new Parquet format, or with the faster",
      "  CSV path? Parquet is the bigger change; CSV is what people asked for.",
      "",
      "✻ Worked for 12s · done",
    ],
  },
};

function git(cmd: string, cwd: string): void {
  execSync(`git ${cmd}`, { cwd, stdio: "ignore" });
}

/** Own prefix: the shared e2e temp reaper never touches it. */
function createRepo(root: string, slug: string): string {
  const dir = path.join(root, slug);
  mkdirSync(dir, { recursive: true });
  git("init -b main", dir);
  git('config user.email "test@daintree.dev"', dir);
  git('config user.name "Daintree Test"', dir);
  git("config commit.gpgsign false", dir);
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

async function polish(page: Page): Promise<void> {
  await page.evaluate((css) => {
    document.getElementById("pw-canopy-answer-polish")?.remove();
    const style = document.createElement("style");
    style.id = "pw-canopy-answer-polish";
    style.textContent = css;
    document.head.appendChild(style);
  }, POLISH_CSS);
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

/** Hold main's own fleet and Canopy broadcasts back, so only the harness's reach the views. */
async function freezeBroadcasts(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ webContents, app: electronApp }) => {
    const g = globalThis as unknown as { __canopyAnswerFrozen?: boolean };
    if (g.__canopyAnswerFrozen) return;
    g.__canopyAnswerFrozen = true;
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

/** Main answers the attention list's ops from a table the harness fills. */
async function answerDecisions(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ ipcMain }) => {
    const g = globalThis as unknown as { __canopyAnswer?: { items: unknown[] } };
    g.__canopyAnswer = { items: [] };
    const t = () => g.__canopyAnswer!;
    // Any handler's own parameters, called with what the renderer sent.
    const handle = (channel: string, fn: (...args: never[]) => unknown) => {
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, async (_e, ...args: unknown[]) =>
        (fn as (...sent: unknown[]) => unknown)(...args)
      );
    };
    handle("decisions:get-status", () => ({
      state: "connected",
      revision: Date.now() + 600_000,
      relayOrigin: "https://decisions.helios.dev",
    }));
    handle("decisions:get-pane-state", () => null);
    handle("decisions:list-attention", () => ({ result: "listed", items: t().items }));
    handle("decisions:list-answer-destinations", () => ({ result: "listed", destinations: [] }));
    handle(
      "decisions:copy-answer",
      () => "[DAINTREE DECISION ANSWER]\n[END DAINTREE DECISION ANSWER]"
    );
    handle("decisions:mark-answer-handled", (payload: { questionId: string }) => {
      t().items = t().items.filter(
        (i) => (i as { questionId: string }).questionId !== payload.questionId
      );
      return { result: "handled" };
    });
  });
}

async function setItems(app: ElectronApplication, items: DecisionsAttentionItem[]): Promise<void> {
  await app.evaluate((_e, next) => {
    (globalThis as unknown as { __canopyAnswer: { items: unknown[] } }).__canopyAnswer.items = next;
  }, items);
}

function iso(msAgo: number): string {
  return new Date(Date.now() - msAgo).toISOString();
}

function webhookItem(alias: number, question: string, text: string): DecisionsAttentionItem {
  return {
    questionId: `qid-canopy-att-${alias}-webhook`,
    alias,
    status: "needs-attention",
    reason: "pane_gone",
    question,
    askedAt: iso(3 * 3_600_000 + alias * 60_000),
    origin: {
      projectId: "helios-billing",
      projectName: "Helios Billing",
      worktreeId: "wt-billing",
      worktreeName: "helios-billing",
      agentId: "codex",
      agentName: "Codex",
      paneId: "s-two",
      paneTitle: "Webhook queue migration",
    },
    answer: {
      source: "human",
      choices: [],
      text,
      correction: false,
      answeredAt: iso(70 * 60_000),
    },
    answerUnavailable: null,
    followUps: [],
    canResume: false,
    canReassign: true,
  };
}

function attentionItems(asker: string, projectName: string): DecisionsAttentionItem[] {
  return [
    webhookItem(
      41,
      "Move the refund webhook to the queue consumer too?",
      "Yes, same consumer, but keep its own dead-letter queue."
    ),
    webhookItem(
      42,
      "Drop the old synchronous handler once the queue is live?",
      "Keep it behind the flag for a week, then drop it."
    ),
    {
      questionId: "qid-canopy-att-38-token",
      alias: 38,
      status: "needs-attention",
      reason: "relaunched",
      question: "Should token refresh retry once on a 401 before signing the user out?",
      askedAt: iso(2 * 3_600_000 + 12 * 60_000),
      origin: {
        projectId: "helios",
        projectName,
        worktreeId: "wt-main",
        worktreeName: "main",
        agentId: "claude",
        agentName: "Claude",
        paneId: asker,
        paneTitle: "Token refresh retry",
      },
      answer: {
        source: "human",
        choices: ["Retry once"],
        text: "Retry once with a fresh token, then sign out. Log the second 401 with the request id.",
        correction: false,
        answeredAt: iso(40 * 60_000),
      },
      answerUnavailable: null,
      followUps: [],
      canResume: true,
      canReassign: true,
    },
  ];
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

interface Real {
  asker: string;
  question: string;
}

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
    const agentId = (run.agentId as string | undefined) ?? "claude";
    return {
      run: { spawnedAt, ...run, agentId, title: "Claude", lastObservedTitle: run.title },
      card: fields ? card(run.runId as string, spawnedAt, now, fields) : undefined,
      unread,
    };
  };
  return [
    spec(
      {
        runId: real.asker,
        spawnedAt: spawned[real.asker],
        workspaceId: w("helios"),
        agentState: "idle",
        since: at(6),
        title: "Token refresh retry",
        cwd: "/repos/helios",
        answerAttention: 1,
      },
      {
        category: "idle",
        priority: 22,
        task: "Retry token refresh once on a 401",
        headline: "Waiting for your answer on the 401 retry",
        summary: "Resumed after a restart and says it is waiting for your phone answer.",
        glance: {
          recap: "Resumed the session and reread tokenRefresh.ts",
          said: null,
          doing: null,
          action: null,
        },
      }
    ),
    spec(
      {
        runId: real.question,
        spawnedAt: spawned[real.question],
        workspaceId: w("helios"),
        agentState: "waiting",
        waitingReason: "question",
        since: at(9),
        title: "Billing export release notes",
        cwd: "/repos/helios",
        canopy: {
          kind: "asked",
          quote: "Should the notes lead with the new Parquet format, or with the faster CSV path?",
          readAt: at(8),
        },
      },
      {
        category: "question",
        priority: 82,
        attentionProbability: 0.9,
        task: "Write the release notes for the billing export",
        headline: "Lead with Parquet, or with CSV?",
        summary: "Asks which change the release notes should open with.",
        question: "Should the notes lead with the new Parquet format, or with the faster CSV path?",
      },
      true
    ),
    spec(
      {
        runId: "s-two",
        workspaceId: w("helios-billing"),
        agentId: "codex",
        agentState: "idle",
        since: at(31),
        spawnedAt: at(80),
        title: "Webhook queue migration",
        cwd: "/repos/helios-billing",
        answerAttention: 2,
      },
      {
        category: "idle",
        priority: 20,
        task: "Move the billing webhooks to the queue consumer",
        headline: "Idle at the prompt",
        summary: "Moved two handlers and stopped before the third.",
      }
    ),
    spec(
      {
        runId: "s-err",
        workspaceId: w("helios-billing"),
        agentState: "waiting",
        waitingReason: "error",
        since: at(14),
        spawnedAt: at(40),
        title: "Ledger reconciliation",
        cwd: "/repos/helios-billing",
      },
      {
        category: "error",
        priority: 66,
        headline: "Stopped on a rate limit",
        summary: "The API returned 429 three times and it stopped retrying.",
      }
    ),
    spec(
      {
        runId: "s-fin",
        workspaceId: w("helios-docs"),
        agentState: "completed",
        since: at(22),
        spawnedAt: at(50),
        title: "Docs search index",
        cwd: "/repos/helios-docs",
      },
      {
        category: "finished",
        priority: 40,
        progress: 100,
        headline: "Rebuilt the docs search index",
        summary: "Indexed 412 pages; the search smoke test passes.",
        tests: "passing",
      }
    ),
    spec(
      {
        runId: "s-work",
        workspaceId: w("helios"),
        agentState: "working",
        since: at(3),
        spawnedAt: at(20),
        title: "Session expiry banner",
        cwd: "/repos/helios",
      },
      {
        category: "working",
        priority: 15,
        headline: "Writing the expiry banner tests",
        summary: "Covering the five-minute warning and the forced sign-out.",
        progress: 60,
      }
    ),
  ];
}

/** Canopy drops a snapshot older than the one it holds, so each push counts up. */
let sequence = 1_000_000_000 + Math.floor(Date.now() / 1000);

function canopySnapshot(
  specs: RunSpec[],
  now: number,
  dispositions: unknown[] = []
): Record<string, unknown> {
  return {
    sequence: ++sequence,
    mode: "on",
    activated: true,
    model: { id: "daintreehq/canopy-reader-17m", status: "ready" },
    dispositions,
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

async function canopyPage(app: ElectronApplication): Promise<Page> {
  let found: Page | null = null;
  await expect
    .poll(
      async () => {
        for (const page of app.windows()) {
          const ok = await page
            .evaluate(() => document.querySelector("[data-canopy-standalone]") !== null)
            .catch(() => false);
          if (ok) {
            found = page;
            return true;
          }
        }
        return false;
      },
      { timeout: T_LONG, intervals: [300], message: "the Canopy window never rendered" }
    )
    .toBe(true);
  return found!;
}

async function sizeCanopy(
  app: ElectronApplication,
  page: Page,
  size: { width: number; height: number }
): Promise<void> {
  await app.evaluate(({ BrowserWindow }, s) => {
    BrowserWindow.getAllWindows()
      .find((w) => w.getTitle() === "Canopy")
      ?.setContentSize(s.width, s.height);
  }, size);
  await expect
    .poll(() => page.evaluate(() => window.innerWidth), {
      timeout: 10_000,
      message: `Canopy never reached ${size.width}px`,
    })
    .toBe(size.width);
  await settle(page, 800);
}

async function selectRow(page: Page, runId: string): Promise<void> {
  const row = page.locator(`${ROWS}[id$="${runId}"]`).first();
  await row.waitFor({ state: "visible", timeout: 10_000 });
  await row.click();
  await expect(page.locator(`${DETAIL}[id$="${runId}"]`)).toBeVisible({ timeout: 10_000 });
  await settle(page, 700);
}

async function parkPointer(page: Page): Promise<void> {
  await page.mouse.move(4, 4);
}

async function shoot(page: Page, name: string): Promise<void> {
  await settle(page, 500);
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file, type: "png", animations: "disabled", caret: "hide" });
  if (!existsSync(file)) throw new Error(`${name}: no file written`);
  written.push(name);
}

async function switchTheme(main: Page, canopy: Page, theme: string): Promise<void> {
  const current = await canopy.locator("html").getAttribute("data-theme");
  if (current === theme) return;
  await main.evaluate(async (id) => {
    await window.electron.appTheme.setColorScheme(id);
  }, theme);
  await expect
    .poll(() => canopy.locator("html").getAttribute("data-theme"), { timeout: 8000 })
    .toBe(theme);
  await polish(canopy);
  await settle(canopy, 1200);
}

const written: string[] = [];

test("canopy answer attention review", async () => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_CANOPY_ANSWER and DESIGN_CAPTURE_DIR are required for this capture",
  });
  test.skip(!ENABLED || !OUT, "Set DAINTREE_SHOT_CANOPY_ANSWER and DESIGN_CAPTURE_DIR");
  test.setTimeout(12 * 60_000);
  mkdirSync(OUT, { recursive: true });

  const repoRoot = mkdtempSync(path.join(tmpdir(), "canopyanswershot-repos-"));
  const userDataDir = mkdtempSync(path.join(tmpdir(), "canopyanswershot-"));
  const dirs = WORKSPACES.map((ws) => createRepo(repoRoot, ws.slug));
  const binDir = installFakeCanopyAgent(dirs[0]!);

  let ctx: AppContext | undefined;
  try {
    ctx = await launchApp({
      userDataDir,
      screenshotScale: SCALE,
      windowSize: { width: 1400, height: 900 },
      env: fakeAgentEnv(binDir),
      extraArgs: ["--disable-gpu", "--in-process-gpu", "--disable-breakpad", "--noerrdialogs"],
    });
    const app = ctx.app;
    const main = await openAndOnboardProject(app, ctx.window, dirs[0]!, WORKSPACES[0]!.name);
    const ids = await ensureProjects(main, dirs);

    const real: Real = { asker: await launchClaude(main), question: await launchClaude(main) };
    setFakeCanopyScene(binDir, real.asker, SCENES.restarted);
    setFakeCanopyScene(binDir, real.question, SCENES.question);

    let spawned: Record<string, number> = {};
    await expect
      .poll(
        async () => {
          spawned = await main.evaluate(async (want: string[]) => {
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
      .toBe(2);

    await answerDecisions(app);
    await setItems(app, attentionItems(real.asker, WORKSPACES[0]!.name));
    await settle(main, 2000);
    await freezeBroadcasts(app);

    const now = Date.now();
    const specs = buildFleet(real, spawned, ids, now);
    // The list holds its order until Sort now, so a pushed change is applied
    // the way the user would apply it.
    const inject = async (
      page: Page,
      s = specs,
      dispositions: unknown[] = [],
      { sortNow = true }: { sortNow?: boolean } = {}
    ) => {
      await push(app, "fleet:snapshot-updated", fleetSnapshot(s, now));
      await push(app, "canopy:snapshot-updated", canopySnapshot(s, now, dispositions));
      await settle(page, 400);
      if (!sortNow) return;
      const sort = page.locator('button:has-text("Sort now")').first();
      if ((await sort.count()) > 0 && (await sort.isVisible())) {
        await sort.click();
        await settle(page, 400);
      }
    };

    await main.evaluate(() => window.electron.canopyWindow.open());
    const page = await canopyPage(app);
    await sizeCanopy(app, page, CANOPY_SIZE);
    await polish(page);
    await inject(page);
    await expect
      .poll(() => page.locator(ROWS).count(), { timeout: 15_000, message: "rows on screen" })
      .toBeGreaterThanOrEqual(5);
    await parkPointer(page);

    // 01 — the run whose answer needs attention, selected.
    await selectRow(page, real.asker);
    await parkPointer(page);
    await expect(page.locator(`${ROWS}[id$="${real.asker}"]`)).toContainText("need");
    await expect(page.getByText("Not every agent is sorted yet")).toHaveCount(0);
    await shoot(page, "01-attention-selected");

    // 02 — two answers needing attention, on a run with no live terminal here.
    await selectRow(page, "s-two");
    await parkPointer(page);
    await shoot(page, "02-attention-two");

    // 03 — an ordinary question: no answer needs attention, the pane as it always was.
    await selectRow(page, real.question);
    await parkPointer(page);
    await shoot(page, "03-plain-question");

    // 04 — the row menu on the run whose answer needs attention.
    const menuRow = page.locator(`${ROWS}[id$="${real.asker}"]`).first();
    await menuRow.click({ button: "right" });
    await expect(page.locator('[role="menu"]').first()).toBeVisible({ timeout: 5000 });
    await settle(page, 400);
    await shoot(page, "04-row-menu");
    await page.keyboard.press("Escape");
    await settle(page, 300);

    // 05 — replied to in Canopy: the run leaves Needs you, the answer still needs attention.
    const replied = [
      { runId: real.asker, spawnedAt: spawned[real.asker], kind: "replied", at: now },
    ];
    await inject(page, specs, replied);
    await selectRow(page, real.asker);
    await parkPointer(page);
    await shoot(page, "05-replied");
    await inject(page);
    await selectRow(page, real.asker);

    // 06 — narrow window.
    await sizeCanopy(app, page, NARROW_SIZE);
    await selectRow(page, real.asker);
    await parkPointer(page);
    await shoot(page, "06-narrow");
    await sizeCanopy(app, page, CANOPY_SIZE);
    await selectRow(page, real.asker);

    const rowOf = (runId: string) => page.locator(`${ROWS}[id$="${runId}"]`).first();
    const isFocused = (selector: string) =>
      page.evaluate((sel) => document.activeElement?.matches(sel) ?? false, selector);
    const review = page.locator(`${DETAIL} ${REVIEW}`).first();
    await expect(review).toBeVisible({ timeout: 5000 });

    // 07 — the keyboard on the route, reached from the run's row with Tab.
    await rowOf(real.asker).focus();
    for (
      let i = 0;
      i < 12 && !(await review.evaluate((el) => el === document.activeElement));
      i++
    ) {
      await page.keyboard.press("Tab");
    }
    await expect(review).toBeFocused();
    await shoot(page, "07-review-focused");

    // 08 — the list, opened from the pane, at this run's answer: its first action has the keyboard.
    const ASKER_Q = `${DIALOG} [data-question-id="qid-canopy-att-38-token"]`;
    await page.keyboard.press("Enter");
    await expect(page.locator(DIALOG)).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(ASKER_Q)).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(`${ASKER_Q} [data-attention-action]`).first()).toBeFocused({
      timeout: 5000,
    });
    await settle(page, 600);
    await shoot(page, "08-review-open");

    // Closed with the answer still there: back to the control that opened it.
    await page.keyboard.press("Escape");
    await expect(page.locator(DIALOG)).toBeHidden({ timeout: 10_000 });
    await settle(page, 300);
    await expect(review).toBeFocused();
    await expect(page.locator("[data-canopy-standalone]")).toBeVisible();

    // From the row menu: the list opens, and its close returns to the row.
    await rowOf(real.asker).click({ button: "right" });
    await page.locator('[role="menuitem"]:has-text("Review answers")').click();
    await expect(page.locator(DIALOG)).toBeVisible({ timeout: 10_000 });
    await settle(page, 400);
    await page.keyboard.press("Escape");
    await expect(page.locator(DIALOG)).toBeHidden({ timeout: 10_000 });
    await settle(page, 300);
    if (!(await isFocused(`[id$="${real.asker}"][data-canopy-card]`))) {
      throw new Error("row menu: the list's close did not return to the run's row");
    }

    // 09 — marked handled in the list: the fleet drops the count, the notice
    // goes with it, and the close returns to the run's row.
    await review.click();
    await expect(page.locator(ASKER_Q)).toBeVisible({ timeout: 10_000 });
    await page.locator(`${ASKER_Q} button:has-text("Mark handled")`).click();
    // An answer that could still be resumed or sent elsewhere asks first.
    const confirmHandled = page.locator('[role="alertdialog"] button:has-text("Mark handled")');
    await expect(confirmHandled).toBeVisible({ timeout: 5000 });
    await confirmHandled.click();
    await expect(page.locator(ASKER_Q)).toHaveCount(0, { timeout: 10_000 });
    await expect(page.locator(`${DIALOG} [data-question-id]`)).toHaveCount(2);
    const cleared = specs.map((s) =>
      s.run.runId === real.asker
        ? {
            ...s,
            run: Object.fromEntries(Object.entries(s.run).filter(([k]) => k !== "answerAttention")),
          }
        : s
    );
    // As main would: the list stays open while the pane behind it catches up.
    await inject(page, cleared, [], { sortNow: false });
    await expect(page.locator(`${DETAIL} [data-canopy-answer-attention]`)).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(page.locator(DIALOG)).toBeHidden({ timeout: 10_000 });
    await settle(page, 500);
    if (!(await isFocused(`[id$="${real.asker}"][data-canopy-card]`))) {
      throw new Error("09: the list's close did not return to the run's row");
    }
    await shoot(page, "09-after-handled");
    await setItems(app, attentionItems(real.asker, WORKSPACES[0]!.name));
    await inject(page);
    await selectRow(page, real.asker);

    // 10, 11 — the notice under raised contrast and forced colours.
    await page.emulateMedia({ contrast: "more" });
    await settle(page, 600);
    await parkPointer(page);
    await shoot(page, "10-prefers-contrast");
    await page.emulateMedia({ contrast: null, forcedColors: "active" });
    await settle(page, 600);
    await parkPointer(page);
    await shoot(page, "11-forced-colors");
    await page.emulateMedia({ forcedColors: null });
    await settle(page, 300);

    // Cross-theme: the attention state in each theme.
    for (const theme of THEMES) {
      await switchTheme(main, page, theme);
      await selectRow(page, real.asker);
      await parkPointer(page);
      await shoot(page, `attention--${theme}`);
    }
    await switchTheme(main, page, THEMES[0]!);
  } finally {
    if (ctx) await closeApp(ctx.app).catch(() => {});
    rmSync(userDataDir, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
  }

  const files = readdirSync(OUT).filter((f) => f.endsWith(".png"));
  const missing = written.filter((name) => !files.includes(`${name}.png`));
  console.log(`[canopy-answer] wrote ${written.length}: ${written.join(", ")}`);
  if (missing.length > 0) throw new Error(`missing captures: ${missing.join(", ")}`);
});
