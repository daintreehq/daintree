/**
 * Decisions pane chip review: the chip an agent pane shows while a question
 * it asked through Daintree Decisions is out, its answer waits to be typed in,
 * or the answer needs a person (#16018), and the Canopy row that answer puts
 * in the needs-you tier.
 *
 * Four fake Claude panes share one worktree. Decisions itself never loads: the
 * harness answers `decisions:get-status` and `decisions:get-pane-state` in
 * main and pushes `decisions:status-changed` and `terminal:decision-state` on
 * the real broadcast channel, so the renderer under review reads them through
 * the seams it always does. One pane also carries terminal notices
 * (`terminal:notify-state`), so the chip is seen beside its neighbour. The
 * Canopy frame holds main's fleet broadcasts back and pushes main's own
 * snapshot with one run marked as having an answer that needs attention.
 *
 *   DAINTREE_SHOT_DECISIONS_CHIP=1 DESIGN_CAPTURE_DIR=/abs/dir \
 *     ./node_modules/.bin/playwright test --project=screenshots decisions-chip-review --workers=1
 *
 * Env knobs:
 *   DAINTREE_SHOT_DECISIONS_CHIP  required — any truthy value runs the capture
 *   DESIGN_CAPTURE_DIR            required — output directory (never the repo)
 *   DAINTREE_SHOT_THEMES          comma-separated theme ids (default daintree,bondi,namib)
 *   DAINTREE_SCREENSHOT_SCALE     device scale factor (default 2)
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

const ENABLED = !!process.env.DAINTREE_SHOT_DECISIONS_CHIP;
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
const POLISH_ID = "pw-decisions-chip-polish";
const POLISH_CSS = `
  *, *::before, *::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
    caret-color: transparent !important;
  }
`;

const THEMED_STATES = ["grid", "popover-several"] as const;
const DAINTREE_STATES = [
  "header-open",
  "header-answered",
  "header-attention",
  "header-several",
  "popover-open",
  "popover-attention",
  "tooltip-several",
  "notify-unfocused",
  "focus-open",
  "narrow",
  "canopy",
  "off",
] as const;
type State = (typeof THEMED_STATES)[number] | (typeof DAINTREE_STATES)[number];
const STATES: readonly State[] = [...THEMED_STATES, ...DAINTREE_STATES];

function git(cmd: string, cwd: string): void {
  execSync(`git ${cmd}`, { cwd, stdio: "ignore" });
}

/** Own prefix: the shared e2e temp reaper never touches it. */
function createRepo(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "dchipshot-helios-"));
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

/** Main answers these ops from a table the harness fills, until the run ends. */
async function answerDecisions(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ ipcMain }) => {
    const g = globalThis as unknown as {
      __dchip?: { status: unknown; panes: Record<string, unknown> };
    };
    g.__dchip = { status: { state: "off" }, panes: {} };
    ipcMain.removeHandler("decisions:get-status");
    ipcMain.handle("decisions:get-status", async () => g.__dchip!.status);
    ipcMain.removeHandler("decisions:get-pane-state");
    ipcMain.handle(
      "decisions:get-pane-state",
      async (_e, terminalId: string) => g.__dchip!.panes[terminalId] ?? null
    );
  });
}

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
    (globalThis as unknown as { __dchip: { status: unknown } }).__dchip.status = next;
  }, status);
  await pushEvent(app, "decisions:status-changed", status);
}

async function setPane(
  app: ElectronApplication,
  state: Omit<PaneDecisionState, "revision">
): Promise<void> {
  const full = { ...state, revision: nextRevision() };
  await app.evaluate((_e, next) => {
    (globalThis as unknown as { __dchip: { panes: Record<string, unknown> } }).__dchip.panes[
      next.terminalId
    ] = next;
  }, full);
  await pushEvent(app, "terminal:decision-state", full);
}

