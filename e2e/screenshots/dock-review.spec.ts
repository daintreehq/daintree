/**
 * Content dock visual-review harness.
 *
 * The dock carries two scopes on one strip — chips for the active worktree,
 * status pills (Background / Waiting / Errors / Trash) for the whole project —
 * and the interesting states are the ones where those scopes disagree: seven
 * agents waiting elsewhere beside one local chip, nothing docked here while
 * other worktrees need attention. This drives the Layout preview entry
 * (`dock-preview.html`), which mounts the real `ContentDock` against the real
 * stores with panels spread across four worktrees.
 *
 * Opt-in only, like every sibling review harness:
 *
 *   DAINTREE_SHOT_DOCK=1 npx playwright test --project=screenshots dock-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_DOCK   required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR    output directory (default artifacts/dock-shots)
 *   DAINTREE_SHOT_THEMES comma-separated theme sweep (default: daintree,bondi,namib)
 *
 * Output, per theme:
 *   <fixture>-<theme>.png           the dock strip at rest
 * Plus, in the first theme only:
 *   rest-<theme>-context.png        the strip under its stand-in sidebar and grid
 *   rest-<theme>-waiting-open.png   the Waiting popover, open
 *   rest-<theme>-trash-open.png     the Trash popover, open
 *   busy-<theme>-trash-open.png     the Trash popover, split by worktree
 *   busy-<theme>-background-open.png the Background popover, split by worktree
 *   busy-<theme>-errors-open.png    the Errors popover
 *   busy-<theme>-compact.png        compact density
 *   busy-<theme>-comfortable.png    comfortable density
 *   busy-<theme>-narrow.png         a narrow window — the rail scrolls
 *
 * Never writes a PNG it has not verified, and counts the files itself.
 */

import { test, expect, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { mkdirSync, readdirSync, unlinkSync } from "fs";
import path from "path";
import {
  makeSnap,
  startPreviewServer,
  stubViteHmrClient,
  type PreviewServer,
} from "../helpers/previewHarness";

const ENABLED = !!process.env.DAINTREE_SHOT_DOCK;

const OUT_DIR = path.resolve(
  process.env.DAINTREE_SHOT_DIR || path.join(process.cwd(), "artifacts", "dock-shots")
);

const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi,namib")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

/** Mirrors `FIXTURES` in the preview entry. */
const FIXTURES = ["rest", "busy", "empty-local", "local-only", "waiting-here-only"] as const;

const ATTACH_TIMEOUT_MS = 30_000;
const DOCK = "#dock-container";

// Chip glyphs and the pill's state circle are 14px; at 1x they are a few
// pixels of anti-aliasing and no judgement about them survives.
test.use({ deviceScaleFactor: 2 });

let server: PreviewServer | undefined;
const snap = makeSnap(OUT_DIR);

test.beforeAll(async () => {
  if (!ENABLED) return;
  const cwd = process.cwd();
  if (OUT_DIR === cwd || cwd.startsWith(OUT_DIR + path.sep)) {
    throw new Error(`DAINTREE_SHOT_DIR resolves to the checkout (${OUT_DIR}) — refusing`);
  }
  mkdirSync(OUT_DIR, { recursive: true });
  for (const f of readdirSync(OUT_DIR)) if (f.endsWith(".png")) unlinkSync(path.join(OUT_DIR, f));
  server = await startPreviewServer();
});

test.afterAll(async () => {
  await server?.close();
});

async function settleDevServer(context: BrowserContext) {
  const page = await context.newPage();
  await stubViteHmrClient(page);
  let navigations = 0;
  page.on("framenavigated", () => navigations++);
  await page.goto(`${server!.baseURL}/dock-preview.html?fixture=rest`);
  for (let attempt = 0; attempt < 8; attempt++) {
    const before = navigations;
    await page.waitForTimeout(2_500);
    const shellCount = await page.locator("[data-preview-shell]").count();
    if (navigations === before && shellCount === 1) break;
  }
  await page.close();
}

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
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text().slice(0, 300));
    });
    page.on("crash", () => {
      crashed = true;
    });
    page.on("pageerror", (error) => errors.push(error.stack ?? error.message));
    try {
      const result = await body(page);
      if (errors.length > 0) throw new Error(`${what}: page threw: ${errors.join(" | ")}`);
      return result;
    } catch (error) {
      if (crashed && attempt === 1) {
        console.warn(`[dock-shots] renderer crashed on ${what}; retrying once`);
        continue;
      }
      const html = await page.content().catch(() => "<unavailable>");
      throw new Error(
        `${what}: ${String(error)}\n  pageerror: ${errors.join(" | ") || "(none)"}\n  console: ${consoleErrors.join(" | ") || "(none)"}\n  html: ${html.slice(0, 400)}`,
        {
          cause: error,
        }
      );
    } finally {
      await page.close().catch(() => undefined);
    }
  }
}

