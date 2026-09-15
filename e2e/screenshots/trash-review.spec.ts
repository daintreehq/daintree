/**
 * "Recently closed" trash popover visual-review harness.
 *
 * Every row on this surface destroys itself twenty seconds after it appears,
 * which makes the states worth looking at — the final five seconds, a list long
 * enough to scroll, a tab group beside an orphaned pane — the ones nobody has
 * ever held still long enough to look at. This drives the Layout preview entry
 * (`trash-preview.html`), which mounts the real `TrashContainer` against the
 * real stores with wall-clock time frozen, then opens the popover the way a
 * user does: by clicking the pill.
 *
 * Opt-in only, like every sibling review harness:
 *
 *   DAINTREE_SHOT_TRASH=1 npx playwright test --project=screenshots trash-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_TRASH  required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR    output directory (default artifacts/trash-shots)
 *   DAINTREE_SHOT_THEMES comma-separated theme sweep (default: daintree,bondi,namib)
 *
 * Output, per theme:
 *   <fixture>-<theme>.png          the popover, open, at rest
 * Plus, in the first theme only:
 *   rest-<theme>-hover.png         a row under the pointer
 *   grouped-<theme>-expanded.png   the tab group expanded
 *   spread-<theme>-confirm.png     the empty-trash confirm over the popover
 *   rest-<theme>-pill.png          the trigger pill, popover closed
 *   rest-<theme>-pill-compact.png  the compact pill with its count badge
 *   spread-<theme>-reduced.png     the same rows under prefers-reduced-motion
 *
 * Hard rule, inherited from the siblings: never write a PNG that has not been
 * verified. `snap()` asserts the target is attached with a real box before it
 * writes, and the test counts the files itself rather than trusting the exit code.
 */

import { test, expect, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readdirSync, rmSync } from "fs";
import path from "path";
import { createServer, type ViteDevServer } from "vite";

const ENABLED = !!process.env.DAINTREE_SHOT_TRASH;

const DEFAULT_WIDTH = 1100;

const OUT_DIR = path.resolve(
  process.env.DAINTREE_SHOT_DIR ?? path.join(process.cwd(), "artifacts", "trash-shots")
);

const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi,namib")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

/** Mirrors `FIXTURES` in the preview entry. */
const FIXTURES = [
  "rest",
  "spread",
  "single",
  "critical",
  "many",
  "grouped",
  "orphan",
  "long-title",
] as const;

/**
 * The dev server compiles each page on first request, and under load that can
 * outrun Playwright's 5s default — a timeout there is not a finding.
 */
const ATTACH_TIMEOUT_MS = 30_000;

const POPOVER = '[role="dialog"][aria-label="Recently closed terminals"]';

let server: ViteDevServer | undefined;
let baseURL = "";

test.beforeAll(async () => {
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
  await server.warmupRequest("/src/components/Layout/__preview__/preview.tsx");
});

test.afterAll(async () => {
  await server?.close();
});

/**
 * Vite discovers dependencies as it transforms, and a discovery mid-run
 * re-bundles and force-reloads every open page — which under Playwright is a
 * blank document at the exact moment the shell is asserted. Hold a throwaway
 * page open until the optimizer has stopped reloading it, so every capture that
 * follows loads a settled server.
 */
async function settleDevServer(context: BrowserContext) {
  const page = await context.newPage();
  let navigations = 0;
  page.on("framenavigated", () => navigations++);
  await page.goto(`${baseURL}/trash-preview.html?fixture=rest`);
  for (let attempt = 0; attempt < 6; attempt++) {
    const before = navigations;
    await page.waitForTimeout(2_500);
    const shellCount = await page.locator("[data-preview-shell]").count();
    if (navigations === before && shellCount === 1) break;
  }
  await page.close();
}

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
 * renders nothing either — both look like "no popover" from outside, and both
 * are the worst way for a visual-review tool to fail: silently.
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
        console.warn(`[trash-shots] renderer crashed on ${what}; retrying once`);
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

interface OpenOptions {
  compact?: boolean;
  /** Leave the popover closed — for shots of the trigger pill itself. */
  closed?: boolean;
}

