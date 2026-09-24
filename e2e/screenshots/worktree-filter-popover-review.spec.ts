/**
 * Worktree filter popover visual-review harness.
 *
 * Drives the component's own preview entry (`worktree-filter-preview.html`)
 * rather than booting Electron: the real `WorktreeFilterPopover` in its sidebar
 * configuration, opened by clicking its trigger, with chip counts and store filters seeded from a
 * fixture. Captured at 2x so hover fills, focus rings and the gaps between
 * section headers and their bodies are measurable.
 *
 * Opt-in only, like every sibling review harness:
 *
 *   DAINTREE_SHOT_FILTER_POPOVER=1 npx playwright test --project=screenshots worktree-filter-popover-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_FILTER_POPOVER  required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR             output directory (default artifacts/worktree-filter-popover-shots)
 *   DAINTREE_SHOT_THEMES          comma-separated theme sweep (default: daintree,bondi,namib)
 */

import { test, expect, type Locator, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readdirSync, rmSync } from "fs";
import path from "path";
import { startPreviewServer, stubViteHmrClient } from "../helpers/previewHarness";

const ENABLED = !!process.env.DAINTREE_SHOT_FILTER_POPOVER;

const OUT_DIR = path.resolve(
  process.env.DAINTREE_SHOT_DIR ??
    path.join(process.cwd(), "artifacts", "worktree-filter-popover-shots")
);

const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi,namib")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

test.use({ deviceScaleFactor: 2 });

let server: Awaited<ReturnType<typeof startPreviewServer>> | undefined;
let baseURL = "";

test.beforeAll(async () => {
  if (!ENABLED) return;
  if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });
  server = await startPreviewServer();
  baseURL = server.baseURL;
});

test.afterAll(async () => {
  await server?.close();
});

const popover = (page: Page) => page.getByTestId("worktree-filter-popover");
const header = (page: Page, name: string) =>
  popover(page).locator("button[aria-expanded]", { hasText: name }).first();

async function open(page: Page, fixture: string, theme: string) {
  await stubViteHmrClient(page);
  // Wide enough for a right-side tooltip, as the workspace beside the sidebar is.
  await page.setViewportSize({ width: 820, height: 820 });
  await page.goto(`${baseURL}/worktree-filter-preview.html?theme=${theme}&fixture=${fixture}`);
  await expect(page.locator("[data-preview-shell]")).toBeAttached();
  await page.getByRole("button", { name: /^Filter and sort worktrees/ }).click();
  await expect(popover(page)).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await page.mouse.move(0, 0);
  await page.waitForTimeout(250);
}

async function expand(page: Page, name: string) {
  const h = header(page, name);
  if ((await h.getAttribute("aria-expanded")) !== "true") {
    await h.click();
    await expect(h).toHaveAttribute("aria-expanded", "true");
  }
  await page.mouse.move(0, 0);
  await page.waitForTimeout(250);
}

/** Never write an unverified frame: a real box, and every facet header present. */
async function snap(target: Locator, file: string): Promise<string> {
  await expect(target).toBeVisible();
  const box = await target.boundingBox();
  if (!box || box.width < 100 || box.height < 100) {
    throw new Error(`${file}: target has no real box (${JSON.stringify(box)}) — refusing to write`);
  }
  await expect(popover(target.page()).locator("button[aria-expanded][aria-controls]")).toHaveCount(
    7
  );
  const out = path.join(OUT_DIR, file);
  await target.screenshot({ path: out, animations: "disabled" });
  return out;
}

test("Worktree filter popover — states and themes", async ({ page }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_FILTER_POPOVER is required for the filter popover capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_FILTER_POPOVER=1 to run the capture");

  const written: string[] = [];
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));

  for (const theme of THEMES) {
    await open(page, "default", theme);
    written.push(await snap(popover(page), `default-${theme}.png`));

    await open(page, "active", theme);
    written.push(await snap(popover(page), `active-${theme}.png`));

    await open(page, "busy", theme);
    for (const name of ["Sort by", "Issues & PRs", "Sessions", "Activity", "Dev server"]) {
      await expand(page, name);
    }
    written.push(await snap(popover(page), `all-open-${theme}.png`));
  }

  // Interaction states, first theme only — affordance questions, not palette ones.
  const theme = THEMES[0]!;

  await open(page, "default", theme);
  await header(page, "Status").hover();
  await page.waitForTimeout(250);
  written.push(await snap(popover(page), `hover-open-header-${theme}.png`));

  await open(page, "default", theme);
  await header(page, "Sessions").hover();
  await page.waitForTimeout(250);
  written.push(await snap(popover(page), `hover-closed-header-${theme}.png`));

  await open(page, "active", theme);
  await header(page, "Status").hover();
  await page.waitForTimeout(250);
  written.push(await snap(popover(page), `hover-active-header-${theme}.png`));

  await open(page, "active", theme);
  await popover(page).getByRole("button", { name: "Clear Status filters" }).hover();
  await page.waitForTimeout(250);
  written.push(await snap(popover(page), `hover-clear-${theme}.png`));

  // A filtered facet, collapsed: its header has to name what it is filtering by.
  await open(page, "active", theme);
  await header(page, "Status").click();
  await expect(header(page, "Status")).toHaveAttribute("aria-expanded", "false");
  await page.mouse.move(0, 0);
  await page.waitForTimeout(250);
  written.push(await snap(popover(page), `active-collapsed-${theme}.png`));

  // A collapsed summary long enough to clip, with the full list on hover.
  await open(page, "many-selected", theme);
  await header(page, "Branch type").click();
  await expect(header(page, "Branch type")).toHaveAttribute("aria-expanded", "false");
  await page.mouse.move(0, 0);
  await page.waitForTimeout(250);
  written.push(await snap(popover(page), `summary-clipped-${theme}.png`));
  await header(page, "Branch type").hover();
  await expect(page.getByRole("tooltip")).toBeVisible({ timeout: 3000 });
  written.push(await snap(page.locator("body"), `summary-tooltip-${theme}.png`));

  // Keyboard focus reached the way a keyboard user reaches it.
  await open(page, "default", theme);
  await header(page, "Sort by").focus();
  await page.keyboard.press("Tab");
  await page.waitForTimeout(250);
  await expect(header(page, "Status")).toBeFocused();
  written.push(await snap(popover(page), `focus-header-${theme}.png`));

  await open(page, "default", theme);
  await expand(page, "Sort by");
  await popover(page).getByRole("radio", { name: "Alphabetical" }).hover();
  await page.waitForTimeout(250);
  written.push(await snap(popover(page), `sort-open-hover-${theme}.png`));

  await open(page, "default", theme);
  await expand(page, "Sort by");
  await header(page, "Sort by").hover();
  await page.waitForTimeout(250);
  written.push(await snap(popover(page), `sort-open-header-hover-${theme}.png`));

  expect(pageErrors, `preview page threw: ${pageErrors.join(" | ")}`).toEqual([]);

  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(written.length);
  console.log(`[worktree-filter-popover-shots] ${onDisk.length} PNGs in ${OUT_DIR}`);
});
