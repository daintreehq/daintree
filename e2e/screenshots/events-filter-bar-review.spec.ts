/**
 * The Diagnostics dock's Events tab: its filter bar and the Context chips in
 * the event detail that narrow the timeline from outside the bar.
 *
 * The snapshot the tab hydrates from is answered through the IPC fault
 * registry with a populated fixture (every context field, a long worktree
 * path), so the real client, store and components render on top of it. Live
 * events still stream in through the real batch broadcast.
 *
 * Each theme pass walks the path a person takes: select an event, open
 * Context, click its Agent chip, leave for Logs and come back, stack more
 * filters, empty the list, clear from the bar, then Clear events with a filter
 * still set. A sweep pass photographs the returned-to-the-tab state in every
 * other theme.
 *
 *   DAINTREE_SHOT_EVENTS_FILTERS=1 DESIGN_CAPTURE_DIR=/tmp/shots \
 *     npx playwright test --project=screenshots events-filter-bar-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_EVENTS_FILTERS  required — any truthy value runs the capture
 *   DESIGN_CAPTURE_DIR            required — output directory (never the repo)
 *   DAINTREE_SHOT_THEMES          comma-separated themes for the full pass
 *                                 (default: daintree,serengeti)
 *   DAINTREE_SHOT_SWEEP_THEMES    themes for the returned-to-tab sweep, or
 *                                 "none" (default: every other built-in)
 *   DAINTREE_SCREENSHOT_SCALE     device scale factor (default 2)
 *
 * Output: <dir>/events--<state>--<theme>.png. Every frame is checked against
 * the state it claims after the settle and before it is written; the run fails
 * if any planned frame is missing.
 */

