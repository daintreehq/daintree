/**
 * Copy context button feedback visual-review harness.
 *
 * Drives `toolbar-preview.html` (the real `Toolbar` against seeded stores) and
 * photographs the Copy context button through a copy's life: at rest, while a
 * run is in flight (past the Doherty gate, so the spinner is up), and in the
 * completion window with its notice pinned. Then narrows the window until the
 * button is evicted to the overflow menu and photographs that row at rest and
 * mid-copy. The run count and the completion notice are driven through the same
 * store and announce seam the `worktree.copyTree` action uses, imported from the
 * page's own module graph so they are the instances the toolbar reads.
 *
 * Opt-in only:
 *
 *   DAINTREE_SHOT_COPY_CONTEXT=1 DESIGN_CAPTURE_DIR=/abs/out \
 *     npx playwright test --project=screenshots copy-context-feedback-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_COPY_CONTEXT  required — any truthy value runs the capture
 *   DESIGN_CAPTURE_DIR          required — an ABSOLUTE directory outside the repo
 *   DAINTREE_SHOT_THEMES        comma-separated themes (default daintree,bondi)
 *
 * Output: `{state}-{theme}.png`. Never writes a PNG it has not verified, fails on
 * any page error, and counts the files on disk at the end.
 */

import { test, expect, type Locator, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync } from "fs";
import path from "path";
import {
  startPreviewServer,
  stubViteHmrClient,
  type PreviewServer,
} from "../helpers/previewHarness";

const ENABLED = !!process.env.DAINTREE_SHOT_COPY_CONTEXT;
const OUT_DIR = process.env.DESIGN_CAPTURE_DIR ?? "";
const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

test.use({ deviceScaleFactor: 2 });

const STRIP = '[role="toolbar"][aria-label="Main toolbar"]';
const BUTTON = '[data-toolbar-button-id="copy-tree"] button';

// Transitions are frozen so a frame never lands mid-fade, but animations are
// left running: the spinner is photographed as it really draws.
const FREEZE_CSS = `
  ::-webkit-scrollbar { display: none !important; }
  *, *::before, *::after {
    transition-duration: 0s !important;
    transition-delay: 0s !important;
    caret-color: transparent !important;
  }
`;

let server: PreviewServer | undefined;
const expected: string[] = [];

test.beforeAll(async () => {
  if (!ENABLED) return;
  if (!path.isAbsolute(OUT_DIR)) {
    throw new Error("DESIGN_CAPTURE_DIR must be an absolute directory outside the repo");
  }
  const repoRoot = realpathSync(process.cwd());
  mkdirSync(OUT_DIR, { recursive: true });
  const outReal = realpathSync(OUT_DIR);
  if (outReal === repoRoot || outReal.startsWith(repoRoot + path.sep)) {
    throw new Error(`DESIGN_CAPTURE_DIR must be outside the repo (${OUT_DIR})`);
  }
  for (const file of readdirSync(OUT_DIR)) {
    if (file.endsWith(".png")) rmSync(path.join(OUT_DIR, file));
  }
  server = await startPreviewServer();
});

test.afterAll(async () => {
  await server?.close();
});

async function settle(page: Page, ms = 250): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
  );
  await page.waitForTimeout(ms);
}

async function open(page: Page, theme: string, width: number): Promise<void> {
  await page.setViewportSize({ width, height: 420 });
  const url = `${server!.baseURL}/toolbar-preview.html?theme=${theme}&fixture=owner&platform=mac`;
  await page.goto(url, { waitUntil: "load" });
  await page.addStyleTag({ content: FREEZE_CSS });
  await page.locator(STRIP).waitFor({ state: "visible", timeout: 30_000 });
  await page
    .locator('[data-toolbar-button-id="launcher"] button')
    .first()
    .waitFor({ state: "visible", timeout: 15_000 });
  await settle(page, 400);
}

async function setRunning(page: Page, running: boolean): Promise<void> {
  await page.evaluate(async (on) => {
    const mod = await import(/* @vite-ignore */ "/src/store/copyTreeRunStore.ts");
    const store = mod.useCopyTreeRunStore.getState();
    if (on) store.beginRun();
    else store.endRun();
  }, running);
}

async function announce(page: Page): Promise<void> {
  await page.bringToFront();
  await page.evaluate(async () => {
    const mod = await import(/* @vite-ignore */ "/src/lib/copyTreeFeedback.ts");
    mod.announceCopyTreeCopy(
      { title: "Context copied", message: "184 files · 612 KB · XML" },
      "copy-tree-harness"
    );
  });
}

