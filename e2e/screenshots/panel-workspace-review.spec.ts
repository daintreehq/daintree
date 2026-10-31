/**
 * Panel workspace review: the pane grid's chrome under a realistic load.
 *
 * Pane title bars are read side by side all day, so the review needs a busy
 * grid rather than one pane: three fake Claude panes (working under a task
 * title, waiting on a question, finished), a shell running a long command, a
 * browser pane and a three-tab terminal group, all in a second worktree of a
 * three-worktree repo. From that grid it captures the whole window at rest and
 * beside the Assistant, a squeezed 1280px window, an overflowing tab strip, a
 * hover-revealed header control, the grid with the Assistant holding the keyboard,
 * a strip of every header, the maximized pane's
 * background readout, filmstrips of the maximize and restore transitions,
 * three armed fleet panes, and (in a second launch with voice configured, a
 * fake microphone and the transcription mock) the dictation target's Mic mark.
 *
 * Agent states come from the real FSM. The fake CLI's OSC 9;4 heartbeat and
 * stream make `working`; a turn ends with a closing line echoed by the fake's
 * cooked tty, then the heartbeat stops. A question line settles to a
 * `question` wait (the amber ring); a completion line settles to a hand-back
 * wait, which the header draws finished (`completed` itself lasts 500ms).
 *
 * At 1600x1000 the automatic grid (80 columns per pane) lays six panes out two
 * wide and three deep and scrolls; whole-window shots are taken scrolled to the
 * top, crops scroll their pane into view. The worktree branch chip in the
 * header never renders for built-in panes (no pane passes `worktreeId` to
 * ContentPanel), so the sidecars record its absence rather than the run
 * requiring it.
 *
 *   DAINTREE_SHOT_PANEL_WORKSPACE=1 DESIGN_CAPTURE_DIR=/abs/dir \
 *     ./node_modules/.bin/playwright test --project=screenshots panel-workspace-review --workers=1
 *
 * Env knobs:
 *   DAINTREE_SHOT_PANEL_WORKSPACE  required — any truthy value runs the capture
 *   DESIGN_CAPTURE_DIR             required — output directory (never the repo)
 *   DAINTREE_SHOT_THEMES           comma-separated theme ids (default daintree,bondi,namib);
 *                                  the daintree-only states run when daintree is listed
 *   DAINTREE_SHOT_ONLY             comma-separated state filter (see STATES)
 *
 * Output: <dir>/<state>--<theme>.png plus a <state>--<theme>.json sidecar with
 * every visible pane header's rect, title, truncation, controls and the focus
 * owner. Each frame is verified after its settle and before it is written; the
 * run fails if any expected file is missing or an unexpected one appears.
 */

