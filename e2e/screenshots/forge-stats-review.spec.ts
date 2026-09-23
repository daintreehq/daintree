/**
 * Toolbar forge stats visual-review harness.
 *
 * The issues / PRs / commits control is a strip of three stat pills whose shape
 * depends on data nobody controls from a real session on demand: a five- or
 * six-digit commit history, a zero count, a missing token, an active rate
 * limit, PR detection paused, a cold start. So this drives the component's own
 * preview entry (`forge-stats-preview.html`), which mounts the REAL
 * `ForgeStatsToolbarButton` against the real theme tokens and `index.css`, with
 * the bridge serving fixture stats.
 *
 *   DAINTREE_SHOT_FORGESTATS=1 npx playwright test --project=screenshots forge-stats-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_FORGESTATS  required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR         output directory (default artifacts/forge-stats-shots)
 *   DAINTREE_SHOT_THEMES      comma-separated theme sweep (default daintree,bondi,namib,svalbard)
 *
 * `svalbard` is in the default sweep because it is one of the themes that
 * overrides the `toolbar-stats-*` tokens outright.
 *
 * Never writes a PNG it has not verified: `snap()` asserts a real box, the
 * fixture's expected text is asserted before the shot, and the test counts the
 * files itself at the end.
 */

import { test, expect, type Locator, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readdirSync, rmSync } from "fs";
import path from "path";
import { startPreviewServer, stubViteHmrClient, makeSnap } from "../helpers/previewHarness";

const ENABLED = !!process.env.DAINTREE_SHOT_FORGESTATS;

const OUT_DIR = path.resolve(
  process.env.DAINTREE_SHOT_DIR ?? path.join(process.cwd(), "artifacts", "forge-stats-shots")
);

const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi,namib,svalbard")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

/** Mirrors `FIXTURES` in the preview entry, which only resolves under Vite. */
const FIXTURES = [
  "default",
  "small",
  "zero",
  "large",
  "commits-only",
  "token-error",
  "rate-limited",
  "pr-paused",
  "loading",
] as const;

/** Segments each fixture must render before it is photographed. */
const EXPECTED_PILLS: Record<string, number> = { "commits-only": 1 };

test.use({ deviceScaleFactor: 3 });

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

async function open(page: Page, fixture: string, theme: string): Promise<Locator> {
  await stubViteHmrClient(page);
  // The pointer survives navigation, so a hover shot would bleed its hover
  // tint (and tooltip) into every later capture at the same coordinates.
  await page.mouse.move(0, 0);
  await page.setViewportSize({ width: 640, height: 420 });
  await page.goto(`${baseURL}/forge-stats-preview.html?theme=${theme}&fixture=${fixture}`);
  const shell = page.locator("[data-preview-shell]");
  await expect(shell, `fixture "${fixture}" rendered no shell`).toBeAttached();
  const pills = page.locator('[data-testid^="forge-stat-pill-"]');
  await expect(pills, `fixture "${fixture}" rendered the wrong pill count`).toHaveCount(
    EXPECTED_PILLS[fixture] ?? 3
  );
  if (fixture !== "loading") {
    // The commit count is the one number every fixture carries; wait for the
    // stats read to land rather than photographing the em-dash placeholder.
    await expect(page.getByTestId("forge-stat-pill-commits")).not.toContainText("—");
  }
  await page.evaluate(() => document.fonts.ready);
  // Width eases over 150ms when the budget changes; let it finish.
  await page.waitForTimeout(400);
  return shell;
}

test("Forge stats — states and themes", async ({ page }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_FORGESTATS is required for the forge-stats capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_FORGESTATS=1 to run the capture");

  const written: string[] = [];
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));

  for (const theme of THEMES) {
    for (const fixture of FIXTURES) {
      const shell = await open(page, fixture, theme);
      written.push(await snap(shell, `${fixture}-${theme}.png`));
    }
  }

  // Interaction states: layout and affordance questions, so the dark default
  // and the light theme only.
  for (const theme of THEMES.slice(0, 2)) {
    // "New since last view" chips — a background poll that raised both counts.
    let shell = await open(page, "default", theme);
    const pushed = await page.evaluate(() =>
      (
        window as unknown as { __forgePreviewPushCounts: (i: number, p: number) => boolean }
      ).__forgePreviewPushCounts(9, 8)
    );
    expect(pushed, "no counts listener subscribed").toBe(true);
    await expect(page.getByTestId("forge-stat-pill-issues")).toContainText("9");
    await page.waitForTimeout(400);
    written.push(await snap(shell, `new-activity-${theme}.png`));

    // Hover on the PR pill.
    shell = await open(page, "default", theme);
    await page.getByTestId("forge-stat-pill-prs").hover();
    await page.waitForTimeout(300);
    written.push(await snap(shell, `hover-prs-${theme}.png`));

    // Keyboard focus on the issues pill.
    shell = await open(page, "default", theme);
    // A keypress first, so the programmatic focus lands as :focus-visible.
    await page.keyboard.press("Shift");
    await page.getByTestId("forge-stat-pill-issues").focus();
    await page.waitForTimeout(250);
    written.push(await snap(shell, `focus-issues-${theme}.png`));

    // Commits dropdown open: the local commits dropdown anchors below.
    shell = await open(page, "default", theme);
    await page.getByTestId("forge-stat-pill-commits").click();
    await expect(page.getByTestId("forge-stat-pill-commits")).toHaveAttribute(
      "aria-expanded",
      "true"
    );
    await page.waitForTimeout(300);
    // The shell plus the top of the anchored dropdown, so the open segment is
    // judged against the panel it owns.
    const box = await shell.boundingBox();
    if (!box) throw new Error("open-commits: shell has no box");
    const out = path.join(OUT_DIR, `open-commits-${theme}.png`);
    await page.screenshot({
      path: out,
      clip: { x: box.x, y: box.y, width: box.width, height: box.height + 120 },
    });
    written.push(out);
  }

  expect(pageErrors, `page errors during capture:\n${pageErrors.join("\n")}`).toEqual([]);
  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(written.length);
  expect(written.length).toBe(THEMES.length * FIXTURES.length + Math.min(2, THEMES.length) * 4);
});
