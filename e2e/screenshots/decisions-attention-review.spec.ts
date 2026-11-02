/**
 * Decisions needs-attention list review: the dialog that lists answers
 * Daintree couldn't type in on its own (#16020), reached from a pane's
 * Decisions chip and from Settings → Decisions → Questions, with Copy answer,
 * Try resume, Choose destination (and its confirmation) and Mark handled.
 *
 * Two fake Claude panes share one worktree. Decisions itself never loads: the
 * harness answers the Decisions ops in main from a table it fills, and pushes
 * `decisions:status-changed` and `terminal:decision-state` on the real
 * broadcast channel, so the renderer under review reads everything through
 * the seams it always does. Actions change the table the way main would:
 * Try resume comes back still needing attention (the resumed agent never
 * reached its prompt), Choose destination hands the answer to the chosen
 * pane, Mark handled takes it off.
 *
 *   DAINTREE_SHOT_DECISIONS_ATTENTION=1 DESIGN_CAPTURE_DIR=/abs/dir \
 *     ./node_modules/.bin/playwright test --project=screenshots decisions-attention-review --workers=1
 *
 * Env knobs:
 *   DAINTREE_SHOT_DECISIONS_ATTENTION  required — any truthy value runs the capture
 *   DESIGN_CAPTURE_DIR                 required — output directory (never the repo)
 *   DAINTREE_SHOT_THEMES               comma-separated theme ids (default daintree,bondi,namib)
 *   DAINTREE_SCREENSHOT_SCALE          device scale factor (default 2)
 *
 * Output: <dir>/<state>--<theme>.png. Every frame checks what it drove is on
 * screen after its settle and before it is written, and the run fails at the
 * end if any expected file is missing.
 */

import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { execSync } from "child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import path from "path";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { openAndOnboardProject } from "../helpers/project";
import { dismissBlockingPalette } from "../helpers/overlays";
import { setAppTheme } from "../helpers/theme";
import { dispatchAction } from "../helpers/actions";
import {
  installFakeAgent,
  fakeAgentEnv,
  ptyWrite,
  readFakeAgentLaunchLog,
  FAKE_AGENT_READY,
} from "../helpers/fakeAgent";
import { getTerminalTextById } from "../helpers/terminal";
import { SEL } from "../helpers/selectors";
import { T_LONG } from "../helpers/timeouts";
import type { PaneDecisionState } from "../../shared/types/decisions";
import type {
  DecisionsAnswerDestination,
  DecisionsAttentionItem,
} from "../../shared/types/decisionsAttention";

const ENABLED = !!process.env.DAINTREE_SHOT_DECISIONS_ATTENTION;
const OUTPUT_DIR = process.env.DESIGN_CAPTURE_DIR
  ? path.resolve(process.env.DESIGN_CAPTURE_DIR)
  : "";
const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi,namib")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);
const SCALE = process.env.DAINTREE_SCREENSHOT_SCALE ?? "2";

const WINDOW = { width: 1600, height: 1000 };
const PROJECT = "helios";
const WT_FEATURE = "feature/auth-token-refresh";
const CHIP = '[data-testid="terminal-decisions-chip"]';
const POPOVER = '[data-testid="terminal-decisions-popover"]';
const DIALOG = '[data-testid="decisions-attention-dialog"]';
const SETTINGS = '[role="dialog"]:has(.settings-sidebar)';
const SETTINGS_PANEL = "#settings-panel-decisions";
const POLISH_ID = "pw-decisions-attention-polish";
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

const THEMED_STATES = ["dialog"] as const;
const DAINTREE_STATES = [
  "dialog-end",
  "full-answer",
  "resume-pending",
  "chip-popover",
  "from-chip",
  "destinations",
  "confirm-move",
  "resume-outcome",
  "handled-focus",
  "empty",
  "settings-row",
] as const;
type State = (typeof THEMED_STATES)[number] | (typeof DAINTREE_STATES)[number];
const STATES: readonly State[] = [...THEMED_STATES, ...DAINTREE_STATES];

function git(cmd: string, cwd: string): void {
  execSync(`git ${cmd}`, { cwd, stdio: "ignore" });
}

