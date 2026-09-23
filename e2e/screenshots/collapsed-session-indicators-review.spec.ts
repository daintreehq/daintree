/**
 * `CollapsedSessionIndicators` visual-review harness.
 *
 * The indicator is the glyph-and-count cluster a row shows in place of its
 * session list: on a collapsed worktree card (beside the alarm pill), on an
 * expanded card whose Sessions disclosure is closed, and on the single row a
 * worktree-less workspace contributes to the sidebar. It only has anything to
 * draw while agents are live, and the states that matter are mixtures — one
 * working, one waiting, one being typed into — so this harness manufactures
 * them with real fake-claude PTYs driven through the app's own FSM:
 *
 *   - working    the fake agent's OSC 9;4 heartbeat plus a visible output
 *                stream (a heartbeat over a static screen is demoted early)
 *   - waiting    the stream and heartbeat stop; the FSM settles
 *   - directing  real keystrokes into a waiting agent's xterm, which is the
 *                only path `TerminalAgentStateController.onUserInput` takes
 *
 * The alarm pill beside it is real too: the fixture advances `main` after the
 * worktree is cut, so the card is genuinely behind its base.
 *
 * Opt-in only, like the sibling review harnesses:
 *
 *   DAINTREE_SHOT_INDICATORS=1 npx playwright test --project=screenshots collapsed-session-indicators-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_INDICATORS  required — any truthy value runs the capture
 *   DESIGN_CAPTURE_DIR        output directory (default artifacts/indicator-shots)
 *   DAINTREE_SHOT_TAG         optional suffix so review rounds sit side by side
 *   DAINTREE_SHOT_THEMES      comma-separated theme sweep (default: every built-in)
 *
 * Hard rule, as in the other review harnesses: never write a PNG that has not
 * been verified. Every capture asserts the indicator is on screen carrying the
 * accessible name of the state it is named for, and throws otherwise.
 */

import { test, expect, type Locator, type Page } from "@playwright/test";
import { execSync } from "child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { launchApp, closeApp, refreshActiveWindow, type AppContext } from "../helpers/launch";
import { openAndOnboardProject } from "../helpers/project";
import { dismissBlockingPalette } from "../helpers/overlays";
import { setAppTheme } from "../helpers/theme";
import { getGridPanelIds } from "../helpers/panels";
import { getTerminalText, waitForTerminalText, writeTerminalInput } from "../helpers/terminal";
import {
  installFakeAgent,
  fakeAgentEnv,
  FAKE_AGENT_READY,
  FAKE_AGENT_IDLE,
  FAKE_AGENT_STREAM_ON,
  FAKE_AGENT_STREAM_OFF,
} from "../helpers/fakeAgent";
import { SEL } from "../helpers/selectors";
import { T_LONG } from "../helpers/timeouts";

const ENABLED = !!process.env.DAINTREE_SHOT_INDICATORS;
const TAG = process.env.DAINTREE_SHOT_TAG ? `-${process.env.DAINTREE_SHOT_TAG}` : "";
const SCALE = process.env.DAINTREE_SCREENSHOT_SCALE ?? "2";
const OUTPUT_DIR = process.env.DESIGN_CAPTURE_DIR
  ? path.resolve(process.env.DESIGN_CAPTURE_DIR)
  : path.resolve(process.cwd(), "artifacts", "indicator-shots");

const ALL_THEMES = [
  "arashiyama",
  "atacama",
  "bali",
  "bondi",
  "daintree",
  "fiordland",
  "galapagos",
  "highlands",
  "hokkaido",
  "movile",
  "namib",
  "redwoods",
  "serengeti",
  "svalbard",
  "table-mountain",
];
const SWEEP_THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

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

const SIDEBAR_RESIZE = '[role="separator"][aria-label^="Resize sidebar"]';
const INDICATORS = '[data-testid="collapsed-session-indicators"]';

