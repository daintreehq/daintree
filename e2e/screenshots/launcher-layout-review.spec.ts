/**
 * Launcher layout visual-review harness.
 *
 * Drives `launcher-preview.html`, which mounts the real `DockLaunchButton` against
 * seeded stores — nine launchable agents, four of them pinned, one recently
 * launched, three recipes, the built-in panels. That populated state is what the
 * layout questions are about, and the Electron harness (`launcher-review.spec.ts`)
 * cannot reach it without a fake binary per agent.
 *
 * Besides the PNGs it writes `hover-tracking.json`: a pointer sweep over the rows
 * that records, at each step, whether the highlighted row is the one under the
 * pointer. "The highlight lags my mouse" is a timing complaint, and a still frame
 * cannot show it.
 *
 * Opt-in only: skips itself unless DAINTREE_SHOT_LAUNCHER is set.
 *
 *   DAINTREE_SHOT_LAUNCHER=1 DAINTREE_SHOT_DIR=/abs/out \
 *     npx playwright test --project=screenshots launcher-layout-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_LAUNCHER  required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR       required — an ABSOLUTE output directory outside the repo
 *   DAINTREE_SHOT_THEMES    themes for the browse sweep (default daintree,bondi,namib)
 *
 * Never writes a PNG it has not verified, and counts the files itself at the end.
 */

import { test, expect, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from "fs";
import path from "path";
import {
  startPreviewServer,
  stubViteHmrClient,
  type PreviewServer,
} from "../helpers/previewHarness";

const ENABLED = !!process.env.DAINTREE_SHOT_LAUNCHER;
const OUT_DIR = process.env.DAINTREE_SHOT_DIR ?? "";
const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi,namib")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

test.use({ deviceScaleFactor: 2 });

const SURFACE = '[role="dialog"][aria-label="Launch"]';
const SEARCH_BOX = '[aria-label="Search agents, panels, and recipes"]';
const OPTION = '[role="option"]';

const FREEZE_CSS = `
  ::-webkit-scrollbar { display: none !important; }
  *, *::before, *::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
    caret-color: transparent !important;
  }
`;

let server: PreviewServer | undefined;
const failures: string[] = [];
const expected: string[] = [];

test.beforeAll(async () => {
  if (!ENABLED) return;
  if (!path.isAbsolute(OUT_DIR)) {
    throw new Error("DAINTREE_SHOT_DIR must be an absolute directory outside the repo");
  }
  const repoRoot = realpathSync(process.cwd());
  mkdirSync(OUT_DIR, { recursive: true });
  const outReal = realpathSync(OUT_DIR);
  if (outReal === repoRoot || outReal.startsWith(repoRoot + path.sep)) {
    throw new Error(`DAINTREE_SHOT_DIR must be outside the repo (${OUT_DIR})`);
  }
  for (const file of readdirSync(OUT_DIR)) {
    if (file.endsWith(".png") || file.endsWith(".json")) rmSync(path.join(OUT_DIR, file));
  }
  server = await startPreviewServer();
});

test.afterAll(async () => {
  await server?.close();
});

interface OpenOptions {
  theme?: string;
  placement?: "toolbar" | "dock";
  fixture?: string;
  width?: number;
  height?: number;
}

async function openLauncher(page: Page, opts: OpenOptions = {}): Promise<void> {
  const { theme = "daintree", placement = "toolbar", fixture = "populated" } = opts;
  await page.setViewportSize({ width: opts.width ?? 1440, height: opts.height ?? 1000 });
  const url = `${server!.baseURL}/launcher-preview.html?theme=${theme}&placement=${placement}&fixture=${fixture}`;
  await page.goto(url, { waitUntil: "load" });
  await page.addStyleTag({ content: FREEZE_CSS });
  const trigger =
    placement === "toolbar"
      ? page.locator('[data-preview-toolbar] button[aria-label^="Launcher"]')
      : page.locator('[data-preview-dock] button[aria-label="Open launcher"]');
  await trigger.waitFor({ state: "visible", timeout: 20_000 });
  await trigger.click();
  await page.locator(SEARCH_BOX).waitFor({ state: "visible", timeout: 8000 });
  await expect.poll(() => page.locator(OPTION).count(), { timeout: 8000 }).toBeGreaterThan(1);
  await settle(page);
}

async function settle(page: Page, ms = 250): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
  );
  await page.waitForTimeout(ms);
}