import { expect, test, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import { mkdtempSync, mkdirSync, rmSync, readdirSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { createFixtureRepo } from "../helpers/fixtures";
import { openAndOnboardProject } from "../helpers/project";
import { dismissBlockingPalette } from "../helpers/overlays";
import { injectStub } from "../helpers/ipcFaults";
import { setAppTheme } from "../helpers/theme";
import { SEL } from "../helpers/selectors";
import { T_LONG, T_MEDIUM } from "../helpers/timeouts";

const ENABLED = !!process.env.DAINTREE_SHOT_EVENTS_FILTERS;
const OUTPUT_DIR = process.env.DESIGN_CAPTURE_DIR
  ? path.resolve(process.env.DESIGN_CAPTURE_DIR)
  : "";
const SCALE = process.env.DAINTREE_SCREENSHOT_SCALE ?? "2";
const ALL_THEMES = [
  "daintree",
  "bondi",
  "table-mountain",
  "arashiyama",
  "fiordland",
  "galapagos",
  "highlands",
  "namib",
  "redwoods",
  "atacama",
  "bali",
  "hokkaido",
  "serengeti",
  "svalbard",
  "movile",
];
const listEnv = (name: string): string[] => (process.env[name] ?? "").split(",").filter(Boolean);
const CORE_THEMES = listEnv("DAINTREE_SHOT_THEMES").length
  ? listEnv("DAINTREE_SHOT_THEMES")
  : ["daintree", "serengeti"];
const SWEEP_ENV = listEnv("DAINTREE_SHOT_SWEEP_THEMES");
const SWEEP_THEMES =
  SWEEP_ENV[0] === "none"
    ? []
    : SWEEP_ENV.length
      ? SWEEP_ENV
      : ALL_THEMES.filter((t) => !CORE_THEMES.includes(t));

const WINDOW = { width: 1440, height: 900 };
const GET_EVENTS_CHANNEL = "event-inspector:get-events";

const AGENT = "claude-7f3a2c91";
const OTHER_AGENT = "codex-12be44d0";
const THIRD_AGENT = "gemini-9c01e7aa";
const WORKTREE =
  "/Users/dev/helios-dashboard-worktrees/feature-oauth-device-flow-with-pkce-refresh";
const MAIN_WORKTREE = "/Users/dev/helios-dashboard";
const TERMINAL = "term-4f2a91c0";
const RUN = "run-20261110-0914-a3";
const TRACE = "5b0e7c2a-91d4-4f0b-8c3e-2a7d1e9f4b60";

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

interface FixtureEvent {
  id: string;
  timestamp: number;
  type: string;
  category: string;
  source: "main" | "renderer";
  payload: Record<string, unknown>;
}

/**
 * A morning's worth of events across three agents, two worktrees and every
 * category. The last one carries all six context fields, so selecting it puts
 * every Context chip on screen at once.
 */
function buildFixture(): FixtureEvent[] {
  const now = Date.now();
  const rows: Array<[string, string, Record<string, unknown>]> = [
    ["sys:worktree:update", "system", { worktreeId: MAIN_WORKTREE, branch: "main", dirty: false }],
    [
      "sys:worktree:update",
      "system",
      { worktreeId: WORKTREE, branch: "feature/oauth-device-flow", dirty: true },
    ],
    [
      "agent:spawned",
      "agent",
      { agentId: AGENT, worktreeId: WORKTREE, terminalId: TERMINAL, runId: RUN, traceId: TRACE },
    ],
    ["agent:detected", "agent", { agentId: AGENT, terminalId: TERMINAL, agentType: "claude" }],
    [
      "agent:state-changed",
      "agent",
      { agentId: AGENT, worktreeId: WORKTREE, from: "idle", to: "working", traceId: TRACE },
    ],
    [
      "watcher:change",
      "watcher",
      { worktreeId: WORKTREE, path: "src/auth/deviceFlow.ts", kind: "change" },
    ],
    ["file:open", "file", { worktreeId: WORKTREE, path: "src/auth/deviceFlow.ts" }],
    [
      "agent:spawned",
      "agent",
      { agentId: OTHER_AGENT, worktreeId: MAIN_WORKTREE, terminalId: "term-8a10b2e4" },
    ],
    [
      "agent:state-changed",
      "agent",
      { agentId: OTHER_AGENT, worktreeId: MAIN_WORKTREE, from: "idle", to: "working" },
    ],
    ["server:started", "server", { worktreeId: MAIN_WORKTREE, port: 5173, command: "npm run dev" }],
    [
      "watcher:change",
      "watcher",
      { worktreeId: WORKTREE, path: "src/auth/tokenStore.ts", kind: "change" },
    ],
    [
      "agent:rate-limit-observed",
      "agent",
      { agentId: AGENT, worktreeId: WORKTREE, retryAfterSeconds: 42, traceId: TRACE },
    ],
    [
      "agent:state-changed",
      "agent",
      { agentId: AGENT, worktreeId: WORKTREE, from: "working", to: "waiting", traceId: TRACE },
    ],
    [
      "sys:issue:detected",
      "system",
      { worktreeId: WORKTREE, issueNumber: 482, title: "Device flow login for headless hosts" },
    ],
    ["ui:notify", "ui", { message: "Agent is waiting for input", agentId: AGENT }],
    [
      "agent:state-changed",
      "agent",
      { agentId: AGENT, worktreeId: WORKTREE, from: "waiting", to: "working", traceId: TRACE },
    ],
    [
      "watcher:change",
      "watcher",
      { worktreeId: MAIN_WORKTREE, path: "package-lock.json", kind: "change" },
    ],
    [
      "agent:spawned",
      "agent",
      { agentId: THIRD_AGENT, worktreeId: MAIN_WORKTREE, terminalId: "term-c2d7e019" },
    ],
    ["file:copy-tree", "file", { worktreeId: WORKTREE, fileCount: 37, bytes: 182344 }],
    [
      "agent:state-changed",
      "agent",
      { agentId: OTHER_AGENT, worktreeId: MAIN_WORKTREE, from: "working", to: "idle" },
    ],
    [
      "artifact:detected",
      "artifact",
      { agentId: OTHER_AGENT, worktreeId: MAIN_WORKTREE, kind: "patch", files: 3 },
    ],
    [
      "watcher:change",
      "watcher",
      { worktreeId: WORKTREE, path: "src/auth/__tests__/deviceFlow.test.ts", kind: "add" },
    ],
    [
      "agent:rate-limit-observed",
      "agent",
      { agentId: THIRD_AGENT, worktreeId: MAIN_WORKTREE, retryAfterSeconds: 12 },
    ],
    [
      "sys:pr:detected",
      "system",
      { worktreeId: WORKTREE, prNumber: 517, issueNumber: 482, state: "open" },
    ],
    ["server:output", "server", { worktreeId: MAIN_WORKTREE, line: "ready in 412 ms" }],
    [
      "agent:state-changed",
      "agent",
      { agentId: THIRD_AGENT, worktreeId: MAIN_WORKTREE, from: "working", to: "idle" },
    ],
    ["ui:modal:open", "ui", { modal: "review-hub", worktreeId: WORKTREE }],
    ["ui:modal:close", "ui", { modal: "review-hub", worktreeId: WORKTREE }],
    [
      "watcher:change",
      "watcher",
      { worktreeId: WORKTREE, path: "src/auth/deviceFlow.ts", kind: "change" },
    ],
    [
      "agent:completed",
      "agent",
      {
        agentId: AGENT,
        worktreeId: WORKTREE,
        runId: RUN,
        terminalId: TERMINAL,
        issueNumber: 482,
        prNumber: 517,
        traceId: TRACE,
        durationMs: 1843021,
        exitCode: 0,
      },
    ],
  ];
  return rows.map(([type, category, payload], i) => ({
    id: `fx-${String(i).padStart(3, "0")}`,
    timestamp: now - (rows.length - i) * 7_300,
    type,
    category,
    source: "main",
    payload,
  }));
}

async function settle(page: Page, ms = 350): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
  );
  await page.waitForTimeout(ms);
}