/**
 * Two worktrees. `busy` carries three agents and is behind its base, so its
 * collapsed header holds the alarm pill and the indicator together — the pair
 * the header has to balance. `solo` carries one agent and no alarm, which is
 * the indicator standing alone in the same slot.
 */
const WORKTREES = {
  busy: { branch: "feature/issue-4821-stream-upload-retry-with-backoff", slug: "stream-upload" },
  solo: { branch: "fix/retry-backoff-jitter", slug: "retry-jitter" },
} as const;

function git(cmd: string, cwd: string): void {
  execSync(`git ${cmd}`, { cwd, stdio: "ignore" });
}

function createFixtureRepo(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "daintree-indshots-"));
  const worktreeRoot = path.join(path.dirname(dir), `${path.basename(dir)}-worktrees`);
  mkdirSync(worktreeRoot, { recursive: true });

  git("init -b main", dir);
  git('config user.email "avery@helios.dev"', dir);
  git('config user.name "Avery Lindqvist"', dir);
  mkdirSync(path.join(dir, "src"), { recursive: true });
  writeFileSync(path.join(dir, "README.md"), "# Helios Dashboard\n");
  writeFileSync(path.join(dir, "src", "retry.ts"), "export const ATTEMPTS = 3;\n");
  git("add -A", dir);
  git('commit -m "Set up the ingest console skeleton"', dir);

  for (const wt of Object.values(WORKTREES)) {
    git(`worktree add -b ${wt.branch} "${path.join(worktreeRoot, wt.slug)}" main`, dir);
  }

  // Advance main after both worktrees are cut, so each is genuinely behind its
  // base and the collapsed header raises the real "Behind" alarm.
  writeFileSync(path.join(dir, "src", "retry.ts"), "export const ATTEMPTS = 5;\n");
  git("add -A", dir);
  git('commit -m "Raise the default retry budget"', dir);

  return {
    dir,
    cleanup: () => {
      if (existsSync(worktreeRoot)) rmSync(worktreeRoot, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function settle(page: Page, ms = 500): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
  );
  await page.waitForTimeout(ms);
}

const written = new Set<string>();

/**
 * Capture `target`, but only once the indicator inside `scope` is visible and
 * names the state this shot is for. `clip` crops the page to the target's box
 * grown by `pad`, which is how the tight header and tooltip shots are taken.
 */
async function snap(
  page: Page,
  slug: string,
  target: Locator,
  opts: { scope?: Locator; expectLabel?: RegExp; pad?: number; clip?: boolean } = {}
): Promise<void> {
  await settle(page);
  const file = path.join(OUTPUT_DIR, `${slug}${TAG}.png`);
  await expect(target, `"${slug}": target never became visible — refusing to write`).toBeVisible({
    timeout: T_LONG,
  });
  if (opts.expectLabel) {
    const indicator = (opts.scope ?? target).locator(INDICATORS).first();
    await expect(
      indicator,
      `"${slug}": indicator label is wrong — refusing to write`
    ).toHaveAttribute("aria-label", opts.expectLabel, { timeout: T_LONG });
  }
  const box = await target.boundingBox();
  if (!box || box.width < 12 || box.height < 8) {
    throw new Error(`"${slug}": target box is ${JSON.stringify(box)} — refusing to write`);
  }
  if (opts.clip) {
    const pad = opts.pad ?? 12;
    const viewport = page.viewportSize() ?? { width: 1680, height: 1050 };
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
  } else {
    await target.screenshot({ path: file, type: "png", animations: "disabled", caret: "hide" });
  }
  written.add(`${slug}${TAG}.png`);
}

const stepFailures: string[] = [];
async function step(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    const detail = String(error).slice(0, 400);
    stepFailures.push(`${name}: ${detail}`);
    console.warn(`[indicator-shots] step "${name}" FAILED:`, detail);
  }
}

const row = (page: Page, branch: string): Locator => page.locator(SEL.worktree.row(branch)).first();
const card = (rowLocator: Locator): Locator => rowLocator.locator(".sidebar-worktree-card").first();