/** Hold main's own fleet broadcasts back, so only the snapshot the harness pushes reaches Canopy. */
async function freezeFleet(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ webContents, app: electronApp }) => {
    const g = globalThis as unknown as { __dchipFrozen?: boolean };
    if (g.__dchipFrozen) return;
    g.__dchipFrozen = true;
    const held = new Set(["fleet:snapshot-updated"]);
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
// The four panes' Decisions state

interface Panes {
  open: string;
  answered: string;
  attention: string;
  several: string;
}

function iso(msAgo: number): string {
  return new Date(Date.now() - msAgo).toISOString();
}

async function seed(app: ElectronApplication, panes: Panes): Promise<void> {
  await setPane(app, {
    terminalId: panes.open,
    openQuestions: [
      {
        questionId: "qid-open-42",
        alias: 42,
        status: "open",
        askedAt: iso(6 * 60_000),
        expiresAt: new Date(Date.now() + 3 * 3_600_000).toISOString(),
      },
    ],
    waitingAnswers: [],
    needsAttention: [],
  });
  await setPane(app, {
    terminalId: panes.answered,
    openQuestions: [],
    waitingAnswers: [
      { questionId: "qid-ans-41", alias: 41, kind: "answer", deliveryStatus: "desktop-received" },
    ],
    needsAttention: [],
  });
  await setPane(app, {
    terminalId: panes.attention,
    openQuestions: [],
    waitingAnswers: [],
    needsAttention: [
      {
        questionId: "qid-att-38",
        alias: 38,
        deliveryStatus: "needs-attention",
        reason: "relaunched",
      },
    ],
  });
  await setPane(app, {
    terminalId: panes.several,
    openQuestions: [
      {
        questionId: "qid-sev-44",
        alias: 44,
        status: "open",
        askedAt: iso(25 * 60_000),
        expiresAt: null,
      },
      {
        questionId: "qid-sev-45",
        alias: 45,
        status: "queued",
        askedAt: iso(20_000),
        expiresAt: null,
      },
    ],
    waitingAnswers: [
      { questionId: "qid-sev-43", alias: 43, kind: "answer", deliveryStatus: "desktop-received" },
    ],
    needsAttention: [
      {
        questionId: "qid-sev-39",
        alias: 39,
        deliveryStatus: "delivery-uncertain",
        reason: "inject_ambiguous",
      },
    ],
  });
  // The chip's neighbour, on the pane with one question out.
  await pushEvent(app, "terminal:notify-state", {
    terminalId: panes.open,
    pendingCount: 2,
    readyCount: 0,
    delivery: { status: "idle" },
    revision: nextRevision(),
  });
}

const EXPECTED_LABEL: Record<keyof Panes, RegExp> = {
  open: /^q-42$/,
  answered: /^q-41 delivering$/,
  attention: /^q-38$/,
  several: /^4 ?(· 1 delivering)?$/,
};

async function chipText(page: Page, id: string): Promise<string | null> {
  return page.evaluate(
    ({ id, sel }) => {
      const chip = document.querySelector<HTMLElement>(
        `[data-panel-id="${id}"][data-panel-location="grid"] ${sel}`
      );
      return chip ? (chip.innerText ?? "").replace(/\s+/g, " ").trim() : null;
    },
    { id, sel: CHIP }
  );
}

async function expectChips(page: Page, panes: Panes): Promise<void> {
  for (const key of Object.keys(panes) as (keyof Panes)[]) {
    await expect
      .poll(() => chipText(page, panes[key]), {
        timeout: 15_000,
        message: `chip on the ${key} pane`,
      })
      .toMatch(EXPECTED_LABEL[key]);
  }
}

/** The notices chip, the Decisions chip's neighbour, on `id`; says what the header holds when it isn't. */
async function expectNotifyChip(app: ElectronApplication, page: Page, id: string): Promise<void> {
  await pushEvent(app, "terminal:notify-state", {
    terminalId: id,
    pendingCount: 2,
    readyCount: 0,
    delivery: { status: "idle" },
    revision: nextRevision(),
  });
  const read = () =>
    page.evaluate((paneId) => {
      const header = document.querySelector<HTMLElement>(
        `[data-panel-id="${paneId}"][data-panel-location="grid"] [data-testid="panel-header-content"]`
      );
      return {
        inPane: document.querySelectorAll(
          `[data-panel-id="${paneId}"][data-panel-location="grid"] [data-testid="terminal-notify-chip"]`
        ).length,
        anywhere: document.querySelectorAll('[data-testid="terminal-notify-chip"]').length,
        header: (header?.innerText ?? "<no header content>").replace(/\s+/g, " ").trim(),
      };
    }, id);
  const ok = await expect
    .poll(async () => (await read()).inPane, { timeout: 8000 })
    .toBe(1)
    .then(() => true)
    .catch(() => false);
  if (!ok) throw new Error(`the notices chip beside it: ${JSON.stringify(await read())}`);
}

async function expectNoChips(page: Page): Promise<void> {
  await expect
    .poll(() => page.locator(CHIP).count(), { timeout: 15_000, message: "chips still showing" })
    .toBe(0);
}

// ---------------------------------------------------------------------------
// Frames

async function paneBox(
  page: Page,
  id: string
): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await page
    .locator(`[data-panel-id="${id}"][data-panel-location="grid"]`)
    .first()
    .boundingBox();
  if (!box || box.width < 100) throw new Error(`pane ${id} not on screen`);
  return box;
}

