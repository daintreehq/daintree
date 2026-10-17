/**
 * Create-worktree footer echo (`BranchSummary`) visual-review harness.
 *
 * Renders the real `NewWorktreeDialog` through `new-worktree-preview.html` and
 * photographs only its footer, where `base → branch` is echoed and cropped to
 * the width it has. The states vary the two names' lengths and the dialog's
 * width, so the crop, the arrow between the names and the target's emphasis are
 * seen when nothing is cut, when one side is, and when both are.
 *
 * Opt-in only, like every sibling review harness:
 *
 *   DAINTREE_SHOT_BRANCH_SUMMARY=1 DESIGN_CAPTURE_DIR=/abs/dir \
 *     npx playwright test --project=screenshots branch-summary-footer-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_BRANCH_SUMMARY  required — any truthy value runs the capture
 *   DESIGN_CAPTURE_DIR            output dir (default artifacts/branch-summary-shots)
 *   DAINTREE_SHOT_THEMES          theme sweep for the both-cropped state
 *                                 (default daintree,bondi,namib,hokkaido,redwoods,serengeti)
 *
 * Output: <state>-<theme>.png. The test counts the files itself rather than
 * trusting its own exit code.
 */

import { test, expect, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readdirSync, rmSync } from "fs";
import path from "path";
import {
  makeSnap,
  startPreviewServer,
  stubViteHmrClient,
  type PreviewServer,
} from "../helpers/previewHarness";

const ENABLED = !!process.env.DAINTREE_SHOT_BRANCH_SUMMARY;
const OUT_DIR = path.resolve(
  process.env.DESIGN_CAPTURE_DIR ?? path.join(process.cwd(), "artifacts", "branch-summary-shots")
);
const THEMES = (
  process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi,namib,hokkaido,redwoods,serengeti"
)
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

const ATTACH_TIMEOUT_MS = 30_000;
/** Entrance, the branch-list round trip and the 300ms path debounce. */
const OPEN_SETTLE_MS = 900;
const CLICK_TIMEOUT_MS = 5_000;

const LONG_BRANCH = "feature/retry-backoff-honours-the-server-retry-after-header";

const snap = makeSnap(OUT_DIR);

// 3x, not the siblings' 2x: the subject is a 12px arrow's place between two
// lines of 12px mono, and a pixel of drift is the whole finding.
test.use({ deviceScaleFactor: 3, actionTimeout: CLICK_TIMEOUT_MS });
let server: PreviewServer | undefined;

test.beforeAll(async () => {
  if (!ENABLED) return;
  if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });
  server = await startPreviewServer();
});

test.afterAll(async () => {
  await server?.close();
});

/** Hold one page open until Vite's optimizer stops force-reloading it. */
async function settleDevServer(context: BrowserContext) {
  const page = await context.newPage();
  await stubViteHmrClient(page);
  let navigations = 0;
  page.on("framenavigated", () => navigations++);
  await page.goto(`${server!.baseURL}/new-worktree-preview.html`);
  for (let attempt = 0; attempt < 8; attempt++) {
    const before = navigations;
    await page.waitForTimeout(2_500);
    const ready = await page.locator('[data-testid="new-worktree-dialog"]').count();
    if (navigations === before && ready === 1) break;
  }
  await page.close();
}

async function withPage<T>(
  context: BrowserContext,
  what: string,
  body: (page: Page) => Promise<T>
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const page = await context.newPage();
    await stubViteHmrClient(page);
    let crashed = false;
    const errors: string[] = [];
    page.on("crash", () => {
      crashed = true;
    });
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      const result = await body(page);
      if (errors.length > 0) throw new Error(`${what}: page threw: ${errors.join(" | ")}`);
      return result;
    } catch (error) {
      if (crashed && attempt === 1) {
        console.warn(`[branch-summary-shots] renderer crashed on ${what}; retrying once`);
        continue;
      }
      throw new Error(`${what}: ${String(error)}`, { cause: error });
    } finally {
      await page.close().catch(() => undefined);
    }
  }
}

interface State {
  name: string;
  /** Viewport width; the dialog is `max-w-2xl`, so below ~720 it narrows with it. */
  width: number;
  /** Omitted: the dialog's default base (`develop`) stands. */
  base?: string;
  /** New-branch mode's name. Ignored when `existing` is set. */
  branch?: string;
  /** Existing-branch mode, with this branch picked. */
  existing?: string;
}