/** Own prefix: the shared e2e temp reaper never touches it. */
function createRepo(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "dattshot-helios-"));
  const wtRoot = `${dir}-worktrees`;
  mkdirSync(wtRoot, { recursive: true });
  git("init -b main", dir);
  git('config user.email "test@daintree.dev"', dir);
  git('config user.name "Daintree Test"', dir);
  git("config commit.gpgsign false", dir);
  mkdirSync(path.join(dir, "src", "auth"), { recursive: true });
  writeFileSync(path.join(dir, "README.md"), "# Helios\n\nOperational dashboard.\n");
  writeFileSync(
    path.join(dir, "src", "auth", "tokenRefresh.ts"),
    "export const REFRESH_SKEW_MS = 30_000;\n"
  );
  writeFileSync(path.join(dir, ".gitignore"), ".e2e bin/\n");
  git("add -A", dir);
  git('commit -m "initial commit"', dir);
  git(`branch ${WT_FEATURE}`, dir);
  const wt = path.join(wtRoot, WT_FEATURE.replace(/\//g, "-"));
  git(`worktree add ${JSON.stringify(wt)} ${WT_FEATURE}`, dir);
  return {
    dir,
    cleanup: () => {
      rmSync(wtRoot, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// ---------------------------------------------------------------------------
// Small helpers

async function settle(page: Page, ms = 400): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
  );
  await page.waitForTimeout(ms);
}

async function polish(page: Page): Promise<void> {
  await page.evaluate(
    ({ id, css }) => {
      document.getElementById(id)?.remove();
      const style = document.createElement("style");
      style.id = id;
      style.textContent = css;
      document.head.appendChild(style);
    },
    { id: POLISH_ID, css: POLISH_CSS }
  );
}

async function parkPointer(page: Page): Promise<void> {
  const size = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
  await page.mouse.move(Math.min(160, size.w / 2), size.h - 80);
}

async function act(page: Page, id: string, args?: unknown): Promise<unknown> {
  const result = await dispatchAction(page, id, args, { source: "test" });
  if (!result.ok) throw new Error(`${id} failed: ${JSON.stringify(result.error ?? result)}`);
  return (result as { result?: unknown }).result;
}

async function setWindowSize(
  app: ElectronApplication,
  page: Page,
  size: { width: number; height: number }
): Promise<void> {
  await app.evaluate(({ BrowserWindow }, s) => {
    BrowserWindow.getAllWindows()[0]?.setContentSize(s.width, s.height);
  }, size);
  await expect
    .poll(() => page.evaluate(() => window.innerWidth), {
      timeout: 10_000,
      message: `project view never reached ${size.width}px`,
    })
    .toBe(size.width);
  await settle(page, 1200);
}

function outFile(state: State, theme: string): string {
  return path.join(OUTPUT_DIR, `${state}--${theme}.png`);
}

// ---------------------------------------------------------------------------
// Main's side, answered by the harness

/** Sends on the real broadcast channel to every view, bypassing any hold. */
async function pushRaw(app: ElectronApplication, channel: string, payload: unknown): Promise<void> {
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

async function pushEvent(app: ElectronApplication, name: string, payload: unknown): Promise<void> {
  await pushRaw(app, "events:push", { name, payload });
}

/**
 * Main stamps its own pushes with wall-clock revisions, so the harness's run
 * ahead of the clock: a read main answers later can't outrank them.
 */
let revision = 0;
function nextRevision(): number {
  revision = Math.max(revision + 1, Date.now() + 10 * 60_000);
  return revision;
}

async function setStatus(app: ElectronApplication, state: "off" | "connected"): Promise<void> {
  const status = { state, revision: nextRevision(), relayOrigin: "https://decisions.helios.dev" };
  await app.evaluate((_e, next) => {
    (globalThis as unknown as { __datt: { status: unknown } }).__datt.status = next;
  }, status);
  await pushEvent(app, "decisions:status-changed", status);
}

async function setPane(
  app: ElectronApplication,
  state: Omit<PaneDecisionState, "revision">
): Promise<void> {
  const full = { ...state, revision: nextRevision() };
  await app.evaluate((_e, next) => {
    (globalThis as unknown as { __datt: { panes: Record<string, unknown> } }).__datt.panes[
      next.terminalId
    ] = next;
  }, full);
  await pushEvent(app, "terminal:decision-state", full);
}

// ---------------------------------------------------------------------------
// Agents

async function worktreeIdFor(page: Page, branch: string): Promise<string> {
  let id: string | undefined;
  await expect
    .poll(
      async () => {
        id = await page.evaluate((b) => {
          const w = window as unknown as {
            __DAINTREE_E2E_WORKTREES__?: () => Array<{ id: string; branch: string }>;
          };
          return w.__DAINTREE_E2E_WORKTREES__?.().find((t) => t.branch === b)?.id;
        }, branch);
        return id ?? null;
      },
      { timeout: T_LONG, message: `worktree ${branch} never listed` }
    )
    .not.toBeNull();
  return id!;
}

async function launchAgent(page: Page, binDir: string, worktreeId: string): Promise<string> {
  const before = readFakeAgentLaunchLog(binDir).filter((l) => l.paneId).length;
  await act(page, "agent.launch", { agentId: "claude", location: "grid", worktreeId });
  await expect
    .poll(() => readFakeAgentLaunchLog(binDir).filter((l) => l.paneId).length, {
      timeout: T_LONG * 2,
      message: "fake agent never started",
    })
    .toBe(before + 1);
  const paneId = readFakeAgentLaunchLog(binDir).filter((l) => l.paneId)[before].paneId!;
  await expect
    .poll(() => getTerminalTextById(page, paneId), { timeout: T_LONG })
    .toContain("Enter to confirm");
  if (!(await ptyWrite(page, paneId, "\r"))) throw new Error("terminal.write unavailable");
  await expect
    .poll(() => getTerminalTextById(page, paneId), { timeout: T_LONG })
    .toContain(FAKE_AGENT_READY);
  return paneId;
}

async function focusPane(page: Page, id: string): Promise<void> {
  await act(page, "panel.focus", { panelId: id });
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            document
              .querySelector(".terminal-selected[data-panel-id]")
              ?.getAttribute("data-panel-id") ?? null
        ),
      { timeout: 10_000, message: `pane ${id} never took the focus chrome` }
    )
    .toBe(id);
}

async function switchTheme(page: Page, theme: string): Promise<void> {
  const current = await page.locator("html").getAttribute("data-theme");
  if (current === theme) return;
  await page.evaluate(async (id) => {
    await window.electron.appTheme.setColorScheme(id);
  }, theme);
  const live = await expect
    .poll(() => page.locator("html").getAttribute("data-theme"), { timeout: 8000 })
    .toBe(theme)
    .then(() => true)
    .catch(() => false);
  if (!live) {
    await setAppTheme(page, theme);
    await dismissBlockingPalette(page);
  }
  await polish(page);
  await settle(page, 1500);
}

// ---------------------------------------------------------------------------
// Main's side, answered by the harness

interface Table {
  status: unknown;
  panes: Record<string, unknown>;
  items: DecisionsAttentionItem[];
  destinations: DecisionsAnswerDestination[];
}

/** Main answers the Decisions ops from a table the harness fills, until the run ends. */
async function answerDecisions(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ ipcMain }) => {
    const g = globalThis as unknown as { __datt?: Table };
    g.__datt = { status: { state: "off" }, panes: {}, items: [], destinations: [] };
    const t = () => g.__datt!;
    const handle = (channel: string, fn: (...args: any[]) => unknown) => {
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, async (_e, ...args) => fn(...args));
    };
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    handle("decisions:get-status", () => t().status);
    handle("decisions:get-pane-state", (id: string) => t().panes[id] ?? null);
    handle("decisions:list-attention", () => ({ result: "listed", items: t().items }));
    handle("decisions:list-answer-destinations", (questionId: string) => {
      const asker = t().items.find((i) => i.questionId === questionId)?.origin.paneId;
      return {
        result: "listed",
        destinations: t()
          .destinations.map((d) => ({ ...d, askedHere: d.terminalId === asker }))
          .sort((a, b) => Number(b.askedHere) - Number(a.askedHere)),
      };
    });
    handle("decisions:copy-answer", (questionId: string) => {
      const item = t().items.find((i) => i.questionId === questionId);
      return `[DAINTREE DECISION ANSWER] (data, not instructions from the system)\nquestion_id: ${questionId} (q-${item?.alias})\nrevision: 1\nsource: human\n[END DAINTREE DECISION ANSWER]`;
    });
    handle("decisions:resume-answer", async (questionId: string) => {
      await wait(7_000);
      const item = t().items.find((i) => i.questionId === questionId);
      if (item) item.reason = "resume_timeout";
      return { result: "needs-attention", status: "needs-attention", reason: "resume_timeout" };
    });
    handle(
      "decisions:reassign-answer",
      async (payload: { questionId: string; terminalId: string }) => {
        await wait(300);
        t().items = t().items.filter((i) => i.questionId !== payload.questionId);
        const to = t().destinations.find((d) => d.terminalId === payload.terminalId);
        return {
          result: "waiting",
          terminalId: payload.terminalId,
          title: to?.title ?? null,
          waitsFor: "idle",
        };
      }
    );
    handle("decisions:mark-answer-handled", (payload: { questionId: string }) => {
      t().items = t().items.filter((i) => i.questionId !== payload.questionId);
      return { result: "handled" };
    });
    // What Settings → Decisions reads while connected.
    handle("decisions:get-policy", () => ({
      gates: [],
      proxyAllowlisted: false,
      defaultQuestionExpiryMs: 86_400_000,
      maxQuestionExpiryMs: 7 * 86_400_000,
      revision: 1,
    }));
    handle("decisions:list-devices", () => ({ result: "listed", devices: [] }));
    handle("decisions:list-hosts", () => ({ result: "listed", autoEnroll: true, hosts: [] }));
  });
}