async function snapGrid(page: Page, state: State, theme: string): Promise<void> {
  await settle(page);
  const box = await page.locator('[role="region"][aria-label="Panels"]').first().boundingBox();
  if (!box || box.width < 200) throw new Error("panel region not on screen");
  await page.screenshot({ path: outFile(state, theme), type: "png", caret: "hide", clip: box });
}

/** The pane's header strip and the first lines under it. */
async function snapHeader(page: Page, state: State, theme: string, id: string): Promise<void> {
  await settle(page);
  const box = await paneBox(page, id);
  const clip = { x: box.x - 2, y: box.y - 2, width: box.width + 4, height: 64 };
  await page.screenshot({ path: outFile(state, theme), type: "png", caret: "hide", clip });
}

/** The pane and whatever floats over it from its header (popover, tooltip). */
async function snapPaneWithLayer(
  page: Page,
  state: State,
  theme: string,
  id: string,
  layer: string,
  settleMs = 400
): Promise<void> {
  if (settleMs > 0) await settle(page, settleMs);
  const pane = await paneBox(page, id);
  const float = await page.locator(layer).first().boundingBox();
  if (!float) throw new Error(`${layer} not on screen`);
  const view = page.viewportSize() ?? WINDOW;
  const x0 = Math.max(0, Math.min(pane.x, float.x) - 8);
  const y0 = Math.max(0, pane.y - 2);
  const x1 = Math.min(view.width, Math.max(pane.x + pane.width, float.x + float.width) + 8);
  const y1 = Math.min(view.height, Math.max(pane.y + 240, float.y + float.height + 12));
  await page.screenshot({
    path: outFile(state, theme),
    type: "png",
    caret: "hide",
    clip: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 },
  });
}

const POPOVER = '[data-testid="terminal-decisions-popover"]';

async function openPopover(page: Page, id: string): Promise<void> {
  await closePopover(page);
  await page.locator(`[data-panel-id="${id}"][data-panel-location="grid"] ${CHIP}`).click();
  await page.locator(POPOVER).waitFor({ state: "visible", timeout: 8000 });
  await expect(page.locator(POPOVER), "one popover open").toHaveCount(1);
  await parkPointer(page);
}

/** Closes an open popover from inside it; an Escape anywhere else would reach the terminal. */
async function closePopover(page: Page): Promise<void> {
  for (let i = 0; i < 3 && (await page.locator(POPOVER).count()) > 0; i++) {
    await page
      .locator(POPOVER)
      .first()
      .focus()
      .catch(() => {});
    await page.keyboard.press("Escape").catch(() => {});
    await settle(page, 250);
  }
}

interface Run {
  app: ElectronApplication;
  page: Page;
  panes: Panes;
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
    if (!existsSync(outFile(state, theme))) throw new Error("PNG did not land");
    console.log(`[decisions-chip] wrote ${state}--${theme} (${Date.now() - started}ms)`);
  } catch (error) {
    rmSync(outFile(state, theme), { force: true });
    const message = `${state}--${theme}: ${String(error).split("\n")[0]}`;
    run.failures.push(message);
    console.warn(`[decisions-chip] FAILED ${message}`);
  } finally {
    await closePopover(run.page);
  }
}

function expectedFiles(): string[] {
  const out: string[] = [];
  for (const s of THEMED_STATES) for (const t of THEMES) out.push(`${s}--${t}.png`);
  if (THEMES.includes("daintree")) for (const s of DAINTREE_STATES) out.push(`${s}--daintree.png`);
  return out.sort();
}

async function ready(page: Page, panes: Panes): Promise<void> {
  await focusPane(page, panes.open);
  await parkPointer(page);
  await expectChips(page, panes);
  await settle(page, 600);
}

