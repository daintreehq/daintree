/**
 * Selected-file menu visual-review harness.
 *
 * Drives `selected-file-menu-preview.html`: the real `SelectedFileMenuItems`
 * inside the terminal context menu (beside the hovered-link section) and the
 * composer menu, for each kind of project host (macOS, Windows, Linux, an SSH
 * host, a WSL distro), under the real theme tokens.
 *
 * Opt-in only, like every sibling review harness:
 *
 *   DAINTREE_SHOT_SELECTED_FILE_MENU=1 npx playwright test --project=screenshots selected-file-menu-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_SELECTED_FILE_MENU  required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR                 output directory (default artifacts/selected-file-menu-shots)
 *   DAINTREE_SHOT_THEMES              comma-separated theme sweep (default: daintree)
 *
 * Never writes a PNG it has not verified: each capture waits for the open menu
 * to be visible and settled, and the test counts the files.
 */

import { test, expect, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readdirSync, rmSync } from "fs";
import path from "path";
import {
  startPreviewServer,
  stubViteHmrClient,
  type PreviewServer,
} from "../helpers/previewHarness";

const ENABLED = !!process.env.DAINTREE_SHOT_SELECTED_FILE_MENU;

const OUT_DIR = path.resolve(
  process.env.DAINTREE_SHOT_DIR ?? path.join(process.cwd(), "artifacts", "selected-file-menu-shots")
);

const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

// `terminal` right-clicks a selection that is also the hovered link, the usual
// case; `terminal-split` hovers a different path, so both sections show.
const SHOTS = [
  { name: "terminal", menu: "terminal", host: "mac", hover: "same" },
  { name: "terminal", menu: "terminal", host: "win", hover: "same" },
  { name: "terminal", menu: "terminal", host: "linux", hover: "same" },
  { name: "terminal", menu: "terminal", host: "remote", hover: "same" },
  { name: "terminal", menu: "terminal", host: "wsl", hover: "same" },
  { name: "terminal-split", menu: "terminal", host: "mac", hover: "other" },
  { name: "composer", menu: "composer", host: "mac", hover: "same" },
] as const;

let server: PreviewServer | undefined;
const pageErrors: string[] = [];

test.use({ viewport: { width: 560, height: 340 }, deviceScaleFactor: 2 });

test.beforeAll(async () => {
  if (!ENABLED) return;
  if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });
  server = await startPreviewServer();
});

test.afterAll(async () => {
  await server?.close();
});

async function capture(page: Page, shot: (typeof SHOTS)[number], theme: string): Promise<string> {
  const label = `${shot.name}-${shot.host}-${theme}`;
  await page.goto(
    `${server!.baseURL}/selected-file-menu-preview.html?theme=${theme}&menu=${shot.menu}&host=${shot.host}&hover=${shot.hover}`
  );
  await expect(
    page.locator("html[data-preview-ready]"),
    `${label}: preview never mounted — ${pageErrors.join(" | ") || "no page error"}`
  ).toBeAttached();
  await page
    .locator("[data-preview-context-trigger]")
    .click({ button: "right", position: { x: 40, y: 30 } });
  const menu = page.locator("[role=menu]");
  await expect(menu, `${label}: menu never opened`).toBeVisible();
  await expect.poll(() => menu.evaluate((el) => getComputedStyle(el).opacity)).toBe("1");
  await expect(menu.getByRole("menuitem", { name: "View file" })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  // timer: menu scale-in — opacity alone settles before the transform does
  await page.waitForTimeout(350);
  const box = await menu.boundingBox();
  if (!box || box.width < 8 || box.height < 8) {
    throw new Error(`${label}: menu has no real box — refusing to write`);
  }
  const out = path.join(OUT_DIR, `${label}.png`);
  await page.screenshot({ path: out });
  return out;
}

test("selected-file menu — callers, hosts and themes", async ({ page }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_SELECTED_FILE_MENU is required for the selected-file menu capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_SELECTED_FILE_MENU=1 to run the capture");

  await stubViteHmrClient(page);
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const written: string[] = [];
  for (const theme of THEMES) {
    for (const shot of SHOTS) written.push(await capture(page, shot, theme));
  }

  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(written.length);
  expect(onDisk.length).toBe(THEMES.length * SHOTS.length);
  console.log(`[selected-file-menu-shots] ${onDisk.length} PNGs in ${OUT_DIR}`);
});
