/**
 * Canopy pane offer review: the offer an agent pane makes while its agent is
 * stopped on a question or an approval and Canopy is off (#16061).
 *
 * The grid is built from real agent states: the fake Claude CLI's heartbeat
 * makes `working`, a question line settles a `question` wait, an approval
 * dialog's rows settle an `approval` wait and a cost line settles a hand-back.
 * Canopy starts off in a fresh profile, so the offer is the app's own. The
 * remote copy names a host through the E2E backdoor's `setHostName`, the
 * field a remote window's hydrate sets. Turning Canopy on is pressed for real
 * and runs last, since nothing in the run turns it off again.
 *
 *   DAINTREE_SHOT_CANOPY_PANE_OFFER=1 DESIGN_CAPTURE_DIR=/abs/dir \
 *     ./node_modules/.bin/playwright test --project=screenshots canopy-pane-offer-review --workers=1
 *
 * Env knobs:
 *   DAINTREE_SHOT_CANOPY_PANE_OFFER  required — any truthy value runs the capture
 *   DESIGN_CAPTURE_DIR               required — output directory (never the repo)
 *   DAINTREE_SHOT_THEMES             comma-separated theme ids (default daintree,bondi,namib)
 *
 * Output: <dir>/<state>--<theme>.png plus a .json sidecar per frame recording
 * every grid pane's agent state and the offer it shows. Each frame is checked
 * after its settle and before it is written: exactly the expected pane carries
 * the offer, and the run fails if any expected file is missing.
 */

import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { execFileSync, execSync } from "child_process";
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
  sendFakeAgentCommand,
  FAKE_AGENT_READY,
} from "../helpers/fakeAgent";
import { getTerminalTextById } from "../helpers/terminal";
import { SEL } from "../helpers/selectors";
import { T_LONG } from "../helpers/timeouts";

const ENABLED = !!process.env.DAINTREE_SHOT_CANOPY_PANE_OFFER;
const OUTPUT_DIR = process.env.DESIGN_CAPTURE_DIR
  ? path.resolve(process.env.DESIGN_CAPTURE_DIR)
  : "";
const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi,namib")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

const QUAD = { width: 1600, height: 1000 };
const PROJECT = "helios";
const WT_FEATURE = "feature/auth-token-refresh";
const WORKING_TITLE = "fix flaky auth token refresh tests";
const QUESTION_LINE = "Should I also regenerate the refresh-token fixtures?";
const APPROVAL_LINES = [
  "Bash command: npm run test -- src/auth",
  "Do you want to proceed?",
  "❯ 1. Yes",
  "  2. Yes, and don't ask again for npm run test commands",
  "  3. No, and tell Claude what to do differently (esc)",
];
const COMPLETION_LINE = "Total cost: $0.42";
const REMOTE_HOST = "studio-mac";
const POLISH_ID = "pw-canopy-pane-offer-polish";
const POLISH_CSS = `
  *, *::before, *::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
    caret-color: transparent !important;
  }
`;

const THEMED_STATES = ["grid4"] as const;
const DAINTREE_STATES = [
  "window",
  "pane-question",
  "pane-focus",
  "pane-remote",
  "pane-approval",
  "pane-narrow",
  "pane-turned-on",
] as const;
type State = (typeof THEMED_STATES)[number] | (typeof DAINTREE_STATES)[number];
const STATES: readonly State[] = [...THEMED_STATES, ...DAINTREE_STATES];

function git(cmd: string, cwd: string): void {
  execSync(`git ${cmd}`, { cwd, stdio: "ignore" });
}

/** Own prefix: the shared e2e temp reaper never touches it. */
function createRepo(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "cposhot-helios-"));
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
  writeFileSync(
    path.join(wt, "src", "auth", "tokenRefresh.ts"),
    "export const REFRESH_SKEW_MS = 45_000;\n"
  );
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

async function setHostName(page: Page, hostName: string | null): Promise<void> {
  const ok = await page.evaluate((name) => {
    const api = (
      window as unknown as {
        __daintreeNotificationsE2E?: { setHostName?: (n: string | null) => void };
      }
    ).__daintreeNotificationsE2E;
    if (!api?.setHostName) return false;
    api.setHostName(name);
    return true;
  }, hostName);
  if (!ok) throw new Error("setHostName backdoor unavailable");
}

