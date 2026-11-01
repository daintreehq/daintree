/**
 * Terminal canvas review: the grid and everything inside a pane below its
 * title bar, under the load it carries all day.
 *
 * The question the captures answer is whether, with four to eight agents
 * running, you can tell at a glance which pane is focused, which is working,
 * which is waiting on you and which has failed. So the grid is built from real
 * agent states, not mocks: the fake Claude CLI's heartbeat makes `working`, a
 * question line settles a `question` wait, a cost line settles a hand-back
 * wait, and an `API Error: 529 Overloaded` line settles an `error` wait (the
 * blocked state). A shell that runs `exit 3` gives the exit-error banner and a
 * shell opened at a missing directory gives the spawn error. The banners with
 * no cheap real trigger (a lost reconnect, a restart in flight, a resume offer)
 * are written into the pane's store record through the E2E backdoor's
 * `patchPanel`, which is the record the pane renders from.
 *
 *   DAINTREE_SHOT_TERMINAL_CANVAS=1 DESIGN_CAPTURE_DIR=/abs/dir \
 *     ./node_modules/.bin/playwright test --project=screenshots terminal-canvas-review --workers=1
 *
 * Env knobs:
 *   DAINTREE_SHOT_TERMINAL_CANVAS  required — any truthy value runs the capture
 *   DESIGN_CAPTURE_DIR             required — output directory (never the repo)
 *   DAINTREE_SHOT_THEMES           comma-separated theme ids (default daintree,bondi,namib)
 *   DAINTREE_SHOT_ONLY             comma-separated state filter (see STATES)
 *
 * Output: <dir>/<state>--<theme>.png plus a .json sidecar per frame recording
 * every grid pane's id, agent state, waiting reason, frame class, focus and the
 * banners it shows. Each frame is verified after its settle and before it is
 * written, and the run fails if any expected file is missing.
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
import { injectGridNotification, backdateNotification } from "../helpers/notifications";
import {
  installFakeAgent,
  fakeAgentEnv,
  ptyWrite,
  readFakeAgentLaunchLog,
  sendFakeAgentCommand,
  FAKE_AGENT_READY,
} from "../helpers/fakeAgent";
import { getGridPanelIds } from "../helpers/panels";
import { getTerminalTextById } from "../helpers/terminal";
import { SEL } from "../helpers/selectors";
import { T_LONG } from "../helpers/timeouts";

const ENABLED = !!process.env.DAINTREE_SHOT_TERMINAL_CANVAS;
const OUTPUT_DIR = process.env.DESIGN_CAPTURE_DIR
  ? path.resolve(process.env.DESIGN_CAPTURE_DIR)
  : "";
const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi,namib")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);
const ONLY = (process.env.DAINTREE_SHOT_ONLY ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const THEMED_STATES = ["grid4", "grid8", "stack", "ansi"] as const;
const DAINTREE_STATES = [
  "grid4-window",
  "grid4-highlights",
  "grid4-gridbar",
  "focus-waiting",
  "banner-sheet",
  "scroll",
  "split",
] as const;
type State = (typeof THEMED_STATES)[number] | (typeof DAINTREE_STATES)[number];
const STATES: readonly State[] = [...THEMED_STATES, ...DAINTREE_STATES];

const QUAD = { width: 1600, height: 1000 };
const WALL = { width: 2400, height: 1350 };
const PROJECT = "helios";
const WT_FEATURE = "feature/auth-token-refresh";
const WT_CHORE = "chore/ci-cache-warmup";
const WORKING_TITLE = "fix flaky auth token refresh tests";
const QUESTION_LINE = "Should I also regenerate the refresh-token fixtures?";
const COMPLETION_LINE = "Total cost: $0.42";
const BLOCKED_LINE = "API Error: 529 Overloaded";
const MISSING_DIR = "/tmp/helios-deleted-worktree/src";
const POLISH_ID = "pw-terminal-canvas-polish";
const POLISH_CSS = `
  *, *::before, *::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
    caret-color: transparent !important;
  }
`;

// Each line exercises one ANSI slot as an agent would use it: SGR 30-37 then
// 90-97, dim (2) and bold (1), then a diff hunk and a status line.
const ANSI_SCRIPT = [
  "clear",
  `printf '\\033[1mANSI palette\\033[0m on the terminal background\\n'`,
  `for i in 0 1 2 3 4 5 6 7; do n=$(echo black red green yellow blue magenta cyan white | cut -d' ' -f$((i+1))); printf "\\033[3\${i}m%-8s\\033[0m \\033[9\${i}mbright-%-8s\\033[0m \\033[2;3\${i}mdim\\033[0m\\n" $n $n; done`,
  `printf '\\033[2mdim default: Read 42 lines from src/auth/tokenRefresh.ts\\033[0m\\n'`,
  `printf '\\033[32m+  const skew = REFRESH_SKEW_MS;\\033[0m\\n\\033[31m-  const skew = 30000;\\033[0m\\n'`,
  `printf '\\033[90m  ⎿  Ran 128 tests in 4.2s\\033[0m  \\033[33m⚠ 2 skipped\\033[0m  \\033[34mhttps://ci.helios.dev/run/4812\\033[0m\\n'`,
].join("; ");

function git(cmd: string, cwd: string): void {
  execSync(`git ${cmd}`, { cwd, stdio: "ignore" });
}

/** Own prefix: the shared e2e temp reaper never touches it. */
function createRepo(): { dir: string; featureDir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "tcshot-helios-"));
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
  const dirs: Record<string, string> = {};
  for (const branch of [WT_FEATURE, WT_CHORE]) {
    git(`branch ${branch}`, dir);
    const wt = path.join(wtRoot, branch.replace(/\//g, "-"));
    git(`worktree add ${JSON.stringify(wt)} ${branch}`, dir);
    dirs[branch] = wt;
  }
  // Uncommitted work in the feature worktree, so a finished agent there has
  // changes to hand back.
  const fwt = dirs[WT_FEATURE]!;
  writeFileSync(
    path.join(fwt, "src", "auth", "tokenRefresh.ts"),
    "export const REFRESH_SKEW_MS = 45_000;\n"
  );
  writeFileSync(path.join(fwt, "src", "auth", "refresh.test.ts"), "// regenerated fixtures\n");
  writeFileSync(path.join(fwt, "README.md"), "# Helios\n\nOperational dashboard.\n\nAuth notes.\n");
  return {
    dir,
    featureDir: fwt,
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

async function patchPanel(
  page: Page,
  panelId: string,
  patch: Record<string, unknown>
): Promise<void> {
  const ok = await page.evaluate(
    ({ id, p }) => {
      const api = (
        window as unknown as {
          __daintreeNotificationsE2E?: {
            patchPanel: (id: string, p: Record<string, unknown>) => boolean;
          };
        }
      ).__daintreeNotificationsE2E;
      return api?.patchPanel(id, p) ?? false;
    },
    { id: panelId, p: patch }
  );
  if (!ok) throw new Error(`patchPanel(${panelId}) failed`);
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
// Sidecar: what each grid pane shows

interface PaneReport {
  panelId: string;
  agentState: string | null;
  frameClass: string;
  focused: boolean;
  exited: boolean;
  rect: { x: number; y: number; width: number; height: number };
  banners: Array<{ text: string; severityGlyph: boolean; role: string | null }>;
}

async function readPanes(page: Page): Promise<PaneReport[]> {
  return page.evaluate(() => {
    const frameClasses = [
      "terminal-selected",
      "panel-state-waiting",
      "panel-state-working",
      "panel-state-hibernated",
      "panel-state-arming",
      "panel-state-blocked",
      "panel-state-failed",
    ];
    return Array.from(
      document.querySelectorAll<HTMLElement>('[data-panel-id][data-panel-location="grid"]')
    )
      .filter((el) => el.getBoundingClientRect().width > 0)
      .map((el) => {
        const r = el.getBoundingClientRect();
        return {
          panelId: el.getAttribute("data-panel-id") ?? "",
          agentState: el.getAttribute("data-agent-state"),
          frameClass: frameClasses.filter((c) => el.classList.contains(c)).join(" ") || "rest",
          focused: el.classList.contains("terminal-selected"),
          exited: el.className.includes("grayscale"),
          rect: {
            x: Math.round(r.x),
            y: Math.round(r.y),
            width: Math.round(r.width),
            height: Math.round(r.height),
          },
          banners: Array.from(el.querySelectorAll<HTMLElement>("[data-inline-status-banner]")).map(
            (b) => ({
              text: (b.innerText ?? "").replace(/\s+/g, " ").trim().slice(0, 160),
              severityGlyph: !!b.querySelector("[data-severity-glyph]"),
              role: b.getAttribute("role"),
            })
          ),
        };
      });
  });
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

async function snapGrid(page: Page, state: State, theme: string, extra = {}): Promise<void> {
  await settle(page);
  const clip = await gridBox(page);
  await page.screenshot({ path: outFile(state, theme, "png"), type: "png", caret: "hide", clip });
  await writeSidecar(page, state, theme, { crop: clip, ...extra });
}

async function snapWindow(page: Page, state: State, theme: string, extra = {}): Promise<void> {
  await settle(page);
  await page.screenshot({ path: outFile(state, theme, "png"), type: "png", caret: "hide" });
  await writeSidecar(page, state, theme, extra);
}

async function paneClip(
  page: Page,
  id: string
): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await page
    .locator(`[data-panel-id="${id}"][data-panel-location="grid"]`)
    .first()
    .boundingBox();
  if (!box || box.width < 100) throw new Error(`pane ${id} not on screen`);
  return { x: box.x - 4, y: box.y - 4, width: box.width + 8, height: box.height + 8 };
}

async function snapPane(page: Page, file: string, id: string): Promise<void> {
  await settle(page);
  const clip = await paneClip(page, id);
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
}

async function expectBanner(page: Page, id: string, text: RegExp): Promise<void> {
  await expect
    .poll(
      async () =>
        (await readPanes(page))
          .find((p) => p.panelId === id)
          ?.banners.map((b) => b.text)
          .join(" | ") ?? "",
      { timeout: 15_000, message: `pane ${id} never showed ${text}` }
    )
    .toMatch(text);
}

// ---------------------------------------------------------------------------
// Agents and shells

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

/** Ends a turn the way a real one ends: a closing line lands while busy, then the heartbeat stops. */
async function endTurn(
  page: Page,
  binDir: string,
  id: string,
  line: string,
  want: (s: PaneStatus) => boolean
): Promise<PaneStatus> {
  const trail: string[] = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    await sendFakeAgentCommand(binDir, "work", T_LONG, id);
    await page.waitForTimeout(8000);
    await sendFakeAgentCommand(binDir, "stream-off", T_LONG, id);
    if (attempt > 0) await ptyWrite(page, id, "\r".repeat(40));
    await ptyWrite(page, id, `${line}\r`);
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

async function newPanelId(page: Page, before: Set<string>): Promise<string> {
  let found: string | undefined;
  await expect
    .poll(
      async () => {
        found = (await getGridPanelIds(page)).find((id) => !before.has(id));
        return found ?? null;
      },
      { timeout: T_LONG, message: "new grid panel never appeared" }
    )
    .not.toBeNull();
  return found!;
}

async function openShell(page: Page, args: Record<string, unknown> = {}): Promise<string> {
  const before = new Set(await getGridPanelIds(page));
  await act(page, "terminal.new", args);
  return newPanelId(page, before);
}

async function waitForPrompt(page: Page, id: string): Promise<void> {
  await expect
    .poll(async () => (await getTerminalTextById(page, id)).trim().length, {
      timeout: 30_000,
      message: `shell ${id} never printed a prompt`,
    })
    .toBeGreaterThan(0);
  await page.waitForTimeout(800);
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

// ---------------------------------------------------------------------------
// The grid

interface Grid {
  binDir: string;
  featureId: string;
  choreId: string;
  working: string;
  waiting: string;
  finished: string;
  blocked: string;
  /** Filled in when the grid grows to eight. */
  exited?: string;
  idle?: string;
  spawnFailed?: string;
  reconnect?: string;
  spawnErrorPatched?: boolean;
}

async function buildQuad(page: Page, binDir: string): Promise<Grid> {
  const featureId = await worktreeIdFor(page, WT_FEATURE);
  const choreId = await worktreeIdFor(page, WT_CHORE);
  await act(page, "worktree.select", { worktreeId: featureId });
  await settle(page, 1500);

  const working = await launchAgent(page, binDir, featureId);
  const waiting = await launchAgent(page, binDir, featureId);
  const finished = await launchAgent(page, binDir, featureId);
  const blocked = await launchAgent(page, binDir, featureId);

  await act(page, "terminal.rename", { terminalId: working, name: WORKING_TITLE });
  await endTurn(page, binDir, waiting, QUESTION_LINE, (s) => s.waitingReason === "question");
  await endTurn(
    page,
    binDir,
    finished,
    COMPLETION_LINE,
    (s) => s.waitingReason === null || s.waitingReason === "prompt"
  );
  await endTurn(page, binDir, blocked, BLOCKED_LINE, (s) => s.waitingReason === "error");
  await sendFakeAgentCommand(binDir, "work", T_LONG, working);
  await expect
    .poll(async () => (await paneStatus(page, working)).agentState, { timeout: 60_000 })
    .toBe("working");
  return { binDir, featureId, choreId, working, waiting, finished, blocked };
}

async function growToEight(page: Page, grid: Grid): Promise<void> {
  // A shell that exits non-zero: the exit-error banner and the receded body.
  const exited = await openShell(page);
  await waitForPrompt(page, exited);
  await ptyWrite(page, exited, "exit 3\r");
  await expectBanner(page, exited, /exited with code 3|code 3/i);
  console.log(
    `[terminal-canvas] exited ${JSON.stringify((await readPanes(page)).find((p) => p.panelId === exited))}`
  );

  // An idle shell that has printed the ANSI sheet — the palette state reads off it.
  const idle = await openShell(page);
  await waitForPrompt(page, idle);
  await ptyWrite(page, idle, `${ANSI_SCRIPT}\r`);
  await expect
    .poll(() => getTerminalTextById(page, idle), { timeout: 15_000 })
    .toContain("ci.helios.dev");

  // A shell whose launch failed. `terminal.new` at a missing directory falls
  // back to the worktree root rather than failing, so the spawn error the
  // pty host would report is written into the pane's record.
  const spawnFailed = await openShell(page);
  await waitForPrompt(page, spawnFailed);
  const spawnErrorPatched = true;
  // A session whose reconnect after an app restart failed.
  const reconnect = await openShell(page);
  await waitForPrompt(page, reconnect);
  await applyFailures(page, { spawnFailed, reconnect });
  await expectBanner(page, reconnect, /Reconnection failed/);
  console.log(`[terminal-canvas] eight ${JSON.stringify(await readPanes(page))}`);

  Object.assign(grid, { exited, idle, spawnFailed, reconnect, spawnErrorPatched });
}

const SPAWN_ERROR = {
  code: "ENOTDIR",
  message: `spawn /bin/zsh ENOTDIR: cwd ${MISSING_DIR} is not a directory`,
  path: MISSING_DIR,
  syscall: "spawn",
};

/**
 * The pane's exit lives in its component state, which a theme switch remounts
 * away, so a pane that has forgotten its exit is restarted and exited again.
 */
async function ensureExited(page: Page, id: string): Promise<void> {
  const shows = async () =>
    ((await readPanes(page)).find((p) => p.panelId === id)?.banners ?? []).some((b) =>
      /code 3/.test(b.text)
    );
  if (await shows()) return;
  await act(page, "terminal.restart", { terminalId: id });
  await page.waitForTimeout(1500);
  await waitForPrompt(page, id);
  await ptyWrite(page, id, "exit 3\r");
  await expectBanner(page, id, /code 3/);
}

/** The host-side failures, re-applied before each frame: a store resync drops them. */
async function applyFailures(
  page: Page,
  ids: { spawnFailed?: string; reconnect?: string; exited?: string }
): Promise<void> {
  if (ids.exited) await ensureExited(page, ids.exited);
  if (ids.spawnFailed) {
    await patchPanel(page, ids.spawnFailed, {
      spawnError: SPAWN_ERROR,
      spawnStatus: "failed",
      cwd: MISSING_DIR,
    });
  }
  if (ids.reconnect) {
    await patchPanel(page, ids.reconnect, {
      reconnectError: {
        type: "error",
        message: "The PTY host restarted and session pty-7f3a was not in its registry.",
        timestamp: Date.now(),
      },
    });
  }
}

async function verifyGrid(page: Page, grid: Grid, count: 4 | 8, focused: string): Promise<void> {
  const panes = await readPanes(page);
  if (panes.length !== count) {
    throw new Error(`grid shows ${panes.length} panes, expected ${count}`);
  }
  const byId = new Map(panes.map((p) => [p.panelId, p]));
  const expectState = async (id: string, state: string, reason?: string | null) => {
    const shown = byId.get(id)?.agentState;
    if (shown !== state) throw new Error(`pane ${id} shows ${shown}, expected ${state}`);
    if (reason !== undefined) {
      const s = await paneStatus(page, id);
      if (s.waitingReason !== reason && !(reason === null && s.waitingReason === "prompt")) {
        throw new Error(`pane ${id} waits for ${s.waitingReason}, expected ${reason}`);
      }
    }
  };
  await expectState(grid.working, "working");
  await expectState(grid.waiting, "waiting", "question");
  await expectState(grid.blocked, "waiting", "error");
  const done = await paneStatus(page, grid.finished);
  if (
    done.agentState !== "waiting" ||
    (done.waitingReason !== null && done.waitingReason !== "prompt")
  ) {
    throw new Error(`finished pane is ${JSON.stringify(done)}`);
  }
  if (count === 8) {
    for (const id of [grid.exited!, grid.spawnFailed!, grid.reconnect!]) {
      if (!byId.get(id)?.banners.length) throw new Error(`pane ${id} lost its banner`);
    }
  }
  const chrome = panes.filter((p) => p.focused).map((p) => p.panelId);
  if (chrome.join() !== focused) {
    throw new Error(`focus chrome on ${JSON.stringify(chrome)}, expected ${focused}`);
  }
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

async function setHighlights(page: Page, show: boolean): Promise<void> {
  await act(page, "preferences.showGridAgentHighlights.set", { show });
  await settle(page, 600);
}

// ---------------------------------------------------------------------------
// States

interface Run {
  app: ElectronApplication;
  page: Page;
  grid: Grid;
  failures: string[];
  written: string[];
}

function wanted(state: State): boolean {
  return ONLY.length === 0 || ONLY.includes(state);
}

async function shoot(
  run: Run,
  state: State,
  theme: string,
  fn: () => Promise<void>
): Promise<void> {
  if (!wanted(state)) return;
  const started = Date.now();
  try {
    await fn();
    if (!existsSync(outFile(state, theme, "png"))) throw new Error("PNG did not land");
    run.written.push(`${state}--${theme}`);
    console.log(`[terminal-canvas] wrote ${state}--${theme} (${Date.now() - started}ms)`);
  } catch (error) {
    rmSync(outFile(state, theme, "png"), { force: true });
    rmSync(outFile(state, theme, "json"), { force: true });
    const message = `${state}--${theme}: ${String(error).split("\n")[0]}`;
    run.failures.push(message);
    console.warn(`[terminal-canvas] FAILED ${message}`);
  }
}

const STACK_PATCH = {
  scrollbackRestoreError: {
    type: "parse",
    message: "Saved scrollback for this session could not be parsed and was skipped.",
    timestamp: Date.now(),
  },
  sessionLostOnRestore: "sibling-owns-session-id",
};
const STACK_CLEAR = { scrollbackRestoreError: undefined, sessionLostOnRestore: undefined };

async function quadStates(run: Run, theme: string): Promise<void> {
  const { page, grid } = run;
  await shoot(run, "grid4", theme, async () => {
    await readyGrid(page, grid.working);
    await verifyGrid(page, grid, 4, grid.working);
    await snapGrid(page, "grid4", theme);
  });
}

async function quadDaintreeStates(run: Run): Promise<void> {
  const { page, grid } = run;
  const theme = "daintree";
  await shoot(run, "grid4-window", theme, async () => {
    await readyGrid(page, grid.working);
    await verifyGrid(page, grid, 4, grid.working);
    await snapWindow(page, "grid4-window", theme);
  });
  await shoot(run, "focus-waiting", theme, async () => {
    await readyGrid(page, grid.waiting);
    await verifyGrid(page, grid, 4, grid.waiting);
    await snapGrid(page, "focus-waiting", theme);
  });
  await shoot(run, "grid4-highlights", theme, async () => {
    await setHighlights(page, true);
    try {
      // Focus off the working pane, or its focus frame hides the working edge.
      await readyGrid(page, grid.waiting);
      await verifyGrid(page, grid, 4, grid.waiting);
      await snapGrid(page, "grid4-highlights", theme);
    } finally {
      await setHighlights(page, false);
    }
  });
  await shoot(run, "grid4-gridbar", theme, async () => {
    // The real emitter's copy and actions (useAgentWaitingNudge).
    const id = await injectGridNotification(page, {
      type: "info",
      title: "Agent waiting for input",
      message:
        "Your agent is waiting for input. Enable notifications to get alerted when this happens.",
      actions: [
        { label: "Enable notifications", variant: "primary" },
        { label: "No thanks", variant: "secondary" },
      ],
    });
    await backdateNotification(page, id, 60_000).catch(() => {});
    await readyGrid(page, grid.working);
    await verifyGrid(page, grid, 4, grid.working);
    await expect(
      page.locator('[data-testid="grid-notification-bar"]').first(),
      "grid bar never rendered"
    ).toBeVisible({ timeout: 10_000 });
    await snapGrid(page, "grid4-gridbar", theme);
    await page.evaluate(() =>
      (
        window as unknown as { __daintreeNotificationsE2E?: { resetToasts: () => void } }
      ).__daintreeNotificationsE2E?.resetToasts()
    );
  });
}

async function wallStates(run: Run, theme: string): Promise<void> {
  const { page, grid } = run;
  await shoot(run, "grid8", theme, async () => {
    await applyFailures(page, grid);
    await readyGrid(page, grid.working);
    await verifyGrid(page, grid, 8, grid.working);
    await snapGrid(page, "grid8", theme, { spawnErrorPatched: grid.spawnErrorPatched });
  });
  await shoot(run, "ansi", theme, async () => {
    await readyGrid(page, grid.working);
    await snapPane(page, outFile("ansi", theme, "png"), grid.idle!);
    await writeSidecar(page, "ansi", theme, { pane: grid.idle });
  });
  await shoot(run, "stack", theme, async () => {
    await patchPanel(page, grid.finished, { ...STACK_PATCH, agentState: "completed" });
    try {
      await readyGrid(page, grid.working);
      await expectBanner(page, grid.finished, /scrollback/i);
      await expectBanner(page, grid.finished, /review when ready/i);
      await snapPane(page, outFile("stack", theme, "png"), grid.finished);
      await writeSidecar(page, "stack", theme, { pane: grid.finished });
    } finally {
      await patchPanel(page, grid.finished, { ...STACK_CLEAR, agentState: "waiting" });
    }
  });
}

/** One banner per pane, cropped and tiled: the catalogue of what a pane can raise. */
async function bannerSheet(run: Run): Promise<void> {
  const { page, grid } = run;
  await shoot(run, "banner-sheet", "daintree", async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "tcshot-sheet-"));
    try {
      await readyGrid(page, grid.working);
      const tiles: string[] = [];
      const tile = async (name: string, id: string) => {
        const f = path.join(tmp, `${tiles.length}-${name}.png`);
        await snapPane(page, f, id);
        tiles.push(f);
      };
      await applyFailures(page, grid);
      await settle(page, 600);
      await tile("spawn-error", grid.spawnFailed!);
      await tile("reconnect-error", grid.reconnect!);
      await tile("exit-error", grid.exited!);
      await patchPanel(page, grid.blocked, { isRestarting: true });
      await expectBanner(page, grid.blocked, /restart/i);
      await tile("restarting", grid.blocked);
      await patchPanel(page, grid.blocked, { isRestarting: false });
      await patchPanel(page, grid.waiting, {
        reconnectError: { type: "timeout", message: "Timed out after 10s", timestamp: Date.now() },
      });
      await expectBanner(page, grid.waiting, /timed out/i);
      await tile("reconnect-timeout", grid.waiting);
      await patchPanel(page, grid.waiting, { reconnectError: undefined });
      await patchPanel(page, grid.finished, { agentState: "completed" });
      await expectBanner(page, grid.finished, /review when ready/i);
      await tile("completion", grid.finished);
      await patchPanel(page, grid.finished, { agentState: "waiting" });
      execFileSync("magick", [
        "montage",
        ...tiles,
        "-tile",
        "3x2",
        "-geometry",
        "+8+8",
        "-background",
        "#7f7f7f",
        "-font",
        "/System/Library/Fonts/Menlo.ttc",
        outFile("banner-sheet", "daintree", "png"),
      ]);
      await writeSidecar(page, "banner-sheet", "daintree", {
        tiles: tiles.map((t) => path.basename(t)),
      });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
}

function expectedFiles(): string[] {
  const out: string[] = [];
  for (const s of THEMED_STATES) {
    if (!wanted(s)) continue;
    for (const t of THEMES) out.push(`${s}--${t}.png`, `${s}--${t}.json`);
  }
  if (THEMES.includes("daintree")) {
    for (const s of DAINTREE_STATES) {
      if (wanted(s)) out.push(`${s}--daintree.png`, `${s}--daintree.json`);
    }
  }
  return out.sort();
}

test("capture the terminal canvas across states and themes", async () => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_TERMINAL_CANVAS is required for the terminal canvas capture",
  });
  test.skip(!ENABLED, "design capture harness — set DAINTREE_SHOT_TERMINAL_CANVAS=1");
  if (!OUTPUT_DIR)
    throw new Error("DESIGN_CAPTURE_DIR must be set to a directory outside the repo");
  test.setTimeout(60 * 60_000);

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
  const userDataDir = mkdtempSync(path.join(tmpdir(), "tcshot-ud-"));
  let ctx: AppContext | undefined;
  const failures: string[] = [];
  const written: string[] = [];
  try {
    // Background windows: invisible, click-through, never activated, so a
    // capture never takes over the screen. An explicit size also keeps the
    // launch helper off its maximize path. Nothing here may fullscreen,
    // maximize, show or focus a window.
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
    console.log(`[terminal-canvas] quad ${JSON.stringify(grid)}`);
    const run: Run = { app: ctx.app, page, grid, failures, written };

    // The daintree pass runs last in each phase so the run ends on the default theme.
    const order = [
      ...THEMES.filter((t) => t !== "daintree"),
      ...THEMES.filter((t) => t === "daintree"),
    ];
    for (const theme of order) {
      await switchTheme(page, theme).catch((e) => failures.push(`${theme}: ${String(e)}`));
      await quadStates(run, theme);
    }
    if (THEMES.includes("daintree")) await quadDaintreeStates(run);

    await growToEight(page, grid);
    console.log(`[terminal-canvas] wall ${JSON.stringify(grid)}`);
    await setWindowSize(ctx.app, page, WALL);
    console.log(`[terminal-canvas] after resize ${JSON.stringify(await readPanes(page))}`);
    for (const theme of order) {
      await switchTheme(page, theme).catch((e) => failures.push(`${theme}: ${String(e)}`));
      await wallStates(run, theme);
    }
    if (THEMES.includes("daintree")) {
      await bannerSheet(run);
      await setWindowSize(ctx.app, page, QUAD);
      await shoot(run, "scroll", "daintree", async () => {
        await readyGrid(page, grid.working);
        const scrolls = await page.evaluate(() => {
          const g = document.getElementById("panel-grid");
          return !!g && g.scrollHeight > g.clientHeight + 4;
        });
        if (!scrolls)
          throw new Error("eight panes at 1600x1000 did not put the grid in scroll mode");
        await snapGrid(page, "scroll", "daintree");
      });
      await shoot(run, "split", "daintree", async () => {
        await act(page, "worktree.select", { worktreeId: grid.choreId });
        await settle(page, 1500);
        const a = await launchAgent(page, binDir, grid.choreId);
        const b = await openShell(page);
        await waitForPrompt(page, b);
        await sendFakeAgentCommand(binDir, "work", T_LONG, a);
        await expect
          .poll(() => page.evaluate(() => !!document.querySelector('[data-split-mode="true"]')), {
            timeout: 10_000,
            message: "two panes did not lay out as a split",
          })
          .toBe(true);
        await readyGrid(page, a);
        await snapGrid(page, "split", "daintree");
      });
    }

    const expected = expectedFiles();
    const present = readdirSync(OUTPUT_DIR)
      .filter((f) => STATES.some((s) => f.startsWith(`${s}--`)))
      .sort();
    const missing = expected.filter((f) => !present.includes(f));
    console.log(
      `[terminal-canvas] wrote ${present.filter((f) => f.endsWith(".png")).length}/${expected.filter((f) => f.endsWith(".png")).length} PNGs to ${OUTPUT_DIR}`
    );
    expect(failures, "state captures failed").toEqual([]);
    expect(missing, "files missing from the output directory").toEqual([]);
  } finally {
    if (ctx?.app) await closeApp(ctx.app).catch(() => {});
    repo.cleanup();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