async function snap(page: Page, file: string, target: Locator, pad = 0): Promise<void> {
  expected.push(file);
  await settle(page, 150);
  const box = await target.boundingBox();
  if (!box || box.width < 20 || box.height < 20) {
    throw new Error(`${file}: capture target has no real box (${JSON.stringify(box)})`);
  }
  const vp = page.viewportSize()!;
  const x = Math.max(0, box.x - pad);
  const y = Math.max(0, box.y - pad);
  const clip = {
    x,
    y,
    width: Math.min(vp.width - x, box.width + pad * 2),
    height: Math.min(vp.height - y, box.height + pad * 2),
  };
  const out = path.join(OUT_DIR, file);
  await page.screenshot({ path: out, clip });
  if (!existsSync(out)) throw new Error(`${file}: screenshot did not land`);
}

/** The Copy context button, its neighbours, and any tooltip hanging under it. */
async function snapButton(page: Page, file: string): Promise<void> {
  const button = page.locator(BUTTON).first();
  await expect(button).toBeVisible();
  const box = (await button.boundingBox())!;
  expected.push(file);
  await settle(page, 150);
  const out = path.join(OUT_DIR, file);
  await page.screenshot({
    path: out,
    clip: { x: Math.max(0, box.x - 150), y: 0, width: 340, height: 150 },
  });
  if (!existsSync(out)) throw new Error(`${file}: screenshot did not land`);
}

async function openOverflowWithCopyRow(page: Page): Promise<Locator> {
  const triggers = page.locator('[data-toolbar-overflow-trigger][data-visible="true"]');
  const count = await triggers.count();
  for (let i = 0; i < count; i++) {
    await triggers.nth(i).click();
    const menu = page.locator('[role="menu"]').last();
    await menu.waitFor({ state: "visible", timeout: 5_000 });
    const row = menu.getByRole("menuitem", { name: /Copy(ing)? context/ });
    if ((await row.count()) > 0) return menu;
    await page.keyboard.press("Escape");
    await settle(page);
  }
  throw new Error("Copy context never reached an overflow menu at this width");
}

test.describe("copy context feedback review", () => {
  test("captures", async ({ page }) => {
    test.info().annotations.push({
      type: "conditional-skip",
      description: "DAINTREE_SHOT_COPY_CONTEXT is required for the copy context capture",
    });
    test.skip(!ENABLED, "Set DAINTREE_SHOT_COPY_CONTEXT to run the copy context capture");
    test.setTimeout(300_000);
    await stubViteHmrClient(page);
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.stack ?? String(e)));

    for (const theme of THEMES) {
      await open(page, theme, 1440);
      await page.mouse.move(700, 400);
      await snapButton(page, `button-rest-${theme}.png`);

      await setRunning(page, true);
      // Past the 400ms Doherty gate the spinner guards.
      await settle(page, 600);
      await expect(page.locator(BUTTON).first()).toHaveAttribute("aria-disabled", "true");
      await snapButton(page, `button-copying-${theme}.png`);

      await announce(page);
      await setRunning(page, false);
      await expect(page.getByRole("tooltip")).toContainText("Context copied");
      await snapButton(page, `button-copied-${theme}.png`);

      // A retry that starts inside the notice window and then fails without
      // announcing must not hand the earlier success's check back.
      await setRunning(page, true);
      await settle(page);
      await setRunning(page, false);
      await expect(page.getByRole("tooltip")).toHaveCount(0);
      await snapButton(page, `button-retry-failed-${theme}.png`);

      // Narrow until the button is evicted, then read the overflow row.
      await open(page, theme, 760);
      await expect(page.locator(BUTTON).first()).toBeHidden();
      let menu = await openOverflowWithCopyRow(page);
      await snap(page, `overflow-rest-${theme}.png`, menu, 8);
      await page.keyboard.press("Escape");
      await settle(page);

      await setRunning(page, true);
      await settle(page, 600);
      menu = await openOverflowWithCopyRow(page);
      await expect(menu.getByRole("menuitem", { name: /Copy(ing)? context/ })).toHaveAttribute(
        "data-disabled",
        ""
      );
      await snap(page, `overflow-copying-${theme}.png`, menu, 8);
      await page.keyboard.press("Escape");
      await setRunning(page, false);
    }

    expect(errors, errors.join("\n")).toEqual([]);
    const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
    for (const file of expected) expect(onDisk, `${file} missing`).toContain(file);
    expect(onDisk.length).toBe(expected.length);
  });
});
