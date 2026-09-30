/**
 * Dock family visual-review harness: the docked chips' own states (open, hover,
 * a tab group open) across themes, and the four status popovers' list states
 * (scrolling, row hover, keyboard focus) that `dock-review` does not reach.
 *
 * Drives the same Layout preview entry as `dock-review` (`dock-preview.html`),
 * which mounts the real `ContentDock` against the real stores.
 *
 *   DAINTREE_SHOT_DOCK_FAMILY=1 npx playwright test --project=screenshots dock-family-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_DOCK_FAMILY  required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR          output directory (default artifacts/dock-family-shots)
 *   DAINTREE_SHOT_THEMES       comma-separated theme sweep (default: daintree,bondi,namib,atacama)
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

const ENABLED = !!process.env.DAINTREE_SHOT_DOCK_FAMILY;

const OUT_DIR = path.resolve(
  process.env.DAINTREE_SHOT_DIR || path.join(process.cwd(), "artifacts", "dock-family-shots")
);

const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi,namib,atacama")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

const ATTACH_TIMEOUT_MS = 30_000;
const DOCK = "#dock-container";

// Chip glyphs are 12-14px; at 1x no judgement about them survives.
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
        console.warn(`[dock-family-shots] renderer crashed on ${what}; retrying once`);
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

async function load(
  page: Page,
  fixture: string,
  theme: string,
  extra: Record<string, string> = {}
): Promise<Locator> {
  await page.setViewportSize({ width: 1440, height: 700 });
  const query = new URLSearchParams({ theme, fixture, width: "1440", ...extra });
  await page.goto(`${server!.baseURL}/dock-preview.html?${query}`);
  await expect(page.locator("[data-preview-shell]").first()).toBeAttached({
    timeout: ATTACH_TIMEOUT_MS,
  });
  await page.evaluate(() => document.fonts.ready);
  const dock = page.locator(DOCK);
  await expect(dock, `fixture "${fixture}" rendered no dock`).toBeVisible();
  await page.waitForTimeout(400);
  return dock;
}

function chip(page: Page, name: RegExp): Locator {
  return page
    .locator("button[data-dock-item]")
    .filter({ has: page.locator("span", { hasText: name }) })
    .first();
}

async function openPill(page: Page, pill: RegExp, dialog: string): Promise<Locator> {
  await page.getByRole("button", { name: pill }).first().click();
  const popover = page.locator(`[role="dialog"][aria-label="${dialog}"]`);
  await expect(popover).toBeVisible();
  await page.waitForTimeout(350);
  return popover;
}

test("dock family — chips and status popovers", async ({ context }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_DOCK_FAMILY is required for the dock family capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_DOCK_FAMILY=1 to run the capture");

  await settleDevServer(context);
  const written: string[] = [];

  for (const theme of THEMES) {
    // An agent chip open: the popover-open treatment against its resting siblings.
    written.push(
      await withPage(context, `chip open ${theme}`, async (page) => {
        const dock = await load(page, "busy", theme, { open: "p-codex" });
        await expect(chip(page, /^Codex$/)).toHaveAttribute("aria-expanded", "true");
        // The dock-panel popover is empty in the preview; the chip is the subject.
        await page.mouse.move(700, 100);
        return snap(dock, `chip-open-${theme}.png`);
      })
    );
    written.push(
      await withPage(context, `group open ${theme}`, async (page) => {
        const dock = await load(page, "busy", theme, { open: "p-g1" });
        await page.mouse.move(700, 100);
        return snap(dock, `group-open-${theme}.png`);
      })
    );
    written.push(
      await withPage(context, `chip hover ${theme}`, async (page) => {
        const dock = await load(page, "busy", theme);
        await chip(page, /^npm run dev$/).hover();
        await page.waitForTimeout(250);
        return snap(dock, `chip-hover-${theme}.png`);
      })
    );
  }

  const theme = THEMES[0]!;

  // Plain-command spinner and agent glyph beside their kind icons.
  written.push(
    await withPage(context, "cues", async (page) =>
      snap(await load(page, "cues", theme), `cues-${theme}.png`)
    )
  );

  written.push(
    await withPage(context, "waiting many", async (page) => {
      await load(page, "waiting-many", theme);
      const popover = await openPill(page, /^Waiting/, "Waiting panels");
      // Scroll part-way so both edges of the list have something beyond them.
      await popover.evaluate((root) => {
        const scroller = Array.from(root.querySelectorAll<HTMLElement>("*")).find(
          (el) =>
            el.scrollHeight > el.clientHeight + 4 && getComputedStyle(el).overflowY !== "visible"
        );
        if (!scroller) throw new Error("waiting-many list does not scroll");
        scroller.scrollTop = 80;
      });
      await page.waitForTimeout(300);
      return snap(page.locator("body"), `waiting-many-${theme}.png`);
    })
  );

  written.push(
    await withPage(context, "waiting row hover", async (page) => {
      await load(page, "waiting-reasons", theme);
      const popover = await openPill(page, /^Waiting/, "Waiting panels");
      await popover.getByTestId("waiting-single-item").nth(1).hover();
      await page.waitForTimeout(250);
      return snap(page.locator("body"), `waiting-hover-${theme}.png`);
    })
  );

  written.push(
    await withPage(context, "waiting keyboard", async (page) => {
      await load(page, "waiting-reasons", theme);
      const pill = page.getByRole("button", { name: /^Waiting/ }).first();
      await pill.focus();
      await page.keyboard.press("Enter");
      const popover = page.locator('[role="dialog"][aria-label="Waiting panels"]');
      await expect(popover).toBeVisible();
      await page.waitForTimeout(350);
      await page.keyboard.press("ArrowDown");
      await page.waitForTimeout(150);
      return snap(page.locator("body"), `waiting-keyboard-${theme}.png`);
    })
  );

  for (const [what, fixture, pill, dialog] of [
    ["background", "busy", /^Background/, "Backgrounded panels"],
    ["errors", "busy", /^Errors/, "Errored terminals"],
    ["trash", "busy", /^Trash/, "Recently closed terminals"],
  ] as const) {
    written.push(
      await withPage(context, `${what} open`, async (page) => {
        await load(page, fixture, theme);
        const popover = await openPill(page, pill, dialog);
        await popover.locator("button").first().hover();
        await page.waitForTimeout(250);
        return snap(page.locator("body"), `${what}-open-${theme}.png`);
      })
    );
  }

  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(written.length);
  expect(onDisk.length).toBe(THEMES.length * 3 + 7);
  console.log(`[dock-family-shots] ${onDisk.length} PNGs in ${OUT_DIR}`);
});