async function themedStates(run: Run, theme: string): Promise<void> {
  const { page, panes } = run;
  await shoot(run, "grid", theme, async () => {
    await ready(page, panes);
    await snapGrid(page, "grid", theme);
  });
  await shoot(run, "popover-several", theme, async () => {
    await ready(page, panes);
    await openPopover(page, panes.several);
    const text = await page.locator(POPOVER).first().innerText();
    for (const alias of ["q-39", "q-43", "q-44", "q-45"]) {
      if (!text.includes(alias)) throw new Error(`popover is missing ${alias}`);
    }
    await snapPaneWithLayer(page, "popover-several", theme, panes.several, POPOVER);
  });
}

async function daintreeStates(run: Run): Promise<void> {
  const { app, page, panes } = run;
  const theme = "daintree";
  const headers: Array<[State, keyof Panes]> = [
    ["header-open", "open"],
    ["header-answered", "answered"],
    ["header-attention", "attention"],
    ["header-several", "several"],
  ];
  for (const [state, key] of headers) {
    await shoot(run, state, theme, async () => {
      await ready(page, panes);
      if (key === "open") await expectNotifyChip(app, page, panes.open);
      await snapHeader(page, state, theme, panes[key]);
    });
  }
  await shoot(run, "popover-open", theme, async () => {
    await ready(page, panes);
    await openPopover(page, panes.open);
    await expect(page.locator(POPOVER).first()).toContainText("Waiting for an answer");
    await snapPaneWithLayer(page, "popover-open", theme, panes.open, POPOVER);
  });
  await shoot(run, "popover-attention", theme, async () => {
    await ready(page, panes);
    await openPopover(page, panes.attention);
    await expect(page.locator(POPOVER).first()).toContainText("needs attention");
    await snapPaneWithLayer(page, "popover-attention", theme, panes.attention, POPOVER);
  });
  await shoot(run, "tooltip-several", theme, async () => {
    await ready(page, panes);
    // Reached from the keyboard, the way the summary also reaches a screen
    // reader: Tab onto the chip opens its tooltip.
    const chip = page.locator(
      `[data-panel-id="${panes.several}"][data-panel-location="grid"] ${CHIP}`
    );
    await chip.focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    // The popper wrapper holding the summary: Radix's role="tooltip" node is a
    // visually hidden copy, so it can't be measured for what shows.
    const tip = "[data-radix-popper-content-wrapper]:has-text('Decisions question')";
    await page.locator(tip).first().waitFor({ state: "visible", timeout: 8000 });
    // Tooltips here dismiss themselves after 2.5 s: a frame to place it, then shoot.
    await snapPaneWithLayer(page, "tooltip-several", theme, panes.several, tip, 150);
  });
  await shoot(run, "notify-unfocused", theme, async () => {
    // The neighbour's popover, opened from a pane that isn't the focused one:
    // the same press that selected the pane used to close it again.
    await ready(page, panes);
    await expectNotifyChip(app, page, panes.open);
    await focusPane(page, panes.answered);
    await page
      .locator(
        `[data-panel-id="${panes.open}"][data-panel-location="grid"] [data-testid="terminal-notify-chip"]`
      )
      .click();
    const layer = page
      .locator('[role="dialog"][data-state="open"]')
      .filter({ hasText: "Stop notices" });
    await layer.first().waitFor({ state: "visible", timeout: 8000 });
    await parkPointer(page);
    await snapPaneWithLayer(
      page,
      "notify-unfocused",
      theme,
      panes.open,
      '[role="dialog"][data-state="open"]'
    );
    await page.keyboard.press("Escape");
  });
  await shoot(run, "focus-open", theme, async () => {
    await ready(page, panes);
    await page
      .locator(`[data-panel-id="${panes.open}"][data-panel-location="grid"] ${CHIP}`)
      .focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    const focused = await page.evaluate(
      (sel) => document.activeElement?.matches(sel) ?? false,
      CHIP
    );
    if (!focused) throw new Error("the chip doesn't hold the keyboard");
    await snapHeader(page, "focus-open", theme, panes.open);
  });
  await shoot(run, "narrow", theme, async () => {
    await act(page, "panel.gridLayout.setStrategy", { strategy: "fixed-columns" });
    await act(page, "panel.gridLayout.setValue", { value: 3 });
    await settle(page, 1200);
    try {
      await ready(page, panes);
      await page
        .locator(`[data-panel-id="${panes.several}"][data-panel-location="grid"]`)
        .first()
        .scrollIntoViewIfNeeded();
      const box = await paneBox(page, panes.several);
      if (box.width > 560) throw new Error(`pane is ${box.width}px wide, not narrow`);
      // The whole chip, warning glyph included, inside the header's clip.
      const overflow = await page.evaluate(
        ({ id, sel }) => {
          const chip = document.querySelector<HTMLElement>(
            `[data-panel-id="${id}"][data-panel-location="grid"] ${sel}`
          );
          const clip = chip?.closest<HTMLElement>('[data-testid="panel-header-content"]');
          if (!chip || !clip) return Number.POSITIVE_INFINITY;
          return chip.getBoundingClientRect().right - clip.getBoundingClientRect().right;
        },
        { id: panes.several, sel: CHIP }
      );
      if (overflow > 0.5) throw new Error(`chip runs ${overflow}px past the header's clip`);
      await snapHeader(page, "narrow", theme, panes.several);
    } finally {
      await act(page, "panel.gridLayout.setStrategy", { strategy: "automatic" });
      await settle(page, 1200);
    }
  });
  await shoot(run, "canopy", theme, async () => {
    await ready(page, panes);
    await freezeFleet(app);
    const snapshot = (await page.evaluate(() => window.electron.fleet.getSnapshot())) as {
      runs: Array<Record<string, unknown> & { runId: string }>;
    } | null;
    if (!snapshot || !snapshot.runs.some((r) => r.runId === panes.attention)) {
      throw new Error("the attention pane isn't in the fleet");
    }
    const runs = snapshot.runs.map((r) =>
      r.runId === panes.attention || r.runId === panes.several ? { ...r, answerAttention: 1 } : r
    );
    const pushed = { ...snapshot, runs, changedAt: Date.now() };
    await pushRaw(app, "fleet:snapshot-updated", pushed);
    await page.keyboard.press(process.platform === "darwin" ? "Meta+E" : "Control+Shift+O");
    const dialog = page.locator('[role="dialog"]').filter({ hasText: "Canopy" }).first();
    await dialog.waitFor({ state: "visible", timeout: 8000 });
    await pushRaw(app, "fleet:snapshot-updated", pushed);
    await settle(page, 1500);
    await expect(dialog).toContainText("Answer needs attention", { timeout: 10_000 });
    await parkPointer(page);
    await settle(page, 400);
    await page.screenshot({ path: outFile("canopy", theme), type: "png", caret: "hide" });
    for (let i = 0; i < 3 && (await dialog.isVisible().catch(() => false)); i++) {
      await page.keyboard.press("Escape").catch(() => {});
      await settle(page, 250);
    }
  });
  await shoot(run, "off", theme, async () => {
    await setStatus(app, "off");
    await focusPane(page, panes.open);
    await expectNoChips(page);
    await snapHeader(page, "off", theme, panes.open);
  });
}

