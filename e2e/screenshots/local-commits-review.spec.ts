/**
 * Local commits dropdown visual-review harness.
 *
 * Drives the forge stats preview entry (`forge-stats-preview.html`), which
 * mounts the REAL `ForgeStatsToolbarButton`, opens the commits pill, and lets
 * the real `LocalCommitsDropdown` read its history and push range from the
 * `?commits=` fixtures in `src/components/Layout/__preview__/localCommitsFixtures.ts`.
 * No provider view is registered in the preview, so the commits pill always
 * opens the local dropdown — the same thing a project with no forge sees.
 *
 *   DAINTREE_SHOT_LOCALCOMMITS=1 npx playwright test --project=screenshots local-commits-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_LOCALCOMMITS  required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR           output directory (default artifacts/local-commits-shots)
 *   DAINTREE_SHOT_THEMES        comma-separated sweep (default daintree,bondi,namib,svalbard);
 *                               the first two get every state, the rest a rest shot
 *
 * Never writes a PNG it has not verified: every state asserts its fixture text
 * (or its absence) before the shot, and the test counts the files at the end.
 */

import { test, expect, type Locator, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readdirSync, rmSync } from "fs";
import path from "path";
import { startPreviewServer, stubViteHmrClient, makeSnap } from "../helpers/previewHarness";

const ENABLED = !!process.env.DAINTREE_SHOT_LOCALCOMMITS;

const OUT_DIR = path.resolve(
  process.env.DAINTREE_SHOT_DIR ?? path.join(process.cwd(), "artifacts", "local-commits-shots")
);

const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi,namib,svalbard")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

/** Subjects the fixtures carry, so a shot can prove its data landed. */
const NEWEST = "keep the commits pill count in step with the worktree";
const WITH_LIST = "update root and plugin package dependencies";
const DEEP = "stop the palette flake on cold start";

test.use({ deviceScaleFactor: 2 });

let server: Awaited<ReturnType<typeof startPreviewServer>> | undefined;
let baseURL = "";
let snap: ReturnType<typeof makeSnap>;

test.beforeAll(async () => {
  if (!ENABLED) return;
  if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });
  server = await startPreviewServer();
  baseURL = server.baseURL;
  snap = makeSnap(OUT_DIR);
});

test.afterAll(async () => {
  await server?.close();
});

function panelOf(page: Page): Locator {
  return page
    .getByRole("combobox", { name: /search commits/i })
    .locator('xpath=ancestor::div[contains(@class,"surface-overlay")][1]');
}

async function openDropdown(
  page: Page,
  commits: string,
  theme: string,
  /** `github`: the GitHub plugin's forge-mode commits list over the same data. */
  forge?: "github"
): Promise<Locator> {
  await stubViteHmrClient(page);
  await page.mouse.move(0, 0);
  await page.setViewportSize({ width: 600, height: 640 });
  await page.goto(
    forge
      ? `${baseURL}/forge-stats-preview.html?theme=${theme}&fixture=default&forge=${forge}&commits=${commits}`
      : `${baseURL}/forge-stats-preview.html?theme=${theme}&fixture=commits-only&commits=${commits}`
  );
  const pill = page.getByTestId("forge-stat-pill-commits");
  await expect(pill, `commits "${commits}" rendered no pill`).toBeVisible();
  await expect(pill).not.toContainText("—");
  await page.evaluate(() => document.fonts.ready);
  await pill.click();
  await expect(pill).toHaveAttribute("aria-expanded", "true");
  const panel = panelOf(page);
  await expect(panel).toBeVisible();
  // Popover entry motion plus the skeleton gate.
  await page.waitForTimeout(500);
  return panel;
}

async function settled(panel: Locator, text: string | null): Promise<void> {
  if (text === null) {
    await expect(panel).not.toContainText(NEWEST);
  } else {
    await expect(panel).toContainText(text);
  }
  await panel.page().waitForTimeout(250);
}

