/**
 * Bulk worktree creation run visual-review harness (#17086).
 *
 * Creating worktrees for a batch of issues runs in the background: the dialog
 * only configures it, and the run shows as a chip in the toolbar with a
 * non-modal popover of every item. This writes PNGs of that surface in every
 * state that carries design weight.
 *
 * Two seams, both real:
 *   - The live flow drives the actual dialog and runner against a fixture repo
 *     with GitHub stubbed and `worktree:create` gated in main, so the chip at
 *     0/20, at 1/20, finished, and retired to the inbox are the runner's own.
 *   - Every other state is a run snapshot published from the project view
 *     through `bulkWorktreeRuns.publish`, the channel the runner itself
 *     reports on; main then pushes it to every view exactly as it would a
 *     real run. That is what makes 7/20 with items on different steps, a
 *     partial failure and two batches at once capturable on demand.
 *
 * Opt-in only: skips itself unless DAINTREE_SHOT_BULK_RUN is set.
 *
 *   DAINTREE_SHOT_BULK_RUN=1 DESIGN_CAPTURE_DIR=/abs/dir \
 *     npx playwright test --project=screenshots bulk-worktree-run-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_BULK_RUN   required — any truthy value runs the capture
 *   DESIGN_CAPTURE_DIR       required — output dir, outside the repo
 *   DAINTREE_SHOT_THEMES     comma-separated themes (default daintree,svalbard)
 *   DAINTREE_SHOT_SWEEP      comma-separated themes for the one-state sweep
 *   DAINTREE_SHOT_ONLY       comma-separated step filter
 *
 * Never writes a PNG it has not verified: each capture asserts its target is
 * on screen with a real box and the text that makes the state this state. A
 * failing step is reported at the end and fails the run.
 */

import { test, expect, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import { mkdirSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { openAndOnboardProject } from "../helpers/project";
import { dismissBlockingPalette } from "../helpers/overlays";
import { setAppTheme } from "../helpers/theme";
import { createFixtureRepo, type FixtureRepo } from "../helpers/fixtures";
import {
  connectGitHub,
  makeFixtureIssue,
  stubListIssues,
  stubRepoStats,
} from "../helpers/githubHelpers";
import { addAndSwitchToProject } from "../helpers/workflows";
import { SEL } from "../helpers/selectors";
import { T_LONG, T_MEDIUM } from "../helpers/timeouts";
import type {
  BulkWorktreeRunItem,
  BulkWorktreeRunSnapshot,
} from "../../shared/types/ipc/bulkWorktreeRuns";

const ENABLED = !!process.env.DAINTREE_SHOT_BULK_RUN;
const SCALE = process.env.DAINTREE_SCREENSHOT_SCALE ?? "2";
const OUTPUT_DIR = process.env.DESIGN_CAPTURE_DIR ?? "";
const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,svalbard")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);
const SWEEP = (
  process.env.DAINTREE_SHOT_SWEEP ?? "daintree,svalbard,namib,bondi,redwoods,highlands"
)
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);
const ONLY = (process.env.DAINTREE_SHOT_ONLY ?? "").split(",").filter(Boolean);

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

const ISSUE_TITLES = [
  "Honour Retry-After on 429 responses from the ingest API",
  "Drain the ingest queue in arrival order after a worker restart",
  "Settings: billing tab loses its scroll position on save",
  "Dashboard sparkline flickers when the range changes",
  "Move the legacy S3, GCS and Azure Blob ingest adapters behind the archive flag",
  "Export CSV drops rows with embedded newlines",
  "Add keyboard navigation to the alerts table",
  "Webhook retries ignore the per-tenant backoff cap",
  "Dark theme: chart axis labels fall below 4.5:1",
  "Flaky: upload resumes from byte 0 after a network blip",
  "Rename 'workspace' to 'project' in onboarding copy",
  "Rate limiter counts preflight OPTIONS requests",
  "Audit log pagination skips the last page",
  "Session expiry banner overlaps the command bar",
  "Support SAML IdP-initiated login",
  "Cache bust fonts on deploy",
  "Search index rebuild blocks the main thread for 4s",
  "Tooltip on truncated tenant names shows the wrong tenant",
  "Billing: proration rounds the wrong way for annual plans",
  "Remove the deprecated v1 metrics endpoint",
];
const ISSUE_BASE = 4100;
const BRANCH = (n: number, title: string) =>
  `feature/issue-${n}-${title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 32)
    .replace(/-$/, "")}`;

const written = new Set<string>();
const stepFailures: string[] = [];

async function step(name: string, fn: () => Promise<void>): Promise<void> {
  if (ONLY.length > 0 && !ONLY.includes(name)) return;
  try {
    await fn();
  } catch (error) {
    const detail = String(error).slice(0, 600);
    stepFailures.push(`${name}: ${detail}`);
    console.warn(`[bulk-run-shots] step "${name}" FAILED:`, detail);
  }
}

async function settle(page: Page, ms = 400): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
  );
  await page.waitForTimeout(ms);
}