const STATES: State[] = [
  { name: "10-fits", width: 1000, branch: "feature/retry-after-header" },
  { name: "20-branch-cropped", width: 1000, branch: LONG_BRANCH },
  { name: "30-both-cropped", width: 1000, base: "feature/streaming-uploads", branch: LONG_BRANCH },
  {
    name: "32-both-cropped-640",
    width: 640,
    base: "feature/streaming-uploads",
    branch: LONG_BRANCH,
  },
  {
    name: "34-both-cropped-540",
    width: 540,
    base: "feature/streaming-uploads",
    branch: LONG_BRANCH,
  },
  { name: "40-long-base-640", width: 640, base: "fix/retry-backoff-jitter", branch: "fix/a" },
  { name: "50-existing-cropped-540", width: 540, existing: "fix/retry-backoff-jitter" },
];

/** The state the theme sweep re-shoots: both names cut, the case under review. */
const SWEEP_STATE = "30-both-cropped";

async function open(page: Page, theme: string, width: number): Promise<Locator> {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(`${server!.baseURL}/new-worktree-preview.html?theme=${theme}`);
  const dialog = page.locator('[data-testid="new-worktree-dialog"]');
  await expect(dialog).toBeAttached({ timeout: ATTACH_TIMEOUT_MS });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(OPEN_SETTLE_MS);
  return dialog;
}

async function pickOption(page: Page, trigger: string, name: string) {
  await page.locator(trigger).click({ timeout: CLICK_TIMEOUT_MS });
  await page
    .getByRole("option")
    .filter({ has: page.locator(`text="${name}"`) })
    .first()
    .click({ timeout: CLICK_TIMEOUT_MS });
  await page.waitForTimeout(300);
}

async function shoot(page: Page, state: State, file: string) {
  console.log(`[branch-summary-shots] ${file}`);
  if (state.existing) {
    await page.getByRole("radio", { name: /Existing/ }).click({ timeout: CLICK_TIMEOUT_MS });
    await page.waitForTimeout(300);
    await pickOption(page, "#existing-branch", state.existing);
  } else {
    if (state.base) await pickOption(page, "#base-branch", state.base);
    await page.locator("#new-branch").fill(state.branch ?? "");
    await page.waitForTimeout(500);
    // Blur onto a static heading: Escape here would ask to discard the draft.
    await page.locator("h3", { hasText: "Destination" }).click({ force: true });
  }
  // Out of the footer, so no hover tooltip or ring sits over the echo.
  await page.mouse.move(2, 2);
  await page.waitForTimeout(400);

  const hint = page.getByTestId("app-dialog-hint");
  const names = hint.locator("[data-branch-name]");
  await expect(names, `${state.name}: the echo is not showing`).toHaveCount(state.existing ? 1 : 2);
  const target = state.existing ?? state.branch!;
  await expect(hint, `${state.name} is not the state it names`).toContainText(target);
  if (state.base) await expect(hint).toContainText(state.base);

  return snap(hint.locator(".."), file);
}

test("branch summary footer — name lengths, dialog widths, theme sweep", async ({ context }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_BRANCH_SUMMARY is required for the branch summary capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_BRANCH_SUMMARY=1 to run the capture");
  test.setTimeout(10 * 60_000);

  await settleDevServer(context);
  const written: string[] = [];

  for (const state of STATES) {
    written.push(
      await withPage(context, `${state.name} daintree`, async (page) => {
        await open(page, "daintree", state.width);
        return shoot(page, state, `${state.name}-daintree.png`);
      })
    );
  }

  const sweep = STATES.find((s) => s.name === SWEEP_STATE)!;
  for (const theme of THEMES.filter((t) => t !== "daintree")) {
    written.push(
      await withPage(context, `${sweep.name} ${theme}`, async (page) => {
        await open(page, theme, sweep.width);
        return shoot(page, sweep, `${sweep.name}-${theme}.png`);
      })
    );
  }

  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(written.length);
  console.log(`[branch-summary-shots] ${onDisk.length} PNGs in ${OUT_DIR}`);
});
