/**
 * Compact error banner visual-review harness.
 *
 * `CompactErrorList` stacks the compact `ErrorBanner` in two hosts — the strip
 * above a terminal pane's output and a worktree card's details — and each only
 * fills when its own operations fail. This drives `error-banner-preview.html`:
 * the real list in stand-ins for both hosts, against the real theme tokens and
 * `index.css`.
 *
 * Opt-in only:
 *
 *   DAINTREE_SHOT_ERROR_BANNER=1 npx playwright test --project=screenshots error-banner-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_ERROR_BANNER  required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR           output directory (default artifacts/error-banner-shots)
 *   DAINTREE_SHOT_THEMES        comma-separated theme sweep (default: daintree,namib,svalbard)
 *
 * Output:
 *   sheet-<theme>.png                   every scene stacked
 *   <scene>-<first theme>.png           each scene on its own
 *   <scene>-open-<theme>.png            the overflow disclosure open (terminal: every theme; card: first)
 *   terminal-overflow-focus-<theme>.png the disclosure trigger with keyboard focus (first theme)
 *
 * Never writes a PNG it has not verified: every scene must hold a rendered
 * banner, `snap()` refuses a target with no real box, and the test counts the
 * files on disk rather than trusting its exit code.
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
import { ERROR_BANNER_SCENES } from "../../src/components/Errors/__preview__/errorBannerFixtures";

const ENABLED = !!process.env.DAINTREE_SHOT_ERROR_BANNER;

const OUT_DIR = path.resolve(
  process.env.DAINTREE_SHOT_DIR ?? path.join(process.cwd(), "artifacts", "error-banner-shots")
);

/** Two dark themes — one of them the low-contrast floor — and a light one. */
const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,namib,svalbard")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

const ATTACH_TIMEOUT_MS = 30_000;
const PAGE = "/error-banner-preview.html";
const OVERFLOW_SCENES = ERROR_BANNER_SCENES.filter((s) => s.errors.length > s.maxInline);

let server: PreviewServer | undefined;
const snap = makeSnap(OUT_DIR);

test.use({ deviceScaleFactor: 2 });

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
  await page.goto(`${server!.baseURL}${PAGE}`);
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
        console.warn(`[error-banner-shots] renderer crashed on ${what}; retrying once`);
        continue;
      }
      throw new Error(`${what}: ${String(error)}`, { cause: error });
    } finally {
      await page.close().catch(() => undefined);
    }
  }
}

async function open(page: Page, query: string, expectedScenes: number): Promise<Locator> {
  await page.setViewportSize({ width: 640, height: 2400 });
  await page.goto(`${server!.baseURL}${PAGE}?${query}`);
  const shell = page.locator("[data-preview-shell]").first();
  await expect(shell).toBeAttached({ timeout: ATTACH_TIMEOUT_MS });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
  await expect(page.locator("[data-scene]")).toHaveCount(expectedScenes);
  // A slot with no dismiss control is a slot the list rendered nothing into.
  for (const slot of await page.locator("[data-banner-slot]").all()) {
    await expect(slot.getByRole("button", { name: /dismiss/i }).first()).toBeVisible();
  }
  return shell;
}

async function openOverflow(page: Page) {
  await page.getByTestId("compact-error-overflow").click();
  await expect(page.getByRole("dialog", { name: "More errors" })).toBeVisible();
  await page.waitForTimeout(300);
}

test("compact error banner — every scene, every theme", async ({ context }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_ERROR_BANNER is required for the error banner capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_ERROR_BANNER=1 to run the capture");
  test.setTimeout(600_000);

  await settleDevServer(context);
  const written: string[] = [];
  const first = THEMES[0]!;

  for (const theme of THEMES) {
    written.push(
      await withPage(context, `sheet ${theme}`, async (page) =>
        snap(await open(page, `theme=${theme}`, ERROR_BANNER_SCENES.length), `sheet-${theme}.png`)
      )
    );
  }

  for (const scene of ERROR_BANNER_SCENES) {
    written.push(
      await withPage(context, `${scene.name} ${first}`, async (page) =>
        snap(
          await open(page, `theme=${first}&scene=${scene.name}`, 1),
          `${scene.name}-${first}.png`
        )
      )
    );
  }

  for (const scene of OVERFLOW_SCENES) {
    const themes = scene.host === "terminal" ? THEMES : [first];
    for (const theme of themes) {
      written.push(
        await withPage(context, `${scene.name} open ${theme}`, async (page) => {
          await open(page, `theme=${theme}&scene=${scene.name}`, 1);
          await page.setViewportSize({ width: 640, height: 720 });
          await openOverflow(page);
          // The popover portals out of the shell, so the shell's box would clip it.
          return snap(page.locator("body"), `${scene.name}-open-${theme}.png`);
        })
      );
    }
  }

  written.push(
    await withPage(context, "overflow focus", async (page) => {
      const shell = await open(page, `theme=${first}&scene=terminal-overflow`, 1);
      await page.getByTestId("compact-error-overflow").focus();
      await page.keyboard.press("Shift+Tab");
      await page.keyboard.press("Tab");
      await expect(page.getByTestId("compact-error-overflow")).toBeFocused();
      return snap(shell, `terminal-overflow-focus-${first}.png`);
    })
  );

  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(written.length);
  const overflowShots = OVERFLOW_SCENES.reduce(
    (n, s) => n + (s.host === "terminal" ? THEMES.length : 1),
    0
  );
  expect(onDisk.length).toBe(THEMES.length + ERROR_BANNER_SCENES.length + overflowShots + 1);
  console.log(`[error-banner-shots] ${onDisk.length} PNGs in ${OUT_DIR}`);
});