async function assertBox(target: Locator, slug: string, minW = 8, minH = 8) {
  await expect(target, `"${slug}": target never became visible — refusing to write`).toBeVisible({
    timeout: T_LONG,
  });
  const box = await target.boundingBox();
  if (!box || box.width < minW || box.height < minH) {
    throw new Error(`"${slug}": target box is ${JSON.stringify(box)} — refusing to write`);
  }
  return box;
}

async function verifyText(target: Locator, slug: string, text: string | RegExp | undefined) {
  if (text === undefined) return;
  await expect(target, `"${slug}": expected content missing — refusing to write`).toContainText(
    text,
    { timeout: T_LONG }
  );
}

async function snapWindow(page: Page, slug: string, mustShow: Locator, text?: string | RegExp) {
  await settle(page);
  await assertBox(mustShow, slug);
  await verifyText(mustShow, slug, text);
  await page.screenshot({
    path: path.join(OUTPUT_DIR, `${slug}.png`),
    type: "png",
    animations: "disabled",
    caret: "hide",
  });
  written.add(`${slug}.png`);
}

async function snap(page: Page, slug: string, target: Locator, text?: string | RegExp) {
  await settle(page);
  await assertBox(target, slug, 40, 16);
  await verifyText(target, slug, text);
  await target.screenshot({
    path: path.join(OUTPUT_DIR, `${slug}.png`),
    type: "png",
    animations: "disabled",
    caret: "hide",
  });
  written.add(`${slug}.png`);
}

/** The chip and its popover together, with the toolbar strip around them for context. */
async function snapRegion(
  page: Page,
  slug: string,
  targets: Locator[],
  text?: { target: Locator; value: string | RegExp },
  pad = 16
) {
  await settle(page);
  const boxes = [];
  for (const t of targets) boxes.push(await assertBox(t, slug));
  if (text) await verifyText(text.target, slug, text.value);
  const vp = page.viewportSize() ?? { width: 1680, height: 1050 };
  const x = Math.max(0, Math.min(...boxes.map((b) => b.x)) - pad - 220);
  const y = 0;
  const right = Math.min(vp.width, Math.max(...boxes.map((b) => b.x + b.width)) + pad);
  const bottom = Math.min(vp.height, Math.max(...boxes.map((b) => b.y + b.height)) + pad);
  await page.screenshot({
    path: path.join(OUTPUT_DIR, `${slug}.png`),
    type: "png",
    animations: "disabled",
    caret: "hide",
    clip: { x, y, width: right - x, height: bottom - y },
  });
  written.add(`${slug}.png`);
}

const chipOf = (page: Page) => page.locator('[data-testid="bulk-worktree-run-indicator"]');
const popoverOf = (page: Page) => page.locator('[data-testid="bulk-worktree-run-popover"]');

async function openPopover(page: Page): Promise<Locator> {
  const chip = chipOf(page);
  await expect(chip).toBeVisible({ timeout: T_LONG });
  if ((await chip.getAttribute("aria-expanded")) !== "true") await chip.click();
  const popover = popoverOf(page);
  await expect(popover, "run popover never opened").toBeVisible({ timeout: T_LONG });
  return popover;
}

async function closePopover(page: Page): Promise<void> {
  if (
    await popoverOf(page)
      .isVisible()
      .catch(() => false)
  ) {
    await page.keyboard.press("Escape");
    await expect(popoverOf(page)).toBeHidden({ timeout: T_MEDIUM });
  }
  await page.mouse.move(400, 600);
}

