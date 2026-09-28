/**
 * Sidebar header refresh + disabled drag grip visual-review harness.
 *
 * Drives `sidebar-header-refresh-preview.html`, which mounts the REAL
 * `SidebarContent` against seeded stores, and captures:
 *   - the header at rest with the pointer away (actions hidden),
 *   - a refresh in flight with the pointer away (the cluster must stay up),
 *   - the finishing turn after the refresh settles, and the fade back once done,
 *   - the disabled grip's tooltip while searching, and the grouped-by-type list,
 *     whose rows mount static and carry no grip to explain.
 *
 * Opt-in only, like every sibling review harness:
 *
 *   DAINTREE_SHOT_SIDEBAR_REFRESH=1 npx playwright test --project=screenshots sidebar-header-refresh-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_SIDEBAR_REFRESH  required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR              output directory (default artifacts/sidebar-refresh-shots)
 *   DAINTREE_SHOT_THEMES           comma-separated theme sweep (default daintree,bondi)
 *
 * Never writes a PNG it has not verified: every shot asserts the state it claims
 * first, and the test counts the files itself.
 */

import { test, expect, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readdirSync, rmSync } from "fs";
import path from "path";
import { startPreviewServer, stubViteHmrClient, makeSnap } from "../helpers/previewHarness";

test.use({ deviceScaleFactor: 2 });

const ENABLED = !!process.env.DAINTREE_SHOT_SIDEBAR_REFRESH;

const OUT_DIR = path.resolve(
  process.env.DAINTREE_SHOT_DIR ?? path.join(process.cwd(), "artifacts", "sidebar-refresh-shots")
);

const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

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

const WIDTH = 350;

async function open(page: Page, fixture: string, theme: string) {
  await stubViteHmrClient(page);
  await page.setViewportSize({ width: WIDTH + 40, height: 460 });
  await page.mouse.move(WIDTH + 30, 440);
  await page.goto(
    `${baseURL}/sidebar-header-refresh-preview.html?theme=${theme}&fixture=${fixture}&width=${WIDTH}`
  );
  const shell = page.locator("[data-preview-shell]");
  await expect(shell, `fixture "${fixture}" rendered nothing`).toBeVisible();
  await expect(page.getByRole("heading", { name: "Worktrees" })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
  return shell;
}

function refreshButton(page: Page) {
  return page.getByRole("button", { name: "Refresh sidebar" });
}

async function opacityOf(page: Page) {
  return refreshButton(page).evaluate((el) => {
    let node: Element | null = el;
    let o = 1;
    while (node) {
      o *= Number(getComputedStyle(node).opacity);
      node = node.parentElement;
    }
    return o;
  });
}

test("Sidebar header refresh visibility and disabled grip reason", async ({ page }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_SIDEBAR_REFRESH is required for the sidebar refresh capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_SIDEBAR_REFRESH=1 to run the capture");

  const written: string[] = [];
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));

  for (const theme of THEMES) {
    // Rest, pointer away: the revealed actions are hidden.
    {
      const shell = await open(page, "rest", theme);
      await expect(refreshButton(page)).toBeHidden();
      written.push(await snap(shell, `header-rest-${theme}.png`));
    }

    // Refresh in flight with the pointer away, as a palette or shortcut refresh.
    {
      const shell = await open(page, "rest", theme);
      await page.evaluate(() => window.dispatchEvent(new CustomEvent("daintree:refresh-sidebar")));
      await expect(refreshButton(page)).toBeVisible();
      await expect(refreshButton(page)).toHaveAttribute("aria-disabled", "true");
      await page.waitForTimeout(400);
      expect(await opacityOf(page)).toBeGreaterThan(0.4);
      written.push(await snap(shell, `header-refresh-inflight-${theme}.png`));

      // Settled: the icon finishes its turn at full strength before fading.
      await page.evaluate(() =>
        window.dispatchEvent(new CustomEvent("daintree:refresh-sidebar-settled"))
      );
      await expect(refreshButton(page)).not.toHaveAttribute("aria-disabled", "true");
      const tail = await refreshButton(page).evaluate(
        (el) => el.querySelector("[data-spinning]") !== null
      );
      if (tail) {
        // The button eases out of its aria-disabled dim, so poll rather than read once.
        await expect.poll(() => opacityOf(page), { timeout: 600 }).toBeGreaterThan(0.9);
        written.push(await snap(shell, `header-refresh-tail-${theme}.png`));
      }

      // One cycle plus the shared fade later, the cluster is gone again.
      await expect(refreshButton(page)).toBeHidden({ timeout: 3000 });
      await page.waitForTimeout(300);
      written.push(await snap(shell, `header-refresh-settled-${theme}.png`));
    }

    // The disabled grip's tooltip names the actual reason.
    {
      await open(page, "search", theme);
      const grip = page.locator("[data-worktree-row-drag-handle]").first();
      await grip.hover();
      await expect(page.getByRole("tooltip")).toHaveText("Drag to reorder is off while searching");
      await page.waitForTimeout(250);
      const file = `grip-tooltip-search-${theme}.png`;
      await page.screenshot({ path: path.join(OUT_DIR, file) });
      written.push(file);
    }

    // Grouped by type: rows mount static, so there is no grip — the status
    // line under the search box is the only explanation, and it must be there.
    {
      const shell = await open(page, "grouped", theme);
      await expect(page.locator("[data-worktree-row-drag-handle]")).toHaveCount(0);
      await expect(page.getByText("Drag to reorder is off while grouped by type")).toBeVisible();
      written.push(await snap(shell, `grouped-no-grip-${theme}.png`));
    }
  }

  expect(pageErrors, `preview page threw: ${pageErrors.join(" | ")}`).toEqual([]);

  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(written.length);
  console.log(`[sidebar-refresh-shots] ${onDisk.length} PNGs in ${OUT_DIR}`);
});
