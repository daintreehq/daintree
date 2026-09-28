/**
 * Forge dropdowns — every state of the Issues, Pull requests and Commits lists.
 *
 * Drives the forge stats preview entry (`forge-stats-preview.html`) with
 * `?forge=github`, which mounts the REAL `ForgeStatsToolbarButton` and the GitHub
 * plugin's real stats-dropdown view, and serves the list reads from
 * `src/components/Layout/__preview__/forgeListFixtures.ts`. The Electron harness
 * (`forge-dropdown-review`) shows a list that loaded; this one reaches the
 * states a live session gets to rarely and never on demand — a cold read that
 * never answers, a failure with nothing cached, a rejected or missing token, a
 * paused API — and lays the three lists beside each other so they can be judged
 * as one family.
 *
 *   DAINTREE_SHOT_FORGELISTS=1 npx playwright test --project=screenshots forge-dropdown-states-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_FORGELISTS  required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR         output directory (default artifacts/forge-list-shots)
 *   DAINTREE_SHOT_THEMES      comma-separated sweep (default daintree,bondi); every
 *                             theme gets every state
 *   DAINTREE_SHOT_CONTRAST    set to 0 to skip the prefers-contrast / forced-colors shots
 *
 * Never writes a PNG it has not verified: every state asserts its fixture text
 * (or its absence) before the shot, and the test counts the files at the end.
 */

import { test, expect, type Locator, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readdirSync, rmSync } from "fs";
import path from "path";
import { startPreviewServer, stubViteHmrClient, makeSnap } from "../helpers/previewHarness";

const ENABLED = !!process.env.DAINTREE_SHOT_FORGELISTS;
const CONTRAST = process.env.DAINTREE_SHOT_CONTRAST !== "0";

const OUT_DIR = path.resolve(
  process.env.DAINTREE_SHOT_DIR ?? path.join(process.cwd(), "artifacts", "forge-list-shots")
);

const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

/** Titles the fixtures carry, so a shot can prove its data landed. */
const FIRST_ISSUE = "Restart into a scratch workspace";
const FIRST_PR = "close the regeneration wedges";
const LONG_ISSUE = "Terminal scrollback jumps to the top";
const NEWEST_COMMIT = "keep the commits pill count in step with the worktree";

type Kind = "issues" | "prs" | "commits";

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

/** The dropdown surface — the fixed-dropdown overlay that holds the open region. */
function panelOf(page: Page): Locator {
  return page
    .locator('[role="region"][aria-labelledby]')
    .locator('xpath=ancestor::div[contains(@class,"surface-overlay")][1]');
}

async function openList(
  page: Page,
  kind: Kind,
  opts: { theme: string; list?: string; commits?: string; fixture?: string }
): Promise<Locator> {
  await stubViteHmrClient(page);
  await page.mouse.move(0, 0);
  await page.setViewportSize({ width: 900, height: 640 });
  const q = new URLSearchParams({
    theme: opts.theme,
    fixture: opts.fixture ?? "default",
    forge: "github",
    commits: opts.commits ?? "few",
  });
  if (opts.list) q.set("list", opts.list);
  await page.goto(`${baseURL}/forge-stats-preview.html?${q.toString()}`);
  // The toolbar sits at the window's right edge in the app, and the panel
  // right-aligns to its pill; a left-parked shell hangs the panel off-screen.
  await page.addStyleTag({ content: "#root { display: flex; justify-content: flex-end; }" });
  const pill = page.getByTestId(`forge-stat-pill-${kind}`);
  await expect(pill, `${kind}: no pill`).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await pill.click();
  await expect(pill).toHaveAttribute("aria-expanded", "true");
  const panel = panelOf(page);
  await expect(panel).toBeVisible();
  // Entry motion plus the chunk load behind the skeleton.
  await page.waitForTimeout(500);
  return panel;
}

async function settled(panel: Locator, text: string | RegExp | null, absent?: string) {
  if (text !== null) await expect(panel).toContainText(text, { timeout: 8_000 });
  if (absent) await expect(panel).not.toContainText(absent);
  await panel.page().waitForTimeout(300);
}

