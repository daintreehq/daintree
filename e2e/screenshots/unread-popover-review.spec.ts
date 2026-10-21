/**
 * Unread popover visual-review harness.
 *
 * Drives the Layout dock preview entry (`dock-preview.html`), which mounts the
 * real `ContentDock` against the real stores, and opens the Unread pill's
 * popover the way a user does: by clicking it. The fixtures cover the shapes
 * the list actually takes — agents with no task title, a split across
 * worktrees, long titles, a tab group, and a list long enough to scroll.
 *
 * Opt-in only, like every sibling review harness:
 *
 *   DAINTREE_SHOT_UNREAD=1 npx playwright test --project=screenshots unread-popover-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_UNREAD  required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR     output directory (default artifacts/unread-shots)
 *   DAINTREE_SHOT_THEMES  comma-separated theme sweep (default: daintree,bondi,namib)
 *
 * Output, per theme:
 *   <fixture>-<theme>.png        the popover, open, at rest
 * Plus, in the first theme only:
 *   <fixture>-<theme>-hover.png  the first row under the pointer
 *   <fixture>-<theme>-focus.png  the first row with keyboard focus
 *   unread-<theme>-pill.png      the dock strip with the pill, closed
 *   unread-three-here-<theme>-drained.png  focus after the focused row drains
 *   unread-long-<theme>-tooltip.png        a truncated title's full text
 *   siblings-<theme>-waiting.png the Waiting popover, for row-grammar comparison
 *
 * Never writes a PNG it has not verified, and counts the files itself.
 */

import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { mkdirSync, readdirSync, unlinkSync } from "fs";
import path from "path";
import {
  makeSnap,
  startPreviewServer,
  stubViteHmrClient,
  type PreviewServer,
} from "../helpers/previewHarness";

const ENABLED = !!process.env.DAINTREE_SHOT_UNREAD;

const OUT_DIR = path.resolve(
  process.env.DAINTREE_SHOT_DIR || path.join(process.cwd(), "artifacts", "unread-shots")
);

const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi,namib")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

/** Mirrors the `unread*` entries of `FIXTURES` in the preview entry. */
const FIXTURES = [
  "unread",
  "unread-three-here",
  "unread-long",
  "unread-group",
  "unread-many",
] as const;

/** Row counts each fixture must render, so a capture of the wrong state fails. */
const EXPECTED_ROWS: Record<(typeof FIXTURES)[number], number> = {
  unread: 3,
  "unread-three-here": 3,
  "unread-long": 3,
  "unread-group": 4,
  "unread-many": 11,
};

const INTERACTIVE_FIXTURES = ["unread", "unread-long"] as const;

const ATTACH_TIMEOUT_MS = 30_000;
const POPOVER = '[role="dialog"][id="unread-container-popover"]';
const ROW = '[data-testid="unread-single-item"]';

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
  await page.goto(`${server!.baseURL}/dock-preview.html?fixture=unread`);
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
        console.warn(`[unread-shots] renderer crashed on ${what}; retrying once`);
        continue;
      }
      throw new Error(`${what}: ${String(error)}\n  pageerror: ${errors.join(" | ") || "(none)"}`, {
        cause: error,
      });
    } finally {
      await page.close().catch(() => undefined);
    }
  }
}

async function openUnread(page: Page, fixture: (typeof FIXTURES)[number], theme: string) {
  await page.setViewportSize({ width: 1440, height: 700 });
  await page.goto(`${server!.baseURL}/dock-preview.html?theme=${theme}&fixture=${fixture}`);
  await expect(page.locator("[data-preview-shell]").first()).toBeAttached({
    timeout: ATTACH_TIMEOUT_MS,
  });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
  await page
    .getByRole("button", { name: /^Unread/ })
    .first()
    .click();
  const popover = page.locator(POPOVER);
  await expect(popover).toBeVisible();
  await expect(popover.locator(ROW)).toHaveCount(EXPECTED_ROWS[fixture]);
  // Radix popover enter animation.
  await page.waitForTimeout(350);
  return popover;
}