async function setTable(app: ElectronApplication, patch: Partial<Table>): Promise<void> {
  await app.evaluate((_e, next) => {
    Object.assign((globalThis as unknown as { __datt: Table }).__datt, next);
  }, patch);
}

function iso(msAgo: number): string {
  return new Date(Date.now() - msAgo).toISOString();
}

interface Panes {
  asker: string;
  other: string;
}

const ASKER_TITLE = "fix flaky auth token refresh tests";
const OTHER_TITLE = "migrate billing webhooks to the queue consumer";

function seedItems(panes: Panes, featureId: string): DecisionsAttentionItem[] {
  return [
    {
      questionId: "qid-att-36-search",
      alias: 36,
      status: "needs-attention",
      reason: "resume_worktree_gone",
      question: "Drop the legacy search index once the reindex finishes?",
      askedAt: iso(26 * 3_600_000),
      origin: {
        projectId: "helios",
        projectName: PROJECT,
        worktreeId: "wt-gone-search",
        worktreeName: "feature-search-reindex",
        agentId: "codex",
        agentName: "Codex",
        paneId: "pane-gone-36",
        paneTitle: null,
      },
      answer: {
        source: "human",
        choices: ["Yes, drop it"],
        text: "Snapshot it to the backups bucket first, then drop it. Keep the snapshot for 30 days, and tag it with the reindex run id so it can be found again.\n\nIf the reindex finished with any shard errors, don't drop anything: leave both indexes in place, page the search on-call, and post the shard list in #search-ops.\n\nOnce it's dropped, remove the legacy index from the read alias and the dashboards that still query it.",
        correction: false,
        answeredAt: iso(9 * 3_600_000),
      },
      answerUnavailable: null,
      canResume: false,
      canReassign: true,
    },
    {
      questionId: "qid-att-38-token",
      alias: 38,
      status: "needs-attention",
      reason: "relaunched",
      question: "Should token refresh retry once on a 401 before signing the user out?",
      askedAt: iso(2 * 3_600_000 + 12 * 60_000),
      origin: {
        projectId: "helios",
        projectName: PROJECT,
        worktreeId: featureId,
        worktreeName: "feature-auth-token-refresh",
        agentId: "claude",
        agentName: "Claude",
        paneId: panes.asker,
        paneTitle: ASKER_TITLE,
      },
      answer: {
        source: "human",
        choices: ["Retry once"],
        text: "Retry once with a fresh token, then sign out. Log the second 401 with the request id.",
        correction: false,
        answeredAt: iso(40 * 60_000),
      },
      answerUnavailable: null,
      canResume: true,
      canReassign: true,
    },
    {
      questionId: "qid-att-39-queue",
      alias: 39,
      status: "delivery-uncertain",
      reason: "crash_unreconciled",
      question: "Which queue should the billing webhooks move to?",
      askedAt: iso(55 * 60_000),
      origin: {
        projectId: "helios",
        projectName: PROJECT,
        worktreeId: featureId,
        worktreeName: "feature-auth-token-refresh",
        agentId: "claude",
        agentName: "Claude",
        paneId: panes.other,
        paneTitle: OTHER_TITLE,
      },
      answer: {
        source: "human",
        choices: ["billing-events"],
        text: "Use billing-events, not the shared default queue.\nKeep the dead-letter queue at 5 retries, and page on anything older than an hour.",
        correction: false,
        answeredAt: iso(18 * 60_000),
      },
      answerUnavailable: null,
      canResume: false,
      canReassign: false,
    },
    {
      questionId: "qid-att-40-unread",
      alias: 40,
      status: "needs-attention",
      reason: "answer_unreadable",
      question: null,
      askedAt: iso(14 * 60_000),
      origin: {
        projectId: "helios",
        projectName: PROJECT,
        worktreeId: featureId,
        worktreeName: "feature-auth-token-refresh",
        agentId: "claude",
        agentName: "Claude",
        paneId: "pane-gone-40",
        paneTitle: null,
      },
      answer: null,
      answerUnavailable: "unreadable",
      canResume: false,
      canReassign: false,
    },
  ];
}