async function dispatch(page: Page, id: string, args?: unknown): Promise<void> {
  await page.evaluate(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ([actionId, a]) => (window as any).__daintreeDispatchAction(actionId, a),
    [id, args] as const
  );
}

function eventsPanel(page: Page): Locator {
  return page.locator(SEL.diagnostics.panel("events"));
}

async function openEventsDock(page: Page): Promise<void> {
  await dispatch(page, "panel.diagnosticsEvents");
  await expect(page.locator(SEL.diagnostics.dock)).toBeVisible({ timeout: T_MEDIUM });
  await expect(eventsPanel(page)).toBeVisible({ timeout: T_MEDIUM });

  // At the default dock height the filter bar eats the panel; grow it to its
  // ceiling once the post-layout max has landed (see core-event-inspector).
  const resize = page.locator(SEL.diagnostics.resizeHandle);
  const dock = page.locator(SEL.diagnostics.dock);
  await expect
    .poll(
      async () => {
        const [max, min, half] = await Promise.all([
          resize.getAttribute("aria-valuemax"),
          resize.getAttribute("aria-valuemin"),
          dock.evaluate((el) => {
            const parent = el.parentElement;
            if (!parent) return -1;
            const s = getComputedStyle(parent);
            const h =
              parent.getBoundingClientRect().height -
              parseFloat(s.paddingTop) -
              parseFloat(s.paddingBottom) -
              parseFloat(s.borderTopWidth) -
              parseFloat(s.borderBottomWidth);
            return Math.floor(h * 0.5);
          }),
        ]);
        return Math.abs(Number(max ?? 0) - Math.max(half, Number(min ?? 0))) <= 1;
      },
      { timeout: T_MEDIUM }
    )
    .toBe(true);
  await resize.press("End");
  await expect
    .poll(
      async () => {
        const [now, max] = await Promise.all([
          resize.getAttribute("aria-valuenow"),
          resize.getAttribute("aria-valuemax"),
        ]);
        return Number(now ?? 0) >= Number(max ?? 0) - 1;
      },
      { timeout: T_MEDIUM }
    )
    .toBe(true);
}

function timelineRows(page: Page): Locator {
  return eventsPanel(page).locator(SEL.events.row);
}

async function selectCompletedEvent(page: Page): Promise<void> {
  const row = timelineRows(page).filter({ hasText: "agent:completed" }).first();
  await row.waitFor({ state: "visible", timeout: T_LONG });
  await row.click();
  await expect(row).toHaveAttribute("aria-current", "true");
}

function contextHeader(page: Page): Locator {
  return eventsPanel(page).getByRole("button", { name: /^Context/ });
}

async function expandContext(page: Page): Promise<void> {
  const header = contextHeader(page);
  await header.waitFor({ state: "visible", timeout: T_MEDIUM });
  if ((await header.getAttribute("aria-expanded")) === "false") await header.click();
  await expect(header).toHaveAttribute("aria-expanded", "true");
}

