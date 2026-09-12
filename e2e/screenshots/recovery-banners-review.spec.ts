/**
 * Global banner family visual-review harness.
 *
 * Ten banners contend for the one slot above the toolbar, so the real app can
 * never show two of them side by side — and a family nobody has seen together
 * is a family nobody has noticed disagreeing. This drives the Recovery
 * preview entry (`recovery-banners-preview.html`): the real banner components
 * against their real stores, the real theme tokens and `index.css`, in the
 * title-bar band they actually occupy.
 *
 * Opt-in only, like every sibling review harness:
 *
 *   DAINTREE_SHOT_BANNERS=1 npx playwright test --project=screenshots recovery-banners-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_BANNERS  required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR      output directory (default artifacts/recovery-banner-shots)
 *   DAINTREE_SHOT_THEMES   comma-separated theme sweep (default: daintree,bondi,namib)
 *
 * Output, per theme:
 *   sheet-<theme>.png              all ten slots stacked, one canonical state each
 *   <fixture>-<theme>.png          each state, rendered through GlobalBannerCoordinator
 * Plus, in the first theme only:
 *   sheet-<theme>-windows.png      the sheet with the Windows caption inset
 *   safe-mode-<theme>-details.png  the details popover open
 *   <fixture>-<theme>-narrow.png   width-pressure cases
 *
 * Hard rule, inherited from the siblings: never write a PNG that has not been
 * verified. `snap()` asserts the target is attached with a real box before it
 * writes, and the test counts the files itself rather than trusting the exit code.
 */

import { test, expect, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readdirSync, rmSync } from "fs";
import path from "path";
import { createServer, type ViteDevServer } from "vite";

const ENABLED = !!process.env.DAINTREE_SHOT_BANNERS;

const DEFAULT_WIDTH = 1100;
const NARROW_WIDTH = 640;

const OUT_DIR = path.resolve(
  process.env.DAINTREE_SHOT_DIR ?? path.join(process.cwd(), "artifacts", "recovery-banner-shots")
);

const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi,namib")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

/** Mirrors `BANNER_FIXTURES`; the settle covers the Doherty-gated variants. */
const FIXTURES = [
  { name: "host-crash", settleMs: 0 },
  { name: "host-crash-diagnostics-failed", settleMs: 0 },
  { name: "host-crash-recovering", settleMs: 600 },
  { name: "watchdog-disabled", settleMs: 0 },
  { name: "host-memory-stall", settleMs: 0 },
  { name: "safe-mode", settleMs: 0 },
  { name: "restore-confirmation", settleMs: 0 },
  { name: "restore-confirmation-suspects", settleMs: 0 },
  { name: "missing-prerequisite", settleMs: 0 },
  { name: "missing-prerequisite-outdated", settleMs: 0 },
  { name: "missing-prerequisite-installing", settleMs: 0 },
  { name: "missing-prerequisite-failed", settleMs: 0 },
  { name: "forge-token", settleMs: 0 },
  { name: "forge-token-single", settleMs: 0 },
  { name: "plugin-document", settleMs: 0 },
  { name: "cloud-sync", settleMs: 0 },
  { name: "rosetta", settleMs: 0 },
] as const;

const SHEET_ROWS = 10;

/** Width pressure is where a long title and a wide action collide. */
const NARROW_FIXTURES = [
  "host-crash",
  "restore-confirmation-suspects",
  "missing-prerequisite-installing",
  "forge-token",
  "rosetta",
] as const;

/**
 * The dev server compiles each page on first request, and under load that can
 * outrun Playwright's 5s default — a timeout there is not a finding.
 */
const ATTACH_TIMEOUT_MS = 30_000;

let server: ViteDevServer | undefined;
let baseURL = "";

test.beforeAll(async ({ browser }) => {
  // No test.skip here: `test.info()` is unavailable in a beforeAll hook, so the
  // structured-skip annotation the repo requires cannot be attached. The test
  // body carries the skip; this hook simply does no work when the flag is unset.
  if (!ENABLED) return;
  if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });

  // `strictPort: false` matters: the project's own vite config sets
  // `strictPort: true`, and that wins over an inline `port: 0` — so with the app
  // running this harness would die on "Port 5173 is already in use".
  server = await createServer({ server: { port: 0, strictPort: false }, logLevel: "warn" });
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === "string") throw new Error("vite gave no TCP address");
  baseURL = `http://127.0.0.1:${address.port}`;

  // Vite discovers dependencies as it transforms, and a discovery mid-run
  // re-bundles and force-reloads every open page — which under Playwright is a
  // blank document at the exact moment the shell is asserted. Transform the
  // entry graph up front, then hold a throwaway page open until the optimizer
  // has stopped reloading it, so every capture that follows loads a settled
  // server.
  await server.warmupRequest("/src/components/Recovery/__preview__/preview.tsx");
  const page = await browser.newPage();
  let navigations = 0;
  page.on("framenavigated", () => navigations++);
  await page.goto(`${baseURL}/recovery-banners-preview.html?fixture=sheet`);
  for (let attempt = 0; attempt < 6; attempt++) {
    const before = navigations;
    await page.waitForTimeout(2_500);
    const shellCount = await page.locator("[data-preview-shell]").count();
    if (navigations === before && shellCount === 1) break;
  }
  await page.close();
});

test.afterAll(async () => {
  await server?.close();
});

