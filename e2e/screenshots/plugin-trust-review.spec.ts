/**
 * Project plugin trust banner visual-review harness.
 *
 * The banner takes room from the panel grid it sits above, so this drives the
 * Plugin preview entry (`plugin-trust-preview.html`): the real banner against
 * its real store, in the grid region it actually occupies, over a stand-in
 * grid whose panels give up whatever the banner claims.
 *
 * Opt-in only, like every sibling review harness:
 *
 *   DAINTREE_SHOT_PLUGIN_TRUST=1 npx playwright test --project=screenshots plugin-trust-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_PLUGIN_TRUST  required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR           output directory (default artifacts/plugin-trust-shots)
 *   DAINTREE_SHOT_THEMES        comma-separated theme sweep (default: daintree,bondi,namib)
 *
 * Output, per theme:
 *   <fixture>-<theme>.png          each state at 1100px
 * Plus, in the first theme only:
 *   <fixture>-<theme>-narrow.png   width pressure at 640px
 *   <fixture>-<theme>-wide.png     the line with room to spare, 1600px
 *   <fixture>-<theme>-mid.png      just above the wrap breakpoint, 880px
 *   <fixture>-<theme>-tiny.png     a grid squeezed by a wide sidebar, 360px
 *
 * Hard rule, inherited from the siblings: never write a PNG that has not been
 * verified. `snap()` asserts the target is attached with a real box before it
 * writes, and the test counts the files itself rather than trusting the exit code.
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

const ENABLED = !!process.env.DAINTREE_SHOT_PLUGIN_TRUST;

const DEFAULT_WIDTH = 1100;
const NARROW_WIDTH = 640;
const WIDE_WIDTH = 1600;
const GRID_HEIGHT = 420;

const OUT_DIR = path.resolve(
  process.env.DAINTREE_SHOT_DIR ?? path.join(process.cwd(), "artifacts", "plugin-trust-shots")
);

const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi,namib")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

/** Mirrors `TRUST_FIXTURES`. */
const FIXTURES = ["single", "multi", "deciding", "error", "spoof-name", "with-grid-bar"] as const;

/** Width pressure is where the choices and the warning collide. */
const NARROW_FIXTURES = ["single", "multi", "spoof-name", "with-grid-bar"] as const;
const WIDE_FIXTURES = ["single", "multi"] as const;
/**
 * Just above the strip's wrap breakpoint, where the controls still share the
 * row and the text column is at its narrowest.
 */
const MID_WIDTH = 880;
const MID_FIXTURES = ["single", "spoof-name"] as const;
/** A grid squeezed by a wide sidebar: narrower than three actions and a × in one row. */
const TINY_WIDTH = 360;
const TINY_FIXTURES = ["single"] as const;

/**
 * The dev server compiles each page on first request, and under load that can
 * outrun Playwright's 5s default — a timeout there is not a finding.
 */
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

/**
 * Vite discovers dependencies as it transforms, and a discovery mid-run
 * re-bundles and force-reloads every open page — which under Playwright is a
 * blank document at the exact moment the shell is asserted. Hold a throwaway
 * page open until the optimizer has stopped reloading it, so every capture
 * that follows loads a settled server.
 */
async function settleDevServer(context: BrowserContext) {
  const page = await context.newPage();
  await stubViteHmrClient(page);
  let navigations = 0;
  page.on("framenavigated", () => navigations++);
  await page.goto(`${server!.baseURL}/plugin-trust-preview.html?fixture=single`);
  for (let attempt = 0; attempt < 6; attempt++) {
    const before = navigations;
    await page.waitForTimeout(2_500);
    const shellCount = await page.locator("[data-preview-shell]").count();
    if (navigations === before && shellCount === 1) break;
  }
  await page.close();
}