// ---------------------------------------------------------------------------
// Published fixture runs
// ---------------------------------------------------------------------------

function item(n: number, overrides: Partial<BulkWorktreeRunItem> = {}): BulkWorktreeRunItem {
  const index = (n - ISSUE_BASE - 1 + ISSUE_TITLES.length) % ISSUE_TITLES.length;
  const title = ISSUE_TITLES[index]!;
  return { number: n, title, stage: "pending", attempt: 0, ...overrides };
}

function succeeded(n: number): BulkWorktreeRunItem {
  const base = item(n);
  return {
    ...base,
    stage: "succeeded",
    attempt: 1,
    worktreeId: `wt-${n}`,
    worktreePath: `/tmp/helios-worktrees/issue-${n}`,
    branch: BRANCH(n, base.title),
  };
}

const numbers = (from: number, count: number) =>
  Array.from({ length: count }, (_, i) => ISSUE_BASE + from + i);

interface RunSpec {
  runId: string;
  mode?: "issue" | "pr";
  phase: BulkWorktreeRunSnapshot["phase"];
  items: BulkWorktreeRunItem[];
  startedAgoMs?: number;
}

function snapshot(spec: RunSpec): BulkWorktreeRunSnapshot {
  const now = Date.now();
  return {
    runId: spec.runId,
    projectId: "set-by-main",
    mode: spec.mode ?? "issue",
    phase: spec.phase,
    items: spec.items,
    startedAt: now - (spec.startedAgoMs ?? 20_000),
    updatedAt: now,
    controllable: true,
  };
}

