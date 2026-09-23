/**
 * Worktree sidebar off-screen indicator visual-review harness.
 *
 * Boots a repo with enough worktrees that the sidebar list scrolls well past
 * one screen, then writes PNGs of the two floating pills that report what sits
 * above and below the viewport: at the top, in the middle, at the bottom, on
 * hover, after a click (where the click actually lands), with agents waiting
 * in worktrees that are off-screen, grouped, filtered, narrow, high contrast,
 * and across every built-in theme.
 *
 * Everything goes through the app's real seams: real git worktrees, real PTYs
 * running the shared fake-claude CLI, and the FSM's own idle path to reach
 * `waiting`. Nothing is patched at the component level.
 *
 * Opt-in only, like the sibling review harnesses: skips itself unless
 * DAINTREE_SHOT_SCROLL is set, so the marketing screenshots workflow never runs it.
 *
 *   DAINTREE_SHOT_SCROLL=1 npx playwright test --project=screenshots sidebar-scroll-indicator
 *
 * Env knobs:
 *   DAINTREE_SHOT_SCROLL   required — any truthy value runs the capture
 *   DAINTREE_CAPTURE_DIR   output directory (default: artifacts/scroll-indicator-shots)
 *   DAINTREE_SHOT_THEMES   comma-separated theme sweep (default: every built-in)
 *   DAINTREE_SHOT_ONLY     comma-separated step filter (step names below)
 *
 * Verification contract: a step asserts the state it drove actually rendered
 * before writing a file, and a failed step is recorded and re-thrown at the end,
 * so a green run means every PNG on disk shows the state it is named for.
 */

import { test, expect, type Locator, type Page } from "@playwright/test";
import { execSync } from "child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { openAndOnboardProject } from "../helpers/project";
import { dismissBlockingPalette } from "../helpers/overlays";
import { ensureFilterSectionOpen } from "../helpers/workflows";
import { setAppTheme } from "../helpers/theme";
import { getGridPanelIds } from "../helpers/panels";
import { getTerminalText, waitForTerminalText, writeTerminalInput } from "../helpers/terminal";
import {
  installFakeAgent,
  fakeAgentEnv,
  FAKE_AGENT_READY,
  FAKE_AGENT_IDLE,
} from "../helpers/fakeAgent";
import { SEL } from "../helpers/selectors";
import { T_LONG } from "../helpers/timeouts";

const ENABLED = !!process.env.DAINTREE_SHOT_SCROLL;
const SCALE = process.env.DAINTREE_SCREENSHOT_SCALE ?? "2";
const OUTPUT_DIR = path.resolve(
  process.env.DAINTREE_CAPTURE_DIR ??
    path.join(process.cwd(), "artifacts", "scroll-indicator-shots")
);

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

const SWEEP_THEMES = (process.env.DAINTREE_SHOT_THEMES ?? ALL_THEMES.join(","))
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

const SIDEBAR = SEL.sidebar.aside;
const SIDEBAR_RESIZE = '[role="separator"][aria-label^="Resize sidebar"]';
const SCROLLER = `${SIDEBAR} [data-virtuoso-scroller="true"]`;
/**
 * Matches the pill before and after a redesign: the wrapper's data attribute
 * once it exists, the original accessible-name prefix until then.
 */
const PILL = {
  above: `${SIDEBAR} [data-sidebar-scroll-indicator="above"] button, ${SIDEBAR} button[aria-label^="Scroll up,"]`,
  below: `${SIDEBAR} [data-sidebar-scroll-indicator="below"] button, ${SIDEBAR} button[aria-label^="Scroll down,"]`,
} as const;

/**
 * Enough worktrees that the list is several screens long. Issue-derived names
 * give the cards realistic headline lengths; the two `waitsFor` rows get a real
 * agent driven to `waiting`, one near the top and one near the bottom, so each
 * pill has an off-screen attention state to report in the middle of the list.
 */
