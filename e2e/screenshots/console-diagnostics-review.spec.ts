/**
 * Console drawer and diagnostics dock visual-review harness.
 *
 * The dev preview's output drawer and the app's diagnostics dock are one idea
 * built twice — a bottom drawer with tabs, an error count and toolbar buttons —
 * so they are captured together and judged against each other. This drives the
 * preview entry (`console-diagnostics-preview.html`), which mounts the real
 * `ConsoleDrawer` and the real `DiagnosticsDock` against the real stores, then
 * performs focus and hover with real keys and a real pointer.
 *
 * Opt-in only: skips itself unless DAINTREE_SHOT_TWINS is set.
 *
 *   DAINTREE_SHOT_TWINS=1 DAINTREE_SHOT_DIR=/abs/out \
 *     npx playwright test --project=screenshots console-diagnostics-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_TWINS    required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR      required — an ABSOLUTE output directory outside the repo
 *   DAINTREE_SHOT_THEMES   themes to sweep (default daintree,svalbard)
 */

import { test, expect, type Locator, type Page } from "@playwright/test";
import { mkdirSync, readdirSync, realpathSync, rmSync } from "fs";
import path from "path";
import { BUILT_IN_THEME_SOURCES } from "@shared/theme/builtInThemeSources";
import {
  makeSnap,
  startPreviewServer,
  stubViteHmrClient,
  type PreviewServer,
} from "../helpers/previewHarness";

const ENABLED = !!process.env.DAINTREE_SHOT_TWINS;
const OUT_DIR = process.env.DAINTREE_SHOT_DIR ?? "";
const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,svalbard")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);
const ALL_THEMES = BUILT_IN_THEME_SOURCES.map((t) => t.id);

test.use({ deviceScaleFactor: 2 });

const FREEZE_CSS = `
  ::-webkit-scrollbar { display: none !important; }
  *, *::before, *::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
  }
`;

const drawer = (p: Page) => p.locator('[data-scene="drawer"]');
const dock = (p: Page) => p.locator('[data-scene="dock"]');
const drawerTab = (p: Page, name: RegExp) =>
  drawer(p).getByRole("tablist").getByRole("tab", { name });
const dockTab = (p: Page, name: RegExp) => dock(p).getByRole("tablist").getByRole("tab", { name });

/** Tab forward until `target` holds focus, so `:focus-visible` is the keyboard's. */
async function tabTo(page: Page, target: Locator): Promise<void> {
  await expect(target).toBeVisible();
  for (let i = 0; i < 60 && !(await target.evaluate((el) => el === document.activeElement)); i++) {
    await page.keyboard.press("Tab");
  }
  await expect(target).toBeFocused();
}

interface Shot {
  name: string;
  query: string;
  /** What must be on screen before the PNG is written. */
  ready: (p: Page) => Locator;
  /** The element photographed. */
  frame: (p: Page) => Locator;
  drive?: (p: Page) => Promise<void>;
}

const consoleReady = (p: Page) => drawer(p).getByText("Failed to load orders:").first();

