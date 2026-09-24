/**
 * Type-anywhere locator pill visual-review harness (#11134).
 *
 * The pill lives for about a second after a keystroke lands somewhere the user
 * cannot see. This drives `typing-locator-preview.html` instead: the real
 * `TypingLocator`, mounted where `App.tsx` mounts it, over a grid of real xterms
 * full of bright build output, fed through the store the product writes.
 *
 * Opt-in only:
 *
 *   DAINTREE_SHOT_TYPING_LOCATOR=1 DAINTREE_SHOT_DIR=/abs/out \
 *     npx playwright test --project=screenshots typing-locator-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_TYPING_LOCATOR  required — enables the capture
 *   DAINTREE_SHOT_DIR             required — absolute output dir. No default: an
 *                                 in-repo fallback would put PNGs into someone's tree.
 *   DAINTREE_SHOT_THEMES          theme sweep (default daintree,bondi,namib)
 *   DAINTREE_SCREENSHOT_SCALE     device scale factor (default 2)
 *
 * Settled states are held by swallowing the component's dwell timers; the
 * `*-mid` states run with motion live, part-way through the entry and the exit.
 */

import { test, expect, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readdirSync, rmSync } from "fs";
import path from "path";
import { startPreviewServer, stubViteHmrClient } from "../helpers/previewHarness";

const ENABLED = !!process.env.DAINTREE_SHOT_TYPING_LOCATOR;
const OUT_DIR = process.env.DAINTREE_SHOT_DIR ?? "";
const SCALE = Number(process.env.DAINTREE_SCREENSHOT_SCALE ?? "2");

const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi,namib")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

/** A distinctive fragment of each fixture in the preview entry, which runs under Vite aliases this loader lacks. */
const LABELS: Record<string, string> = {
  locate: "Claude",
  task: "Fix flaky shard rebalance",
  long: "Refactor TerminalResizeController",
  "file-added": "File reference added to",
  refused: "File reference not added",
};

interface LocatorApi {
  show: (id: string) => void;
  clear: () => void;
  hold: (mode: "none" | "all" | "unmount") => void;
  timings: { enter: number; exit: number; dwell: number };
}
type HarnessWindow = Window & { __typingLocator: LocatorApi };

const STRETCH_MS = 1500;
const STRETCH_CSS = `[data-locator-host] * {
  transition-duration: ${STRETCH_MS}ms !important;
  animation-duration: ${STRETCH_MS}ms !important;
}`;

/** Pane kept around the pill in a zoom crop. */
const ZOOM_MARGIN = 56;

let server: Awaited<ReturnType<typeof startPreviewServer>> | undefined;

test.beforeAll(async () => {
  if (!ENABLED) return;
  if (!OUT_DIR || !path.isAbsolute(OUT_DIR)) {
    throw new Error("DAINTREE_SHOT_DIR must be an absolute path");
  }
  if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });
  server = await startPreviewServer();
});

test.afterAll(async () => {
  await server?.close();
});

async function open(page: Page, theme: string, layout: "grid" | "narrow" = "grid") {
  await stubViteHmrClient(page);
  await page.setViewportSize({ width: layout === "narrow" ? 480 : 1260, height: 740 });
  await page.goto(`${server!.baseURL}/typing-locator-preview.html?theme=${theme}&layout=${layout}`);
  await expect(page.locator("[data-preview-shell]")).toBeAttached({ timeout: 30_000 });
  await page.evaluate(() => document.fonts.ready);
  const panes = layout === "narrow" ? 2 : 4;
  // A pill over empty panes says nothing about legibility over real output.
  await expect(page.locator('[data-xterm-host][data-ready="true"]')).toHaveCount(panes, {
    timeout: 15_000,
  });
  await expect(page.locator(".xterm-rows").first()).toContainText(/tests/);
  await page.waitForTimeout(200);
}

function pill(page: Page, fixture: string) {
  // The pill itself, holding the fixture that was asked for.
  return page.locator("[data-locator-host] [data-typing-locator]", { hasText: LABELS[fixture] });
}

type Hold = "none" | "all" | "unmount";

async function show(page: Page, fixture: string, hold: Hold) {
  // Clear and show in separate tasks: in one tick React batches them, the pill
  // never unmounts, and a fresh show never gets its `@starting-style` entry.
  await page.evaluate(() => (window as unknown as HarnessWindow).__typingLocator.clear());
  await expect(page.locator("[data-typing-locator]")).toHaveCount(0);
  await page.evaluate(
    ([id, h]) => {
      const api = (window as unknown as HarnessWindow).__typingLocator;
      api.hold(h as Hold);
      api.show(id as string);
    },
    [fixture, hold] as const
  );
}