interface LoadOptions {
  width?: number;
  density?: "compact" | "normal" | "comfortable";
}

async function load(
  page: Page,
  fixture: string,
  theme: string,
  options: LoadOptions = {}
): Promise<Locator> {
  const width = options.width ?? 1440;
  await page.setViewportSize({ width, height: 700 });
  await page.goto(
    `${server!.baseURL}/dock-preview.html?theme=${theme}&fixture=${fixture}&width=${width}&density=${options.density ?? "normal"}`
  );
  const shell = page.locator("[data-preview-shell]").first();
  await expect(shell).toBeAttached({ timeout: ATTACH_TIMEOUT_MS });
  await page.evaluate(() => document.fonts.ready);
  const dock = page.locator(DOCK);
  await expect(dock, `fixture "${fixture}" rendered no dock`).toBeVisible();
  // Status pills fade in over 200ms on mount; wait it out.
  await page.waitForTimeout(400);
  return dock;
}

/** A pill the fixture promises must be on screen, or the shot is of the wrong state. */
async function expectPill(page: Page, name: RegExp) {
  await expect(page.getByRole("button", { name }).first()).toBeVisible();
}

test("content dock — every state, every theme", async ({ context }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_DOCK is required for the dock capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_DOCK=1 to run the capture");

  await settleDevServer(context);
  const written: string[] = [];

  for (const theme of THEMES) {
    for (const fixture of FIXTURES) {
      written.push(
        await withPage(context, `${fixture} ${theme}`, async (page) => {
          const dock = await load(page, fixture, theme);
          if (fixture === "rest") await expectPill(page, /^Waiting/);
          return snap(dock, `${fixture}-${theme}.png`);
        })
      );
    }
  }

  const theme = THEMES[0]!;

  written.push(
    await withPage(context, "context", async (page) => {
      await load(page, "rest", theme);
      return snap(page.locator("[data-preview-shell]"), `rest-${theme}-context.png`);
    })
  );

  written.push(
    await withPage(context, "waiting open", async (page) => {
      await load(page, "rest", theme);
      await page
        .getByRole("button", { name: /^Waiting/ })
        .first()
        .click();
      const popover = page.locator('[role="dialog"][aria-label="Waiting panels"]');
      await expect(popover).toBeVisible();
      await page.waitForTimeout(350);
      return snap(page.locator("body"), `rest-${theme}-waiting-open.png`);
    })
  );

  written.push(
    await withPage(context, "trash open", async (page) => {
      await load(page, "rest", theme);
      await page.locator('[data-testid="trash-container"]').click();
      const popover = page.locator('[role="dialog"][aria-label="Recently closed terminals"]');
      await expect(popover).toBeVisible();
      await page.waitForTimeout(350);
      return snap(page.locator("body"), `rest-${theme}-trash-open.png`);
    })
  );

  written.push(
    await withPage(context, "busy trash open", async (page) => {
      await load(page, "busy", theme);
      await page.locator('[data-testid="trash-container"]').click();
      const popover = page.locator('[role="dialog"][aria-label="Recently closed terminals"]');
      await expect(popover).toBeVisible();
      await expect(popover.getByRole("group", { name: "This worktree" })).toBeVisible();
      await expect(popover.getByRole("group", { name: "Other worktrees" })).toBeVisible();
      await page.waitForTimeout(350);
      return snap(page.locator("body"), `busy-${theme}-trash-open.png`);
    })
  );

  for (const [what, pill, dialog] of [
    ["background", /^Background/, "Backgrounded panels"],
    ["errors", /^Errors/, "Errored terminals"],
  ] as const) {
    written.push(
      await withPage(context, `busy ${what} open`, async (page) => {
        await load(page, "busy", theme);
        await page.getByRole("button", { name: pill }).first().click();
        const popover = page.locator(`[role="dialog"][aria-label="${dialog}"]`);
        await expect(popover).toBeVisible();
        await expect(popover.getByRole("group", { name: "Other worktrees" })).toBeVisible();
        await page.waitForTimeout(350);
        return snap(page.locator("body"), `busy-${theme}-${what}-open.png`);
      })
    );
  }

  for (const density of ["compact", "comfortable"] as const) {
    written.push(
      await withPage(context, `busy ${density}`, async (page) =>
        snap(await load(page, "busy", theme, { density }), `busy-${theme}-${density}.png`)
      )
    );
  }

  written.push(
    await withPage(context, "busy narrow", async (page) =>
      snap(await load(page, "busy", theme, { width: 1100 }), `busy-${theme}-narrow.png`)
    )
  );

  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(written.length);
  expect(onDisk.length).toBe(THEMES.length * FIXTURES.length + 9);
  console.log(`[dock-shots] ${onDisk.length} PNGs in ${OUT_DIR}`);
});