/** The chip in the detail's Context section, never a token in the bar. */
function contextChip(page: Page, label: string): Locator {
  return eventsPanel(page)
    .locator("div.grid", { has: page.locator("span", { hasText: new RegExp(`^${label}:?$`) }) })
    .locator("button[data-filter-chip]")
    .first();
}

/** The bar's own sign of a context filter, independent of the Context section. */
async function expectAppliedToken(page: Page, label: string): Promise<void> {
  const token = eventsPanel(page).locator(`[data-applied-filter][aria-label="${label}"]`);
  await expect(token).toBeVisible();
  await expect(token).toHaveAttribute("aria-pressed", "true");
}

async function expectRowsAllMention(page: Page, text: string): Promise<void> {
  const texts = await timelineRows(page).allInnerTexts();
  if (texts.length === 0) throw new Error(`expected rows mentioning ${text}, found none`);
  const stray = texts.filter((t) => !t.includes(text));
  if (stray.length > 0) throw new Error(`rows not narrowed to ${text}: ${stray[0]}`);
}

async function expectSomeRowLacks(page: Page, text: string): Promise<void> {
  const texts = await timelineRows(page).allInnerTexts();
  if (!texts.some((t) => !t.includes(text))) {
    throw new Error(`list still narrowed to ${text} (${texts.length} rows)`);
  }
}

/** The dock, grown to take in an open popover that portals above it. */
async function snap(page: Page, state: string, theme: string): Promise<void> {
  await settle(page);
  const box = await page.locator(SEL.diagnostics.dock).boundingBox();
  if (!box) throw new Error(`${state}: dock has no box`);
  let top = box.y;
  const popper = page.locator("[data-radix-popper-content-wrapper]");
  for (let i = 0; i < (await popper.count()); i++) {
    const pb = await popper.nth(i).boundingBox();
    if (pb && pb.height > 0) top = Math.min(top, pb.y - 12);
  }
  top = Math.max(0, top);
  await page.screenshot({
    path: path.join(OUTPUT_DIR, `events--${state}--${theme}.png`),
    type: "png",
    animations: "disabled",
    caret: "hide",
    clip: { x: box.x, y: top, width: box.width, height: box.y + box.height - top },
  });
}

/**
 * The type list runs past the popover at this height: it must scroll, reach
 * its last group, and say so with the bottom fade while it continues.
 */
async function expectTypeListContinues(page: Page): Promise<void> {
  const scroller = page
    .locator("[data-radix-popper-content-wrapper] .overflow-y-auto")
    .filter({ hasText: "sys:" });
  const state = await scroller.first().evaluate((el) => {
    const fade = el.nextElementSibling as HTMLElement | null;
    return {
      overflows: el.scrollHeight > el.clientHeight + 1,
      fadeOpacity: fade ? getComputedStyle(fade).opacity : "missing",
    };
  });
  console.log(`[events-filter-shots] type list ${JSON.stringify(state)}`);
  if (!state.overflows) return;
  if (state.fadeOpacity !== "1")
    throw new Error(`type list continues with no fade: ${state.fadeOpacity}`);
  const lastGroup = page
    .locator("[data-radix-popper-content-wrapper]")
    .getByText("Artifact", { exact: true });
  await lastGroup.scrollIntoViewIfNeeded();
  await expect(lastGroup).toBeInViewport();
  await scroller.first().evaluate((el) => el.scrollTo({ top: 0 }));
  await settle(page, 200);
}

async function applyTheme(page: Page, theme: string): Promise<void> {
  await setAppTheme(page, theme);
  await page.addStyleTag({ content: POLISH_CSS });
  await dismissBlockingPalette(page);
  await settle(page, 500);
}

/** Leave for Logs and come back, the way the issue's step 2 does. */
async function roundTripTabs(page: Page): Promise<void> {
  await page.locator(SEL.diagnostics.tab("logs")).click();
  await expect(page.locator(SEL.diagnostics.panel("logs"))).toBeVisible({ timeout: T_MEDIUM });
  await settle(page, 300);
  await page.locator(SEL.diagnostics.tab("events")).click();
  await expect(eventsPanel(page)).toBeVisible({ timeout: T_MEDIUM });
  await timelineRows(page).first().waitFor({ state: "visible", timeout: T_LONG });
}

