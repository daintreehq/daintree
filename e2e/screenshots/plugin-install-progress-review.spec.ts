/**
 * Plugin install progress banner visual-review harness.
 *
 * The banner spans the full-window Plugin Manager directly under its title bar,
 * so this drives the preview entry (`plugin-install-progress-preview.html`): the
 * real banner with the exact props `usePluginManager` hands it at each point in
 * an install, the real theme tokens and `index.css`, between a stand-in header
 * and the stand-in master/detail it pushes down.
 *
 * Opt-in only, like every sibling review harness:
 *
 *   DAINTREE_SHOT_INSTALL_PROGRESS=1 npx playwright test --project=screenshots plugin-install-progress-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_INSTALL_PROGRESS  required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR               output directory (default artifacts/plugin-install-progress-shots)
 *   DAINTREE_SHOT_THEMES            comma-separated theme sweep (default: daintree,bondi,namib)
 *
 * Output, per theme:
 *   <fixture>-<theme>.png           each state at 1100px
 * Plus, in the first theme only:
 *   <fixture>-<theme>-narrow.png    width pressure at the 800px minimum window
 *   cancel-focused-<theme>.png      the cancel control under keyboard focus
 *
 * Hard rule, inherited from the siblings: never write a PNG that has not been
 * verified. `snap()` asserts the target is attached with a real box before it
 * writes, the banner must be present, and the test counts the files itself
 * rather than trusting the exit code.
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

const ENABLED = !!process.env.DAINTREE_SHOT_INSTALL_PROGRESS;

const DEFAULT_WIDTH = 1100;
const NARROW_WIDTH = 800;

const OUT_DIR = path.resolve(
  process.env.DAINTREE_SHOT_DIR ??
    path.join(process.cwd(), "artifacts", "plugin-install-progress-shots")
);

const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi,namib")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

/**
 * Mirrors `FIXTURES` in the preview. Every banner waits out the 400ms Doherty
 * gate and a 250ms entrance; `still-working` also waits out the five-second
 * long-wait note.
 */
const FIXTURES = [
  { name: "starting", settleMs: 900 },
  { name: "downloading", settleMs: 900 },
  { name: "extracting", settleMs: 900 },
  { name: "extracting-long", settleMs: 900 },
  { name: "validating", settleMs: 900 },
  { name: "activating", settleMs: 900 },
  { name: "still-working", settleMs: 5_600 },
  { name: "cancelling", settleMs: 900 },
  { name: "with-restart", settleMs: 900 },
] as const;

const NARROW_FIXTURES = ["extracting-long", "still-working", "with-restart"] as const;

const ATTACH_TIMEOUT_MS = 30_000;

const snap = makeSnap(OUT_DIR);

let server: PreviewServer | undefined;

test.beforeAll(async () => {
  // No test.skip here: `test.info()` is unavailable in a beforeAll hook, so the
  // structured-skip annotation the repo requires cannot be attached. The test
  // body carries the skip; this hook simply does no work when the flag is unset.
  if (!ENABLED) return;
  if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });
  server = await startPreviewServer();
});

test.afterAll(async () => {
  await server?.close();
});

/** Hold one page open until Vite's optimizer stops force-reloading it. */
async function settleDevServer(context: BrowserContext) {
  const page = await context.newPage();
  await stubViteHmrClient(page);
  let navigations = 0;
  page.on("framenavigated", () => navigations++);
  await page.goto(`${server!.baseURL}/plugin-install-progress-preview.html?fixture=extracting`);
  for (let attempt = 0; attempt < 6; attempt++) {
    const before = navigations;
    await page.waitForTimeout(2_500);
    const shellCount = await page.locator("[data-preview-shell]").count();
    if (navigations === before && shellCount === 1) break;
  }
  await page.close();
}

/** Every capture gets its own page, and a renderer that dies gets one more go. */
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
        console.warn(`[install-progress-shots] renderer crashed on ${what}; retrying once`);
        continue;
      }
      if (crashed) throw new Error(`${what}: renderer crashed twice`, { cause: error });
      throw error;
    } finally {
      await page.close().catch(() => undefined);
    }
  }
}

async function openFixture(
  page: Page,
  fixture: string,
  theme: string,
  width: number,
  settleMs: number
): Promise<Locator> {
  await page.setViewportSize({ width, height: 460 });
  await page.goto(
    `${server!.baseURL}/plugin-install-progress-preview.html?theme=${theme}&fixture=${fixture}&width=${width}`
  );
  const shell = page.locator("[data-preview-shell]").first();
  await expect(shell).toBeAttached({ timeout: ATTACH_TIMEOUT_MS });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(settleMs);
  // An empty slot means the banner returned null — a picture of the stand-in
  // dressed up as a passing run.
  const banner = page.locator("[data-install-progress] [role='status']").first();
  await expect(banner, `fixture "${fixture}" rendered no banner`).toBeAttached();
  return shell;
}

test("plugin install progress banner — every state, every theme", async ({ context }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_INSTALL_PROGRESS is required for the install progress capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_INSTALL_PROGRESS=1 to run the capture");
  test.setTimeout(10 * 60_000);

  await settleDevServer(context);
  const written: string[] = [];

  for (const theme of THEMES) {
    for (const { name, settleMs } of FIXTURES) {
      written.push(
        await withPage(context, `${name} ${theme}`, async (page) =>
          snap(
            await openFixture(page, name, theme, DEFAULT_WIDTH, settleMs),
            `${name}-${theme}.png`
          )
        )
      );
    }
  }

  const theme = THEMES[0]!;
  for (const name of NARROW_FIXTURES) {
    const settleMs = FIXTURES.find((f) => f.name === name)!.settleMs;
    written.push(
      await withPage(context, `${name} narrow`, async (page) =>
        snap(
          await openFixture(page, name, theme, NARROW_WIDTH, settleMs),
          `${name}-${theme}-narrow.png`
        )
      )
    );
  }

  written.push(
    await withPage(context, "cancel focused", async (page) => {
      const shell = await openFixture(page, "extracting", theme, DEFAULT_WIDTH, 900);
      // The stand-in header opts out of the tab order, so the first Tab lands on
      // the banner's own control — the way a keyboard user actually reaches it.
      await page.keyboard.press("Tab");
      const focused = await page.evaluate(
        () => !!document.activeElement?.closest("[data-install-progress]")
      );
      if (!focused) throw new Error("cancel-focused: Tab did not reach the banner");
      await page.waitForTimeout(200);
      return snap(shell, `cancel-focused-${theme}.png`);
    })
  );

  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(written.length);
  expect(onDisk.length).toBe(THEMES.length * FIXTURES.length + NARROW_FIXTURES.length + 1);
  console.log(`[install-progress-shots] ${onDisk.length} PNGs in ${OUT_DIR}`);
});
