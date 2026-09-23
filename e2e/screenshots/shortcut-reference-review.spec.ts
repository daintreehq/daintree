/**
 * Keyboard shortcut reference (the ⌘/ cheatsheet) visual-review harness.
 *
 * The cheatsheet is a single dialog, but nearly everything worth judging about it
 * only shows with real data behind it: 137 registered bindings across ~18
 * categories, two-step chords, actions bound twice, and user overrides. So the app
 * is booted with its real registry and a handful of overrides written through the
 * same `keybinding.setOverride` IPC the Settings page uses, then the dialog is
 * opened with its own shortcut and captured in every state that carries design
 * weight:
 *
 *   rest         top of the list, no query
 *   middle       scrolled into the long categories
 *   end          scrolled to the bottom (the tail categories and the footer)
 *   overrides    a query that lands on user-changed and user-cleared bindings
 *   chord        a chord-prefix query ("⌘K"), the two-step chord family
 *   empty        a query with no matches
 *   narrow-rest  the same dialog at the smallest window, zoomed in (≈450 CSS px)
 *   narrow-query a filtered list at that width
 *
 * Each state is captured in every theme listed in DAINTREE_SHOT_THEMES (a dark and a
 * light theme by default), in one launch.
 *
 *   DAINTREE_SHOT_SHORTCUTS=1 DAINTREE_SHOT_DIR=/tmp/shots \
 *     npx playwright test --project=screenshots shortcut-reference-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_SHORTCUTS  required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR        required — output directory (never the repo)
 *   DAINTREE_SHOT_THEMES     comma-separated theme ids (default: daintree,bondi)
 *   DAINTREE_SHOT_ONLY       comma-separated state filter (names above)
 *   DAINTREE_SCREENSHOT_SCALE device scale factor (default 2)
 *
 * The run fails unless every planned PNG exists on disk and each state rendered what
 * it claims to (rows present, or the empty state present), checked after the settle.
 */

import { test, expect, type Page, type ElectronApplication } from "@playwright/test";
import { execSync } from "child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { openAndOnboardProject } from "../helpers/project";
import { dismissBlockingPalette } from "../helpers/overlays";
import { setAppTheme } from "../helpers/theme";

const ENABLED = !!process.env.DAINTREE_SHOT_SHORTCUTS;
const OUTPUT_DIR = process.env.DAINTREE_SHOT_DIR ? path.resolve(process.env.DAINTREE_SHOT_DIR) : "";
const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi").split(",").filter(Boolean);
const ONLY = (process.env.DAINTREE_SHOT_ONLY ?? "").split(",").filter(Boolean);
const SCALE = process.env.DAINTREE_SCREENSHOT_SCALE ?? "2";

const MOD = process.platform === "darwin" ? "Meta" : "Control";
const WIDE = { width: 1680, height: 1050 };
// The window can't go below 800×600 (createWindow's minimum), so a narrow
// layout is reached the way a user reaches it: zooming in. 1.75× at the
// minimum width leaves about 450 CSS px for the page.
const NARROW = { width: 800, height: 600 };
const NARROW_ZOOM = 1.75;

const DIALOG = '[role="dialog"]:has(input[aria-label="Search shortcuts"])';
// AppDialog puts role="dialog" on the full-viewport scrim; the card is its child.
const CARD = `${DIALOG} > div`;
const SEARCH = `${DIALOG} input[aria-label="Search shortcuts"]`;
const ROWS = `${DIALOG} [role="listitem"]`;

/**
 * Overrides seeded through the real IPC before the theme reload, so the renderer
 * boots with them the way a returning user's would. One rebinding, one cleared
 * binding, and one previously-unbound action given a key.
 */
const OVERRIDES: Record<string, string[]> = {
  "terminal.watch": ["Ctrl+Alt+W"],
  "terminal.redraw": [],
  "agent.cursor": ["Cmd+Alt+U"],
};

const POLISH_CSS = `
  ::-webkit-scrollbar { display: none !important; width: 0 !important; height: 0 !important; }
  *, *::before, *::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
    caret-color: transparent !important;
  }
`;

function git(cmd: string, cwd: string): void {
  execSync(`git ${cmd}`, { cwd, stdio: "ignore" });
}