const RUNS = {
  running7: (): RunSpec => ({
    runId: "shot-running-7",
    phase: "running",
    items: [
      ...numbers(1, 7).map(succeeded),
      item(ISSUE_BASE + 8, {
        stage: "assigning",
        attempt: 1,
        worktreeId: "wt-8",
        branch: BRANCH(ISSUE_BASE + 8, ISSUE_TITLES[7]!),
      }),
      item(ISSUE_BASE + 9, { stage: "terminals-spawning", attempt: 1, worktreeId: "wt-9" }),
      item(ISSUE_BASE + 10, { stage: "worktree-creating", attempt: 2 }),
      item(ISSUE_BASE + 11, { stage: "worktree-creating", attempt: 1 }),
      ...numbers(12, 9).map((n) => item(n)),
    ],
  }),
  // Every worktree is on disk and the last few are still setting up: the
  // count has reached the total while the batch is still working.
  finishing: (): RunSpec => ({
    runId: "shot-finishing",
    phase: "running",
    items: [
      ...numbers(1, 6).map(succeeded),
      item(ISSUE_BASE + 7, { stage: "worktree-created", attempt: 1, worktreeId: "wt-7" }),
      item(ISSUE_BASE + 8, { stage: "terminals-spawning", attempt: 1, worktreeId: "wt-8" }),
      item(ISSUE_BASE + 9, { stage: "assigning", attempt: 1, worktreeId: "wt-9" }),
      item(ISSUE_BASE + 10, { stage: "verifying", attempt: 1, worktreeId: "wt-10" }),
    ],
  }),
  // One creation failed and the rest are setting up: nothing is left to
  // create, so this is the setup tail even though the count stops at 9/10.
  finishingWithFailure: (): RunSpec => ({
    runId: "shot-finishing-failure",
    phase: "running",
    items: [
      ...numbers(1, 8).map(succeeded),
      item(ISSUE_BASE + 9, { stage: "verifying", attempt: 1, worktreeId: "wt-9" }),
      item(ISSUE_BASE + 10, {
        stage: "failed",
        attempt: 3,
        failedStep: "worktree",
        error: "fatal: invalid reference: origin/feature/issue-4110",
      }),
    ],
  }),
  partial: (): RunSpec => ({
    runId: "shot-partial",
    phase: "done",
    items: [
      ...numbers(1, 4).map(succeeded),
      item(ISSUE_BASE + 5, {
        stage: "failed",
        attempt: 3,
        failedStep: "worktree",
        error:
          "fatal: 'feature/issue-4105-move-the-legacy-s3-gcs-and' is already checked out at '/Users/avery/helios-worktrees/legacy-adapters'",
      }),
      ...numbers(6, 6).map(succeeded),
      item(ISSUE_BASE + 12, {
        stage: "failed",
        attempt: 1,
        failedStep: "verification",
        worktreeId: "wt-12",
        error: "1 terminal crashed after spawn",
      }),
      ...numbers(13, 5).map(succeeded),
      item(ISSUE_BASE + 18, {
        stage: "failed",
        attempt: 1,
        failedStep: "assignment",
        worktreeId: "wt-18",
        error: "GitHub refused the assignment: you don't have permission to assign this issue",
      }),
      ...numbers(19, 2).map(succeeded),
    ],
  }),
  partialRetrying: (): RunSpec => ({
    runId: "shot-partial-retry",
    phase: "running",
    items: [
      ...numbers(1, 4).map(succeeded),
      item(ISSUE_BASE + 5, { stage: "worktree-creating", attempt: 1, retried: 1 }),
      ...numbers(6, 6).map(succeeded),
      item(ISSUE_BASE + 12, {
        stage: "terminals-spawning",
        attempt: 1,
        retried: 1,
        worktreeId: "wt-12",
      }),
      ...numbers(13, 5).map(succeeded),
      item(ISSUE_BASE + 18, { stage: "pending", attempt: 1, retried: 1, worktreeId: "wt-18" }),
      ...numbers(19, 2).map(succeeded),
    ],
  }),
  allFailed: (): RunSpec => ({
    runId: "shot-all-failed",
    phase: "done",
    items: numbers(1, 6).map((n) =>
      item(n, {
        stage: "failed",
        attempt: 5,
        failedStep: "worktree",
        error: "Couldn't reach github.com after 5 attempts (ETIMEDOUT)",
      })
    ),
  }),
  cancelling: (): RunSpec => ({
    runId: "shot-cancelling",
    phase: "cancelling",
    items: [
      ...numbers(1, 7).map(succeeded),
      item(ISSUE_BASE + 8, { stage: "worktree-creating", attempt: 1 }),
      item(ISSUE_BASE + 9, { stage: "worktree-creating", attempt: 1 }),
      ...numbers(10, 11).map((n) => item(n)),
    ],
  }),
  cancelled: (): RunSpec => ({
    runId: "shot-cancelled",
    phase: "cancelled",
    items: [
      ...numbers(1, 7).map(succeeded),
      item(ISSUE_BASE + 8, { stage: "cancelled", attempt: 1, worktreeId: "wt-8" }),
      item(ISSUE_BASE + 9, { stage: "cancelled", attempt: 1, worktreeId: "wt-9" }),
      ...numbers(10, 11).map((n) => item(n, { stage: "cancelled" })),
    ],
  }),
  prRunning: (): RunSpec => ({
    runId: "shot-pr",
    mode: "pr",
    phase: "running",
    startedAgoMs: 4_000,
    items: [
      { ...succeeded(ISSUE_BASE + 301), title: "Bump vitest to 4.1 and fix snapshot drift" },
      { ...succeeded(ISSUE_BASE + 302), title: "feat(export): stream CSV instead of buffering" },
      {
        ...item(ISSUE_BASE + 303, { stage: "terminals-spawning", attempt: 1 }),
        title: "fix(auth): refresh SAML metadata on rotation",
      },
      { ...item(ISSUE_BASE + 304), title: "chore: drop Node 20 from the CI matrix" },
      { ...item(ISSUE_BASE + 305), title: "docs: document the ingest backpressure knobs" },
    ],
  }),
};

async function publish(page: Page, spec: RunSpec): Promise<void> {
  const snap = snapshot(spec);
  await page.evaluate((s) => window.electron.bulkWorktreeRuns.publish(s), snap);
}

/** Settle every run this view published, then forget all of them. */
async function clearRuns(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const api = window.electron.bulkWorktreeRuns;
    for (const run of await api.list()) {
      if (run.phase === "running" || run.phase === "cancelling") {
        await api.publish({ ...run, phase: "done", updatedAt: Date.now() }).catch(() => {});
      }
      await api.dismiss(run.runId).catch(() => {});
    }
  });
  await expect(chipOf(page), "chip still showing after clearing every run").toBeHidden({
    timeout: T_LONG,
  });
}