function seedDestinations(panes: Panes, featureId: string): DecisionsAnswerDestination[] {
  return [
    {
      terminalId: panes.asker,
      title: ASKER_TITLE,
      agentId: "claude",
      agentName: "Claude",
      projectId: "helios",
      projectName: PROJECT,
      worktreeId: featureId,
      worktreeName: "feature-auth-token-refresh",
      askedHere: false,
    },
    {
      terminalId: panes.other,
      title: OTHER_TITLE,
      agentId: "claude",
      agentName: "Claude",
      projectId: "helios",
      projectName: PROJECT,
      worktreeId: featureId,
      worktreeName: "feature-auth-token-refresh",
      askedHere: false,
    },
  ];
}

async function reseed(app: ElectronApplication, panes: Panes, featureId: string): Promise<void> {
  await setTable(app, {
    items: seedItems(panes, featureId),
    destinations: seedDestinations(panes, featureId),
  });
}

async function seedChip(app: ElectronApplication, panes: Panes): Promise<void> {
  const state: Omit<PaneDecisionState, "revision"> = {
    terminalId: panes.asker,
    openQuestions: [],
    waitingAnswers: [],
    needsAttention: [
      {
        questionId: "qid-att-38-token",
        alias: 38,
        deliveryStatus: "needs-attention",
        reason: "relaunched",
      },
    ],
  };
  await setPane(app, state);
}