/** Load one fixture in one theme and open the popover the way a user does. */
async function open(
  page: Page,
  fixture: string,
  theme: string,
  options: OpenOptions = {}
): Promise<Locator> {
  await page.setViewportSize({ width: DEFAULT_WIDTH, height: 560 });
  const compact = options.compact ? "&compact=1" : "";
  await page.goto(
    `${baseURL}/trash-preview.html?theme=${theme}&fixture=${fixture}&width=${DEFAULT_WIDTH}${compact}`
  );
  const shell = page.locator("[data-preview-shell]").first();
  await expect(shell).toBeAttached({ timeout: ATTACH_TIMEOUT_MS });
  await page.evaluate(() => document.fonts.ready);

  const pill = page.locator('[data-testid="trash-container"]');
  await expect(pill, `fixture "${fixture}" rendered no trash pill`).toBeVisible();
  if (options.closed) {
    await page.waitForTimeout(150);
    return pill;
  }

  await pill.click();
  const popover = page.locator(POPOVER);
  await expect(popover, `fixture "${fixture}" opened no popover`).toBeVisible();
  // The popover's own entry transition is 200ms; wait it out so no capture
  // lands mid-fade and reads as a contrast finding.
  await page.waitForTimeout(350);
  // An open popover with no rows is a picture of an empty box dressed up as a
  // passing run — the exact failure this harness exists to make visible.
  await expect(popover.locator("[data-trash-row]")).not.toHaveCount(0);
  return popover;
}

test("recently-closed trash — every state, every theme", async ({ context }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_TRASH is required for the trash capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_TRASH=1 to run the capture");

  await settleDevServer(context);
  const written: string[] = [];

  for (const theme of THEMES) {
    for (const fixture of FIXTURES) {
      written.push(
        await withPage(context, `${fixture} ${theme}`, async (page) =>
          snap(await open(page, fixture, theme), `${fixture}-${theme}.png`)
        )
      );
    }
  }

  const theme = THEMES[0]!;

  // Hover is the state the countdown currently depends on, so the difference
  // between it and the resting shot above is the finding, photographed.
  written.push(
    await withPage(context, "rest hover", async (page) => {
      const popover = await open(page, "rest", theme);
      await popover.locator("[data-trash-row]").first().hover();
      await page.waitForTimeout(250);
      return snap(popover, `rest-${theme}-hover.png`);
    })
  );

  written.push(
    await withPage(context, "grouped expanded", async (page) => {
      const popover = await open(page, "grouped", theme);
      await popover.getByRole("button", { name: "Expand group" }).click();
      await page.waitForTimeout(250);
      return snap(popover, `grouped-${theme}-expanded.png`);
    })
  );

  // The confirm is a separate surface over this one, and the popover has to
  // survive underneath it — hence the whole body rather than the popover box.
  written.push(
    await withPage(context, "empty-trash confirm", async (page) => {
      const popover = await open(page, "spread", theme);
      await popover.getByRole("button", { name: "Empty trash" }).click();
      await expect(page.getByText(/permanently removed/)).toBeVisible();
      await page.waitForTimeout(250);
      return snap(page.locator("body"), `spread-${theme}-confirm.png`);
    })
  );

  written.push(
    await withPage(context, "pill", async (page) =>
      snap(await open(page, "rest", theme, { closed: true }), `rest-${theme}-pill.png`)
    )
  );

  written.push(
    await withPage(context, "pill compact", async (page) =>
      snap(
        await open(page, "many", theme, { closed: true, compact: true }),
        `many-${theme}-pill-compact.png`
      )
    )
  );

  // A continuously-shrinking bar is a motion trigger, so the reduced-motion
  // rendering is a state that carries design weight, not an edge case.
  written.push(
    await withPage(
      context,
      "reduced motion",
      async (page) => snap(await open(page, "spread", theme), `spread-${theme}-reduced.png`),
      (page) => page.emulateMedia({ reducedMotion: "reduce" })
    )
  );

  // Count the files ourselves. A harness that trusts its own exit code is how a
  // review ends up reasoning about screenshots that were never written.
  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(written.length);
  expect(onDisk.length).toBeGreaterThanOrEqual(THEMES.length * FIXTURES.length);
  console.log(`[trash-shots] ${onDisk.length} PNGs in ${OUT_DIR}`);
});