import { expect, test, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import { execFileSync, execSync } from "child_process";
import { createServer, type Server } from "http";
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
import {
  launchApp,
  closeApp,
  removeSingletonFiles,
  waitForProcessExit,
  type AppContext,
} from "../helpers/launch";
import {
  launchAppWithFakeMicrophone,
  stubNativeMicrophonePermission,
  writeWav,
} from "../helpers/fakeMicrophone";
import { createTranscriptionMock } from "../helpers/transcriptionMock";
import { openDictationTarget, seedVoiceConfig } from "../helpers/voice";
import { ensureWindowFocused } from "../helpers/focus";
import { VOICE_TOGGLE_CHORD } from "../helpers/shortcuts";
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
import { openBrowser, getGridPanelIds } from "../helpers/panels";
import { getTerminalTextById, runTerminalCommand } from "../helpers/terminal";
import { SEL } from "../helpers/selectors";
import { T_LONG, T_MEDIUM } from "../helpers/timeouts";

const ENABLED = !!process.env.DAINTREE_SHOT_PANEL_WORKSPACE;
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

const THEMED_STATES = ["grid-busy", "grid-busy-assistant", "headers-strip"] as const;
const DAINTREE_STATES = [
  "header-hover",
  "grid-dense-assistant",
  "assistant-focused",
  "tabs-overflow",
  "maximized",
  "maximize-strip",
  "restore-strip",
  "fleet-armed",
  "dictation-target",
] as const;
type State = (typeof THEMED_STATES)[number] | (typeof DAINTREE_STATES)[number];
const STATES: readonly State[] = [...THEMED_STATES, ...DAINTREE_STATES];

/** Skipped (and logged) rather than written as a wrong frame; excluded from the count. */
const UNREACHABLE: Partial<Record<State, string>> = {};

const WIDE = { width: 1600, height: 1000 };
const DENSE = { width: 1280, height: 800 };
const PROJECT = "helios";
const WT_FEATURE = "feature/auth-token-refresh";
const WT_CHORE = "chore/ci-cache-warmup";
const AGENT_TITLE = "fix flaky auth token refresh tests";
const SHELL_COMMAND = "sleep 3600 && echo 'staging db migration dry-run finished'";
const COMPLETION_LINE = "Total cost: $0.42";
const QUESTION_LINE = "Should I also regenerate the refresh-token fixtures?";
const ASSISTANT_PANEL = 'aside[aria-label="Daintree Assistant"]';
const ADD_TAB = '[aria-label="Duplicate panel as new tab"]';
const POLISH_ID = "pw-panel-workspace-polish";
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
const LABEL_FONT = "/System/Library/Fonts/Menlo.ttc";

const PAGE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Helios staging — auth dashboard</title>
<style>body{font:14px/1.6 -apple-system,system-ui,sans-serif;margin:28px;color:#222;background:#fafafa}
h1{font-size:20px}td{padding:4px 12px;border-bottom:1px solid #ddd}</style></head><body>
<h1>Helios staging — auth dashboard</h1>
<table><tr><td>Token refresh p95</td><td>184 ms</td></tr><tr><td>Refresh failures (1h)</td><td>3</td></tr>
<tr><td>Active sessions</td><td>1,204</td></tr></table></body></html>`;

function git(cmd: string, cwd: string): void {
  execSync(`git ${cmd}`, { cwd, stdio: "ignore" });
}

/** Own prefix: the shared e2e temp reaper and pre-launch hygiene never touch it. */
function createRepo(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "pwshot-helios-"));
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
  for (const branch of [WT_FEATURE, WT_CHORE]) {
    git(`branch ${branch}`, dir);
    git(
      `worktree add ${JSON.stringify(path.join(wtRoot, branch.replace(/\//g, "-")))} ${branch}`,
      dir
    );
  }
  return {
    dir,
    cleanup: () => {
      rmSync(wtRoot, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function startServer(): Promise<{ server: Server; baseUrl: string }> {
  return new Promise((resolve) => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(PAGE_HTML);
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

// ---------------------------------------------------------------------------
// Small helpers

async function settle(page: Page, ms = 400): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
  );
  await page.waitForTimeout(ms);
}

async function polish(page: Page, on: boolean): Promise<void> {
  await page.evaluate(
    ({ id, css, on }) => {
      document.getElementById(id)?.remove();
      if (!on) return;
      const style = document.createElement("style");
      style.id = id;
      style.textContent = css;
      document.head.appendChild(style);
    },
    { id: POLISH_ID, css: POLISH_CSS, on }
  );
}

async function parkPointer(page: Page): Promise<void> {
  // Over the sidebar's empty lower half: no pane header, no tooltip trigger.
  const size = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
  await page.mouse.move(Math.min(200, size.w / 2), size.h - 120);
}

async function blur(page: Page): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
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
  await settle(page, 800);
}

interface TerminalRow {
  id: string;
  kind: string;
  agentState: string | null;
  isFocused: boolean;
  title: string | null;
  location: string;
}

async function listTerminals(page: Page): Promise<TerminalRow[]> {
  const result = (await act(page, "terminal.list", {})) as
    TerminalRow[] | { terminals?: TerminalRow[] };
  return Array.isArray(result) ? result : (result?.terminals ?? []);
}

async function agentState(page: Page, id: string): Promise<string | null> {
  return (await listTerminals(page)).find((t) => t.id === id)?.agentState ?? null;
}

function upscale(file: string, factor = 2): void {
  const width = Number(
    execFileSync("sips", ["-g", "pixelWidth", file])
      .toString()
      .match(/pixelWidth: (\d+)/)?.[1]
  );
  if (!width) throw new Error(`could not read width of ${file}`);
  execFileSync("sips", ["--resampleWidth", String(width * factor), file], { stdio: "ignore" });
}

type Box = { x: number; y: number; width: number; height: number };

/**
 * Crops are meant to land at 2x device pixels so pip-level detail reads. A
 * Retina window already captures at 2x; a 1x capture is upscaled.
 */
/**
 * The automatic grid keeps 80 columns per pane, so at 1600px beside the
 * sidebar six panes lay out two wide and three deep and the grid scrolls.
 * Whole-window shots are taken scrolled to the top; crops scroll their pane in.
 */
async function scrollGridTop(page: Page): Promise<void> {
  await page.evaluate(() => {
    const first = document.querySelector('[data-panel-id][data-panel-location="grid"]');
    for (let n = first?.parentElement; n && n !== document.body; n = n.parentElement) {
      const style = getComputedStyle(n);
      if (/(auto|scroll)/.test(style.overflowY) && n.scrollHeight > n.clientHeight) n.scrollTop = 0;
    }
  });
  await settle(page, 300);
}

async function revealPanel(page: Page, panelId: string): Promise<void> {
  await page.evaluate((id) => {
    document
      .querySelector(`[data-panel-id="${id}"][data-panel-location="grid"]`)
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, panelId);
  await settle(page, 300);
}

async function headerOf(page: Page, panelId: string): Promise<HeaderReport> {
  const header = (await readHeaders(page)).find((h) => h.panelId === panelId);
  if (!header) throw new Error(`no header for ${panelId}`);
  return header;
}

async function cropUpscale(page: Page): Promise<number> {
  const dpr = await page.evaluate(() => window.devicePixelRatio);
  return dpr >= 2 ? 1 : Math.ceil(2 / dpr);
}

function outFile(state: State, theme: string, ext: "png" | "json"): string {
  return path.join(OUTPUT_DIR, `${state}--${theme}.${ext}`);
}

// ---------------------------------------------------------------------------
// Sidecar

interface HeaderReport {
  panelId: string;
  agentState: string | null;
  agentGlyph: string | null;
  focused: boolean;
  rect: Box;
  title: string;
  titleTruncated: boolean;
  tabs: Array<{ title: string; active: boolean; truncated: boolean; rect: Box }>;
  controls: Array<{ label: string; rect: Box; opacity: number; visible: boolean }>;
}

async function readHeaders(page: Page): Promise<HeaderReport[]> {
  return page.evaluate(() => {
    const box = (el: Element) => {
      const r = el.getBoundingClientRect();
      return {
        x: Math.round(r.x),
        y: Math.round(r.y),
        width: Math.round(r.width),
        height: Math.round(r.height),
      };
    };
    const effectiveOpacity = (el: Element | null): number => {
      let o = 1;
      for (let n = el; n && n !== document.body; n = n.parentElement) {
        o *= Number(getComputedStyle(n).opacity);
      }
      return Math.round(o * 100) / 100;
    };
    const panels = Array.from(
      document.querySelectorAll<HTMLElement>('[data-panel-id][data-panel-location="grid"]')
    ).filter((el) => el.getBoundingClientRect().width > 0);
    return panels.map((panel) => {
      const controls = panel.querySelector('[data-testid="panel-header-controls"]');
      const header =
        (controls?.closest("[data-pane-chrome]") as HTMLElement | null) ??
        (panel.querySelector("[data-pane-chrome]") as HTMLElement | null);
      const titleEl = header?.querySelector<HTMLElement>(
        "span[data-fleet-gesture-passthrough].truncate"
      );
      const tabs = Array.from(header?.querySelectorAll<HTMLElement>('[role="tab"]') ?? []).map(
        (tab) => {
          const text = tab.querySelector<HTMLElement>(".truncate") ?? tab;
          return {
            title: (tab.textContent ?? "").trim(),
            active: tab.getAttribute("aria-selected") === "true",
            truncated: text.scrollWidth > text.clientWidth,
            rect: box(tab),
          };
        }
      );
      const labelled = Array.from(
        header?.querySelectorAll<HTMLElement>("[aria-label]") ?? []
      ).filter((el) => el !== header && !el.matches('[role="tab"]'));
      return {
        panelId: panel.getAttribute("data-panel-id") ?? "",
        agentState: panel.getAttribute("data-agent-state"),
        agentGlyph:
          header
            ?.querySelector('[data-testid="panel-header-agent-indicator"] [role="status"]')
            ?.getAttribute("aria-label") ?? null,
        focused: panel.classList.contains("terminal-selected"),
        rect: header ? box(header) : { x: 0, y: 0, width: 0, height: 0 },
        title: (titleEl?.textContent ?? "").trim(),
        titleTruncated: titleEl ? titleEl.scrollWidth > titleEl.clientWidth : false,
        tabs,
        controls: labelled.map((el) => {
          const r = box(el);
          const opacity = effectiveOpacity(el);
          return {
            label: el.getAttribute("aria-label") ?? "",
            rect: r,
            opacity,
            visible: r.width > 0 && r.height > 0 && opacity > 0.01,
          };
        }),
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
  const headers = await readHeaders(page);
  const env = await page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    return {
      window: {
        width: window.innerWidth,
        height: window.innerHeight,
        dpr: window.devicePixelRatio,
      },
      activeElement:
        !el || el === document.body
          ? "body"
          : {
              tag: el.tagName.toLowerCase(),
              ariaLabel: el.getAttribute("aria-label"),
              testId: el.getAttribute("data-testid"),
              className: typeof el.className === "string" ? el.className.slice(0, 120) : null,
              panelId: el.closest("[data-panel-id]")?.getAttribute("data-panel-id") ?? null,
              inAssistant: !!el.closest('aside[aria-label="Daintree Assistant"]'),
            },
      focusedChromePanel:
        document
          .querySelector(".terminal-selected[data-panel-id]")
          ?.getAttribute("data-panel-id") ?? null,
    };
  });
  const terminals = await listTerminals(page).catch(() => []);
  writeFileSync(
    outFile(state, theme, "json"),
    JSON.stringify(
      {
        state,
        theme,
        ...env,
        storeFocusedPanel: terminals.find((t) => t.isFocused)?.id ?? null,
        terminals: terminals.map((t) => ({
          id: t.id,
          kind: t.kind,
          title: t.title,
          agentState: t.agentState,
          location: t.location,
        })),
        headers,
        ...extra,
      },
      null,
      2
    )
  );
}

async function snapWindow(page: Page, state: State, theme: string, extra = {}): Promise<void> {
  await settle(page);
  await page.screenshot({ path: outFile(state, theme, "png"), type: "png", caret: "hide" });
  await writeSidecar(page, state, theme, extra);
}

async function snapCrop(
  page: Page,
  state: State,
  theme: string,
  box: Box,
  extra: Record<string, unknown> = {}
): Promise<void> {
  await settle(page);
  const view = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
  // The padding may hang over an edge; the subject itself may not.
  if (box.y + box.height < 24 || box.y > view.h - 24 || box.x > view.w - 24) {
    throw new Error(`${state}: crop ${JSON.stringify(box)} is off-screen`);
  }
  const x = Math.max(0, Math.floor(box.x));
  const y = Math.max(0, Math.floor(box.y));
  const clip = {
    x,
    y,
    width: Math.min(view.w, Math.ceil(box.x + box.width)) - x,
    height: Math.min(view.h, Math.ceil(box.y + box.height)) - y,
  };
  const file = outFile(state, theme, "png");
  await page.screenshot({ path: file, type: "png", caret: "hide", clip });
  const factor = await cropUpscale(page);
  if (factor > 1) upscale(file, factor);
  await writeSidecar(page, state, theme, { crop: clip, upscale: factor, ...extra });
}

// ---------------------------------------------------------------------------
// The busy grid

interface Grid {
  binDir: string;
  worktreeId: string;
  working: string;
  waiting: string;
  completed: string;
  shell: string;
  browser: string;
  /** Any member of the tab group; the grid element carries the active tab's id. */
  groupMembers: string[];
}

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

async function waitForState(page: Page, id: string, want: string, timeout = 90_000): Promise<void> {
  await expect
    .poll(() => agentState(page, id), {
      timeout,
      intervals: [500, 1000],
      message: `${id} never reached ${want}`,
    })
    .toBe(want);
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

/**
 * Ends a turn the way a real Claude turn ends: a closing line lands at the
 * bottom of the screen while the agent is busy, then the busy signal stops and
 * the FSM settles to waiting. The fake has no free-form output, but its cooked
 * tty echoes what is written to it. The stream first fills the pane so the
 * line sits in the tail the classifiers scan.
 *
 * A completion line settles into a hand-back wait (the header draws the
 * finished glyph; `completed` itself is held for only 500ms before the FSM
 * moves to waiting). A trailing question settles into a `question` wait, the
 * one the header draws as asking for input.
 */
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

async function addTabTo(page: Page, groupLocator: Locator, expectTabs: number): Promise<void> {
  const header = groupLocator.locator("[data-pane-chrome]").first();
  await header.hover();
  await groupLocator.locator(ADD_TAB).first().click({ force: true });
  await expect
    .poll(async () => (await groupFrame(page))?.tabs ?? 0, {
      timeout: T_LONG,
      message: `tab group never reached ${expectTabs} tabs`,
    })
    .toBeGreaterThanOrEqual(expectTabs);
  await settle(page, 600);
}

/** The grid element showing the tab group, found by its tab strip. */
async function groupFrame(page: Page): Promise<{ id: string; tabs: number } | null> {
  return page.evaluate(() => {
    for (const el of Array.from(
      document.querySelectorAll<HTMLElement>('[data-panel-id][data-panel-location="grid"]')
    )) {
      const tabs = el.querySelectorAll('[role="tab"]').length;
      if (tabs > 1) return { id: el.getAttribute("data-panel-id") ?? "", tabs };
    }
    return null;
  });
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

async function buildGrid(page: Page, binDir: string, baseUrl: string): Promise<Grid> {
  const worktreeId = await worktreeIdFor(page, WT_FEATURE);
  await worktreeIdFor(page, WT_CHORE);
  await act(page, "worktree.select", { worktreeId });
  await settle(page, 1500);

  const working = await launchAgent(page, binDir, worktreeId);
  const waiting = await launchAgent(page, binDir, worktreeId);
  const completed = await launchAgent(page, binDir, worktreeId);

  let before = new Set(await getGridPanelIds(page));
  await act(page, "terminal.new", {});
  const shell = await newPanelId(page, before);
  await runTerminalCommand(page, page.locator(`[data-panel-id="${shell}"]`), SHELL_COMMAND, {
    readyTimeout: 30_000,
  });

  before = new Set(await getGridPanelIds(page));
  await openBrowser(page);
  const browser = await newPanelId(page, before);
  const address = page.locator(`[data-panel-id="${browser}"] ${SEL.browser.addressBar}`);
  await address.waitFor({ state: "visible", timeout: T_LONG });
  await address.click();
  await address.fill(`${baseUrl}/staging`);
  await page.keyboard.press("Enter");
  await expect(address).toHaveValue(/127\.0\.0\.1/, { timeout: T_LONG });

  before = new Set(await getGridPanelIds(page));
  await act(page, "terminal.new", {});
  const groupRoot = await newPanelId(page, before);
  await page
    .locator(`[data-panel-id="${groupRoot}"] .xterm`)
    .first()
    .waitFor({ state: "visible", timeout: T_LONG });
  const rootLocator = page.locator(`[data-panel-id="${groupRoot}"]`);
  await rootLocator.locator("[data-pane-chrome]").first().hover();
  await rootLocator.locator(ADD_TAB).first().click({ force: true });
  await expect.poll(async () => (await groupFrame(page))?.tabs ?? 0, { timeout: T_LONG }).toBe(2);
  const g = await groupFrame(page);
  await addTabTo(page, page.locator(`[data-panel-id="${g!.id}"]`), 3);

  // States: rename the working pane to a task title, keep it streaming, settle
  // the second to waiting and the third to completed.
  await act(page, "terminal.rename", { terminalId: working, name: AGENT_TITLE });
  await endTurn(page, binDir, waiting, QUESTION_LINE, (s) => s.waitingReason === "question");
  await endTurn(
    page,
    binDir,
    completed,
    COMPLETION_LINE,
    (s) => s.waitingReason === null || s.waitingReason === "prompt"
  );
  await sendFakeAgentCommand(binDir, "work", T_LONG, working);
  await waitForState(page, working, "working");

  const members = (await listTerminals(page))
    .filter(
      (t) =>
        t.location === "grid" &&
        t.kind === "terminal" &&
        ![working, waiting, completed, shell].includes(t.id) &&
        t.id !== browser
    )
    .map((t) => t.id);
  return { binDir, worktreeId, working, waiting, completed, shell, browser, groupMembers: members };
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

/** Throws unless the grid is the six-slot busy grid this harness promises. */
async function verifyBusyGrid(
  page: Page,
  grid: Grid,
  opts: { focused?: string | null; tabs?: number } = {}
): Promise<void> {
  const headers = await readHeaders(page);
  if (headers.length !== 6) {
    throw new Error(
      `grid shows ${headers.length} panes, expected 6 (${JSON.stringify(headers.map((h) => h.panelId))})`
    );
  }
  const byId = new Map(headers.map((h) => [h.panelId, h]));
  for (const id of [grid.working, grid.waiting, grid.completed, grid.shell, grid.browser]) {
    if (!byId.has(id)) throw new Error(`pane ${id} is not on the grid`);
  }
  if (byId.get(grid.working)?.agentState !== "working") {
    throw new Error(`working pane shows ${byId.get(grid.working)?.agentState}`);
  }
  if (byId.get(grid.waiting)?.agentState !== "waiting") {
    throw new Error(`waiting pane shows ${byId.get(grid.waiting)?.agentState}`);
  }
  const waitingStatus = await paneStatus(page, grid.waiting);
  if (waitingStatus.agentState !== "waiting" || waitingStatus.waitingReason !== "question") {
    throw new Error(`waiting pane is ${JSON.stringify(waitingStatus)}`);
  }
  const doneStatus = await paneStatus(page, grid.completed);
  if (
    doneStatus.agentState !== "waiting" ||
    (doneStatus.waitingReason !== null && doneStatus.waitingReason !== "prompt")
  ) {
    throw new Error(`finished pane is ${JSON.stringify(doneStatus)}`);
  }
  const glyph = (id: string) => byId.get(id)?.agentGlyph ?? null;
  const askGlyph = glyph(grid.waiting);
  const doneGlyph = glyph(grid.completed);
  if (askGlyph && doneGlyph && askGlyph === doneGlyph) {
    throw new Error(`waiting and finished panes wear the same glyph (${askGlyph})`);
  }
  const group = headers.find((h) => h.tabs.length > 1);
  const wantTabs = opts.tabs ?? 3;
  if (!group || group.tabs.length !== wantTabs) {
    throw new Error(`tab group shows ${group?.tabs.length ?? 0} tabs, expected ${wantTabs}`);
  }
  const focused = opts.focused === undefined ? grid.working : opts.focused;
  const chrome = headers.filter((h) => h.focused).map((h) => h.panelId);
  if (focused === null ? chrome.length !== 0 : chrome.join() !== focused) {
    throw new Error(`focus chrome on ${JSON.stringify(chrome)}, expected ${focused}`);
  }
}

async function readyBusyGrid(page: Page, grid: Grid): Promise<void> {
  await focusPane(page, grid.working);
  await blur(page).catch(() => {});
  // Blurring the terminal must not drop the store focus; re-assert the chrome.
  await focusPane(page, grid.working);
  await scrollGridTop(page);
  await parkPointer(page);
  await settle(page, 600);
}

async function assistantOpen(page: Page): Promise<boolean> {
  const aside = page.locator(ASSISTANT_PANEL);
  return (await aside.count()) > 0 && (await aside.getAttribute("inert")) === null;
}

async function setAssistant(page: Page, open: boolean): Promise<void> {
  if ((await assistantOpen(page)) === open) return;
  await act(page, "help.togglePanel");
  await expect
    .poll(() => assistantOpen(page), {
      timeout: T_LONG,
      message: `assistant never ${open ? "opened" : "closed"}`,
    })
    .toBe(open);
  await settle(page, 1200);
}

async function switchTheme(page: Page, theme: string, grid: Grid): Promise<void> {
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
    console.log(`[panel-workspace] ${theme} did not apply in place; reloading`);
    await setAppTheme(page, theme);
    await dismissBlockingPalette(page);
  }
  await polish(page, true);
  await settle(page, 1500);
  await expect.poll(async () => (await readHeaders(page)).length, { timeout: T_LONG }).toBe(6);
  await readyBusyGrid(page, grid);
}

// ---------------------------------------------------------------------------
// States

interface Run {
  app: ElectronApplication;
  page: Page;
  grid: Grid;
  failures: string[];
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
  if (UNREACHABLE[state]) {
    console.log(`[panel-workspace] skip ${state}--${theme}: ${UNREACHABLE[state]}`);
    return;
  }
  const started = Date.now();
  try {
    await fn();
    if (!existsSync(outFile(state, theme, "png"))) throw new Error("PNG did not land");
    console.log(`[panel-workspace] wrote ${state}--${theme} (${Date.now() - started}ms)`);
  } catch (error) {
    rmSync(outFile(state, theme, "png"), { force: true });
    rmSync(outFile(state, theme, "json"), { force: true });
    const message = `${state}--${theme}: ${String(error).split("\n")[0]}`;
    run.failures.push(message);
    console.warn(`[panel-workspace] FAILED ${message}`);
  }
  await run.page.keyboard.press("Escape").catch(() => {});
}

async function headersStrip(run: Run, theme: string): Promise<void> {
  const { page } = run;
  const headers = (await readHeaders(page)).sort(
    (a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x
  );
  const factor = await cropUpscale(page);
  const tmp = mkdtempSync(path.join(tmpdir(), "pwshot-headers-"));
  try {
    const files: string[] = [];
    const view = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
    for (const [i, placed] of headers.entries()) {
      await revealPanel(page, placed.panelId);
      const h = await headerOf(page, placed.panelId);
      if (
        h.rect.width < 20 ||
        h.rect.height < 10 ||
        h.rect.y < 0 ||
        h.rect.y + h.rect.height > view.h
      ) {
        throw new Error(`header ${h.panelId} is not on screen (${JSON.stringify(h.rect)})`);
      }
      const file = path.join(tmp, `h${i}.png`);
      await page.screenshot({ path: file, type: "png", caret: "hide", clip: h.rect });
      if (factor > 1) upscale(file, factor);
      files.push(file);
    }
    const out = outFile("headers-strip", theme, "png");
    execFileSync("magick", [
      ...files,
      "-background",
      "#7f7f7f",
      "-gravity",
      "north",
      "-splice",
      "0x6",
      "-append",
      "-chop",
      "0x6",
      out,
    ]);
    await writeSidecar(page, "headers-strip", theme, {
      order: headers.map((h, i) => ({
        index: i,
        panelId: h.panelId,
        title: h.title || h.tabs.map((t) => t.title).join(" | "),
      })),
      upscale: factor,
      gapPx: 6,
    });
    await scrollGridTop(page);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

async function themedStates(run: Run, theme: string): Promise<void> {
  const { page, grid } = run;
  await shoot(run, "grid-busy", theme, async () => {
    await setAssistant(page, false);
    await readyBusyGrid(page, grid);
    await verifyBusyGrid(page, grid);
    await snapWindow(page, "grid-busy", theme);
  });
  await shoot(run, "headers-strip", theme, async () => {
    await setAssistant(page, false);
    await readyBusyGrid(page, grid);
    await verifyBusyGrid(page, grid);
    await headersStrip(run, theme);
  });
  await shoot(run, "grid-busy-assistant", theme, async () => {
    await setAssistant(page, true);
    await readyBusyGrid(page, grid);
    await verifyBusyGrid(page, grid);
    if (!(await assistantOpen(page))) throw new Error("assistant closed during settle");
    await snapWindow(page, "grid-busy-assistant", theme);
  });
  await setAssistant(page, false).catch(() => {});
}

/** ~6 frames of a transition, slowed through CDP, tiled with their times. */
async function filmstrip(
  run: Run,
  state: State,
  trigger: () => Promise<void>,
  verify: () => Promise<void>
): Promise<void> {
  const { page } = run;
  const tmp = mkdtempSync(path.join(tmpdir(), "pwshot-strip-"));
  const cdp = await page.context().newCDPSession(page);
  const frames: Array<{ file: string; t: number }> = [];
  const RATE = 0.1;
  const FRAMES = 6;
  const SPAN_MS = 3000;
  try {
    await polish(page, false);
    await settle(page, 300);
    await cdp.send("Animation.enable");
    await cdp.send("Animation.setPlaybackRate", { playbackRate: RATE });
    const started: string[] = [];
    cdp.on(
      "Animation.animationStarted",
      (e: { animation: { name?: string; type?: string; source?: { duration?: number } } }) => {
        started.push(
          `${e.animation.type}:${e.animation.name ?? ""}:${e.animation.source?.duration ?? "?"}`
        );
      }
    );
    // Frame 0 is the state before the trigger; the rest are spread over SPAN_MS.
    const before = path.join(tmp, "f0.png");
    await page.screenshot({ path: before, type: "png", caret: "hide", animations: "allow" });
    frames.push({ file: before, t: -1 });
    const t0 = Date.now();
    await trigger();
    for (let i = 1; i < FRAMES; i++) {
      const due = t0 + ((i - 1) * SPAN_MS) / (FRAMES - 2);
      const wait = due - Date.now();
      if (wait > 0) await page.waitForTimeout(wait);
      const file = path.join(tmp, `f${i}.png`);
      await page.screenshot({ path: file, type: "png", caret: "hide", animations: "allow" });
      frames.push({ file, t: Date.now() - t0 });
    }
    await cdp.send("Animation.setPlaybackRate", { playbackRate: 1 });
    await settle(page, 800);
    await verify();
    const args: string[] = ["montage"];
    for (const f of frames) {
      const label =
        f.t < 0 ? "before trigger" : `t=${f.t}ms real (~${Math.round(f.t * RATE)}ms app time)`;
      args.push("-label", label, f.file);
    }
    args.push(
      "-font",
      LABEL_FONT,
      "-pointsize",
      "16",
      "-tile",
      "2x",
      "-geometry",
      "1200x750+8+8",
      "-background",
      "#2b2b2b",
      "-fill",
      "#f0f0f0",
      outFile(state, "daintree", "png")
    );
    execFileSync("magick", args);
    await writeSidecar(page, state, "daintree", {
      playbackRate: RATE,
      frames: frames.map((f, i) => ({
        index: i,
        realMs: f.t < 0 ? null : f.t,
        appMs: f.t < 0 ? null : Math.round(f.t * RATE),
      })),
      animationsStarted: started,
      layoutAnimations: started.filter((a) => !/spin|outline/.test(a)),
      note: "The layout swap itself is not animated: ContentGrid renders ContentGridMaximizedSingle (or the grid) on the next commit with no view transition or FLIP. Any entries in layoutAnimations are incidental element enters/fades, not the pane moving.",
    });
  } finally {
    await cdp.send("Animation.setPlaybackRate", { playbackRate: 1 }).catch(() => {});
    await cdp.detach().catch(() => {});
    await polish(page, true);
    rmSync(tmp, { recursive: true, force: true });
  }
}

async function isMaximized(page: Page): Promise<boolean> {
  return (await page.locator('[aria-label="Restore grid view"]').count()) > 0;
}

async function daintreeStates(run: Run): Promise<void> {
  const { page, grid, app } = run;
  const theme = "daintree";

  await shoot(run, "header-hover", theme, async () => {
    await setAssistant(page, false);
    await readyBusyGrid(page, grid);
    await verifyBusyGrid(page, grid);
    const headers = await readHeaders(page);
    const target = headers.find((h) => h.panelId === grid.shell)!;
    const controls = target.controls.find((c) => c.label === "Panel controls");
    const x = (controls ? controls.rect.x : target.rect.x + target.rect.width) - 36;
    await page.mouse.move(x, target.rect.y + target.rect.height / 2);
    await settle(page, 700);
    const after = (await readHeaders(page)).find((h) => h.panelId === grid.shell)!;
    const plus = after.controls.find((c) => c.label === "Duplicate panel as new tab");
    if (!plus || plus.opacity < 0.99)
      throw new Error(`hover did not reveal + (${JSON.stringify(plus)})`);
    if (after.focused) throw new Error("hovered pane is the focused one");
    const row = headers.filter((h) => Math.abs(h.rect.y - target.rect.y) < 4);
    const top = Math.min(...row.map((h) => h.rect.y));
    const bottom = Math.max(...row.map((h) => h.rect.y + h.rect.height));
    const left = Math.min(...row.map((h) => h.rect.x));
    const right = Math.max(...row.map((h) => h.rect.x + h.rect.width));
    await snapCrop(
      page,
      "header-hover",
      theme,
      { x: left - 8, y: top - 8, width: right - left + 16, height: bottom - top + 24 },
      {
        hoveredPanel: grid.shell,
        pointer: { x, y: target.rect.y + target.rect.height / 2 },
      }
    );
    await parkPointer(page);
  });

  await shoot(run, "grid-dense-assistant", theme, async () => {
    try {
      await setWindowSize(app, page, DENSE);
      await setAssistant(page, true);
      await readyBusyGrid(page, grid);
      await verifyBusyGrid(page, grid);
      if ((await page.evaluate(() => window.innerWidth)) !== DENSE.width)
        throw new Error("window is not 1280px");
      await snapWindow(page, "grid-dense-assistant", theme);
    } finally {
      await setAssistant(page, false).catch(() => {});
      await setWindowSize(app, page, WIDE);
    }
  });

  await shoot(run, "assistant-focused", theme, async () => {
    try {
      await setAssistant(page, true);
      await readyBusyGrid(page, grid);
      await verifyBusyGrid(page, grid);
      // Keyboard in the assistant: the grid pane it will hand back to keeps
      // neither its frame nor its header lift.
      await page.locator('[aria-label="Daintree Assistant"] [role="tab"]').first().focus();
      await expect(page.locator(".assistant-focused")).toHaveCount(1, { timeout: T_MEDIUM });
      await expect(page.locator(".terminal-selected")).toHaveCount(0, { timeout: T_MEDIUM });
      await parkPointer(page);
      await settle(page, 600);
      await snapWindow(page, "assistant-focused", theme);
    } finally {
      await setAssistant(page, false).catch(() => {});
    }
  });

  await shoot(run, "tabs-overflow", theme, async () => {
    await setAssistant(page, false);
    for (let n = (await groupFrame(page))?.tabs ?? 0; n < 7; n++) {
      const g = await groupFrame(page);
      await addTabTo(page, page.locator(`[data-panel-id="${g!.id}"]`), n + 1);
    }
    await readyBusyGrid(page, grid);
    await verifyBusyGrid(page, grid, { tabs: 7 });
    const g = await groupFrame(page);
    await revealPanel(page, g!.id);
    await parkPointer(page);
    await settle(page, 400);
    const pane = page.locator(`[data-panel-id="${g!.id}"]`);
    const chevron = pane.locator('[data-testid="panel-tabs-overflow"]');
    await chevron.waitFor({ state: "visible", timeout: 5000 });
    const box = await pane.boundingBox();
    if (!box) throw new Error("tab group has no box");
    await snapCrop(
      page,
      "tabs-overflow",
      theme,
      { x: box.x - 16, y: box.y - 16, width: box.width + 32, height: 120 },
      {
        groupPanel: g!.id,
        chevronLabel: await chevron.getAttribute("aria-label"),
      }
    );
  });

  await shoot(run, "maximized", theme, async () => {
    await setAssistant(page, false);
    await readyBusyGrid(page, grid);
    await focusPane(page, grid.completed);
    await act(page, "terminal.toggleMaximize", { terminalId: grid.completed });
    await page
      .locator('[aria-label="Restore grid view"]')
      .waitFor({ state: "visible", timeout: T_LONG });
    await parkPointer(page);
    await settle(page, 1200);
    const readout = page
      .locator('[role="status"]')
      .filter({ hasText: /other panes?/ })
      .first();
    await readout.waitFor({ state: "visible", timeout: 10_000 });
    const text = ((await readout.textContent()) ?? "").replace(/\s+/g, " ").trim();
    if (!/working/.test(text) || !/waiting/.test(text)) throw new Error(`readout reads "${text}"`);
    await snapWindow(page, "maximized", theme, { readout: text });
  });
  if (await isMaximized(page)) {
    await act(page, "terminal.toggleMaximize", { terminalId: grid.completed }).catch(() => {});
    await settle(page, 1000);
  }

  await shoot(run, "maximize-strip", theme, async () => {
    await readyBusyGrid(page, grid);
    await focusPane(page, grid.completed);
    if (await isMaximized(page)) throw new Error("grid already maximized");
    await filmstrip(
      run,
      "maximize-strip",
      async () => void (await act(page, "terminal.toggleMaximize", { terminalId: grid.completed })),
      async () => {
        if (!(await isMaximized(page))) throw new Error("maximize did not land");
      }
    );
  });

  await shoot(run, "restore-strip", theme, async () => {
    if (!(await isMaximized(page))) {
      await act(page, "terminal.toggleMaximize", { terminalId: grid.completed });
      await page
        .locator('[aria-label="Restore grid view"]')
        .waitFor({ state: "visible", timeout: T_LONG });
      await settle(page, 1000);
    }
    await filmstrip(
      run,
      "restore-strip",
      async () => void (await act(page, "terminal.toggleMaximize", { terminalId: grid.completed })),
      async () => {
        if (await isMaximized(page)) throw new Error("restore did not land");
        if ((await readHeaders(page)).length !== 6) throw new Error("restored grid is not 6 panes");
      }
    );
  });
  if (await isMaximized(page)) {
    await act(page, "terminal.toggleMaximize", { terminalId: grid.completed }).catch(() => {});
    await settle(page, 1000);
  }

  await shoot(run, "fleet-armed", theme, async () => {
    const order = [grid.completed, grid.waiting, grid.working];
    try {
      await readyBusyGrid(page, grid);
      for (const id of order) {
        await focusPane(page, id);
        await act(page, "fleet.armFocused");
        await settle(page, 300);
      }
      await parkPointer(page);
      await settle(page, 800);
      const followers = await page.locator("[data-fleet-follower]").count();
      const towers = await page.locator('[data-testid="panel-armed-broadcast-indicator"]').count();
      if (followers < 2 || towers < 2) throw new Error(`followers=${followers} towers=${towers}`);
      await snapWindow(page, "fleet-armed", theme, {
        armed: order,
        followers,
        radioTowers: towers,
      });
    } finally {
      for (const id of order) {
        const armed = await page
          .locator(
            `[data-panel-id="${id}"] [data-testid="panel-armed-broadcast-indicator"], [data-panel-id="${id}"][data-selected]`
          )
          .count();
        if (armed > 0) {
          await act(page, "panel.focus", { panelId: id }).catch(() => {});
          await act(page, "fleet.armFocused").catch(() => {});
        }
      }
    }
  });
}

// ---------------------------------------------------------------------------

/**
 * The dictation target's Mic mark only shows during a live recording session,
 * which needs voice configured before launch, a microphone and a provider. It
 * gets its own launch so a voice failure costs this one frame: a seeded voice
 * config, Chromium's fake capture device reading a looping tone, and the
 * shared transcription mock as the provider. The grid is a shell beside the
 * fake Claude whose composer takes the dictation.
 */
async function captureDictation(failures: string[]): Promise<void> {
  const state: State = "dictation-target";
  const theme = "daintree";
  if (!wanted(state) || !THEMES.includes(theme)) return;
  const repo = createRepo();
  const binDir = installFakeAgent(repo.dir);
  const wavPath = writeWav(path.join(repo.dir, ".e2e bin"), "tone.wav", {
    seconds: 4,
    frequency: 440,
    amplitude: 0.5,
  });
  const mock = await createTranscriptionMock();
  const userDataDir = mkdtempSync(path.join(tmpdir(), "pwshot-panelws-voice-ud-"));
  let ctx: AppContext | undefined;
  try {
    const first = await launchApp({ userDataDir });
    const pid = first.app.process().pid;
    await closeApp(first.app);
    if (pid) await waitForProcessExit(pid);
    seedVoiceConfig(userDataDir, {
      enabled: true,
      openaiApiKey: "sk-e2e-test-key-not-real",
      deepgramApiKey: "dg-e2e-test-key-not-real",
      language: "en",
      dictionary: [],
      transcriptionModel: "gpt-live-transcribe",
      correctionEnabled: false,
      correctionModel: "gpt-6.1-terra",
      correctionCustomInstructions: "",
      paragraphingStrategy: "spoken-command",
      resolveFileLinks: true,
    });
    removeSingletonFiles(userDataDir);
    ctx = await launchAppWithFakeMicrophone({
      userDataDir,
      wavPath,
      windowSize: WIDE,
      env: { ...mock.env(), ...fakeAgentEnv(binDir) },
      extraArgs: ["--disable-gpu", "--in-process-gpu", "--disable-breakpad", "--noerrdialogs"],
    });
    await stubNativeMicrophonePermission(ctx.app);
    const page = await openAndOnboardProject(ctx.app, ctx.window, repo.dir, PROJECT);
    await dismissBlockingPalette(page);
    await setWindowSize(ctx.app, page, WIDE);
    await polish(page, true);
    const worktreeId = await worktreeIdFor(page, WT_FEATURE);
    await act(page, "worktree.select", { worktreeId });
    await settle(page, 1000);
    const before = new Set(await getGridPanelIds(page));
    await act(page, "terminal.new", {});
    await newPanelId(page, before);
    const pane = await openDictationTarget(page, binDir);
    const paneId = await pane.getAttribute("data-panel-id");
    await ensureWindowFocused(ctx.app);
    await page.keyboard.press(VOICE_TOGGLE_CHORD);
    const mark = pane.locator('[data-testid="panel-dictation-mark"]');
    await mark.waitFor({ state: "visible", timeout: T_LONG });
    await mock.waitForAudioBytes(24_000, T_LONG);
    await page.mouse.move(4, 600);
    await settle(page, 800);
    if (!(await mark.isVisible())) throw new Error("Mic mark went away before the capture");
    const headers = await readHeaders(page);
    const target = headers.find((h) => h.panelId === paneId);
    if (!target) throw new Error(`dictation pane ${paneId} has no header`);
    const row = headers.filter((h) => Math.abs(h.rect.y - target.rect.y) < 4);
    const top = Math.min(...row.map((h) => h.rect.y));
    const left = Math.min(...row.map((h) => h.rect.x));
    const right = Math.max(...row.map((h) => h.rect.x + h.rect.width));
    await snapCrop(
      page,
      state,
      theme,
      { x: left - 8, y: top - 8, width: right - left + 16, height: target.rect.height + 48 },
      { dictationPanel: paneId, audioBytes: mock.audioBytes() }
    );
    await page.keyboard.press(VOICE_TOGGLE_CHORD).catch(() => {});
    console.log(`[panel-workspace] wrote ${state}--${theme}`);
  } catch (error) {
    rmSync(outFile(state, theme, "png"), { force: true });
    rmSync(outFile(state, theme, "json"), { force: true });
    const message = `${state}--${theme}: ${String(error).split("\n")[0]}`;
    failures.push(message);
    console.warn(`[panel-workspace] FAILED ${message}`);
  } finally {
    if (ctx?.app) await closeApp(ctx.app).catch(() => {});
    await mock.close().catch(() => {});
    repo.cleanup();
    rmSync(userDataDir, { recursive: true, force: true });
  }
}

function expectedFiles(): string[] {
  const files: string[] = [];
  for (const theme of THEMES) {
    for (const s of THEMED_STATES) {
      if (wanted(s) && !UNREACHABLE[s]) files.push(`${s}--${theme}.png`, `${s}--${theme}.json`);
    }
  }
  if (THEMES.includes("daintree")) {
    for (const s of DAINTREE_STATES) {
      if (wanted(s) && !UNREACHABLE[s]) files.push(`${s}--daintree.png`, `${s}--daintree.json`);
    }
  }
  return files;
}

test("panel workspace — busy grid headers, tabs, maximize, fleet", async () => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_PANEL_WORKSPACE is required for the panel workspace capture",
  });
  test.skip(!ENABLED, "Set DAINTREE_SHOT_PANEL_WORKSPACE=1 to run the panel workspace capture");
  if (!OUTPUT_DIR)
    throw new Error("DESIGN_CAPTURE_DIR must be set to a directory outside the repo");
  test.setTimeout(45 * 60_000);

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
  const userDataDir = mkdtempSync(path.join(tmpdir(), "pwshot-panelws-ud-"));
  const { server, baseUrl } = await startServer();
  let ctx: AppContext | undefined;
  const failures: string[] = [];
  try {
    ctx = await launchApp({
      userDataDir,
      windowSize: WIDE,
      env: fakeAgentEnv(binDir),
      extraArgs: ["--disable-gpu", "--in-process-gpu", "--disable-breakpad", "--noerrdialogs"],
    });
    const page = await openAndOnboardProject(ctx.app, ctx.window, repo.dir, PROJECT);
    await dismissBlockingPalette(page);
    await page.locator(SEL.worktree.mainCard).waitFor({ state: "visible", timeout: T_LONG });
    await setWindowSize(ctx.app, page, WIDE);
    await polish(page, true);

    const grid = await buildGrid(page, binDir, baseUrl);
    console.log(`[panel-workspace] grid ${JSON.stringify(grid)}`);
    const run: Run = { app: ctx.app, page, grid, failures };

    const order = [
      ...THEMES.filter((t) => t !== "daintree"),
      ...(THEMES.includes("daintree") ? ["daintree"] : []),
    ];
    for (const theme of order) {
      try {
        await switchTheme(page, theme, grid);
        await themedStates(run, theme);
      } catch (error) {
        failures.push(`${theme}: ${String(error).split("\n")[0]}`);
      }
    }
    if (THEMES.includes("daintree")) {
      try {
        await switchTheme(page, "daintree", grid);
        await daintreeStates(run);
      } catch (error) {
        failures.push(`daintree-only: ${String(error).split("\n")[0]}`);
      }
    }

    await closeApp(ctx.app).catch(() => {});
    ctx = undefined;
    await captureDictation(failures);

    const expected = expectedFiles();
    const present = readdirSync(OUTPUT_DIR).filter((f) =>
      STATES.some((s) => f.startsWith(`${s}--`))
    );
    const missing = expected.filter((f) => !present.includes(f));
    const extra = present.filter((f) => !expected.includes(f));
    console.log(
      `[panel-workspace] wrote ${present.filter((f) => f.endsWith(".png")).length}/${expected.filter((f) => f.endsWith(".png")).length} PNGs to ${OUTPUT_DIR}`
    );
    expect(failures, "state captures failed").toEqual([]);
    expect(missing, "files missing from the output directory").toEqual([]);
    expect(extra, "unexpected extra files").toEqual([]);
  } finally {
    if (ctx?.app) await closeApp(ctx.app).catch(() => {});
    server.close();
    repo.cleanup();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