function createFixtureRepo(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "daintree-shortcut-shots-"));
  git("init -b main", dir);
  git('config user.email "test@daintree.dev"', dir);
  git('config user.name "Daintree Test"', dir);
  mkdirSync(path.join(dir, "src"), { recursive: true });
  writeFileSync(path.join(dir, "README.md"), "# Helios Dashboard\n");
  writeFileSync(path.join(dir, "src", "index.ts"), "export const version = 1;\n");
  git("add -A", dir);
  git('commit -m "initial commit"', dir);
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

async function settle(page: Page, ms = 350): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
  );
  await page.waitForTimeout(ms);
}

/** Zoom every renderer; zoom is per-origin and survives reloads, so reset it too. */
async function setZoom(app: ElectronApplication, factor: number): Promise<void> {
  await app.evaluate(({ webContents }, f) => {
    for (const wc of webContents.getAllWebContents()) wc.setZoomFactor(f);
  }, factor);
}

async function setWindowSize(
  app: ElectronApplication,
  size: { width: number; height: number }
): Promise<void> {
  await app.evaluate(({ BrowserWindow }, s) => {
    BrowserWindow.getAllWindows()[0]?.setSize(s.width, s.height);
  }, size);
}

/** Opens with the dialog's own binding (⌘/), falling back to the ⌘K ⌘S chord. */
async function openReference(page: Page): Promise<void> {
  const dialog = page.locator(DIALOG);
  await page.keyboard.press(`${MOD}+/`);
  const opened = await dialog
    .waitFor({ state: "visible", timeout: 3000 })
    .then(() => true)
    .catch(() => false);
  if (!opened) {
    await page.keyboard.press(`${MOD}+K`);
    await settle(page, 150);
    await page.keyboard.press(`${MOD}+S`);
    await dialog.waitFor({ state: "visible", timeout: 5000 });
  }
  // Where focus lands is reported, not asserted: a regression there is a finding
  // for the review, and the rest of the states are still worth capturing.
  await settle(page, 200);
  const searchFocused = await page
    .locator(SEARCH)
    .evaluate((el) => el === document.activeElement)
    .catch(() => false);
  if (!searchFocused) {
    const active = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      return el ? `${el.tagName.toLowerCase()} "${el.getAttribute("aria-label") ?? ""}"` : "none";
    });
    console.warn(`[shortcut-shots] search not focused on open; focus is on ${active}`);
  }
}

async function closeReference(page: Page): Promise<void> {
  await page.keyboard.press("Escape").catch(() => {});
  await page
    .locator(DIALOG)
    .waitFor({ state: "hidden", timeout: 5000 })
    .catch(() => {});
  await settle(page, 150);
}

/** Scroll the dialog body's own scroll box to a fraction of its range. */
async function scrollBody(page: Page, fraction: number): Promise<void> {
  const ok = await page.locator(CARD).evaluate((card, f) => {
    const scroller = Array.from(card.querySelectorAll<HTMLElement>("*")).find((el) => {
      const oy = getComputedStyle(el).overflowY;
      return (oy === "auto" || oy === "scroll") && el.scrollHeight > el.clientHeight + 1;
    });
    if (!scroller) return false;
    scroller.scrollTop = Math.round((scroller.scrollHeight - scroller.clientHeight) * f);
    return true;
  }, fraction);
  if (!ok) throw new Error("the dialog body has no scrollable overflow to scroll");
}

async function search(page: Page, query: string): Promise<void> {
  await page.locator(SEARCH).fill(query);
  await settle(page, 300);
}

type Expectation = "rows" | "empty";

async function verify(page: Page, expectation: Expectation): Promise<void> {
  if (expectation === "rows") {
    const count = await page.locator(ROWS).count();
    if (count === 0) throw new Error("expected shortcut rows, found none");
  } else {
    const count = await page.locator(ROWS).count();
    if (count !== 0) throw new Error(`expected the empty state, found ${count} rows`);
    const text = (await page.locator(CARD).innerText()).toLowerCase();
    if (!text.includes("no shortcuts")) throw new Error("empty state text is missing");
  }
}

const failures: string[] = [];
const written: string[] = [];

async function capture(
  page: Page,
  theme: string,
  name: string,
  expectation: Expectation
): Promise<void> {
  await settle(page, 300);
  await verify(page, expectation);
  const file = `${name}--${theme}.png`;
  await page
    .locator(CARD)
    .first()
    .screenshot({
      path: path.join(OUTPUT_DIR, file),
      type: "png",
      animations: "disabled",
      caret: "hide",
    });
  written.push(file);
}