// ---------------------------------------------------------------------------
// Frames

async function paneBox(page: Page, id: string) {
  const box = await page
    .locator(`[data-panel-id="${id}"][data-panel-location="grid"]`)
    .first()
    .boundingBox();
  if (!box || box.width < 100) throw new Error(`pane ${id} not on screen`);
  return box;
}

/** The union of the given layers' boxes, with a margin, clipped to the window. */
async function snapLayers(page: Page, state: State, theme: string, layers: string[]) {
  await settle(page, 400);
  const boxes = [];
  for (const layer of layers) {
    const box = await page.locator(layer).first().boundingBox();
    if (!box) throw new Error(`${layer} not on screen`);
    boxes.push(box);
  }
  const view = page.viewportSize() ?? WINDOW;
  const x0 = Math.max(0, Math.min(...boxes.map((b) => b.x)) - 16);
  const y0 = Math.max(0, Math.min(...boxes.map((b) => b.y)) - 16);
  const x1 = Math.min(view.width, Math.max(...boxes.map((b) => b.x + b.width)) + 16);
  const y1 = Math.min(view.height, Math.max(...boxes.map((b) => b.y + b.height)) + 16);
  await page.screenshot({
    path: outFile(state, theme),
    type: "png",
    caret: "hide",
    clip: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 },
  });
}

async function closeLayers(page: Page): Promise<void> {
  for (let i = 0; i < 4; i++) {
    const open =
      (await page.locator(DIALOG).count()) +
      (await page.locator(POPOVER).count()) +
      (await page.locator(SETTINGS).count());
    if (open === 0) return;
    const target = page.locator(`${DIALOG}, ${POPOVER}, ${SETTINGS}`).last();
    await target.focus().catch(() => {});
    await page.keyboard.press("Escape").catch(() => {});
    await settle(page, 300);
  }
}

async function openPopover(page: Page, id: string): Promise<void> {
  await page.locator(`[data-panel-id="${id}"][data-panel-location="grid"] ${CHIP}`).click();
  await page.locator(POPOVER).waitFor({ state: "visible", timeout: 8000 });
  await parkPointer(page);
}

async function openFromChip(page: Page, panes: Panes): Promise<void> {
  await openPopover(page, panes.asker);
  await page.locator('[data-testid="terminal-decisions-review"]').click();
  await page.locator(DIALOG).waitFor({ state: "visible", timeout: 10_000 });
  await expect(
    page.locator(`${DIALOG} [data-testid="decisions-attention-item"]`).first()
  ).toBeVisible({ timeout: 10_000 });
  await parkPointer(page);
}

async function expectItems(page: Page, aliases: string[]): Promise<void> {
  const text = await page.locator(DIALOG).first().innerText();
  for (const alias of aliases) {
    if (!text.includes(alias)) throw new Error(`dialog is missing ${alias}`);
  }
}