/**
 * Select a worktree through the card's own select overlay. A plain click on
 * the card lands on whatever child sits under its centre (the path button, a
 * disclosure), which does something else entirely.
 */
async function selectCard(rowLocator: Locator): Promise<void> {
  await rowLocator.locator("[data-card-select-overlay]").first().dispatchEvent("click");
  await expect(card(rowLocator), "worktree did not become active").toHaveAttribute(
    "data-active",
    "true",
    { timeout: T_LONG }
  );
}

async function setCardCollapsed(rowLocator: Locator, collapsed: boolean): Promise<void> {
  const toggle = rowLocator
    .locator(
      '[data-worktree-row-toolbar] [aria-label="Expand card"], [data-worktree-row-toolbar] [aria-label="Collapse card"]'
    )
    .first();
  await expect(toggle, "card collapse toggle is missing").toBeVisible({ timeout: T_LONG });
  const expanded = (await toggle.getAttribute("aria-expanded")) === "true";
  if (expanded === collapsed) {
    await toggle.click();
    await rowLocator.page().waitForTimeout(400);
  }
  await expect(toggle, `card did not reach collapsed=${collapsed}`).toHaveAttribute(
    "aria-expanded",
    collapsed ? "false" : "true",
    { timeout: T_LONG }
  );
}

async function setSection(
  rowLocator: Locator,
  kind: "details" | "terminals",
  expanded: boolean
): Promise<void> {
  const button = rowLocator.locator(`[id$="-${kind}-button"]`).first();
  if (!(await button.isVisible().catch(() => false))) return;
  if (((await button.getAttribute("aria-expanded")) === "true") !== expanded) {
    await button.click();
    await rowLocator.page().waitForTimeout(350);
  }
}

async function setSidebarWidth(page: Page, target: number): Promise<void> {
  const handle = page.locator(SIDEBAR_RESIZE).first();
  if (!(await handle.isVisible().catch(() => false))) return;
  await handle.focus();
  const start = Number((await handle.getAttribute("aria-valuenow")) ?? "0");
  const key = target < start ? "ArrowLeft" : "ArrowRight";
  for (let i = 0; i < 60; i++) {
    const now = Number((await handle.getAttribute("aria-valuenow")) ?? "0");
    if (Math.abs(now - target) <= 12) break;
    if (target < start && now <= target) break;
    if (target > start && now >= target) break;
    await page.keyboard.press(key);
  }
  await page.waitForTimeout(250);
}

/** The pointer is parked off the sidebar so no row renders its hovered form. */
async function parkPointer(page: Page): Promise<void> {
  await page.mouse.move(1600, 980);
  await page.waitForTimeout(150);
}

async function launchAgentSession(page: Page): Promise<string> {
  const before = new Set(await getGridPanelIds(page));
  await dismissBlockingPalette(page).catch(() => {});
  await page.locator(SEL.agent.trayButton).click();
  await page.locator(SEL.agent.launcherRow("Claude")).first().click();

  let panelId: string | null = null;
  for (let i = 0; i < 80 && !panelId; i++) {
    const ids = await getGridPanelIds(page).catch(() => [] as string[]);
    panelId = ids.find((id) => !before.has(id)) ?? null;
    if (!panelId) await page.waitForTimeout(250);
  }
  if (!panelId) throw new Error("agent panel never appeared");

  const panel = page.locator(`[data-panel-id="${panelId}"]`);
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const text = (await getTerminalText(panel).catch(() => "")).toLowerCase();
    if (text.includes(FAKE_AGENT_READY.toLowerCase())) break;
    if (text.includes("enter to confirm") || text.includes("trust this folder")) {
      await writeTerminalInput(page, panel, "\r").catch(() => {});
      break;
    }
    await page.waitForTimeout(250);
  }
  await waitForTerminalText(panel, FAKE_AGENT_READY, T_LONG);
  await writeTerminalInput(page, panel, `${FAKE_AGENT_STREAM_ON}\r`);
  await expectAgentState(page, panelId, "working");
  return panelId;
}