const SHOTS: Shot[] = [
  {
    name: "twins-rest",
    query: "scene=twins&tab=console&dockTab=problems",
    ready: consoleReady,
    frame: (p) => p.locator("#root > div"),
  },
  {
    name: "drawer-console",
    query: "scene=drawer&tab=console",
    ready: consoleReady,
    frame: drawer,
  },
  {
    name: "drawer-console-narrow",
    query: "scene=drawer&tab=console&width=460",
    ready: consoleReady,
    frame: drawer,
  },
  {
    name: "drawer-tab-focus",
    query: "scene=drawer&tab=console",
    ready: consoleReady,
    frame: drawer,
    drive: (p) => tabTo(p, drawerTab(p, /^Console/)),
  },
  {
    name: "drawer-tab-hover",
    query: "scene=drawer&tab=console",
    ready: consoleReady,
    frame: drawer,
    drive: (p) => drawerTab(p, /^Diagnostics/).hover(),
  },
  {
    name: "drawer-filter-errors-focus",
    query: "scene=drawer&tab=console",
    ready: consoleReady,
    frame: drawer,
    drive: async (p) => {
      // Either spelling of the level filter: pressed buttons before, radios after.
      const errors = drawer(p)
        .locator('[role="radio"], [aria-pressed]')
        .filter({ hasText: /^Errors/ })
        .first();
      await errors.click();
      await p.mouse.move(0, 0);
      await p.keyboard.press("Shift+Tab");
      await p.keyboard.press("Tab");
      await expect(errors).toBeFocused();
    },
  },
  {
    name: "drawer-toolbar-hover",
    query: "scene=drawer&tab=console",
    ready: consoleReady,
    frame: drawer,
    drive: (p) =>
      drawer(p)
        .getByRole("button", { name: /^Restart dev server/ })
        .hover(),
  },
  {
    name: "drawer-toolbar-focus",
    query: "scene=drawer&tab=console",
    ready: consoleReady,
    frame: drawer,
    drive: (p) => tabTo(p, drawer(p).getByRole("button", { name: /^Restart dev server/ })),
  },
  {
    name: "drawer-toggle-focus",
    query: "scene=drawer&tab=console",
    ready: consoleReady,
    frame: drawer,
    drive: (p) => tabTo(p, drawer(p).getByRole("button", { name: /output drawer/i })),
  },
  {
    name: "drawer-restarting",
    query: "scene=drawer&tab=console&restarting=1",
    ready: consoleReady,
    frame: drawer,
  },
  {
    name: "drawer-closed",
    query: "scene=drawer&open=0",
    ready: (p) => drawer(p).getByText("Output drawer"),
    frame: drawer,
  },
  {
    name: "drawer-diagnostics",
    query: "scene=drawer&tab=diagnostics",
    ready: (p) => drawer(p).getByText("Proxy port"),
    frame: drawer,
  },
  {
    name: "drawer-diagnostics-failed",
    query: "scene=drawer&tab=diagnostics&diag=failed",
    ready: (p) => drawer(p).getByText(/Couldn.t load diagnostics/),
    frame: drawer,
  },
  {
    name: "dock-problems",
    query: "scene=dock&dockTab=problems",
    ready: (p) =>
      dock(p)
        .getByText(/git fetch failed/)
        .first(),
    frame: dock,
  },
  {
    name: "dock-logs",
    query: "scene=dock&dockTab=logs",
    ready: (p) =>
      dock(p)
        .getByText(/Previous session/)
        .first(),
    frame: dock,
  },
  {
    name: "dock-tab-focus",
    query: "scene=dock&dockTab=problems",
    ready: (p) =>
      dock(p)
        .getByText(/git fetch failed/)
        .first(),
    frame: dock,
    drive: (p) => tabTo(p, dockTab(p, /^Problems/)),
  },
  {
    name: "dock-close-hover",
    query: "scene=dock&dockTab=problems",
    ready: (p) =>
      dock(p)
        .getByText(/git fetch failed/)
        .first(),
    frame: dock,
    drive: (p) =>
      dock(p)
        .getByRole("button", { name: /close diagnostics/i })
        .hover(),
  },
];

let server: PreviewServer | undefined;

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
    if (file.endsWith(".png")) rmSync(path.join(OUT_DIR, file), { force: true });
  }
  server = await startPreviewServer();
});

test.afterAll(async () => {
  await server?.close();
});

async function open(page: Page, shot: Shot, theme: string): Promise<Locator> {
  await page.setViewportSize({ width: 1000, height: 1200 });
  await stubViteHmrClient(page);
  await page.mouse.move(0, 0);
  page.removeAllListeners("pageerror");
  page.on("pageerror", (error) => console.warn(`[twins-shots] pageerror: ${error.message}`));
  const url = `${server!.baseURL}/console-diagnostics-preview.html?theme=${theme}&${shot.query}`;
  try {
    await page.goto(url);
    await expect(shot.ready(page)).toBeVisible({ timeout: 30_000 });
  } catch {
    await page.goto("about:blank");
    await page.goto(url, { waitUntil: "load" });
    await expect(shot.ready(page)).toBeVisible({ timeout: 30_000 });
  }
  // Styled, not raw HTML: an unstyled tab has no padding at all. Located by
  // attribute, not role, because a collapsed drawer hides its strip from the tree.
  await expect(page.locator('[role="tab"]').first()).not.toHaveCSS("padding-left", "0px");
  await page.addStyleTag({ content: FREEZE_CSS });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(150);
  return shot.frame(page);
}

test("Console drawer and diagnostics dock", async ({ page }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_TWINS is required for the drawer twins capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_TWINS=1 to run the capture");
  test.setTimeout(15 * 60_000);

  const unknown = THEMES.filter((theme) => !ALL_THEMES.includes(theme));
  if (unknown.length > 0) {
    throw new Error(`Unknown theme(s) in DAINTREE_SHOT_THEMES: ${unknown.join(", ")}`);
  }

  const snap = makeSnap(OUT_DIR);
  const written: string[] = [];

  for (const theme of THEMES) {
    for (const shot of SHOTS) {
      const frame = await open(page, shot, theme);
      if (shot.drive) {
        await shot.drive(page);
        await page.waitForTimeout(150);
      }
      await expect(shot.ready(page)).toBeVisible();
      written.push(await snap(frame, `${shot.name}--${theme}.png`));
    }
  }

  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(written.length);
  expect(onDisk.length).toBe(THEMES.length * SHOTS.length);
  console.log(`[twins-shots] ${onDisk.length} PNGs in ${OUT_DIR}`);
});