test("unread popover — every state, every theme", async ({ context }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_UNREAD is required for the unread popover capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_UNREAD=1 to run the capture");
  test.setTimeout(10 * 60_000);

  await settleDevServer(context);
  const written: string[] = [];

  for (const theme of THEMES) {
    for (const fixture of FIXTURES) {
      written.push(
        await withPage(context, `${fixture} ${theme}`, async (page) =>
          snap(await openUnread(page, fixture, theme), `${fixture}-${theme}.png`)
        )
      );
    }
  }

  const theme = THEMES[0]!;

  for (const fixture of INTERACTIVE_FIXTURES) {
    written.push(
      await withPage(context, `${fixture} hover`, async (page) => {
        const popover = await openUnread(page, fixture, theme);
        await popover.locator(ROW).first().hover();
        await page.waitForTimeout(300);
        return snap(popover, `${fixture}-${theme}-hover.png`);
      })
    );
    written.push(
      await withPage(context, `${fixture} focus`, async (page) => {
        const popover = await openUnread(page, fixture, theme);
        await popover.locator(ROW).first().focus();
        await page.keyboard.press("Shift");
        await page.waitForTimeout(300);
        return snap(popover, `${fixture}-${theme}-focus.png`);
      })
    );
  }

  written.push(
    await withPage(context, "drain under focus", async (page) => {
      const popover = await openUnread(page, "unread-three-here", theme);
      await popover.locator(ROW).first().focus();
      await page.waitForTimeout(200);
      await page.keyboard.press("ArrowRight");
      await expect(popover.getByTestId("unread-mark-read-button").first()).toBeFocused();
      // The fleet drops the run, as a read does; focus must land on the next row.
      await page.evaluate(() => {
        const { useFleetSnapshotStore } = (
          window as unknown as {
            __dockPreview: {
              useFleetSnapshotStore: {
                getState: () => { snapshot: { runs: Array<{ runId: string }> } };
                setState: (s: unknown) => void;
              };
            };
          }
        ).__dockPreview;
        const { snapshot } = useFleetSnapshotStore.getState();
        useFleetSnapshotStore.setState({
          snapshot: { ...snapshot, runs: snapshot.runs.filter((r) => r.runId !== "h-3") },
        });
      });
      await expect(popover.locator(ROW)).toHaveCount(2);
      await expect(popover.locator(ROW).first()).toBeFocused();
      await page.waitForTimeout(300);
      return snap(popover, `unread-three-here-${theme}-drained.png`);
    })
  );

  written.push(
    await withPage(context, "drain twice under focus", async (page) => {
      const popover = await openUnread(page, "unread-many", theme);
      const drop = (runId: string) =>
        page.evaluate((id) => {
          const { useFleetSnapshotStore } = (
            window as unknown as {
              __dockPreview: {
                useFleetSnapshotStore: {
                  getState: () => { snapshot: { runs: Array<{ runId: string }> } };
                  setState: (s: unknown) => void;
                };
              };
            }
          ).__dockPreview;
          const { snapshot } = useFleetSnapshotStore.getState();
          useFleetSnapshotStore.setState({
            snapshot: { ...snapshot, runs: snapshot.runs.filter((r) => r.runId !== id) },
          });
        }, runId);
      const rows = popover.locator(ROW);
      // Focus the third row, drain the first, then the focused one: focus
      // must land on the row that was fourth, not skip past it.
      const fourth = await rows.nth(3).getAttribute("aria-label");
      await rows.nth(2).focus();
      await page.waitForTimeout(200);
      // This worktree holds m-8, m-4 and m-0, oldest first.
      await drop("m-8");
      await expect(rows).toHaveCount(10);
      await drop("m-0");
      await expect(rows).toHaveCount(9);
      await expect(popover.locator(`${ROW}[aria-label="${fourth}"]`)).toBeFocused();
      await page.waitForTimeout(300);
      return snap(popover, `unread-many-${theme}-drained-twice.png`);
    })
  );

  written.push(
    await withPage(context, "keyboard truncation", async (page) => {
      const popover = await openUnread(page, "unread-long", theme);
      await popover.locator(ROW).first().focus();
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("ArrowUp");
      await expect(page.getByRole("tooltip").first()).toBeAttached({ timeout: 5_000 });
      await page.waitForTimeout(400);
      const box = (await popover.boundingBox())!;
      const out = path.join(OUT_DIR, `unread-long-${theme}-tooltip-keyboard.png`);
      await page.screenshot({
        path: out,
        clip: { x: box.x - 8, y: box.y - 48, width: box.width + 16, height: box.height + 96 },
      });
      return out;
    })
  );

  written.push(
    await withPage(context, "truncation tooltip", async (page) => {
      const popover = await openUnread(page, "unread-long", theme);
      await popover.locator(ROW).first().locator("span.truncate").first().hover();
      const tip = page.getByRole("tooltip");
      await expect(tip.first()).toBeAttached({ timeout: 5_000 });
      await page.waitForTimeout(400);
      const box = (await popover.boundingBox())!;
      const out = path.join(OUT_DIR, `unread-long-${theme}-tooltip.png`);
      await page.screenshot({
        path: out,
        clip: { x: box.x - 8, y: box.y - 48, width: box.width + 16, height: box.height + 56 },
      });
      return out;
    })
  );

  written.push(
    await withPage(context, "pill", async (page) => {
      await page.setViewportSize({ width: 1440, height: 700 });
      await page.goto(`${server!.baseURL}/dock-preview.html?theme=${theme}&fixture=unread`);
      await expect(page.locator("[data-preview-shell]").first()).toBeAttached({
        timeout: ATTACH_TIMEOUT_MS,
      });
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(400);
      return snap(page.locator("[data-dock-frame]"), `unread-${theme}-pill.png`);
    })
  );

  written.push(
    await withPage(context, "waiting sibling", async (page) => {
      await page.setViewportSize({ width: 1440, height: 700 });
      await page.goto(
        `${server!.baseURL}/dock-preview.html?theme=${theme}&fixture=waiting-reasons`
      );
      await expect(page.locator("[data-preview-shell]").first()).toBeAttached({
        timeout: ATTACH_TIMEOUT_MS,
      });
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(400);
      await page
        .getByRole("button", { name: /^Waiting/ })
        .first()
        .click();
      const popover = page.locator('[role="dialog"][id="waiting-container-popover"]');
      await expect(popover).toBeVisible();
      await expect(popover.locator('[data-testid="waiting-single-item"]')).toHaveCount(5);
      await page.waitForTimeout(350);
      return snap(popover, `siblings-${theme}-waiting.png`);
    })
  );

  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(written.length);
  expect(onDisk.length).toBe(THEMES.length * FIXTURES.length + INTERACTIVE_FIXTURES.length * 2 + 6);
  console.log(`[unread-shots] ${onDisk.length} PNGs in ${OUT_DIR}`);
});