async function expectAgentState(page: Page, panelId: string, state: string): Promise<void> {
  const panel = page.locator(`[data-panel-id="${panelId}"]`);
  await expect
    .poll(() => panel.getAttribute("data-agent-state"), {
      message: `agent ${panelId} never reached ${state}`,
      timeout: T_LONG * 3,
      intervals: [300, 600, 1000],
    })
    .toBe(state)
    .catch(async (error: unknown) => {
      const seen = await page.evaluate(
        (id) =>
          Array.from(document.querySelectorAll(`[data-panel-id="${id}"]`)).map((el) => ({
            tag: el.tagName,
            state: el.getAttribute("data-agent-state"),
            cls: el.className.toString().slice(0, 80),
          })),
        panelId
      );
      throw new Error(`${String(error).slice(0, 200)} — saw ${JSON.stringify(seen)}`);
    });
}

async function driveWaiting(page: Page, panelId: string): Promise<void> {
  const panel = page.locator(`[data-panel-id="${panelId}"]`);
  await writeTerminalInput(page, panel, `${FAKE_AGENT_STREAM_OFF}\r`);
  await writeTerminalInput(page, panel, `${FAKE_AGENT_IDLE}\r`);
  await expectAgentState(page, panelId, "waiting");
}

/**
 * Directing is renderer-only: it is raised by keystrokes arriving through
 * xterm's onData while the agent is canonically waiting. `terminal.write`
 * bypasses that path, so this types into the focused xterm for real. Five or
 * more characters buys the long (10s) debounce, which is the capture window.
 */
async function driveDirecting(page: Page, panelId: string): Promise<void> {
  const panel = page.locator(`[data-panel-id="${panelId}"]`);
  await panel.locator(".xterm").first().click();
  await page.keyboard.type("tighten the jitter bound", { delay: 15 });
  await expectAgentState(page, panelId, "directing");
}