test("Local commits dropdown — states and themes", async ({ page }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_LOCALCOMMITS is required for the local commits capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_LOCALCOMMITS=1 to run the capture");
  test.setTimeout(10 * 60_000);

  const written: string[] = [];
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));

  // Vite's dependency optimizer re-bundles when the entry's import graph has
  // changed since the last run and answers the stale chunks with 504s, which
  // leaves the first page blank. Load until the pill renders, then capture.
  await stubViteHmrClient(page);
  const warm = page.getByTestId("forge-stat-pill-commits");
  for (let attempt = 0; attempt < 6; attempt++) {
    await page.goto(`${baseURL}/forge-stats-preview.html?fixture=commits-only&commits=few`);
    if (await warm.isVisible({ timeout: 15_000 }).catch(() => false)) break;
    await page.waitForTimeout(3_000);
  }
  await expect(warm, "preview never rendered the commits pill").toBeVisible();
  pageErrors.length = 0;

  const full = THEMES.slice(0, 2);
  const rest = THEMES.slice(2);
  let expected = 0;

  for (const theme of full) {
    const shot = async (panel: Locator, name: string) => {
      written.push(await snap(panel, `${name}-${theme}.png`));
    };

    // A few commits, just opened: search focused, nothing under the cursor.
    let panel = await openDropdown(page, "few", theme);
    await settled(panel, NEWEST);
    await shot(panel, "01-few-rest");

    // Pointer over the second row.
    await page.getByText("pin the pill and dropdown to one cwd").hover();
    await page.waitForTimeout(250);
    await shot(panel, "02-few-hover");
    await page.mouse.move(0, 0);

    // Keyboard cursor on the second row (a row without a body).
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(250);
    await shot(panel, "03-few-cursor");

    // Cursor back on the first row and its body expanded with Enter.
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("Enter");
    await expect(panel).toContainText("Read both from the same cwd.");
    await page.waitForTimeout(350);
    await shot(panel, "04-few-expanded");

    // Everything pushed / never pushed / no remote.
    panel = await openDropdown(page, "synced", theme);
    await settled(panel, NEWEST);
    await shot(panel, "05-synced");
    panel = await openDropdown(page, "unpublished", theme);
    await settled(panel, NEWEST);
    await shot(panel, "06-unpublished");
    panel = await openDropdown(page, "no-remote", theme);
    await settled(panel, NEWEST);
    await shot(panel, "07-no-remote");

    // A long history: top, cursor deep into the list, scrolled to the end.
    panel = await openDropdown(page, "long", theme);
    await settled(panel, WITH_LIST);
    await shot(panel, "08-long-top");
    for (let i = 0; i < 14; i++) await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(350);
    await shot(panel, "09-long-cursor-deep");
    await panel.evaluate((el) => {
      const scroller = [...el.querySelectorAll<HTMLElement>("*")].find(
        // The list scroller, not a collapsed body's overflow-hidden wrapper,
        // which also reports more content than it shows.
        (n) =>
          n.scrollHeight > n.clientHeight + 4 &&
          ["auto", "scroll"].includes(getComputedStyle(n).overflowY)
      );
      if (!scroller) throw new Error("no scrolling list in the panel");
      scroller.scrollTop = scroller.scrollHeight;
    });
    await expect(panel).toContainText(DEEP);
    await expect(page.getByRole("button", { name: /load more/i })).toBeInViewport();
    await page.waitForTimeout(350);
    await shot(panel, "10-long-bottom");

    // A search that matches nothing.
    panel = await openDropdown(page, "few", theme);
    await settled(panel, NEWEST);
    await page.keyboard.type("zebra");
    await expect(panel).not.toContainText(NEWEST, { timeout: 3_000 });
    await page.waitForTimeout(300);
    await shot(panel, "11-search-empty");

    // An empty repository.
    panel = await openDropdown(page, "empty", theme);
    await settled(panel, null);
    await page.waitForTimeout(300);
    await shot(panel, "12-empty");

    // The history read has not answered.
    panel = await openDropdown(page, "loading", theme);
    await settled(panel, null);
    await page.waitForTimeout(400);
    await shot(panel, "13-loading");

    // The history read failed.
    panel = await openDropdown(page, "error", theme);
    await settled(panel, "Couldn't load commits");
    await shot(panel, "14-error");

    // Page two failed.
    panel = await openDropdown(page, "load-more-error", theme);
    await settled(panel, WITH_LIST);
    await page.getByRole("button", { name: /load more/i }).click();
    await expect(panel).toContainText("timed out", { timeout: 3_000 });
    await page.waitForTimeout(300);
    await shot(panel, "15-load-more-error");

    // In context: the pill and the panel it owns.
    panel = await openDropdown(page, "few", theme);
    await settled(panel, NEWEST);
    {
      const shell = page.locator("[data-preview-shell]");
      const shellBox = await shell.boundingBox();
      const panelBox = await panel.boundingBox();
      if (!shellBox || !panelBox) throw new Error("in-context: missing box");
      const out = path.join(OUT_DIR, `16-in-context-${theme}.png`);
      await page.screenshot({
        path: out,
        clip: {
          x: shellBox.x,
          y: shellBox.y,
          width: shellBox.width,
          height: panelBox.y + panelBox.height - shellBox.y + 12,
        },
      });
      written.push(out);
    }

    // The GitHub plugin's commits list — the same surface in forge mode.
    panel = await openDropdown(page, "few", theme, "github");
    await settled(panel, NEWEST);
    await shot(panel, "17-github-few-rest");
    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(250);
    await shot(panel, "18-github-few-cursor");

    // The footer's widest case: a capped range under the cursor, beside the
    // forge's own footer action.
    panel = await openDropdown(page, "capped", theme, "github");
    await settled(panel, "newest 2 marked");
    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(250);
    await shot(panel, "19-github-capped-cursor");
    expected += 19;
  }

  for (const theme of rest) {
    let panel = await openDropdown(page, "few", theme);
    await settled(panel, NEWEST);
    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(250);
    written.push(await snap(panel, `01-few-cursor-${theme}.png`));
    panel = await openDropdown(page, "long", theme);
    await settled(panel, WITH_LIST);
    written.push(await snap(panel, `08-long-top-${theme}.png`));
    expected += 2;
  }

  expect(pageErrors, `page errors during capture:\n${pageErrors.join("\n")}`).toEqual([]);
  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(written.length);
  expect(written.length).toBe(expected);
});