/** The popover plus a margin, so its edge and shadow are part of the picture. */
async function snapSurface(page: Page, file: string, pad = 24): Promise<void> {
  expected.push(file);
  await settle(page, 150);
  const box = await page.locator(SURFACE).boundingBox();
  if (!box || box.width < 40 || box.height < 40) {
    throw new Error(`${file}: launcher has no real box (${JSON.stringify(box)})`);
  }
  const viewport = page.viewportSize()!;
  const x = Math.max(0, box.x - pad);
  const y = Math.max(0, box.y - pad);
  const out = path.join(OUT_DIR, file);
  await page.screenshot({
    path: out,
    clip: {
      x,
      y,
      width: Math.min(box.width + pad * 2, viewport.width - x),
      height: Math.min(box.height + pad * 2, viewport.height - y),
    },
  });
  if (!existsSync(out)) throw new Error(`${file}: screenshot did not land`);
}

async function step(name: string, page: Page, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    failures.push(`${name}: ${String(error).split("\n")[0]}`);
  }
  void page;
}

async function center(page: Page, selector: string, nth: number) {
  const box = await page.locator(selector).nth(nth).boundingBox();
  if (!box) throw new Error(`no box for ${selector} #${nth}`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/**
 * Sweep the pointer down the list at a brisk but ordinary speed, sampling after
 * each move whether the highlighted row is the row under the pointer. Records
 * how many samples lagged, and how long after the pointer stops the highlight
 * catches up.
 */
async function measureHoverTracking(page: Page) {
  const first = await center(page, OPTION, 0);
  const count = await page.locator(OPTION).count();
  const last = await center(page, OPTION, Math.min(count - 1, 12));
  await page.mouse.move(first.x, first.y - 40);
  await settle(page, 100);

  const sample = () =>
    page.evaluate(
      ([x, y]) => {
        const under = document.elementFromPoint(x, y)?.closest('[role="option"]');
        const selected = document.querySelector('[role="option"][aria-selected="true"]');
        return {
          under: under?.getAttribute("aria-label")?.split(",")[0].split(".")[0] ?? null,
          selected: selected?.getAttribute("aria-label")?.split(",")[0].split(".")[0] ?? null,
        };
      },
      [x0, y0] as [number, number]
    );
  let x0 = first.x;
  let y0 = first.y;

  const steps = 24;
  const samples: Array<{ under: string | null; selected: string | null }> = [];
  for (let i = 0; i <= steps; i++) {
    x0 = first.x;
    y0 = first.y + ((last.y - first.y) * i) / steps;
    await page.mouse.move(x0, y0);
    // One frame between moves — roughly a 60Hz pointer.
    await page.waitForTimeout(16);
    samples.push(await sample());
  }
  const lagged = samples.filter((s) => s.under !== null && s.under !== s.selected).length;

  const stoppedAt = Date.now();
  let catchUpMs: number | null = null;
  for (let i = 0; i < 40; i++) {
    const s = await sample();
    if (s.under !== null && s.under === s.selected) {
      catchUpMs = Date.now() - stoppedAt;
      break;
    }
    await page.waitForTimeout(10);
  }
  return { steps: samples.length, lagged, catchUpMs, samples };
}

test("launcher layout review", async ({ page }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_LAUNCHER is required for the launcher layout capture",
  });
  test.skip(!ENABLED, "Set DAINTREE_SHOT_LAUNCHER to run the launcher layout capture");
  test.setTimeout(240_000);
  await stubViteHmrClient(page);
  page.on("pageerror", (err) => failures.push(`pageerror: ${err.message.split("\n")[0]}`));

  // Warm the optimizer so its first-load reload cannot land mid-capture.
  await page.goto(`${server!.baseURL}/launcher-preview.html`, { waitUntil: "load" });
  await page.waitForTimeout(3000);

  for (const theme of THEMES) {
    await step(`browse-${theme}`, page, async () => {
      await openLauncher(page, { theme });
      await snapSurface(page, `01-browse-${theme}.png`);
    });
  }

  await step("browse-short", page, async () => {
    await openLauncher(page, { height: 720 });
    await snapSurface(page, "02-browse-short-window.png");
  });

  await step("search-mixed", page, async () => {
    await openLauncher(page);
    await page.locator(SEARCH_BOX).fill("re");
    await expect.poll(() => page.locator(OPTION).count(), { timeout: 5000 }).toBeGreaterThan(2);
    await snapSurface(page, "03-search-mixed.png");
  });

  await step("search-narrow", page, async () => {
    await openLauncher(page);
    await page.locator(SEARCH_BOX).fill("co");
    await expect.poll(() => page.locator(OPTION).count(), { timeout: 5000 }).toBeGreaterThan(0);
    await snapSurface(page, "04-search-narrow.png");
  });

  await step("presets", page, async () => {
    await openLauncher(page);
    const claude = page.locator(`${OPTION}[aria-label^="Claude"]`).first();
    const index = await page
      .locator(OPTION)
      .evaluateAll(
        (els) => els.findIndex((el) => el.getAttribute("aria-label")?.startsWith("Claude")),
        undefined
      );
    await claude.waitFor({ state: "attached" });
    for (let i = 0; i < index; i++) await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowRight");
    await expect
      .poll(() => page.locator(`${OPTION}[data-row-kind="preset"]`).count(), { timeout: 5000 })
      .toBeGreaterThan(1);
    await snapSurface(page, "05-presets-expanded.png");
  });

  await step("keyboard", page, async () => {
    await openLauncher(page);
    for (let i = 0; i < 7; i++) await page.keyboard.press("ArrowDown");
    await snapSurface(page, "06-keyboard-selection.png");
  });

  await step("pointer", page, async () => {
    await openLauncher(page);
    const p = await center(page, OPTION, 5);
    await page.mouse.move(p.x, p.y - 30);
    await page.mouse.move(p.x, p.y, { steps: 4 });
    await settle(page, 200);
    await snapSurface(page, "07-pointer-hover.png");
  });

  await step("capture", page, async () => {
    await openLauncher(page);
    const edit = page.locator('[data-testid^="launcher-shortcut-edit-"]').first();
    await edit.waitFor({ state: "attached", timeout: 5000 });
    await edit.dispatchEvent("click");
    await expect(page.locator('[data-testid^="launcher-capture-"]')).toBeVisible();
    await snapSurface(page, "08-shortcut-capture.png");
  });

  await step("empty", page, async () => {
    await openLauncher(page);
    await page.locator(SEARCH_BOX).fill("zzzzqqqq");
    await settle(page);
    await snapSurface(page, "09-empty.png");
  });

  await step("dock", page, async () => {
    await openLauncher(page, { placement: "dock" });
    await snapSurface(page, "10-dock-placement.png");
  });

  await step("narrow", page, async () => {
    await openLauncher(page, { width: 520, height: 900 });
    await snapSurface(page, "11-narrow-window.png", 8);
  });

  await step("few", page, async () => {
    await openLauncher(page, { fixture: "few" });
    await snapSurface(page, "12-few-agents.png");
  });

  // Every launchable agent installed: the agent column is the long one, and
  // the popover's height budget decides whether it scrolls.
  for (const height of [1000, 800]) {
    await step(`all-agents-${height}`, page, async () => {
      await openLauncher(page, { fixture: "all", height });
      await snapSurface(page, `15-all-agents-${height}.png`);
    });
  }

  // Fifteen plugin panels: the panel list is the long one this time.
  await step("plugins", page, async () => {
    await openLauncher(page, { fixture: "plugins" });
    await snapSurface(page, "16-plugin-panels.png");
  });

  // The dock opens the same launcher upward; its inventories must lay out
  // the same way the toolbar's do.
  for (const fixture of ["all", "plugins"] as const) {
    await step(`dock-${fixture}`, page, async () => {
      await openLauncher(page, { placement: "dock", fixture });
      await snapSurface(page, `17-dock-${fixture}.png`);
    });
  }

  await step("all-agents-narrow", page, async () => {
    await openLauncher(page, { fixture: "all", width: 520, height: 900 });
    await snapSurface(page, "15-all-agents-narrow.png", 8);
  });

  await step("all-agents-short", page, async () => {
    await openLauncher(page, { fixture: "all", height: 620 });
    await snapSurface(page, "15-all-agents-620.png");
  });

  await step("setup", page, async () => {
    await openLauncher(page, { fixture: "setup" });
    await snapSurface(page, "13-needs-setup.png");
  });

  await step("forced-colors", page, async () => {
    await page.emulateMedia({ forcedColors: "active" });
    await openLauncher(page);
    await snapSurface(page, "14-forced-colors.png");
    await page.emulateMedia({ forcedColors: "none" });
  });

  await step("hover-tracking", page, async () => {
    await openLauncher(page);
    const result = await measureHoverTracking(page);
    writeFileSync(path.join(OUT_DIR, "hover-tracking.json"), JSON.stringify(result, null, 2));
  });

  const present = new Set(readdirSync(OUT_DIR));
  const missing = expected.filter((f) => !present.has(f));
  expect(failures, "launcher capture steps failed").toEqual([]);
  expect(missing, `launcher captures missing from ${OUT_DIR}`).toEqual([]);
  expect(present.has("hover-tracking.json"), "hover-tracking.json missing").toBe(true);
});