/** Write one PNG, having proved there is something to write. */
async function snap(target: Locator, file: string): Promise<string> {
  await expect(target).toBeAttached();
  const box = await target.boundingBox();
  if (!box || box.width < 8 || box.height < 8) {
    throw new Error(`${file}: target has no real box (${JSON.stringify(box)}) — refusing to write`);
  }
  const out = path.join(OUT_DIR, file);
  await target.screenshot({ path: out });
  return out;
}

/**
 * Every capture gets its own page, and a renderer that dies gets one more go.
 *
 * A page that throws renders nothing, and a renderer the OS kills under load
 * renders nothing either — both look like "no shell" from outside, and both
 * are the worst way for a visual-review tool to fail: silently. So the page
 * reports its own uncaught errors and console errors into any failure, a crash
 * is named as a crash, and one crash is retried before it fails the run, since
 * a crash under load is noise and two in a row are not.
 */
async function withPage<T>(
  context: BrowserContext,
  what: string,
  body: (page: Page) => Promise<T>,
  init?: (page: Page) => Promise<void>
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const page = await context.newPage();
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
      await init?.(page);
      const result = await body(page);
      if (errors.length > 0) throw new Error(`${what}: page threw: ${errors.join(" | ")}`);
      return result;
    } catch (error) {
      if (crashed && attempt === 1) {
        console.warn(`[recovery-banner-shots] renderer crashed on ${what}; retrying once`);
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

async function settle(page: Page, extraMs: number) {
  await page.evaluate(() => document.fonts.ready);
  // The banner's entrance is a 250ms opacity-and-slide; wait it out so no
  // capture lands mid-transition.
  await page.waitForTimeout(350 + extraMs);
}

/** Load one state in one theme at one width, through the coordinator, and settle it. */
async function openFixture(
  page: Page,
  fixture: string,
  theme: string,
  width: number,
  settleMs: number
): Promise<Locator> {
  await page.setViewportSize({ width, height: 400 });
  await page.goto(
    `${baseURL}/recovery-banners-preview.html?theme=${theme}&fixture=${fixture}&width=${width}`
  );
  const shell = page.locator("[data-preview-shell]").first();
  await expect(shell).toBeAttached({ timeout: ATTACH_TIMEOUT_MS });
  await settle(page, settleMs);
  const banner = page.locator("[data-banner-slot] [role]").first();
  // An empty slot means the coordinator resolved to nothing, or the banner
  // returned null — a picture of the toolbar strip dressed up as a passing run.
  await expect(banner, `fixture "${fixture}" rendered no banner`).toBeAttached();
  return shell;
}

async function openSheet(page: Page, theme: string, width: number): Promise<Locator> {
  await page.setViewportSize({ width, height: 2400 });
  await page.goto(
    `${baseURL}/recovery-banners-preview.html?theme=${theme}&fixture=sheet&width=${width}`
  );
  const shell = page.locator("[data-preview-shell]").first();
  await expect(shell).toBeAttached({ timeout: ATTACH_TIMEOUT_MS });
  await settle(page, 0);
  // Every row must hold a banner — a sheet with a silent gap is the exact
  // failure this harness exists to make visible.
  await expect(page.locator("[data-banner-slot] [role]")).toHaveCount(SHEET_ROWS);
  return shell;
}

test("global banner family — every slot, every state, every theme", async ({ context }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_BANNERS is required for the banner capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_BANNERS=1 to run the capture");

  const written: string[] = [];

  for (const theme of THEMES) {
    written.push(
      await withPage(context, `sheet ${theme}`, async (page) =>
        snap(await openSheet(page, theme, DEFAULT_WIDTH), `sheet-${theme}.png`)
      )
    );
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

  // The safe-mode details popover is the one piece of banner UI that lives
  // outside the band, and it carries its own hand-rolled controls.
  written.push(
    await withPage(context, "safe-mode details", async (page) => {
      const shell = await openFixture(page, "safe-mode", theme, DEFAULT_WIDTH, 0);
      await page.getByRole("button", { name: "Show details" }).click();
      await expect(page.getByText(/quarantined/)).toBeVisible();
      await page.waitForTimeout(250);
      return snap(shell, `safe-mode-${theme}-details.png`);
    })
  );

  for (const name of NARROW_FIXTURES) {
    const fixture = FIXTURES.find((f) => f.name === name)!;
    written.push(
      await withPage(context, `${name} narrow`, async (page) =>
        snap(
          await openFixture(page, name, theme, NARROW_WIDTH, fixture.settleMs),
          `${name}-${theme}-narrow.png`
        )
      )
    );
  }

  // The Windows caption strip reserves the right edge instead of the left, so
  // the dismiss button and actions sit against it there.
  written.push(
    await withPage(
      context,
      "sheet windows",
      async (page) =>
        snap(await openSheet(page, theme, DEFAULT_WIDTH), `sheet-${theme}-windows.png`),
      (page) =>
        page.addInitScript(() => {
          Object.defineProperty(navigator, "platform", { get: () => "Win32" });
        })
    )
  );

  // Count the files ourselves. A harness that trusts its own exit code is how a
  // review ends up reasoning about screenshots that were never written.
  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(written.length);
  expect(onDisk.length).toBeGreaterThanOrEqual(THEMES.length * (FIXTURES.length + 1));
  console.log(`[recovery-banner-shots] ${onDisk.length} PNGs in ${OUT_DIR}`);
});