interface PaneStatus {
  agentState: string | null;
  waitingReason: string | null;
}

async function paneStatus(page: Page, id: string): Promise<PaneStatus> {
  const result = (await act(page, "terminal.getStatus", { terminalIds: [id] })) as
    | {
        terminals?: Array<{
          terminalId: string;
          agentState: string | null;
          waitingReason?: string;
        }>;
      }
    | Array<{ terminalId: string; agentState: string | null; waitingReason?: string }>;
  const rows = Array.isArray(result) ? result : (result?.terminals ?? []);
  const row = rows.find((r) => r.terminalId === id);
  return { agentState: row?.agentState ?? null, waitingReason: row?.waitingReason ?? null };
}

function outFile(state: State, theme: string, ext: "png" | "json"): string {
  return path.join(OUTPUT_DIR, `${state}--${theme}.${ext}`);
}

// ---------------------------------------------------------------------------
// What each grid pane shows

interface PaneReport {
  panelId: string;
  agentState: string | null;
  focused: boolean;
  rect: { x: number; y: number; width: number; height: number };
  offer: string | null;
  offerText: string | null;
  banners: string[];
}

async function readPanes(page: Page): Promise<PaneReport[]> {
  return page.evaluate(() =>
    Array.from(
      document.querySelectorAll<HTMLElement>('[data-panel-id][data-panel-location="grid"]')
    )
      .filter((el) => el.getBoundingClientRect().width > 0)
      .map((el) => {
        const r = el.getBoundingClientRect();
        const offer = el.querySelector<HTMLElement>("[data-canopy-pane-offer]");
        return {
          panelId: el.getAttribute("data-panel-id") ?? "",
          agentState: el.getAttribute("data-agent-state"),
          focused: el.classList.contains("terminal-selected"),
          rect: {
            x: Math.round(r.x),
            y: Math.round(r.y),
            width: Math.round(r.width),
            height: Math.round(r.height),
          },
          offer: offer?.getAttribute("data-canopy-pane-offer") ?? null,
          offerText: offer ? (offer.innerText ?? "").replace(/\s+/g, " ").trim() : null,
          banners: Array.from(el.querySelectorAll<HTMLElement>("[data-inline-status-banner]")).map(
            (b) => (b.innerText ?? "").replace(/\s+/g, " ").trim().slice(0, 200)
          ),
        };
      })
  );
}

/** Exactly `holder` shows the offer in `kind`, and no other pane shows any. */
async function expectOffer(
  page: Page,
  holder: string,
  kind: "offer" | "turned-on",
  text?: RegExp
): Promise<void> {
  let last: PaneReport[] = [];
  await expect
    .poll(
      async () => {
        last = await readPanes(page);
        const holders = last.filter((p) => p.offer !== null);
        if (holders.length !== 1) return `holders=${holders.map((p) => p.panelId).join(",")}`;
        const [only] = holders;
        if (only!.panelId !== holder) return `held by ${only!.panelId}`;
        if (only!.offer !== kind) return `kind ${only!.offer}`;
        if (text && !text.test(only!.offerText ?? "")) return `text ${only!.offerText}`;
        return "ok";
      },
      { timeout: 20_000, message: `offer not on ${holder} as ${kind}` }
    )
    .toBe("ok");
}

async function writeSidecar(
  page: Page,
  state: State,
  theme: string,
  extra: Record<string, unknown> = {}
): Promise<void> {
  const panes = await readPanes(page);
  const env = await page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
    dpr: window.devicePixelRatio,
  }));
  writeFileSync(
    outFile(state, theme, "json"),
    JSON.stringify({ state, theme, window: env, panes, ...extra }, null, 2)
  );
}

async function gridBox(
  page: Page
): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await page.locator('[role="region"][aria-label="Panels"]').first().boundingBox();
  if (!box || box.width < 200) throw new Error("panel region not on screen");
  return box;
}