interface Run {
  app: ElectronApplication;
  page: Page;
  panes: Panes;
  featureId: string;
  failures: string[];
}

async function shoot(run: Run, state: State, theme: string, fn: () => Promise<void>) {
  const started = Date.now();
  try {
    await reseed(run.app, run.panes, run.featureId);
    await fn();
    if (!existsSync(outFile(state, theme))) throw new Error("PNG did not land");
    console.log(`[decisions-attention] wrote ${state}--${theme} (${Date.now() - started}ms)`);
  } catch (error) {
    rmSync(outFile(state, theme), { force: true });
    const message = `${state}--${theme}: ${String(error).split("\n")[0]}`;
    run.failures.push(message);
    console.warn(`[decisions-attention] FAILED ${message}`);
  } finally {
    await closeLayers(run.page);
  }
}

function expectedFiles(): string[] {
  const out: string[] = [];
  for (const s of THEMED_STATES) for (const t of THEMES) out.push(`${s}--${t}.png`);
  if (THEMES.includes("daintree")) for (const s of DAINTREE_STATES) out.push(`${s}--daintree.png`);
  return out.sort();
}

async function ready(page: Page, panes: Panes): Promise<void> {
  await focusPane(page, panes.other);
  await parkPointer(page);
  await expect
    .poll(
      () =>
        page
          .locator(`[data-panel-id="${panes.asker}"][data-panel-location="grid"] ${CHIP}`)
          .count(),
      { timeout: 15_000, message: "chip on the asking pane" }
    )
    .toBe(1);
  await settle(page, 400);
}

async function themedStates(run: Run, theme: string): Promise<void> {
  const { page, panes } = run;
  await shoot(run, "dialog", theme, async () => {
    await ready(page, panes);
    await openFromChip(page, panes);
    await expectItems(page, ["q-36", "q-38", "q-39", "q-40"]);
    // The list from its top, nothing focused inside it.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await snapLayers(page, "dialog", theme, [DIALOG]);
  });
}