test("Forge dropdowns — every state of the three lists", async ({ page }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_FORGELISTS is required for the forge list capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_FORGELISTS=1 to run the capture");
  test.setTimeout(15 * 60_000);

  const written: string[] = [];
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));

  // Vite's dependency optimizer re-bundles on the first load of a changed
  // import graph and answers stale chunks with 504s; load until a pill renders.
  await stubViteHmrClient(page);
  const warm = page.getByTestId("forge-stat-pill-issues");
  for (let attempt = 0; attempt < 6; attempt++) {
    await page.goto(`${baseURL}/forge-stats-preview.html?forge=github&list=rich&commits=few`);
    if (await warm.isVisible({ timeout: 15_000 }).catch(() => false)) break;
    await page.waitForTimeout(3_000);
  }
  await expect(warm, "preview never rendered the issues pill").toBeVisible();
  pageErrors.length = 0;

  let expected = 0;
  const shotFor = (theme: string) => async (panel: Locator, name: string) => {
    written.push(await snap(panel, `${name}-${theme}.png`));
    expected += 1;
  };

  for (const theme of THEMES) {
    const shot = shotFor(theme);
    const kbd = page.keyboard;

    // ---- Issues ---------------------------------------------------------
    let panel = await openList(page, "issues", { theme, list: "rich" });
    await settled(panel, FIRST_ISSUE);
    await shot(panel, "01-issues-rest");

    await kbd.press("ArrowDown");
    await kbd.press("ArrowDown");
    await page.waitForTimeout(250);
    await shot(panel, "02-issues-cursor");

    await page.getByTestId("github-item-11755").hover();
    await page.waitForTimeout(500);
    await shot(panel, "03-issues-hover-long");
    await page.mouse.move(0, 0);

    await kbd.press("Shift+F10");
    await expect(page.getByRole("menu")).toBeVisible();
    await page.waitForTimeout(300);
    {
      const menu = page.getByRole("menu");
      const pb = await panel.boundingBox();
      const mb = await menu.boundingBox();
      if (!pb || !mb) throw new Error("row menu: missing box");
      const x = Math.min(pb.x, mb.x) - 8;
      const y = Math.min(pb.y, mb.y) - 8;
      const out = path.join(OUT_DIR, `04-issues-row-menu-${theme}.png`);
      await page.screenshot({
        path: out,
        clip: {
          x,
          y,
          width: Math.max(pb.x + pb.width, mb.x + mb.width) - x + 8,
          height: Math.max(pb.y + pb.height, mb.y + mb.height) - y + 8,
        },
      });
      written.push(out);
      expected += 1;
    }
    await kbd.press("Escape");

    panel = await openList(page, "issues", { theme, list: "rich" });
    await settled(panel, FIRST_ISSUE);
    await kbd.type("memory");
    await settled(panel, "Renderer memory climbs", FIRST_ISSUE);
    await shot(panel, "05-issues-search");

    await kbd.press("ControlOrMeta+a");
    await kbd.type("zebra");
    await settled(panel, /match “zebra”/);
    await shot(panel, "06-issues-search-empty");

    panel = await openList(page, "issues", { theme, list: "rich" });
    await settled(panel, FIRST_ISSUE);
    await panel.getByRole("radio", { name: "Closed" }).click();
    await settled(panel, /No closed issues/);
    await shot(panel, "07-issues-closed-empty");
    await panel.getByRole("button", { name: /Show open issues/ }).click();

    panel = await openList(page, "issues", { theme, list: "rich" });
    await settled(panel, FIRST_ISSUE);
    await kbd.press("ArrowDown");
    await kbd.press("Shift+Space");
    await kbd.press("ArrowDown");
    await kbd.press("ArrowDown");
    await kbd.press("Shift+Space");
    await settled(panel, /2 issues selected/);
    await shot(panel, "08-issues-selection");

    panel = await openList(page, "issues", { theme, list: "long" });
    await settled(panel, LONG_ISSUE);
    await shot(panel, "09-issues-long-top");
    await panel.evaluate((el) => {
      const scroller = [...el.querySelectorAll<HTMLElement>("*")].find(
        (n) =>
          n.scrollHeight > n.clientHeight + 4 &&
          ["auto", "scroll"].includes(getComputedStyle(n).overflowY)
      );
      if (!scroller) throw new Error("no scrolling list in the panel");
      scroller.scrollTop = scroller.scrollHeight;
    });
    await page.waitForTimeout(500);
    await shot(panel, "10-issues-long-bottom");

    panel = await openList(page, "issues", { theme, list: "loading" });
    await page.waitForTimeout(700);
    await settled(panel, null, FIRST_ISSUE);
    await shot(panel, "11-issues-loading");

    panel = await openList(page, "issues", { theme, list: "offline" });
    await settled(panel, /Cannot reach GitHub|Couldn.t reach GitHub/);
    await shot(panel, "12-issues-offline");

    panel = await openList(page, "issues", { theme, list: "bad-token" });
    await settled(panel, /token/i);
    await shot(panel, "13-issues-bad-token");

    panel = await openList(page, "issues", { theme, list: "no-token" });
    await settled(panel, /not connected/i);
    await shot(panel, "14-issues-no-token");

    panel = await openList(page, "issues", { theme, list: "rate-limited" });
    await settled(panel, /paused/i);
    await shot(panel, "15-issues-rate-limited");

    panel = await openList(page, "issues", { theme, list: "rich" });
    await settled(panel, FIRST_ISSUE);
    await page.evaluate(() =>
      (
        window as unknown as { __forgePreviewRateLimit: (m: number) => void }
      ).__forgePreviewRateLimit(14)
    );
    await settled(panel, /paused/i);
    await shot(panel, "16-issues-rate-limited-stale");

    panel = await openList(page, "issues", { theme, list: "rich" });
    await settled(panel, FIRST_ISSUE);
    await page.evaluate(() =>
      (
        window as unknown as { __forgePreviewFailNextList: (m: string) => void }
      ).__forgePreviewFailNextList("Cannot reach GitHub. Check your network connection.")
    );
    await panel.getByRole("button", { name: /^Refresh/ }).click();
    await settled(panel, /reach GitHub/);
    await page.mouse.move(0, 0);
    await page.waitForTimeout(300);
    await shot(panel, "17-issues-stale-error");

    panel = await openList(page, "issues", { theme, list: "empty" });
    await settled(panel, /No open issues/);
    await shot(panel, "18-issues-empty");

    panel = await openList(page, "issues", { theme, list: "rich" });
    await settled(panel, FIRST_ISSUE);
    await panel.getByRole("button", { name: /^Sort issues/ }).click();
    await expect(page.getByRole("menu")).toBeVisible();
    await page.waitForTimeout(300);
    {
      const shell = page.locator("[data-preview-shell]");
      const sb = await shell.boundingBox();
      const pb = await panel.boundingBox();
      if (!sb || !pb) throw new Error("sort: missing box");
      const out = path.join(OUT_DIR, `19-issues-sort-open-${theme}.png`);
      await page.screenshot({
        path: out,
        clip: { x: pb.x - 8, y: sb.y, width: pb.width + 16, height: 220 },
      });
      written.push(out);
      expected += 1;
    }
    await kbd.press("Escape");

    panel = await openList(page, "issues", { theme, list: "rich" });
    await settled(panel, FIRST_ISSUE);
    {
      const shell = page.locator("[data-preview-shell]");
      const sb = await shell.boundingBox();
      const pb = await panel.boundingBox();
      if (!sb || !pb) throw new Error("in-context: missing box");
      const out = path.join(OUT_DIR, `20-issues-in-context-${theme}.png`);
      await page.screenshot({
        path: out,
        clip: {
          x: Math.min(sb.x, pb.x),
          y: sb.y,
          width: Math.max(sb.x + sb.width, pb.x + pb.width) - Math.min(sb.x, pb.x),
          height: pb.y + pb.height - sb.y + 12,
        },
      });
      written.push(out);
      expected += 1;
    }

    // ---- Pull requests --------------------------------------------------
    panel = await openList(page, "prs", { theme, list: "rich" });
    await settled(panel, FIRST_PR);
    await shot(panel, "21-prs-rest");
    await kbd.press("ArrowDown");
    await kbd.press("ArrowDown");
    await kbd.press("ArrowDown");
    await page.waitForTimeout(250);
    await shot(panel, "22-prs-cursor");

    panel = await openList(page, "prs", { theme, list: "rich" });
    await settled(panel, FIRST_PR);
    await panel.getByRole("radio", { name: "Merged" }).click();
    await settled(panel, /No merged pull requests/);
    await shot(panel, "23-prs-merged-empty");

    panel = await openList(page, "prs", { theme, list: "loading" });
    await page.waitForTimeout(700);
    await settled(panel, null, FIRST_PR);
    await shot(panel, "24-prs-loading");

    panel = await openList(page, "prs", { theme, list: "empty" });
    await settled(panel, /No open pull requests/);
    await shot(panel, "25-prs-empty");

    // ---- Commits (the GitHub plugin's forge-mode list) ------------------
    panel = await openList(page, "commits", { theme, list: "rich", commits: "few" });
    await settled(panel, NEWEST_COMMIT);
    await shot(panel, "30-commits-rest");
    await kbd.press("ArrowDown");
    await kbd.press("ArrowDown");
    await page.waitForTimeout(250);
    await shot(panel, "31-commits-cursor");

    panel = await openList(page, "commits", { theme, list: "rich", commits: "long" });
    await settled(panel, /update root and plugin package dependencies/);
    await shot(panel, "32-commits-long");

    panel = await openList(page, "commits", { theme, list: "rich", commits: "loading" });
    await page.waitForTimeout(700);
    await settled(panel, null, NEWEST_COMMIT);
    await shot(panel, "33-commits-loading");

    panel = await openList(page, "commits", { theme, list: "rich", commits: "error" });
    await settled(panel, /Couldn.t load commits/);
    await shot(panel, "34-commits-error");
  }

  // ---- High contrast: macOS's prefers-contrast, then Windows forced colors.
  if (CONTRAST) {
    const theme = THEMES[0]!;
    await page.emulateMedia({ contrast: "more" });
    const hc = async (kind: Kind, text: string, name: string) => {
      const panel = await openList(page, kind, { theme, list: "rich", commits: "few" });
      await settled(panel, text);
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("ArrowDown");
      await page.waitForTimeout(250);
      written.push(await snap(panel, `${name}-${theme}.png`));
      expected += 1;
    };
    await hc("issues", FIRST_ISSUE, "40-hc-more-issues");
    await hc("prs", FIRST_PR, "41-hc-more-prs");
    await hc("commits", NEWEST_COMMIT, "42-hc-more-commits");
    await page.emulateMedia({ contrast: "no-preference", forcedColors: "active" });
    await hc("issues", FIRST_ISSUE, "43-hc-forced-issues");
    await hc("commits", NEWEST_COMMIT, "44-hc-forced-commits");
    await page.emulateMedia({ forcedColors: "none" });
  }

  expect(pageErrors, `page errors during capture:\n${pageErrors.join("\n")}`).toEqual([]);
  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(written.length);
  expect(written.length).toBe(expected);
});