// ---------------------------------------------------------------------------
// Live flow seams
// ---------------------------------------------------------------------------

async function installGatedCreates(app: ElectronApplication, cwd: string): Promise<void> {
  await app.evaluate(
    ({ ipcMain }, { cwd }) => {
      const g = globalThis as unknown as {
        __bulkShotGate: { released: number; waiting: Array<() => void>; made: number };
      };
      g.__bulkShotGate = { released: 0, waiting: [], made: 0 };
      type Payload = { branchName: string; options: { newBranch: string } };
      const replace = (channel: string, handler: (event: unknown, payload: Payload) => unknown) => {
        ipcMain.removeHandler(channel);
        ipcMain.handle(channel, handler as never);
      };
      replace("worktree:get-available-branch", async (_e, payload) => payload.branchName);
      replace("worktree:get-default-path", async () => cwd);
      replace("worktree:set-active", async () => undefined);
      replace("worktree:create", async (_e, payload) => {
        const gate = g.__bulkShotGate;
        const index = gate.made++;
        if (index >= gate.released) {
          await new Promise<void>((resolve) => gate.waiting.push(resolve));
        }
        return {
          worktreeId: `shot-live-${index}-${payload.options.newBranch}`,
          branch: payload.options.newBranch,
          setupState: "unknown",
        };
      });
    },
    { cwd }
  );
}

async function releaseCreates(app: ElectronApplication, count: number): Promise<void> {
  await app.evaluate((_electron, count) => {
    const gate = (
      globalThis as unknown as {
        __bulkShotGate: { released: number; waiting: Array<() => void> };
      }
    ).__bulkShotGate;
    gate.released += count;
    for (let i = 0; i < count && gate.waiting.length > 0; i++) gate.waiting.shift()!();
  }, count);
}

async function openBulkDialog(page: Page): Promise<Locator> {
  const pill = page.locator(SEL.github.statPillIssues);
  await expect(pill).toBeVisible({ timeout: T_LONG });
  await expect(pill).not.toHaveAccessibleName(/Configure/, { timeout: T_LONG });
  await pill.click();
  await page.locator(SEL.github.searchIssues).fill("");
  await expect(page.locator(SEL.github.item(ISSUE_BASE + 1))).toBeVisible({ timeout: T_LONG });
  await page.getByRole("button", { name: "Select issues" }).click();
  const selectAll = page
    .locator(SEL.github.selectionActions)
    .getByRole("menuitem", { name: /Select all/ });
  await expect(selectAll).toBeVisible({ timeout: T_MEDIUM });
  await selectAll.press("Enter");
  await expect(page.locator(SEL.github.bulkActionBar)).toBeVisible({ timeout: T_MEDIUM });
  await page.locator(SEL.github.bulkCreateButton).click();
  const dialog = page.locator(SEL.github.bulkCreateDialog);
  await expect(dialog).toBeVisible({ timeout: T_LONG });
  const assign = dialog.getByRole("checkbox", { name: "Assign to me" });
  await expect(assign).toBeEnabled({ timeout: T_LONG });
  await assign.uncheck();
  const recipeTrigger = page.locator("#bulk-recipe-selector-trigger");
  await recipeTrigger.click();
  await page
    .locator("#bulk-recipe-selector")
    .getByRole("option", { name: /No recipe/ })
    .click();
  await expect(recipeTrigger).toContainText(/No recipe/, { timeout: T_MEDIUM });
  return dialog;
}

/**
 * The toolbar is one Tab stop with arrow keys between its items (roving
 * tabindex), so reach it the way a keyboard user does: Tab into the toolbar,
 * then arrow to the chip. Real key presses, so :focus-visible is honest.
 */
async function tabToChip(page: Page): Promise<void> {
  const chip = chipOf(page);
  await page.mouse.click(700, 500);
  let inToolbar = false;
  for (let i = 0; i < 120 && !inToolbar; i++) {
    await page.keyboard.press("Tab");
    inToolbar = await page.evaluate(
      () => document.activeElement?.closest("header [data-toolbar-item]") !== null
    );
  }
  if (!inToolbar) throw new Error("Tab never reached the toolbar");
  await page.keyboard.press("End");
  for (let i = 0; i < 40; i++) {
    const reached = await chip
      .evaluate((el) => el === document.activeElement && el.matches(":focus-visible"))
      .catch(() => false);
    if (reached) return;
    await page.keyboard.press("ArrowLeft");
  }
  throw new Error("never reached :focus-visible on the run chip with the arrow keys");
}

