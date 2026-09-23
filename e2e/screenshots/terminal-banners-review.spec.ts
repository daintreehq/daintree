/**
 * In-panel terminal banner family visual-review harness.
 *
 * Sibling of `recovery-banners-review.spec.ts`, which covers the global
 * title-bar family. These banners live inside one terminal pane each — spawn
 * failed, restart failed, scrollback restore failed, agent finished — so a
 * pane only ever shows its own, and the family has never been seen together.
 * This drives `terminal-banners-preview.html`: the real banner components in a
 * stand-in pane at the widths a grid actually gives a pane, against the real
 * theme tokens and `index.css`.
 *
 * Opt-in only:
 *
 *   DAINTREE_SHOT_TERMINAL_BANNERS=1 npx playwright test --project=screenshots terminal-banners-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_TERMINAL_BANNERS  required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR               output directory (default artifacts/terminal-banner-shots)
 *   DAINTREE_SHOT_THEMES            comma-separated theme sweep (default: daintree,bondi,namib)
 *
 * Output:
 *   <group>-<width>-<theme>.png     every fixture in the group, stacked, at one pane width
 *   overflow-<width>-<theme>.png    the spawn banner's overflow menu open (first theme only)
 *
 * Never writes a PNG it has not verified: every pane on a sheet must hold a
 * rendered banner, `snap()` refuses a target with no real box, and the test
 * counts the files on disk rather than trusting its exit code.
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

const ENABLED = !!process.env.DAINTREE_SHOT_TERMINAL_BANNERS;

const OUT_DIR = path.resolve(
  process.env.DAINTREE_SHOT_DIR ?? path.join(process.cwd(), "artifacts", "terminal-banner-shots")
);

const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi,namib")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

/** A 2x2 grid on a laptop, a 2-column split, and a pane maximised on a wide display. */
const WIDTHS = [320, 560, 1100] as const;

/** Mirrors `TERMINAL_BANNER_FIXTURES` group sizes; a sheet short of its count has a silent gap. */
const GROUPS = [
  { name: "errors", count: 9 },
  { name: "status", count: 8 },
] as const;

const ATTACH_TIMEOUT_MS = 30_000;
const PAGE = "/terminal-banners-preview.html";

let server: PreviewServer | undefined;
const snap = makeSnap(OUT_DIR);

test.beforeAll(async () => {
  if (!ENABLED) return;
  if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });
  server = await startPreviewServer();
});

test.afterAll(async () => {
  await server?.close();
});

/** Hold one page open until Vite's dependency optimizer has stopped reloading it. */
async function settleDevServer(context: BrowserContext) {
  const page = await context.newPage();
  await stubViteHmrClient(page);
  let navigations = 0;
  page.on("framenavigated", () => navigations++);
  await page.goto(`${server!.baseURL}${PAGE}?group=errors`);
  for (let attempt = 0; attempt < 8; attempt++) {
    const before = navigations;
    await page.waitForTimeout(2_500);
    const shells = await page.locator("[data-preview-shell]").count();
    if (navigations === before && shells === 1) break;
  }
  await page.close();
}

/** One fresh page per capture; one renderer crash under load is retried, two are not. */
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
        console.warn(`[terminal-banner-shots] renderer crashed on ${what}; retrying once`);
        continue;
      }
      throw new Error(`${what}: ${String(error)}`, { cause: error });
    } finally {
      await page.close().catch(() => undefined);
    }
  }
}

async function openSheet(
  page: Page,
  query: string,
  width: number,
  expected: number
): Promise<Locator> {
  await page.setViewportSize({ width: width + 32, height: 4000 });
  await page.goto(`${server!.baseURL}${PAGE}?${query}&width=${width}`);
  const shell = page.locator("[data-preview-shell]").first();
  await expect(shell).toBeAttached({ timeout: ATTACH_TIMEOUT_MS });
  await page.evaluate(() => document.fonts.ready);
  // The banner entrance is a 250ms opacity-and-slide.
  await page.waitForTimeout(400);
  await expect(page.locator("[data-fixture]")).toHaveCount(expected);
  // Every slot must hold a rendered banner, not an empty div.
  await expect(page.locator("[data-banner-slot] > [role]")).toHaveCount(expected);
  return shell;
}

test("terminal banner family — every state, three pane widths, every theme", async ({
  context,
}) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_TERMINAL_BANNERS is required for the banner capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_TERMINAL_BANNERS=1 to run the capture");
  test.setTimeout(600_000);

  await settleDevServer(context);
  const written: string[] = [];

  for (const theme of THEMES) {
    for (const width of WIDTHS) {
      for (const group of GROUPS) {
        written.push(
          await withPage(context, `${group.name} ${width} ${theme}`, async (page) =>
            snap(
              await openSheet(page, `theme=${theme}&group=${group.name}`, width, group.count),
              `${group.name}-${width}-${theme}.png`
            )
          )
        );
      }
    }
  }

  const theme = THEMES[0]!;
  for (const width of [320, 560] as const) {
    written.push(
      await withPage(context, `overflow ${width}`, async (page) => {
        await openSheet(page, `theme=${theme}&fixture=spawn-enoent`, width, 1);
        await page.setViewportSize({ width: width + 32, height: 420 });
        await page.getByRole("button", { name: "More recovery options" }).click();
        await expect(page.getByRole("button", { name: "Remove terminal" })).toBeVisible();
        await page.waitForTimeout(250);
        return snap(page.locator("body"), `overflow-${width}-${theme}.png`);
      })
    );
  }

  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(written.length);
  expect(onDisk.length).toBe(THEMES.length * WIDTHS.length * GROUPS.length + 2);
  console.log(`[terminal-banner-shots] ${onDisk.length} PNGs in ${OUT_DIR}`);
});