test("collapsed session indicators review — placements, states and themes", async () => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_INDICATORS is required for the indicator capture",
  });
  test.skip(!ENABLED, "Set DAINTREE_SHOT_INDICATORS to run the indicator capture");
  test.setTimeout(15 * 60_000);

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const repo = createFixtureRepo();
  const fakeBinDir = installFakeAgent(repo.dir, { streamLinesPerSec: 2 });
  const userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-indshot-"));
  let ctx: AppContext | undefined;

  try {
    ctx = await launchApp({
      userDataDir,
      screenshotScale: SCALE,
      windowSize: { width: 1680, height: 1050 },
      env: fakeAgentEnv(fakeBinDir),
      extraArgs: ["--disable-gpu", "--in-process-gpu", "--disable-breakpad", "--noerrdialogs"],
    });
    let page = await openAndOnboardProject(ctx.app, ctx.window, repo.dir, "Helios Dashboard");
    await setAppTheme(page, "daintree");
    await page.addStyleTag({ content: POLISH_CSS }).catch(() => {});
    await dismissBlockingPalette(page);

    const sidebar = page.locator(SEL.sidebar.aside).first();
    const busy = row(page, WORKTREES.busy.branch);
    const solo = row(page, WORKTREES.solo.branch);
    await expect(busy, "busy worktree card never rendered").toBeVisible({ timeout: T_LONG });
    await expect(solo, "solo worktree card never rendered").toBeVisible({ timeout: T_LONG });
    await settle(page, 1500);

    // Agents land in the active worktree: one in `solo`, three in `busy`.
    await selectCard(solo);
    const soloAgent = await launchAgentSession(page);
    await selectCard(busy);
    const agents: string[] = [];
    for (let i = 0; i < 3; i++) agents.push(await launchAgentSession(page));
    void soloAgent;
    await dismissBlockingPalette(page);

    // The busy card must not be active for the resting collapsed shots: an
    // active collapsed card grows a sub-line. Select the project's main row.
    const activateOther = async () => {
      await selectCard(page.locator("[data-worktree-row]").first());
      await parkPointer(page);
    };

    // 1. All working — one segment, the simplest thing the cluster draws.
    await step("working", async () => {
      await setCardCollapsed(busy, true);
      await setCardCollapsed(solo, true);
      await activateOther();
      await snap(page, "10-header-working", card(busy), { expectLabel: /^3 sessions: 3 working$/ });
      await snap(page, "11-header-solo", card(solo), { expectLabel: /^1 session: 1 working$/ });
    });

    // Panels mount only for the active worktree, so every drive happens with
    // `busy` selected and the shots are taken after moving selection away.
    const inBusy = async (fn: () => Promise<void>) => {
      await selectCard(busy);
      await fn();
      await activateOther();
    };

    // 2. Mixed — two working, one waiting. The state every other shot keys off.
    await inBusy(() => driveWaiting(page, agents[0]!));
    const mixed = /^3 sessions: 2 working, 1 waiting$/;
    await step("mixed", async () => {
      await snap(page, "20-header-mixed", card(busy), { expectLabel: mixed });
      const headerCluster = busy.locator(INDICATORS).first();
      await snap(page, "21-header-mixed-zoom", headerCluster, {
        expectLabel: mixed,
        scope: busy,
        clip: true,
        pad: 40,
      });
      await snap(page, "22-sidebar-collapsed-mixed", sidebar, { scope: busy, expectLabel: mixed });
    });

    // 3. The tooltip, from a real hover on the cluster.
    await step("tooltip", async () => {
      const cluster = busy.locator(INDICATORS).first();
      await cluster.hover();
      const tip = page.locator('[role="tooltip"]').first();
      await expect(tip, "tooltip never opened").toBeVisible({ timeout: T_LONG });
      await settle(page, 300);
      const tipBox = await tip.boundingBox();
      const clusterBox = await cluster.boundingBox();
      if (!tipBox || !clusterBox) throw new Error("tooltip or cluster has no box");
      const x = Math.max(0, Math.min(tipBox.x, clusterBox.x) - 24);
      const y = Math.max(0, Math.min(tipBox.y, clusterBox.y) - 16);
      const right = Math.max(tipBox.x + tipBox.width, clusterBox.x + clusterBox.width) + 24;
      const bottom = Math.max(tipBox.y + tipBox.height, clusterBox.y + clusterBox.height) + 16;
      await page.screenshot({
        path: path.join(OUTPUT_DIR, `30-tooltip${TAG}.png`),
        clip: { x, y, width: right - x, height: bottom - y },
        animations: "disabled",
        caret: "hide",
      });
      written.add(`30-tooltip${TAG}.png`);
      await parkPointer(page);
    });

    // 4. Expanded card, Sessions disclosure closed — the second placement.
    await step("sessions-collapsed", async () => {
      await setCardCollapsed(busy, false);
      await setSection(busy, "details", false);
      await setSection(busy, "terminals", false);
      await parkPointer(page);
      const trigger = busy.locator('[id$="-terminals-button"]').first();
      await snap(page, "40-sessions-row-mixed", trigger, {
        scope: busy,
        expectLabel: mixed,
        clip: true,
        pad: 8,
      });
      await snap(page, "41-card-sessions-collapsed", card(busy), { expectLabel: mixed });
      await setCardCollapsed(busy, true);
      await activateOther();
    });

    // 5. Narrow sidebar: the cluster competing with the branch name and pill.
    await step("narrow", async () => {
      await setSidebarWidth(page, 240);
      await parkPointer(page);
      await snap(page, "50-header-narrow", card(busy), { expectLabel: mixed });
      await setSidebarWidth(page, 320);
      await parkPointer(page);
    });

    // 6. High contrast, both halves.
    await step("contrast", async () => {
      await page.emulateMedia({ contrast: "more" });
      await snap(page, "60-header-prefers-contrast", card(busy), { expectLabel: mixed });
      await page.emulateMedia({ contrast: "no-preference", forcedColors: "active" });
      await snap(page, "61-header-forced-colors", card(busy), { expectLabel: mixed });
      await page.emulateMedia({ forcedColors: "none" });
    });

    // 7. Theme sweep of the mixed header. Theme switches reload the renderer;
    //    working and waiting live in main and survive it.
    await step("themes", async () => {
      const themes = SWEEP_THEMES.length > 0 ? SWEEP_THEMES : ALL_THEMES;
      for (const theme of themes) {
        await setAppTheme(page, theme);
        await page.addStyleTag({ content: POLISH_CSS }).catch(() => {});
        await dismissBlockingPalette(page);
        await parkPointer(page);
        const themed = row(page, WORKTREES.busy.branch);
        await snap(page, `200-theme-${theme}`, card(themed), { expectLabel: mixed });
      }
      await setAppTheme(page, "daintree");
      await page.addStyleTag({ content: POLISH_CSS }).catch(() => {});
      await dismissBlockingPalette(page);
    });

    // 8. All three segments: working, waiting, directing. Directing lasts ten
    //    seconds after the last keystroke, so these shots are taken together.
    await step("three-states", async () => {
      await inBusy(async () => {
        await driveWaiting(page, agents[1]!);
        await driveDirecting(page, agents[1]!);
      });
      const three = /^3 sessions: 1 working, 1 directing, 1 waiting$/;
      await snap(page, "70-header-three-states", card(busy), { expectLabel: three });
      await snap(page, "71-header-three-states-zoom", busy.locator(INDICATORS).first(), {
        scope: busy,
        expectLabel: three,
        clip: true,
        pad: 40,
      });
    });

    // 9. Everything waiting — the state the indicator exists to flag.
    await step("waiting", async () => {
      await inBusy(async () => {
        await driveWaiting(page, agents[2]!);
        await expectAgentState(page, agents[1]!, "waiting");
      });
      await snap(page, "80-header-all-waiting", card(busy), {
        expectLabel: /^3 sessions: 3 waiting$/,
      });
      await snap(page, "81-sidebar-collapsed-waiting", sidebar, {
        scope: busy,
        expectLabel: /^3 sessions: 3 waiting$/,
      });
    });

    // 10. The third placement: a scratch workspace's root row.
    await step("workspace-root", async () => {
      await page.evaluate(async () => {
        const scratch = await window.electron.scratch.create("Scratch pad");
        if (scratch?.id) await window.electron.scratch.switch(scratch.id);
      });
      page = await refreshActiveWindow(ctx!.app, page);
      await page.addStyleTag({ content: POLISH_CSS }).catch(() => {});
      await dismissBlockingPalette(page);
      const rootRow = page.locator("[data-workspace-root-row]").first();
      await expect(rootRow, "workspace root row never rendered").toBeVisible({ timeout: T_LONG });
      const a = await launchAgentSession(page);
      const b = await launchAgentSession(page);
      await expectAgentState(page, a, "working");
      await expectAgentState(page, b, "working");
      await driveWaiting(page, a);
      await dismissBlockingPalette(page);
      await parkPointer(page);
      await snap(page, "90-workspace-root-row", rootRow, {
        expectLabel: /^2 sessions: 1 working, 1 waiting$/,
      });
      await snap(page, "91-workspace-root-sidebar", page.locator(SEL.sidebar.aside).first(), {
        scope: rootRow,
        expectLabel: /^2 sessions: 1 working, 1 waiting$/,
      });
    });
  } finally {
    if (ctx?.app) await closeApp(ctx.app);
    repo.cleanup();
    rmSync(userDataDir, { recursive: true, force: true });
  }

  const onDisk = readdirSync(OUTPUT_DIR).filter((f) => f.endsWith(`${TAG}.png`));
  console.log(`[indicator-shots] wrote ${written.size} shots; ${onDisk.length} PNGs on disk`);
  if (written.size === 0) throw new Error("[indicator-shots] produced no screenshots at all");
  if (stepFailures.length > 0) {
    throw new Error(
      `[indicator-shots] ${stepFailures.length} step(s) failed:\n${stepFailures.join("\n")}`
    );
  }
});