const WORKTREES = [
  { branch: "feature/issue-4821-stream-upload-retry", waits: false },
  { branch: "feature/issue-4907-oauth-device-flow", waits: false },
  { branch: "fix/issue-5012-token-refresh-race", waits: true },
  { branch: "feature/issue-5120-ingest-queue-metrics", waits: false },
  { branch: "chore/bump-electron-42", waits: false },
  { branch: "feature/issue-5233-port-broker-leases", waits: false },
  { branch: "fix/issue-5301-diff-viewer-wrap", waits: false },
  { branch: "feature/issue-5388-plugin-consent-audit", waits: false },
  { branch: "refactor/issue-5402-store-accessors", waits: false },
  { branch: "feature/issue-5477-fleet-broadcast-preview", waits: false },
  { branch: "docs/plugin-authoring-guide", waits: false },
  { branch: "fix/issue-5519-terminal-reflow-pin", waits: false },
  { branch: "feature/issue-5604-worktree-dashboard-sort", waits: false },
  { branch: "feature/issue-5688-mcp-tier-allowlist", waits: false },
  { branch: "fix/issue-5712-notify-grid-bar", waits: false },
  { branch: "feature/issue-5790-theme-contrast-gate", waits: false },
  { branch: "fix/issue-5833-stale-selected-path", waits: true },
  { branch: "feature/issue-5901-recipe-runner-empty", waits: false },
];

function git(cmd: string, cwd: string): void {
  execSync(`git ${cmd}`, { cwd, stdio: "ignore" });
}

interface Fixture {
  dir: string;
  cleanup: () => void;
}