async function daintreeStates(run: Run): Promise<void> {
  const { page, panes } = run;
  const theme = "daintree";
  await shoot(run, "dialog-end", theme, async () => {
    await ready(page, panes);
    await openFromChip(page, panes);
    await expectItems(page, ["q-36", "q-38", "q-39", "q-40"]);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    // The list scrolled to its end: the last answers, and how the dialog ends.
    await page
      .locator(`${DIALOG} [data-testid="decisions-attention-item"]`)
      .last()
      .scrollIntoViewIfNeeded();
    await snapLayers(page, "dialog-end", theme, [DIALOG]);
  });
  await shoot(run, "full-answer", theme, async () => {
    await ready(page, panes);
    await openFromChip(page, panes);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.getByRole("button", { name: "Show full answer" }).first().click();
    await expect(page.getByRole("button", { name: "Show less" })).toBeVisible();
    await parkPointer(page);
    await snapLayers(page, "full-answer", theme, [DIALOG]);
  });
  await shoot(run, "resume-pending", theme, async () => {
    await ready(page, panes);
    await openFromChip(page, panes);
    await page.getByRole("button", { name: "Try resume for q-38" }).click();
    await expect(page.locator(DIALOG)).toContainText("Still working", { timeout: 8000 });
    await parkPointer(page);
    await snapLayers(page, "resume-pending", theme, [DIALOG]);
    // Let the resume finish before the next frame reseeds the table.
    await expect(page.locator('[data-testid="decisions-attention-outcome"]')).toBeVisible({
      timeout: 10_000,
    });
  });
  await shoot(run, "chip-popover", theme, async () => {
    await ready(page, panes);
    await openPopover(page, panes.asker);
    await expect(page.locator('[data-testid="terminal-decisions-review"]')).toBeVisible();
    const pane = await paneBox(page, panes.asker);
    const pop = await page.locator(POPOVER).first().boundingBox();
    if (!pop) throw new Error("popover not on screen");
    await settle(page);
    const x0 = Math.max(0, Math.min(pane.x, pop.x) - 8);
    const x1 = Math.max(pane.x + pane.width, pop.x + pop.width) + 8;
    const y1 = Math.max(pane.y + 240, pop.y + pop.height + 12);
    await page.screenshot({
      path: outFile("chip-popover", theme),
      type: "png",
      caret: "hide",
      clip: { x: x0, y: Math.max(0, pane.y - 2), width: x1 - x0, height: y1 - pane.y + 2 },
    });
  });
  await shoot(run, "from-chip", theme, async () => {
    await ready(page, panes);
    // Opened from the asking pane's chip by keyboard: its answer's first action holds the focus.
    await page
      .locator(`[data-panel-id="${panes.asker}"][data-panel-location="grid"] ${CHIP}`)
      .focus();
    await page.keyboard.press("Enter");
    await page.locator(POPOVER).waitFor({ state: "visible", timeout: 8000 });
    await page.locator('[data-testid="terminal-decisions-review"]').focus();
    await page.keyboard.press("Enter");
    await page.locator(DIALOG).waitFor({ state: "visible", timeout: 10_000 });
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? null), {
        timeout: 8000,
      })
      .toBe("Try resume for q-38");
    await snapLayers(page, "from-chip", theme, [DIALOG]);
  });
  await shoot(run, "destinations", theme, async () => {
    await ready(page, panes);
    await openFromChip(page, panes);
    await page.getByRole("button", { name: "Choose destination for q-38" }).click();
    const menu = page.locator('[role="menu"]').filter({ hasText: "Agents running here" });
    await expect(menu).toContainText(OTHER_TITLE, { timeout: 8000 });
    await parkPointer(page);
    await snapLayers(page, "destinations", theme, [DIALOG, '[role="menu"]']);
  });
  await shoot(run, "confirm-move", theme, async () => {
    await ready(page, panes);
    await openFromChip(page, panes);
    await page.getByRole("button", { name: "Choose destination for q-36" }).click();
    const menu = page.locator('[role="menu"]').filter({ hasText: "Agents running here" });
    await menu.getByText(OTHER_TITLE).click();
    const confirm = page
      .locator('[role="dialog"], [role="alertdialog"]')
      .filter({ hasText: "Send answer" });
    await confirm.first().waitFor({ state: "visible", timeout: 8000 });
    await parkPointer(page);
    await settle(page, 400);
    await page.screenshot({ path: outFile("confirm-move", theme), type: "png", caret: "hide" });
    await page.keyboard.press("Escape");
  });
  await shoot(run, "resume-outcome", theme, async () => {
    await ready(page, panes);
    await openFromChip(page, panes);
    await page.getByRole("button", { name: "Try resume for q-38" }).click();
    await expect(page.locator('[data-testid="decisions-attention-outcome"]')).toContainText(
      "still needs attention",
      { timeout: 15_000 }
    );
    await expect(page.locator(DIALOG)).toContainText("didn't reach its prompt in time");
    await parkPointer(page);
    await snapLayers(page, "resume-outcome", theme, [DIALOG]);
  });
  await shoot(run, "handled-focus", theme, async () => {
    await ready(page, panes);
    await openFromChip(page, panes);
    const handled = page.getByRole("button", { name: "Mark q-36 handled" });
    await handled.focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Enter");
    await expect(page.locator('[data-testid="decisions-attention-outcome"]')).toContainText(
      "marked handled",
      { timeout: 8000 }
    );
    await expect
      .poll(() => page.locator(`${DIALOG} [data-testid="decisions-attention-item"]`).count())
      .toBe(3);
    const focused = await page.evaluate(
      () => document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.tagName
    );
    if (focused !== "Try resume for q-38") throw new Error(`focus landed on ${focused}`);
    await snapLayers(page, "handled-focus", theme, [DIALOG]);
  });
  await shoot(run, "empty", theme, async () => {
    await ready(page, panes);
    await openFromChip(page, panes);
    for (const alias of ["q-36", "q-38", "q-39", "q-40"]) {
      await page.getByRole("button", { name: `Mark ${alias} handled` }).click();
      await expect(page.getByRole("button", { name: `Mark ${alias} handled` })).toHaveCount(0, {
        timeout: 8000,
      });
    }
    await expect(page.locator(DIALOG)).toContainText("Nothing needs attention");
    await parkPointer(page);
    await snapLayers(page, "empty", theme, [DIALOG]);
  });
  await shoot(run, "settings-row", theme, async () => {
    await ready(page, panes);
    await page.evaluate(() => {
      window.dispatchEvent(
        new CustomEvent("daintree:open-settings-tab", { detail: { tab: "decisions" } })
      );
    });
    await page.locator(SETTINGS).waitFor({ state: "visible", timeout: 20_000 });
    const row = page.locator(`${SETTINGS_PANEL} #decisions-questions`);
    await expect(row).toContainText("4 answers", { timeout: 10_000 });
    await page.evaluate((sel) => {
      const el = document.querySelector<HTMLElement>(sel);
      let scroller = el?.parentElement ?? null;
      while (scroller) {
        const oy = getComputedStyle(scroller).overflowY;
        if ((oy === "auto" || oy === "scroll") && scroller.clientHeight > 0) break;
        scroller = scroller.parentElement;
      }
      if (!el || !scroller) throw new Error("no scroller above the Questions section");
      scroller.scrollTop +=
        el.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 120;
    }, `${SETTINGS_PANEL} #decisions-questions`);
    await parkPointer(page);
    await settle(page, 400);
    await page
      .locator(`${SETTINGS} > div`)
      .first()
      .screenshot({ path: outFile("settings-row", theme), type: "png", caret: "hide" });
  });
}