async function resizeWindow(app: ElectronApplication, width: number, height: number) {
  await app.evaluate(
    ({ BrowserWindow }, { width, height }) => {
      for (const win of BrowserWindow.getAllWindows()) win.setContentSize(width, height);
    },
    { width, height }
  );
}

// ---------------------------------------------------------------------------

test("bulk worktree run review — states and themes", async () => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_BULK_RUN is required for the bulk run capture",
  });
  test.skip(!ENABLED, "Set DAINTREE_SHOT_BULK_RUN to run the bulk run capture");
  if (!OUTPUT_DIR || !path.isAbsolute(OUTPUT_DIR)) {
    throw new Error("DESIGN_CAPTURE_DIR must be an absolute directory outside the repo");
  }
  test.setTimeout(30 * 60_000);

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const repoA: FixtureRepo = createFixtureRepo({
    name: "helios-dashboard",
    withGitHubRemote: true,
  });
  const repoB: FixtureRepo = createFixtureRepo({ name: "ledger-service", withGitHubRemote: true });
  const userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-bulkshot-"));
  let ctx: AppContext | undefined;

  try {
    ctx = await launchApp({
      userDataDir,
      screenshotScale: SCALE,
      windowSize: { width: 1680, height: 1050 },
      env: { DAINTREE_E2E_FAULT_MODE: "1" },
      extraArgs: ["--disable-gpu", "--in-process-gpu", "--disable-breakpad", "--noerrdialogs"],
    });
    const app = ctx.app;
    let page = await openAndOnboardProject(app, ctx.window, repoA.dir, "Helios Dashboard");
    await dismissBlockingPalette(page);

    const issues = ISSUE_TITLES.map((title, i) => makeFixtureIssue(ISSUE_BASE + 1 + i, title));
    await installGatedCreates(app, repoA.dir);
    await connectGitHub(app, page);
    await stubRepoStats(app, { issueCount: issues.length, prCount: 0, commitCount: 1 }, page);
    await stubListIssues(app, issues);

    // --- The live flow, default theme only: the runner's own run. ---------
    await setAppTheme(page, THEMES[0]!);
    await page.addStyleTag({ content: POLISH_CSS }).catch(() => {});
    await dismissBlockingPalette(page);

    await step("live", async () => {
      const dialog = await openBulkDialog(page);
      await snap(page, `10-config-dialog--${THEMES[0]}`, dialog, "Create 20 worktrees");

      await dialog.locator('[data-testid="bulk-create-confirm-button"]').click();
      await expect(dialog, "the dialog stayed open after Create").toBeHidden({ timeout: T_LONG });
      await expect(chipOf(page)).toContainText("0/20", { timeout: T_LONG });
      await page.mouse.move(800, 600);
      await snapWindow(page, `11-after-create--${THEMES[0]}`, chipOf(page), "Creating worktrees");

      await releaseCreates(app, 1);
      await expect(chipOf(page)).toContainText("1/20", { timeout: T_LONG });
      let popover = await openPopover(page);
      await snapRegion(page, `12-running-1of20--${THEMES[0]}`, [chipOf(page), popover], {
        target: popover,
        value: "1 of 20 created",
      });
      await closePopover(page);

      await releaseCreates(app, 19);
      await expect(chipOf(page)).toHaveAttribute("data-tone", "success", { timeout: T_LONG * 2 });
      popover = await openPopover(page);
      await snapRegion(page, `13-done-lingering--${THEMES[0]}`, [chipOf(page), popover], {
        target: popover,
        value: "20 worktrees created",
      });
      await closePopover(page);
      await expect(chipOf(page), "a clean finish never retired").toBeHidden({ timeout: 20_000 });

      const bell = page.locator(SEL.notifications.bellButton).first();
      await bell.click();
      const center = page.locator('[data-testid="notification-center"]');
      await expect(center).toBeVisible({ timeout: T_LONG });
      await snapRegion(page, `14-retired-to-inbox--${THEMES[0]}`, [bell, center], {
        target: center,
        value: "20 worktrees created",
      });
      await page.keyboard.press("Escape");
      await clearRuns(page);
    });

    // --- Published states, per theme. -------------------------------------
    for (const theme of THEMES) {
      await clearRuns(page).catch(() => {});
      await setAppTheme(page, theme);
      await page.addStyleTag({ content: POLISH_CSS }).catch(() => {});
      await dismissBlockingPalette(page);
      await clearRuns(page).catch(() => {});

      const states: Array<{ slug: string; runs: RunSpec[]; expect: string | RegExp }> = [
        { slug: "19-finishing-setup", runs: [RUNS.finishing()], expect: "Finishing setup" },
        {
          slug: "19b-finishing-with-failure",
          runs: [RUNS.finishingWithFailure()],
          expect: "1 setting up",
        },
        { slug: "20-running-7of20", runs: [RUNS.running7()], expect: "Attempt 2" },
        { slug: "21-partial-failure", runs: [RUNS.partial()], expect: "Retry 3 failed" },
        {
          slug: "22-partial-retrying",
          runs: [RUNS.partialRetrying()],
          expect: "Retrying 3 failed",
        },
        { slug: "23-all-failed", runs: [RUNS.allFailed()], expect: "Couldn't create 6 worktrees" },
        { slug: "24-cancelling", runs: [RUNS.cancelling()], expect: "Cancelling…" },
        { slug: "25-cancelled", runs: [RUNS.cancelled()], expect: "Creation cancelled" },
        {
          slug: "26-two-batches-pr",
          runs: [RUNS.running7(), RUNS.prRunning()],
          expect: "pull request",
        },
      ];
      for (const state of states) {
        await step(state.slug, async () => {
          await clearRuns(page);
          for (const run of state.runs) await publish(page, run);
          await expect(chipOf(page)).toBeVisible({ timeout: T_LONG });
          await page.mouse.move(800, 600);
          await snap(page, `${state.slug}-chip--${theme}`, chipOf(page));
          const popover = await openPopover(page);
          await snapRegion(page, `${state.slug}--${theme}`, [chipOf(page), popover], {
            target: popover,
            value: state.expect,
          });
          await closePopover(page);
        });
      }

      await step("keyboard", async () => {
        await clearRuns(page);
        await publish(page, RUNS.partial());
        await tabToChip(page);
        await page.keyboard.press("Enter");
        const popover = popoverOf(page);
        await expect(popover).toBeVisible({ timeout: T_LONG });
        await page.keyboard.press("Tab");
        await snapRegion(page, `27-keyboard-focus--${theme}`, [chipOf(page), popover], {
          target: popover,
          value: "Retry 3 failed",
        });
        await page.keyboard.press("Escape");
        await expect(popover).toBeHidden({ timeout: T_MEDIUM });
        // Radix hands focus back once the content has unmounted, a task later.
        await expect
          .poll(() => chipOf(page).evaluate((el) => el === document.activeElement), {
            timeout: 3_000,
            message: "Escape did not return focus to the chip",
          })
          .toBe(true);
      });
    }

    // --- Forced colours and reduced motion, default theme. ----------------
    await clearRuns(page).catch(() => {});
    await setAppTheme(page, THEMES[0]!);
    await page.addStyleTag({ content: POLISH_CSS }).catch(() => {});
    await dismissBlockingPalette(page);

    await step("forced-colors", async () => {
      await clearRuns(page);
      await page.emulateMedia({ forcedColors: "active" });
      const on = await page.evaluate(() => matchMedia("(forced-colors: active)").matches);
      if (!on) throw new Error("forced-colors emulation did not take");
      await publish(page, RUNS.partial());
      const popover = await openPopover(page);
      await snapRegion(page, `28-forced-colors--${THEMES[0]}`, [chipOf(page), popover], {
        target: popover,
        value: "Retry 3 failed",
      });
      await closePopover(page);
      await clearRuns(page);
      await publish(page, RUNS.running7());
      await expect(chipOf(page)).toContainText("9/20", { timeout: T_LONG });
      await page.mouse.move(800, 600);
      await snap(page, `28b-forced-colors-running-chip--${THEMES[0]}`, chipOf(page));
      await page.emulateMedia({ forcedColors: "none" });
    });

    await step("more-contrast", async () => {
      await clearRuns(page);
      await page.emulateMedia({ contrast: "more" });
      const on = await page.evaluate(() => matchMedia("(prefers-contrast: more)").matches);
      if (!on) throw new Error("prefers-contrast emulation did not take");
      await publish(page, RUNS.running7());
      await expect(chipOf(page)).toContainText("9/20", { timeout: T_LONG });
      await page.mouse.move(800, 600);
      await snap(page, `28c-more-contrast-running-chip--${THEMES[0]}`, chipOf(page));
      await page.emulateMedia({ contrast: "no-preference" });
    });

    await step("reduced-motion", async () => {
      await clearRuns(page);
      await page.emulateMedia({ reducedMotion: "reduce" });
      await publish(page, RUNS.running7());
      const popover = await openPopover(page);
      await snapRegion(page, `29-reduced-motion--${THEMES[0]}`, [chipOf(page), popover], {
        target: popover,
        value: "9 of 20 created",
      });
      await closePopover(page);
      await page.emulateMedia({ reducedMotion: "no-preference" });
    });

    // --- One state across the theme sweep, for a contact sheet. -----------
    for (const theme of SWEEP) {
      await step(`sweep-${theme}`, async () => {
        await clearRuns(page).catch(() => {});
        await setAppTheme(page, theme);
        await page.addStyleTag({ content: POLISH_CSS }).catch(() => {});
        await dismissBlockingPalette(page);
        await clearRuns(page);
        await publish(page, RUNS.partial());
        await publish(page, { ...RUNS.running7(), startedAgoMs: 1_000 });
        const popover = await openPopover(page);
        await snapRegion(page, `90-sweep--${theme}`, [chipOf(page), popover], {
          target: popover,
          value: "Retry 3 failed",
        });
        await closePopover(page);
        // The live chip on its own, gauge included, in the same theme.
        await clearRuns(page);
        await publish(page, RUNS.running7());
        await expect(chipOf(page)).toContainText("9/20", { timeout: T_LONG });
        await page.mouse.move(800, 600);
        await snap(page, `91-sweep-chip--${theme}`, chipOf(page));
      });
    }

    // --- Another project, then a narrow window. ---------------------------
    await clearRuns(page).catch(() => {});
    await setAppTheme(page, THEMES[0]!);
    await page.addStyleTag({ content: POLISH_CSS }).catch(() => {});
    await dismissBlockingPalette(page);
    await step("other-project", async () => {
      await clearRuns(page);
      await publish(page, RUNS.running7());
      await expect(chipOf(page)).toBeVisible({ timeout: T_LONG });
      const other = await addAndSwitchToProject(app, page, repoB.dir, "Ledger Service");
      await other.addStyleTag({ content: POLISH_CSS }).catch(() => {});
      await dismissBlockingPalette(other);
      await expect(chipOf(other), "the run never showed in the other project").toContainText(
        "9/20",
        { timeout: T_LONG }
      );
      await other.mouse.move(800, 600);
      await snapWindow(other, `40-other-project--${THEMES[0]}`, chipOf(other), "9/20");
      const popover = await openPopover(other);
      await snapRegion(other, `41-other-project-popover--${THEMES[0]}`, [chipOf(other), popover], {
        target: popover,
        value: "Creating worktrees",
      });
      await closePopover(other);

      await resizeWindow(app, 1040, 720);
      await settle(other, 800);
      await expect(chipOf(other)).toBeVisible({ timeout: T_LONG });
      await snapWindow(other, `50-narrow-window--${THEMES[0]}`, chipOf(other), "9/20");
      await resizeWindow(app, 1680, 1050);
      page = other;
    });
  } finally {
    if (ctx) await closeApp(ctx.app).catch(() => {});
    repoA.cleanup();
    repoB.cleanup();
  }

  console.log(`[bulk-run-shots] wrote ${written.size} PNGs to ${OUTPUT_DIR}`);
  if (stepFailures.length > 0) {
    throw new Error(`bulk run capture had failing steps:\n${stepFailures.join("\n")}`);
  }
});