function createRepo(): Fixture {
  const dir = mkdtempSync(path.join(tmpdir(), "daintree-scrollshots-"));
  const wtRoot = path.join(path.dirname(dir), `${path.basename(dir)}-worktrees`);
  mkdirSync(wtRoot, { recursive: true });
  git("init -b main", dir);
  git('config user.email "avery@helios.dev"', dir);
  git('config user.name "Avery Lindqvist"', dir);
  mkdirSync(path.join(dir, "src"), { recursive: true });
  writeFileSync(path.join(dir, "README.md"), "# Helios Dashboard\n");
  writeFileSync(path.join(dir, "src", "index.ts"), "export const main = (): number => 0;\n");
  git("add -A", dir);
  git('commit -m "Set up the ingest console skeleton"', dir);

  WORKTREES.forEach((wt, i) => {
    const slug = wt.branch.replace(/[/]/g, "-");
    const wtDir = path.join(wtRoot, slug);
    git(`worktree add -b ${wt.branch} ${JSON.stringify(wtDir)} main`, dir);
    // Every third tree is dirty so the cards are not all one height.
    if (i % 3 === 0) {
      writeFileSync(path.join(wtDir, "wip.md"), `in progress on ${wt.branch}\n`);
    }
  });

  return {
    dir,
    cleanup: () => {
      if (existsSync(wtRoot)) rmSync(wtRoot, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function settle(page: Page, ms = 450): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
  );
  await page.waitForTimeout(ms);
}

async function parkPointer(page: Page): Promise<void> {
  await page.mouse.move(1100, 60);
  await settle(page, 200);
}

const written = new Set<string>();
const notes: string[] = [];
const ONLY = (process.env.DAINTREE_SHOT_ONLY ?? "").split(",").filter(Boolean);
const stepFailures: string[] = [];

async function step(name: string, fn: () => Promise<void>): Promise<void> {
  if (ONLY.length > 0 && !ONLY.includes(name)) return;
  try {
    await fn();
  } catch (error) {
    const detail = String(error).slice(0, 500);
    stepFailures.push(`${name}: ${detail}`);
    console.warn(`[scroll-shots] step "${name}" FAILED:`, detail);
  }
}

/** Whole-sidebar capture, after proving the sidebar is really there. */
async function snapSidebar(page: Page, slug: string): Promise<void> {
  await settle(page);
  const sidebar = page.locator(SIDEBAR).first();
  await expect(sidebar, `"${slug}": sidebar not visible — refusing to write`).toBeVisible();
  const file = path.join(OUTPUT_DIR, `${slug}.png`);
  await sidebar.screenshot({ path: file, animations: "disabled", caret: "hide" });
  written.add(`${slug}.png`);
}

/**
 * A full-width band of the sidebar around one pill: the pill plus the rows it
 * floats over, which is what its legibility and occlusion are judged against.
 * Refuses to write unless the pill is actually on screen.
 */
async function snapPill(page: Page, slug: string, which: "above" | "below"): Promise<void> {
  await settle(page);
  const pill = page.locator(PILL[which]).first();
  await expect(pill, `"${slug}": ${which} pill not visible — refusing to write`).toBeVisible({
    timeout: 5000,
  });
  const pillBox = await pill.boundingBox();
  const sideBox = await page.locator(SIDEBAR).first().boundingBox();
  if (!pillBox || !sideBox || pillBox.width < 16 || pillBox.height < 12) {
    throw new Error(`"${slug}": degenerate pill box ${JSON.stringify(pillBox)}`);
  }
  const top = Math.max(sideBox.y, pillBox.y - 56);
  const bottom = Math.min(sideBox.y + sideBox.height, pillBox.y + pillBox.height + 56);
  const file = path.join(OUTPUT_DIR, `${slug}.png`);
  await page.screenshot({
    path: file,
    clip: { x: sideBox.x, y: top, width: sideBox.width, height: bottom - top },
    animations: "disabled",
    caret: "hide",
  });
  written.add(`${slug}.png`);
  notes.push(
    `${slug}: pill ${Math.round(pillBox.width)}x${Math.round(pillBox.height)} label="${await pill.getAttribute(
      "aria-label"
    )}" text="${(await pill.innerText()).replace(/\s+/g, " ").trim()}"`
  );
}

async function expectPillGone(page: Page, which: "above" | "below"): Promise<void> {
  await expect(page.locator(PILL[which]), `${which} pill should be hidden here`).toHaveCount(0, {
    timeout: 5000,
  });
}

async function scrollerMetrics(page: Page): Promise<{ top: number; max: number }> {
  return page
    .locator(SCROLLER)
    .first()
    .evaluate((el) => ({
      top: Math.round(el.scrollTop),
      max: Math.round(el.scrollHeight - el.clientHeight),
    }));
}

/** Put the list at a fraction of its scroll range, or at an absolute offset. */
async function scrollTo(page: Page, where: number | "top" | "bottom" | "middle"): Promise<void> {
  const scroller = page.locator(SCROLLER).first();
  await expect(scroller, "virtualized scroller missing").toBeAttached({ timeout: T_LONG });
  await scroller.evaluate((el, w) => {
    const max = el.scrollHeight - el.clientHeight;
    const top = w === "top" ? 0 : w === "bottom" ? max : w === "middle" ? max / 2 : (w as number);
    el.scrollTop = top;
    el.dispatchEvent(new Event("scroll"));
  }, where);
  await settle(page, 600);
}

const row = (page: Page, branch: string): Locator => page.locator(SEL.worktree.row(branch)).first();

async function typeQuery(page: Page, query: string): Promise<void> {
  const input = page.locator(SEL.worktree.searchInput).first();
  await input.click();
  await input.fill(query);
  await settle(page, 600);
}

async function clearQuery(page: Page): Promise<void> {
  const input = page.locator(SEL.worktree.searchInput).first();
  await input.fill("");
  await page.waitForTimeout(900);
  await input.evaluate((el: HTMLElement) => el.blur());
  await settle(page, 300);
}

async function setSidebarWidth(page: Page, target: number): Promise<void> {
  const handle = page.locator(SIDEBAR_RESIZE).first();
  await handle.focus();
  for (let i = 0; i < 60; i++) {
    const now = Math.round((await page.locator(SIDEBAR).first().boundingBox())?.width ?? 0);
    if (Math.abs(now - target) < 6) break;
    await page.keyboard.press(now > target ? "ArrowLeft" : "ArrowRight");
    await page.waitForTimeout(30);
  }
  await handle.evaluate((el: HTMLElement) => el.blur());
  await settle(page, 400);
}

/** Toggle "Group by type" in the filter popover to the wanted state. */
async function setGrouped(page: Page, grouped: boolean): Promise<void> {
  const openPopover = page.locator(`${SEL.worktree.filterPopover}[data-state="open"]`).first();
  if (!(await openPopover.isVisible().catch(() => false))) {
    await page.locator(SEL.worktree.filterButton).first().click();
  }
  await expect(openPopover).toBeVisible({ timeout: 6000 });
  await ensureFilterSectionOpen(openPopover, "Sort by");
  const toggle = openPopover.getByRole("checkbox", { name: "Group by type" });
  await expect(toggle, "group-by-type checkbox missing").toBeVisible({ timeout: 5000 });
  if (((await toggle.getAttribute("aria-checked")) === "true") !== grouped) await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", grouped ? "true" : "false");
  await settle(page, 300);
  await page.keyboard.press("Escape");
  await settle(page, 500);
}

/**
 * Launch one fake-claude session in the active worktree, drive it past the
 * trust prompt, then idle it so the FSM settles to `waiting` through the app's
 * own path.
 */
async function launchWaitingAgent(page: Page): Promise<void> {
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
  await writeTerminalInput(page, panel, `${FAKE_AGENT_IDLE}\r`);
  await expect(panel, "agent never reached waiting").toHaveAttribute(
    "data-agent-state",
    "waiting",
    { timeout: T_LONG * 2 }
  );
}

/** Select a worktree by filtering the list down to it, so it is clickable wherever it sits. */
async function activate(page: Page, branch: string): Promise<void> {
  await typeQuery(page, branch.split("/")[1]!.slice(0, 16));
  const card = row(page, branch).locator(".sidebar-worktree-card").first();
  await expect(card, `${branch} card not found`).toBeVisible({ timeout: T_LONG });
  await card.click();
  await expect(card, `${branch} did not become active`).toHaveAttribute("data-active", "true", {
    timeout: T_LONG,
  });
  await clearQuery(page);
}

async function prepare(page: Page): Promise<void> {
  await page.addStyleTag({ content: POLISH_CSS }).catch(() => {});
  await dismissBlockingPalette(page);
  await parkPointer(page);
}

test("sidebar off-screen indicator review — states and themes", async () => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_SCROLL is required for the scroll-indicator capture",
  });
  test.skip(!ENABLED, "Set DAINTREE_SHOT_SCROLL to run the scroll-indicator capture");
  test.setTimeout(15 * 60_000);

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const repo = createRepo();
  const fakeBinDir = installFakeAgent(repo.dir);
  const userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-scrollshot-"));
  let ctx: AppContext | undefined;

  try {
    ctx = await launchApp({
      userDataDir,
      screenshotScale: SCALE,
      windowSize: { width: 1440, height: 900 },
      env: fakeAgentEnv(fakeBinDir),
      extraArgs: ["--disable-gpu", "--in-process-gpu", "--disable-breakpad", "--noerrdialogs"],
    });
    const page = await openAndOnboardProject(ctx.app, ctx.window, repo.dir, "Helios Dashboard");
    await setAppTheme(page, "daintree");
    await prepare(page);

    // The list sorts newest first, so wait for the whole set rather than one
    // row that may sit off-screen.
    await expect
      .poll(() => page.locator(`${SIDEBAR} [data-worktree-row]`).count(), {
        timeout: T_LONG,
        message: "worktree rows never rendered",
      })
      .toBeGreaterThan(6);
    await settle(page, 1500);
    const { max } = await scrollerMetrics(page);
    notes.push(`scroll range: ${max}px`);
    if (max < 600) throw new Error(`list barely scrolls (${max}px) — fixture too short`);

    // 1. The list at rest, before anything needs attention: the plain count.
    await step("plain", async () => {
      await scrollTo(page, "top");
      await expectPillGone(page, "above");
      await snapSidebar(page, "10-top-sidebar");
      await snapPill(page, "11-top-below-pill", "below");
      await scrollTo(page, "middle");
      await snapSidebar(page, "12-middle-sidebar");
      await snapPill(page, "13-middle-above-pill", "above");
      await snapPill(page, "14-middle-below-pill", "below");
      await scrollTo(page, "bottom");
      await expectPillGone(page, "below");
      await snapSidebar(page, "15-bottom-sidebar");
      await snapPill(page, "16-bottom-above-pill", "above");
    });

    // 2. Hover — the pill's only pointer feedback.
    await step("hover", async () => {
      await scrollTo(page, "middle");
      await page.locator(PILL.below).first().hover();
      await settle(page, 300);
      await snapPill(page, "20-hover-below-pill", "below");
      await parkPointer(page);
    });

    // 3. Agents waiting in worktrees that sit off-screen. The two waiting rows
    //    are near opposite ends, so in the middle of the list each pill has one.
    await step("waiting", async () => {
      for (const wt of WORKTREES.filter((w) => w.waits)) {
        await activate(page, wt.branch);
        await launchWaitingAgent(page);
      }
      // Leave a quiet middle worktree active, as a user in the middle of work would.
      await activate(page, WORKTREES[9]!.branch);
      await parkPointer(page);
      await scrollTo(page, "middle");
      await snapSidebar(page, "30-waiting-middle-sidebar");
      await snapPill(page, "31-waiting-middle-above-pill", "above");
      await snapPill(page, "32-waiting-middle-below-pill", "below");
      await scrollTo(page, "top");
      await snapSidebar(page, "33-waiting-top-sidebar");
      await snapPill(page, "34-waiting-top-below-pill", "below");
    });

    // 4. Where a click lands. The scroll position after the smooth scroll is
    //    recorded beside the frame, because "where did that take me" is the
    //    whole question.
    await step("click", async () => {
      await scrollTo(page, "top");
      const before = await scrollerMetrics(page);
      await page.locator(PILL.below).first().click();
      await page.waitForTimeout(1200);
      await parkPointer(page);
      const after = await scrollerMetrics(page);
      notes.push(`click below from top: scrollTop ${before.top} -> ${after.top} of ${after.max}`);
      await snapSidebar(page, "40-after-click-below-sidebar");

      await scrollTo(page, "bottom");
      const b2 = await scrollerMetrics(page);
      await page.locator(PILL.above).first().click();
      await page.waitForTimeout(1200);
      await parkPointer(page);
      const a2 = await scrollerMetrics(page);
      notes.push(`click above from bottom: scrollTop ${b2.top} -> ${a2.top} of ${a2.max}`);
      await snapSidebar(page, "41-after-click-above-sidebar");
    });

    // 5. Filtered — the counts follow the filtered list, not the full one.
    await step("filtered", async () => {
      await typeQuery(page, "fix");
      await page
        .locator(SEL.worktree.searchInput)
        .first()
        .evaluate((el: HTMLElement) => el.blur());
      await scrollTo(page, "top");
      await snapSidebar(page, "50-filtered-top-sidebar");
      await clearQuery(page);
    });

    // 6. Grouped by type — section headers in the list, not counted as rows.
    await step("grouped", async () => {
      await setGrouped(page, true);
      await parkPointer(page);
      await scrollTo(page, "middle");
      await snapSidebar(page, "55-grouped-middle-sidebar");
      await setGrouped(page, false);
      await parkPointer(page);
    });

    // 7. Narrow sidebar — the pill's width against the shortest title column.
    await step("narrow", async () => {
      await setSidebarWidth(page, 220);
      await parkPointer(page);
      await scrollTo(page, "middle");
      await snapSidebar(page, "60-narrow-middle-sidebar");
      await snapPill(page, "61-narrow-below-pill", "below");
      await setSidebarWidth(page, 320);
    });

    // 8. High contrast — prefers-contrast (macOS) and forced-colors (Windows).
    await step("contrast", async () => {
      await parkPointer(page);
      await scrollTo(page, "middle");
      await page.emulateMedia({ contrast: "more" });
      await snapPill(page, "70-contrast-more-below-pill", "below");
      await page.emulateMedia({ contrast: "no-preference", forcedColors: "active" });
      await snapPill(page, "71-forced-colors-below-pill", "below");
      await snapPill(page, "72-forced-colors-above-pill", "above");
      await page.emulateMedia({ forcedColors: "none" });
      await settle(page, 300);
    });

    // 9. Theme sweep of the waiting-in-the-middle band, both pills.
    await step("themes", async () => {
      for (const theme of SWEEP_THEMES) {
        await setAppTheme(page, theme);
        await prepare(page);
        await expect(page.locator(`${SIDEBAR} [data-worktree-row]`).first()).toBeVisible({
          timeout: T_LONG,
        });
        await settle(page, 800);
        await scrollTo(page, "middle");
        await snapPill(page, `200-theme-${theme}-below`, "below");
        await snapPill(page, `201-theme-${theme}-above`, "above");
      }
    });
  } finally {
    if (ctx?.app) await closeApp(ctx.app);
    repo.cleanup();
    rmSync(userDataDir, { recursive: true, force: true });
  }

  writeFileSync(path.join(OUTPUT_DIR, "notes.txt"), notes.join("\n") + "\n");
  const onDisk = readdirSync(OUTPUT_DIR).filter((f) => f.endsWith(".png"));
  console.log(`[scroll-shots] wrote ${written.size} shots; ${onDisk.length} PNGs on disk`);
  if (written.size === 0) throw new Error("[scroll-shots] produced no screenshots at all");
  if (stepFailures.length > 0) {
    throw new Error(
      `[scroll-shots] ${stepFailures.length} step(s) failed:\n${stepFailures.join("\n")}`
    );
  }
});