async function typeSearch(page: Page, text: string): Promise<void> {
  const input = eventsPanel(page).locator(SEL.events.searchInput);
  await input.click();
  await input.fill(text);
}

async function clearSearchField(page: Page): Promise<void> {
  const input = eventsPanel(page).locator(SEL.events.searchInput);
  await input.fill("");
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await settle(page, 400);
}

async function captureFullPass(page: Page, theme: string, written: string[]): Promise<void> {
  await applyTheme(page, theme);
  await openEventsDock(page);
  await selectCompletedEvent(page);
  await expandContext(page);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await expect(contextChip(page, "Agent")).toHaveAttribute("aria-pressed", "false");
  await expectSomeRowLacks(page, AGENT);
  await snap(page, "rest", theme);
  written.push(`rest--${theme}`);

  await contextChip(page, "Agent").click();
  await expect(contextChip(page, "Agent")).toHaveAttribute("aria-pressed", "true");
  await page.mouse.move(4, 4);
  await settle(page, 300);
  await expectRowsAllMention(page, AGENT);
  await expectAppliedToken(page, `Agent: ${AGENT}`);
  await snap(page, "context-active", theme);
  written.push(`context-active--${theme}`);

  await roundTripTabs(page);
  await expectRowsAllMention(page, AGENT);
  await expectAppliedToken(page, `Agent: ${AGENT}`);
  await snap(page, "context-remount", theme);
  written.push(`context-remount--${theme}`);

  // Densest bar: a second context value, a category and a committed search.
  await expandContext(page);
  await contextChip(page, "Worktree").click();
  await expect(contextChip(page, "Worktree")).toHaveAttribute("aria-pressed", "true");
  await eventsPanel(page)
    .getByRole("group", { name: "Filter by category" })
    .getByRole("button", { name: /^Agent/ })
    .click();
  await typeSearch(page, "state");
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.mouse.move(4, 4);
  await settle(page, 500);
  await expectRowsAllMention(page, "agent:state-changed");
  await snap(page, "stacked", theme);
  written.push(`stacked--${theme}`);

  await eventsPanel(page).locator(SEL.events.moreFilters).click();
  const trace = page.locator(SEL.events.traceInput);
  await trace.waitFor({ state: "visible", timeout: T_MEDIUM });
  await settle(page, 300);
  await expectTypeListContinues(page);
  await snap(page, "filters-popover", theme);
  written.push(`filters-popover--${theme}`);
  await page.keyboard.press("Escape");
  await trace.waitFor({ state: "hidden", timeout: T_MEDIUM });

  await typeSearch(page, "no-such-event-zz");
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.mouse.move(4, 4);
  await settle(page, 500);
  await expect(eventsPanel(page).getByText("No events match filters")).toBeVisible();
  await snap(page, "filtered-empty", theme);
  written.push(`filtered-empty--${theme}`);
  await clearSearchField(page);

  // A draft typed and cleared from the bar before its debounce commits.
  const barClear = eventsPanel(page).getByRole("button", { name: "Clear filters", exact: true });
  await typeSearch(page, "draft-in-flight");
  await expect(barClear).toHaveCount(1);
  await barClear.click();
  await page.mouse.move(4, 4);
  await settle(page, 600);
  await expect(eventsPanel(page).locator(SEL.events.searchInput)).toHaveValue("");
  await expect(barClear).toHaveCount(0);
  await expect(eventsPanel(page).locator("[data-applied-filter]")).toHaveCount(0);
  await expect(contextChip(page, "Agent")).toHaveAttribute("aria-pressed", "false");
  await expectSomeRowLacks(page, AGENT);
  await snap(page, "cleared", theme);
  written.push(`cleared--${theme}`);

  // Clear events with a context filter still set, then let new events land.
  await selectAnyAgentEvent(page);
  await expandContext(page);
  if ((await contextChip(page, "Agent").getAttribute("aria-pressed")) === "false") {
    await contextChip(page, "Agent").click();
  }
  await expect(contextChip(page, "Agent")).toHaveAttribute("aria-pressed", "true");
  await page.locator(SEL.diagnostics.dock).getByRole("button", { name: "Clear events" }).click();
  const confirm = page
    .locator('[role="alertdialog"], [role="dialog"]')
    .filter({ hasText: "Clear events?" });
  await confirm.waitFor({ state: "visible", timeout: T_MEDIUM });
  await confirm.getByRole("button", { name: "Clear events" }).click();
  await confirm.waitFor({ state: "hidden", timeout: T_MEDIUM });
  for (let i = 0; i < 4; i++) await dispatch(page, "actions.search", { query: `after-clear-${i}` });
  await page.mouse.move(4, 4);
  await settle(page, 900);
  await expect(eventsPanel(page).getByText("agent:completed")).toHaveCount(0);
  await expectAppliedToken(page, `Agent: ${AGENT}`);
  await snap(page, "after-clear-events", theme);
  written.push(`after-clear-events--${theme}`);
}