async function state(name: string, fn: () => Promise<void>, page: Page): Promise<void> {
  if (ONLY.length > 0 && !ONLY.includes(name)) return;
  try {
    await fn();
  } catch (error) {
    const detail = String(error).split("\n")[0];
    console.warn(`[shortcut-shots] state "${name}" FAILED:`, detail);
    failures.push(`${name}: ${detail}`);
  } finally {
    await closeReference(page);
  }
}

test("shortcut reference review — every state, every theme", async () => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_SHORTCUTS is required for the shortcut-reference capture",
  });
  test.skip(!ENABLED, "Set DAINTREE_SHOT_SHORTCUTS to run the shortcut-reference capture");
  if (!OUTPUT_DIR) throw new Error("DAINTREE_SHOT_DIR is required — captures never go in the repo");
  test.setTimeout(10 * 60_000);

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const repo = createFixtureRepo();
  const userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-shortcutshot-"));
  let ctx: AppContext | undefined;

  try {
    ctx = await launchApp({
      userDataDir,
      screenshotScale: SCALE,
      windowSize: WIDE,
      extraArgs: ["--disable-gpu", "--in-process-gpu", "--disable-breakpad", "--noerrdialogs"],
    });
    const app = ctx.app;
    await setWindowSize(app, WIDE);
    const page = await openAndOnboardProject(app, ctx.window, repo.dir, "Helios Dashboard");

    await page.evaluate(async (overrides) => {
      for (const [actionId, combos] of Object.entries(overrides)) {
        await window.electron.keybinding.setOverride(actionId as never, combos);
      }
    }, OVERRIDES);

    for (const theme of THEMES) {
      await setWindowSize(app, WIDE);
      await setZoom(app, 1);
      // setAppTheme reloads the renderer, which is also what loads the overrides.
      await setAppTheme(page, theme);
      await page.addStyleTag({ content: POLISH_CSS });
      await dismissBlockingPalette(page);
      await settle(page, 800);

      await state(
        "rest",
        async () => {
          await openReference(page);
          await capture(page, theme, "01-rest", "rows");
        },
        page
      );

      await state(
        "middle",
        async () => {
          await openReference(page);
          await scrollBody(page, 0.45);
          await capture(page, theme, "02-middle", "rows");
        },
        page
      );

      await state(
        "end",
        async () => {
          await openReference(page);
          await scrollBody(page, 1);
          await capture(page, theme, "03-end", "rows");
        },
        page
      );

      await state(
        "overrides",
        async () => {
          await openReference(page);
          await search(page, "focused terminal");
          await capture(page, theme, "04-overrides", "rows");
        },
        page
      );

      await state(
        "chord",
        async () => {
          await openReference(page);
          await search(page, "⌘K");
          await capture(page, theme, "05-chord", "rows");
        },
        page
      );

      await state(
        "empty",
        async () => {
          await openReference(page);
          await search(page, "zzqx flux");
          await capture(page, theme, "06-empty", "empty");
        },
        page
      );

      await setWindowSize(app, NARROW);
      await setZoom(app, NARROW_ZOOM);
      await settle(page, 600);
      const cssWidth = await page.evaluate(() => window.innerWidth);
      if (cssWidth > 520) failures.push(`narrow: page is ${cssWidth} CSS px wide, expected ≤ 520`);

      await state(
        "narrow-rest",
        async () => {
          await openReference(page);
          await capture(page, theme, "07-narrow-rest", "rows");
        },
        page
      );

      await state(
        "narrow-query",
        async () => {
          await openReference(page);
          await search(page, "agent");
          await capture(page, theme, "08-narrow-query", "rows");
        },
        page
      );
    }

    const onDisk = new Set(readdirSync(OUTPUT_DIR).filter((f) => f.endsWith(".png")));
    const missing = written.filter((f) => !onDisk.has(f));
    expect(missing, "captures reported written but missing on disk").toEqual([]);
    expect(failures, "shortcut reference capture states failed").toEqual([]);
    if (ONLY.length === 0) expect(written.length).toBe(THEMES.length * 8);
  } finally {
    if (ctx?.app) await closeApp(ctx.app);
    repo.cleanup();
    if (existsSync(userDataDir)) rmSync(userDataDir, { recursive: true, force: true });
  }
});