test("capture the Decisions needs-attention list across states and themes", async () => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_DECISIONS_ATTENTION is required for the needs-attention capture",
  });
  test.skip(!ENABLED, "design capture harness — set DAINTREE_SHOT_DECISIONS_ATTENTION=1");
  if (!OUTPUT_DIR)
    throw new Error("DESIGN_CAPTURE_DIR must be set to a directory outside the repo");
  test.setTimeout(20 * 60_000);

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const repoRoot = realpathSync(process.cwd());
  const outReal = realpathSync(OUTPUT_DIR);
  if (outReal === repoRoot || outReal.startsWith(repoRoot + path.sep)) {
    throw new Error(`DESIGN_CAPTURE_DIR must be outside the repo (${OUTPUT_DIR})`);
  }
  for (const file of readdirSync(OUTPUT_DIR)) {
    if (STATES.some((s) => file.startsWith(`${s}--`)))
      rmSync(path.join(OUTPUT_DIR, file), { force: true });
  }

  const repo = createRepo();
  const binDir = installFakeAgent(repo.dir, { perPane: true, streamLinesPerSec: 8 });
  const userDataDir = mkdtempSync(path.join(tmpdir(), "dattshot-ud-"));
  let ctx: AppContext | undefined;
  const failures: string[] = [];
  try {
    ctx = await launchApp({
      headed: false,
      userDataDir,
      screenshotScale: SCALE,
      windowSize: WINDOW,
      env: fakeAgentEnv(binDir),
      extraArgs: ["--disable-gpu", "--in-process-gpu", "--disable-breakpad", "--noerrdialogs"],
    });
    const { app } = ctx;
    const page = await openAndOnboardProject(app, ctx.window, repo.dir, PROJECT);
    await dismissBlockingPalette(page);
    await page.locator(SEL.worktree.mainCard).waitFor({ state: "visible", timeout: T_LONG });
    await setWindowSize(app, page, WINDOW);
    await polish(page);

    const featureId = await worktreeIdFor(page, WT_FEATURE);
    await act(page, "worktree.select", { worktreeId: featureId });
    await settle(page, 1500);
    const panes: Panes = {
      asker: await launchAgent(page, binDir, featureId),
      other: await launchAgent(page, binDir, featureId),
    };
    await act(page, "terminal.rename", { terminalId: panes.asker, name: ASKER_TITLE });
    await act(page, "terminal.rename", { terminalId: panes.other, name: OTHER_TITLE });
    console.log(`[decisions-attention] panes ${JSON.stringify(panes)}`);

    await answerDecisions(app);
    await setStatus(app, "connected");
    await seedChip(app, panes);

    const run: Run = { app, page, panes, featureId, failures };
    const order = [
      ...THEMES.filter((t) => t !== "daintree"),
      ...THEMES.filter((t) => t === "daintree"),
    ];
    for (const theme of order) {
      await switchTheme(page, theme).catch((e) => failures.push(`${theme}: ${String(e)}`));
      await themedStates(run, theme);
    }
    if (THEMES.includes("daintree")) await daintreeStates(run);

    const expected = expectedFiles();
    const present = readdirSync(OUTPUT_DIR)
      .filter((f) => STATES.some((s) => f.startsWith(`${s}--`)))
      .sort();
    const missing = expected.filter((f) => !present.includes(f));
    console.log(
      `[decisions-attention] wrote ${present.length}/${expected.length} PNGs to ${OUTPUT_DIR}`
    );
    expect(failures, "state captures failed").toEqual([]);
    expect(missing, "files missing from the output directory").toEqual([]);
  } finally {
    if (ctx?.app) await closeApp(ctx.app).catch(() => {});
    repo.cleanup();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