async function selectAnyAgentEvent(page: Page): Promise<void> {
  const row = timelineRows(page).filter({ hasText: AGENT }).last();
  await row.waitFor({ state: "visible", timeout: T_LONG });
  await row.click();
}

async function captureSweepPass(page: Page, theme: string, written: string[]): Promise<void> {
  await applyTheme(page, theme);
  await openEventsDock(page);
  await selectCompletedEvent(page);
  await expandContext(page);
  await contextChip(page, "Agent").click();
  await expect(contextChip(page, "Agent")).toHaveAttribute("aria-pressed", "true");
  await roundTripTabs(page);
  await page.mouse.move(4, 4);
  await expectRowsAllMention(page, AGENT);
  await expectAppliedToken(page, `Agent: ${AGENT}`);
  await snap(page, "context-remount", theme);
  written.push(`context-remount--${theme}`);
}

async function stubSnapshot(app: ElectronApplication): Promise<void> {
  await injectStub(app, GET_EVENTS_CHANNEL, buildFixture());
}

test("events filter bar — states and themes", async () => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_EVENTS_FILTERS is required for the events filter bar capture",
  });
  test.skip(!ENABLED, "Set DAINTREE_SHOT_EVENTS_FILTERS=1 to run the events filter bar capture");
  if (!OUTPUT_DIR)
    throw new Error("DESIGN_CAPTURE_DIR must be set to a directory outside the repo");

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const repo = createFixtureRepo({ name: "helios-dashboard" });
  const userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-eventsshot-"));
  let ctx: AppContext | undefined;
  const failures: string[] = [];
  const planned: string[] = [];
  try {
    ctx = await launchApp({
      userDataDir,
      screenshotScale: SCALE,
      windowSize: WINDOW,
      extraArgs: ["--disable-gpu", "--in-process-gpu", "--disable-breakpad", "--noerrdialogs"],
      env: { DAINTREE_E2E_FAULT_MODE: "1" },
    });
    await ctx.app.evaluate(({ BrowserWindow }, s) => {
      BrowserWindow.getAllWindows()[0]?.setSize(s.width, s.height);
    }, WINDOW);
    await stubSnapshot(ctx.app);
    const page = await openAndOnboardProject(ctx.app, ctx.window, repo.dir, "Helios Dashboard");
    await dismissBlockingPalette(page);

    for (const theme of CORE_THEMES) {
      try {
        await captureFullPass(page, theme, planned);
      } catch (error) {
        failures.push(`${theme}: ${String(error).split("\n").slice(0, 3).join(" ")}`);
      }
    }
    for (const theme of SWEEP_THEMES) {
      try {
        await captureSweepPass(page, theme, planned);
      } catch (error) {
        failures.push(`sweep ${theme}: ${String(error).split("\n").slice(0, 3).join(" ")}`);
      }
    }

    const files = new Set(readdirSync(OUTPUT_DIR).filter((f) => f.endsWith(".png")));
    const missing = planned.map((s) => `events--${s}.png`).filter((f) => !files.has(f));
    expect(failures, "passes failed").toEqual([]);
    expect(missing, "frames missing from the output directory").toEqual([]);
  } finally {
    if (ctx?.app) await closeApp(ctx.app);
    repo.cleanup();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