test("capture the Decisions pane chip across states and themes", async () => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_DECISIONS_CHIP is required for the Decisions chip capture",
  });
  test.skip(!ENABLED, "design capture harness — set DAINTREE_SHOT_DECISIONS_CHIP=1");
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
  const userDataDir = mkdtempSync(path.join(tmpdir(), "dchipshot-ud-"));
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
      open: await launchAgent(page, binDir, featureId),
      answered: await launchAgent(page, binDir, featureId),
      attention: await launchAgent(page, binDir, featureId),
      several: await launchAgent(page, binDir, featureId),
    };
    await act(page, "terminal.rename", {
      terminalId: panes.open,
      name: "fix flaky auth token refresh tests",
    });
    // Long enough that a narrow pane has to choose between the title and its chips.
    await act(page, "terminal.rename", {
      terminalId: panes.several,
      name: "migrate billing webhooks to the queue consumer and backfill failed retries",
    });
    console.log(`[decisions-chip] panes ${JSON.stringify(panes)}`);

    await answerDecisions(app);
    // Off first: nothing shows, and nothing is read for any pane.
    await expectNoChips(page);
    await setStatus(app, "connected");
    await seed(app, panes);
    await expectChips(page, panes);

    const run: Run = { app, page, panes, failures };
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
      `[decisions-chip] wrote ${present.length}/${expected.length} PNGs to ${OUTPUT_DIR}`
    );
    expect(failures, "state captures failed").toEqual([]);
    expect(missing, "files missing from the output directory").toEqual([]);
  } finally {
    if (ctx?.app) await closeApp(ctx.app).catch(() => {});
    repo.cleanup();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