async function pillBox(page: Page, fixture: string, file: string) {
  const target = pill(page, fixture);
  await expect(target, `${file}: pill not rendered`).toBeAttached();
  const box = await target.boundingBox();
  if (!box || box.width < 40 || box.height < 12) {
    throw new Error(`${file}: pill has no real box (${JSON.stringify(box)}) — refusing to write`);
  }
  return box;
}

async function snapZoom(page: Page, fixture: string, file: string): Promise<string> {
  const box = await pillBox(page, fixture, file);
  const host = (await page.locator("[data-locator-host]").boundingBox())!;
  const x = Math.max(host.x, box.x - ZOOM_MARGIN * 2);
  const y = Math.max(host.y, box.y - ZOOM_MARGIN);
  const right = Math.min(host.x + host.width, box.x + box.width + ZOOM_MARGIN * 2);
  const bottom = Math.min(host.y + host.height, box.y + box.height + ZOOM_MARGIN * 1.5);
  const out = path.join(OUT_DIR, file);
  await page.screenshot({ path: out, clip: { x, y, width: right - x, height: bottom - y } });
  return out;
}

async function snapContext(page: Page, fixture: string, file: string): Promise<string> {
  await pillBox(page, fixture, file);
  const out = path.join(OUT_DIR, file);
  await page.locator("[data-locator-host]").screenshot({ path: out });
  return out;
}

async function settled(page: Page, fixture: string) {
  await show(page, fixture, "all");
  const timings = await page.evaluate(
    () => (window as unknown as HarnessWindow).__typingLocator.timings
  );
  await page.waitForTimeout(timings.enter + 150);
}

test("Typing locator — states and themes", async ({ browser }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_TYPING_LOCATOR is required for the typing locator capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_TYPING_LOCATOR=1 to run the capture");

  const context = await browser.newContext({ deviceScaleFactor: SCALE });
  const page = await context.newPage();
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  const written: string[] = [];

  for (const theme of THEMES) {
    await open(page, theme);

    await settled(page, "locate");
    written.push(await snapContext(page, "locate", `01-locate-context-${theme}.png`));
    written.push(await snapZoom(page, "locate", `01-locate-${theme}.png`));

    await settled(page, "task");
    written.push(await snapZoom(page, "task", `02-task-${theme}.png`));

    await settled(page, "long");
    written.push(await snapContext(page, "long", `03-long-context-${theme}.png`));

    await settled(page, "file-added");
    written.push(await snapZoom(page, "file-added", `04-file-added-${theme}.png`));

    await settled(page, "refused");
    written.push(await snapZoom(page, "refused", `05-refused-${theme}.png`));

    // Motion frames: the transition is stretched to STRETCH_MS so a frame
    // part-way through is photographed deterministically, whatever the
    // screenshot costs.
    const timings = await page.evaluate(
      () => (window as unknown as HarnessWindow).__typingLocator.timings
    );
    const stretch = await page.addStyleTag({ content: STRETCH_CSS });
    await show(page, "locate", "all");
    // Early: the enter easing is a critically damped spring, so by 40% of the
    // way in the pill is already all but settled.
    await page.waitForTimeout(STRETCH_MS * 0.15);
    written.push(await snapZoom(page, "locate", `07-enter-mid-${theme}.png`));
    await show(page, "locate", "unmount");
    await page.waitForTimeout(timings.dwell + STRETCH_MS * 0.4);
    written.push(await snapZoom(page, "locate", `08-exit-mid-${theme}.png`));
    await stretch.evaluate((el) => el.remove());
    await page.evaluate(() => (window as unknown as HarnessWindow).__typingLocator.clear());
    await expect(pill(page, "locate")).toHaveCount(0, { timeout: 3_000 });

    await open(page, theme, "narrow");
    await settled(page, "long");
    written.push(await snapContext(page, "long", `06-narrow-long-${theme}.png`));
  }

  // Degraded surfaces, one theme each.
  await page.emulateMedia({ forcedColors: "active" });
  await open(page, "daintree");
  await settled(page, "locate");
  written.push(await snapZoom(page, "locate", `09-forced-colors-daintree.png`));
  await page.emulateMedia({ forcedColors: "none", contrast: "more" });
  await open(page, "daintree");
  await settled(page, "locate");
  written.push(await snapZoom(page, "locate", `10-contrast-more-daintree.png`));
  await page.emulateMedia({ contrast: "no-preference" });

  await context.close();

  expect(pageErrors, `page errors: ${pageErrors.join(" | ")}`).toEqual([]);
  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(written.length);
  expect(written.length).toBe(THEMES.length * 9 + 2);
  console.log(`[typing-locator-shots] wrote ${written.length} captures to ${OUT_DIR}`);
});
