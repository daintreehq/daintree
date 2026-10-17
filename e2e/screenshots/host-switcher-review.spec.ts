/**
 * Host switcher visual-review harness.
 *
 * Mounts `host-switcher-preview.html` — the real `HostSwitcherPalette` against
 * a seeded host list, metrics history and window host — and writes one PNG per
 * state per theme. Opt-in only:
 *
 *   DAINTREE_SHOT_HOSTSWITCHER=1 DAINTREE_SHOT_DIR=/abs/out \
 *     ./node_modules/.bin/playwright test --project=screenshots host-switcher-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_HOSTSWITCHER  required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR           required — absolute output directory outside the repo
 *   DAINTREE_SHOT_THEMES        themes to sweep (default: daintree,bondi,namib)
 *
 * Output: <state>--<theme>.png. A frame is written only after its state is
 * verified, and the run counts the files on disk against the plan.
 */

import { test, expect, type Locator, type Page } from "@playwright/test";
import { mkdirSync, readdirSync, realpathSync, rmSync } from "fs";
import path from "path";
import {
  startPreviewServer,
  stubViteHmrClient,
  type PreviewServer,
} from "../helpers/previewHarness";

const ENABLED = !!process.env.DAINTREE_SHOT_HOSTSWITCHER;
const OUT_DIR = process.env.DAINTREE_SHOT_DIR ?? "";
const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi,namib")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

test.use({ deviceScaleFactor: 2 });

const DIALOG = '[role="dialog"][aria-label="Switch host"]';
const VIEWPORT = { width: 1100, height: 900 };

let server: PreviewServer | undefined;

test.beforeAll(async () => {
  if (!ENABLED) return;
  if (!path.isAbsolute(OUT_DIR)) {
    throw new Error("DAINTREE_SHOT_DIR must be an absolute directory outside the repo");
  }
  const repoRoot = realpathSync(process.cwd());
  mkdirSync(OUT_DIR, { recursive: true });
  const outReal = realpathSync(OUT_DIR);
  if (outReal === repoRoot || outReal.startsWith(repoRoot + path.sep)) {
    throw new Error(`DAINTREE_SHOT_DIR must be outside the repo (${OUT_DIR})`);
  }
  for (const file of readdirSync(OUT_DIR)) {
    if (file.endsWith(".png")) rmSync(path.join(OUT_DIR, file), { force: true });
  }
  server = await startPreviewServer();
});

test.afterAll(async () => {
  await server?.close();
});

const FREEZE_CSS = `
  ::-webkit-scrollbar { display: none !important; }
  *, *::before, *::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
    caret-color: transparent !important;
  }
`;

async function snap(page: Page, dialog: Locator, file: string, pad = 32): Promise<string> {
  await expect(dialog).toBeAttached();
  const box = await dialog.boundingBox();
  if (!box || box.width < 8 || box.height < 8) {
    throw new Error(`${file}: dialog has no real box (${JSON.stringify(box)}) — refusing to write`);
  }
  const x = Math.max(0, box.x - pad);
  const y = Math.max(0, box.y - pad);
  const out = path.join(OUT_DIR, file);
  await page.screenshot({
    path: out,
    clip: {
      x,
      y,
      width: Math.min(box.width + pad * 2, VIEWPORT.width - x),
      height: Math.min(box.height + pad * 2, VIEWPORT.height - y),
    },
  });
  return out;
}

async function open(page: Page, fixture: string, theme: string): Promise<Locator> {
  await page.setViewportSize(VIEWPORT);
  const url = `${server!.baseURL}/host-switcher-preview.html?theme=${theme}&fixture=${fixture}`;
  const dialog = page.locator(DIALOG).first();
  try {
    await page.goto(url);
    await expect(dialog).toBeAttached({ timeout: 30_000 });
  } catch {
    console.warn(`[host-switcher-shots] first mount of ${fixture}/${theme} failed; retrying once`);
    await page.goto("about:blank");
    await page.goto(url, { waitUntil: "load" });
    await expect(dialog).toBeAttached({ timeout: 30_000 });
  }
  // The host list arrives over the shimmed bridge after mount.
  await expect(dialog.getByRole("option").nth(1)).toBeVisible({ timeout: 10_000 });
  await page.addStyleTag({ content: FREEZE_CSS });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
  return dialog;
}

async function selectedId(dialog: Locator): Promise<string | null> {
  const selected = dialog.locator('[role="option"][aria-selected="true"]');
  if ((await selected.count()) === 0) return null;
  return selected.first().getAttribute("id");
}

test("host switcher — states and themes", async ({ page }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_HOSTSWITCHER is required for the host switcher capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_HOSTSWITCHER=1 to run the capture");
  test.setTimeout(600_000);

  await stubViteHmrClient(page);
  page.on("pageerror", (err) => console.error(`[host-switcher-shots] page error: ${err.message}`));
  const written: string[] = [];

  for (const theme of THEMES) {
    {
      const dialog = await open(page, "fleet", theme);
      await expect(dialog.getByRole("option")).toHaveCount(9);
      written.push(await snap(page, dialog, `fleet--${theme}.png`));

      const before = await selectedId(dialog);
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("ArrowDown");
      await page.waitForTimeout(150);
      const after = await selectedId(dialog);
      if (after === null || after === before) {
        throw new Error("ArrowDown did not move the selection — refusing to write");
      }
      written.push(await snap(page, dialog, `fleet-keyboard--${theme}.png`));
    }

    {
      const dialog = await open(page, "remote", theme);
      await expect(dialog.locator('[aria-current="true"]')).toHaveCount(1);
      written.push(await snap(page, dialog, `remote--${theme}.png`));
    }

    {
      const dialog = await open(page, "search", theme);
      await dialog.getByRole("combobox").fill("studio");
      await expect(dialog.getByRole("option")).toHaveCount(4);
      await page.waitForTimeout(200);
      written.push(await snap(page, dialog, `search--${theme}.png`));

      await dialog.getByRole("combobox").fill("kubernetes");
      await expect(dialog.getByRole("option")).toHaveCount(0);
      await page.waitForTimeout(200);
      written.push(await snap(page, dialog, `nomatch--${theme}.png`));
    }

    {
      const dialog = await open(page, "pair", theme);
      await expect(dialog.getByRole("option")).toHaveCount(2);
      written.push(await snap(page, dialog, `pair--${theme}.png`));
    }
  }

  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(written.length);
  expect(onDisk.length).toBe(THEMES.length * 6);
  console.log(`[host-switcher-shots] ${onDisk.length} PNGs in ${OUT_DIR}`);
});