/**
 * Every capture gets its own page, and a renderer that dies gets one more go.
 * A crash under load is noise; two in a row are not.
 */
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
    const consoleErrors: string[] = [];
    page.on("crash", () => {
      crashed = true;
    });
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text().slice(0, 300));
    });
    try {
      const result = await body(page);
      if (errors.length > 0) throw new Error(`${what}: page threw: ${errors.join(" | ")}`);
      return result;
    } catch (error) {
      if (crashed && attempt === 1) {
        console.warn(`[plugin-trust-shots] renderer crashed on ${what}; retrying once`);
        continue;
      }
      if (crashed) throw new Error(`${what}: renderer crashed twice`, { cause: error });
      const html = await page.content().catch(() => "<unavailable>");
      throw new Error(
        `${what}: ${String(error)}\n  url: ${page.url()}\n  console: ${consoleErrors.join(" | ") || "(none)"}\n  html: ${html.slice(0, 400)}`,
        { cause: error }
      );
    } finally {
      await page.close().catch(() => undefined);
    }
  }
}

/** Load one state in one theme at one width, and settle it past the banner's entrance. */
async function openFixture(
  page: Page,
  fixture: string,
  theme: string,
  width: number
): Promise<Locator> {
  await page.setViewportSize({ width, height: GRID_HEIGHT + 40 });
  await page.goto(
    `${server!.baseURL}/plugin-trust-preview.html?theme=${theme}&fixture=${fixture}&width=${width}&height=${GRID_HEIGHT}`
  );
  const shell = page.locator("[data-preview-shell]").first();
  await expect(shell).toBeAttached({ timeout: ATTACH_TIMEOUT_MS });
  await page.evaluate(() => document.fonts.ready);
  // The banner's entrance is a 250ms opacity-and-slide; wait it out.
  await page.waitForTimeout(400);
  const banner = page.locator("[data-banner-slot] [role='status']").first();
  // An empty slot means the banner returned null — a picture of the grid
  // dressed up as a passing run.
  await expect(banner, `fixture "${fixture}" rendered no banner`).toBeAttached();
  return shell;
}

test("project plugin trust banner — every state, every theme", async ({ context }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_PLUGIN_TRUST is required for the plugin trust capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_PLUGIN_TRUST=1 to run the capture");

  await settleDevServer(context);
  const written: string[] = [];

  for (const theme of THEMES) {
    for (const name of FIXTURES) {
      written.push(
        await withPage(context, `${name} ${theme}`, async (page) =>
          snap(await openFixture(page, name, theme, DEFAULT_WIDTH), `${name}-${theme}.png`)
        )
      );
    }
  }

  const theme = THEMES[0]!;
  for (const name of NARROW_FIXTURES) {
    written.push(
      await withPage(context, `${name} narrow`, async (page) =>
        snap(await openFixture(page, name, theme, NARROW_WIDTH), `${name}-${theme}-narrow.png`)
      )
    );
  }
  for (const name of WIDE_FIXTURES) {
    written.push(
      await withPage(context, `${name} wide`, async (page) =>
        snap(await openFixture(page, name, theme, WIDE_WIDTH), `${name}-${theme}-wide.png`)
      )
    );
  }
  for (const name of MID_FIXTURES) {
    written.push(
      await withPage(context, `${name} mid`, async (page) =>
        snap(await openFixture(page, name, theme, MID_WIDTH), `${name}-${theme}-mid.png`)
      )
    );
  }
  for (const name of TINY_FIXTURES) {
    written.push(
      await withPage(context, `${name} tiny`, async (page) =>
        snap(await openFixture(page, name, theme, TINY_WIDTH), `${name}-${theme}-tiny.png`)
      )
    );
  }

  // Count the files ourselves. A harness that trusts its own exit code is how a
  // review ends up reasoning about screenshots that were never written.
  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(written.length);
  expect(onDisk.length).toBe(
    THEMES.length * FIXTURES.length +
      NARROW_FIXTURES.length +
      WIDE_FIXTURES.length +
      MID_FIXTURES.length +
      TINY_FIXTURES.length
  );
  console.log(`[plugin-trust-shots] ${onDisk.length} PNGs in ${OUT_DIR}`);
});