async function snapGrid(page: Page, state: State, theme: string): Promise<void> {
  await settle(page);
  const clip = await gridBox(page);
  await page.screenshot({ path: outFile(state, theme, "png"), type: "png", caret: "hide", clip });
  await writeSidecar(page, state, theme, { crop: clip });
}

async function snapWindow(page: Page, state: State, theme: string): Promise<void> {
  await settle(page);
  await page.screenshot({ path: outFile(state, theme, "png"), type: "png", caret: "hide" });
  await writeSidecar(page, state, theme);
}

/** One pane, at twice the pixels so the banner's type reads. */
async function snapPane(page: Page, state: State, theme: string, id: string): Promise<void> {
  await settle(page);
  const box = await page
    .locator(`[data-panel-id="${id}"][data-panel-location="grid"]`)
    .first()
    .boundingBox();
  if (!box || box.width < 100) throw new Error(`pane ${id} not on screen`);
  const clip = { x: box.x - 4, y: box.y - 4, width: box.width + 8, height: box.height + 8 };
  const file = outFile(state, theme, "png");
  await page.screenshot({ path: file, type: "png", caret: "hide", clip });
  const dpr = await page.evaluate(() => window.devicePixelRatio);
  if (dpr < 2) {
    const width = Number(
      execFileSync("sips", ["-g", "pixelWidth", file])
        .toString()
        .match(/pixelWidth: (\d+)/)?.[1]
    );
    execFileSync("sips", ["--resampleWidth", String(width * 2), file], { stdio: "ignore" });
  }
  await writeSidecar(page, state, theme, { crop: clip, pane: id });
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

/** Ends a turn the way a real one ends: its closing lines land while busy, then the heartbeat stops. */
async function endTurn(
  page: Page,
  binDir: string,
  id: string,
  lines: readonly string[],
  want: (s: PaneStatus) => boolean
): Promise<PaneStatus> {
  const trail: string[] = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    await sendFakeAgentCommand(binDir, "work", T_LONG, id);
    await page.waitForTimeout(8000);
    await sendFakeAgentCommand(binDir, "stream-off", T_LONG, id);
    if (attempt > 0) await ptyWrite(page, id, "\r".repeat(40));
    for (const line of lines) {
      await ptyWrite(page, id, `${line}\r`);
      await page.waitForTimeout(150);
    }
    await page.waitForTimeout(800);
    await sendFakeAgentCommand(binDir, "idle", T_LONG, id);
    let last: PaneStatus = { agentState: null, waitingReason: null };
    const reached = await expect
      .poll(
        async () => {
          last = await paneStatus(page, id);
          const tag = `${last.agentState}/${last.waitingReason}`;
          if (trail[trail.length - 1] !== tag) trail.push(tag);
          return last.agentState === "waiting" && want(last);
        },
        { timeout: 90_000, intervals: [500, 1000] }
      )
      .toBe(true)
      .then(() => true)
      .catch(() => false);
    if (reached) return last;
  }
  throw new Error(`turn on ${id} never settled as wanted: ${trail.join(" > ")}`);
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

async function readyGrid(page: Page, focused: string): Promise<void> {
  await focusPane(page, focused);
  await page.evaluate(() => {
    const grid = document.getElementById("panel-grid");
    if (grid) grid.scrollTop = 0;
  });
  await parkPointer(page);
  await settle(page, 800);
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

interface Grid {
  binDir: string;
  working: string;
  question: string;
  finished: string;
  approval: string;
}

async function buildQuad(page: Page, binDir: string): Promise<Grid> {
  const featureId = await worktreeIdFor(page, WT_FEATURE);
  await act(page, "worktree.select", { worktreeId: featureId });
  await settle(page, 1500);

  const working = await launchAgent(page, binDir, featureId);
  const question = await launchAgent(page, binDir, featureId);
  const finished = await launchAgent(page, binDir, featureId);
  const approval = await launchAgent(page, binDir, featureId);

  await act(page, "terminal.rename", { terminalId: working, name: WORKING_TITLE });
  // The question stops first, so it is the pane that takes the offer.
  await endTurn(page, binDir, question, [QUESTION_LINE], (s) => s.waitingReason === "question");
  await expectOffer(page, question, "offer");
  await endTurn(
    page,
    binDir,
    finished,
    [COMPLETION_LINE],
    (s) => s.waitingReason === null || s.waitingReason === "prompt"
  );
  await endTurn(page, binDir, approval, APPROVAL_LINES, (s) => s.waitingReason === "approval");
  await sendFakeAgentCommand(binDir, "work", T_LONG, working);
  await expect
    .poll(async () => (await paneStatus(page, working)).agentState, { timeout: 60_000 })
    .toBe("working");
  return { binDir, working, question, finished, approval };
}

// ---------------------------------------------------------------------------
// States

interface Run {
  app: ElectronApplication;
  page: Page;
  grid: Grid;
  failures: string[];
}

async function shoot(
  run: Run,
  state: State,
  theme: string,
  fn: () => Promise<void>
): Promise<void> {
  const started = Date.now();
  try {
    await fn();
    if (!existsSync(outFile(state, theme, "png"))) throw new Error("PNG did not land");
    console.log(`[canopy-pane-offer] wrote ${state}--${theme} (${Date.now() - started}ms)`);
  } catch (error) {
    rmSync(outFile(state, theme, "png"), { force: true });
    rmSync(outFile(state, theme, "json"), { force: true });
    const message = `${state}--${theme}: ${String(error).split("\n")[0]}`;
    run.failures.push(message);
    console.warn(`[canopy-pane-offer] FAILED ${message}`);
  }
}

function expectedFiles(): string[] {
  const out: string[] = [];
  for (const s of THEMED_STATES)
    for (const t of THEMES) out.push(`${s}--${t}.png`, `${s}--${t}.json`);
  if (THEMES.includes("daintree")) {
    for (const s of DAINTREE_STATES) out.push(`${s}--daintree.png`, `${s}--daintree.json`);
  }
  return out.sort();
}

async function daintreeStates(run: Run): Promise<void> {
  const { page, grid } = run;
  const theme = "daintree";
  await shoot(run, "window", theme, async () => {
    await readyGrid(page, grid.working);
    await expectOffer(page, grid.question, "offer");
    await snapWindow(page, "window", theme);
  });
  await shoot(run, "pane-question", theme, async () => {
    await readyGrid(page, grid.working);
    await expectOffer(page, grid.question, "offer", /question/);
    await snapPane(page, "pane-question", theme, grid.question);
  });
  await shoot(run, "pane-focus", theme, async () => {
    // The keyboard on the offer's button, reached from the pane by Tab.
    await readyGrid(page, grid.question);
    await expectOffer(page, grid.question, "offer");
    await page
      .locator(`[data-panel-id="${grid.question}"] [data-canopy-pane-offer] button`)
      .first()
      .focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    await snapPane(page, "pane-focus", theme, grid.question);
  });
  await shoot(run, "pane-remote", theme, async () => {
    await setHostName(page, REMOTE_HOST);
    try {
      await readyGrid(page, grid.working);
      await expectOffer(page, grid.question, "offer", new RegExp(REMOTE_HOST));
      await snapPane(page, "pane-remote", theme, grid.question);
    } finally {
      await setHostName(page, null);
    }
  });
  await shoot(run, "pane-approval", theme, async () => {
    // The question's agent moves on: the offer goes to the pane still asking.
    await sendFakeAgentCommand(grid.binDir, "work", T_LONG, grid.question);
    await expect
      .poll(async () => (await paneStatus(page, grid.question)).agentState, { timeout: 60_000 })
      .toBe("working");
    await readyGrid(page, grid.working);
    await expectOffer(page, grid.approval, "offer", /approval/);
    await snapPane(page, "pane-approval", theme, grid.approval);
  });
  await shoot(run, "pane-narrow", theme, async () => {
    // Three fixed columns at this window: panes just over the grid's 380px
    // floor, as narrow as a laptop's 2x2 gets.
    await act(page, "panel.gridLayout.setStrategy", { strategy: "fixed-columns" });
    await act(page, "panel.gridLayout.setValue", { value: 3 });
    await settle(page, 1200);
    try {
      await readyGrid(page, grid.working);
      await expectOffer(page, grid.approval, "offer");
      await page
        .locator(`[data-panel-id="${grid.approval}"][data-panel-location="grid"]`)
        .first()
        .scrollIntoViewIfNeeded();
      const width = (await readPanes(page)).find((p) => p.panelId === grid.approval)?.rect.width;
      if (!width || width > 520) throw new Error(`holder pane is ${width}px wide, not narrow`);
      await snapPane(page, "pane-narrow", theme, grid.approval);
    } finally {
      await act(page, "panel.gridLayout.setStrategy", { strategy: "automatic" });
      await settle(page, 1200);
    }
  });
  await shoot(run, "pane-turned-on", theme, async () => {
    await readyGrid(page, grid.working);
    await expectOffer(page, grid.approval, "offer");
    await page
      .locator(`[data-panel-id="${grid.approval}"] [data-canopy-pane-offer] button`, {
        hasText: "Turn on Canopy",
      })
      .first()
      .click();
    // What it says next follows the model as main reports it: on its way,
    // already here, or refused by the network the capture runs on.
    await expectOffer(page, grid.approval, "turned-on", /Canopy is on|Canopy's model/);
    await parkPointer(page);
    await snapPane(page, "pane-turned-on", theme, grid.approval);
  });
}

test("capture the Canopy pane offer across states and themes", async () => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_CANOPY_PANE_OFFER is required for the Canopy pane offer capture",
  });
  test.skip(!ENABLED, "design capture harness — set DAINTREE_SHOT_CANOPY_PANE_OFFER=1");
  if (!OUTPUT_DIR)
    throw new Error("DESIGN_CAPTURE_DIR must be set to a directory outside the repo");
  test.setTimeout(30 * 60_000);

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
  const userDataDir = mkdtempSync(path.join(tmpdir(), "cposhot-ud-"));
  let ctx: AppContext | undefined;
  const failures: string[] = [];
  try {
    // Background windows: invisible, click-through, never activated.
    ctx = await launchApp({
      headed: false,
      userDataDir,
      windowSize: QUAD,
      env: fakeAgentEnv(binDir),
      extraArgs: ["--disable-gpu", "--in-process-gpu", "--disable-breakpad", "--noerrdialogs"],
    });
    const page = await openAndOnboardProject(ctx.app, ctx.window, repo.dir, PROJECT);
    await dismissBlockingPalette(page);
    await page.locator(SEL.worktree.mainCard).waitFor({ state: "visible", timeout: T_LONG });
    await setWindowSize(ctx.app, page, QUAD);
    await polish(page);

    const grid = await buildQuad(page, binDir);
    console.log(`[canopy-pane-offer] quad ${JSON.stringify(grid)}`);
    const run: Run = { app: ctx.app, page, grid, failures };

    // The daintree pass runs last so the per-state frames run on the default theme.
    const order = [
      ...THEMES.filter((t) => t !== "daintree"),
      ...THEMES.filter((t) => t === "daintree"),
    ];
    for (const theme of order) {
      await switchTheme(page, theme).catch((e) => failures.push(`${theme}: ${String(e)}`));
      await shoot(run, "grid4", theme, async () => {
        await readyGrid(page, grid.working);
        await expectOffer(page, grid.question, "offer");
        await snapGrid(page, "grid4", theme);
      });
    }
    if (THEMES.includes("daintree")) await daintreeStates(run);

    const expected = expectedFiles();
    const present = readdirSync(OUTPUT_DIR)
      .filter((f) => STATES.some((s) => f.startsWith(`${s}--`)))
      .sort();
    const missing = expected.filter((f) => !present.includes(f));
    console.log(
      `[canopy-pane-offer] wrote ${present.filter((f) => f.endsWith(".png")).length}/${expected.filter((f) => f.endsWith(".png")).length} PNGs to ${OUTPUT_DIR}`
    );
    expect(failures, "state captures failed").toEqual([]);
    expect(missing, "files missing from the output directory").toEqual([]);
  } finally {
    if (ctx?.app) await closeApp(ctx.app).catch(() => {});
    repo.cleanup();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
