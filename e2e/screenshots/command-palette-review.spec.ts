/**
 * Command palette (⌘⇧P) visual-review harness.
 *
 * The palette is one dialog with a lot of states, and most of what is worth
 * judging only shows with history behind it: the Favorites and Recently used
 * bands, a pinned row, a row that offers hide, an unavailable action with its
 * reason, a destructive action with its consequence line. So the app boots with
 * its real action registry, a few actions are run and pinned through the palette
 * itself — the same path a user takes — and then every state that carries design
 * weight is captured:
 *
 *   first-open      the very first opening, with the one-time prefix hint row
 *                   (first theme only: the hint retires after one showing)
 *   rest            the browse rail: Favorites, Recently used, then categories
 *   recent          the cursor on a Recently used row (pin + hide offered)
 *   browse          scrolled into the category inventory
 *   search          a query with title and description matches
 *   unavailable     a query landing on an unavailable action, selected
 *   danger          a query landing on a destructive action, selected
 *   no-match        a query with no matches
 *   path            a path-like query that hands off to the project switcher
 *   commands        the `>` commands scope, with a query
 *   narrow          the rail at the smallest window, zoomed in (≈450 CSS px)
 *
 *   DAINTREE_SHOT_COMMAND_PALETTE=1 DAINTREE_SHOT_DIR=/tmp/shots \
 *     npx playwright test --project=screenshots command-palette-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_COMMAND_PALETTE  required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR              required — output directory (never the repo)
 *   DAINTREE_SHOT_THEMES           comma-separated theme ids (default: daintree,bondi)
 *   DAINTREE_SHOT_ONLY             comma-separated state filter (names above)
 *   DAINTREE_SCREENSHOT_SCALE      device scale factor (default 2)
 *
 * The run fails unless every planned PNG exists on disk and each state rendered
 * what it claims to, checked after the settle.
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
import { SEL } from "../helpers/selectors";

const ENABLED = !!process.env.DAINTREE_SHOT_COMMAND_PALETTE;
const OUTPUT_DIR = process.env.DAINTREE_SHOT_DIR ? path.resolve(process.env.DAINTREE_SHOT_DIR) : "";
const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi").split(",").filter(Boolean);
const ONLY = (process.env.DAINTREE_SHOT_ONLY ?? "").split(",").filter(Boolean);
const SCALE = process.env.DAINTREE_SCREENSHOT_SCALE ?? "2";

const MOD = process.platform === "darwin" ? "Meta" : "Control";
const WIDE = { width: 1680, height: 1050 };
const NARROW = { width: 800, height: 600 };
const NARROW_ZOOM = 1.75;

const DIALOG = SEL.actionPalette.dialog;
const SEARCH = SEL.actionPalette.searchInput;
const ROWS = `${DIALOG} [role="option"][id^="action-option-"]`;

// Run through the palette so they land in Recently used the way a user's do.
// Each is harmless and run an even number of times where it toggles state.
const SEED_RUNS = ["Toggle sidebar", "Toggle sidebar", "Toggle focus mode", "Toggle focus mode"];
// Pinned with Alt+P from a search row, so Favorites holds real rows.
const SEED_PINS = ["Open settings", "New terminal"];

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
  const dir = mkdtempSync(path.join(tmpdir(), "daintree-cmdpalette-shots-"));
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

async function openPalette(page: Page): Promise<void> {
  await page.keyboard.press(`${MOD}+Shift+P`);
  await page.locator(DIALOG).waitFor({ state: "visible", timeout: 5000 });
  await settle(page, 200);
  const focused = await page
    .locator(SEARCH)
    .evaluate((el) => el === document.activeElement)
    .catch(() => false);
  if (!focused) console.warn("[cmdpalette-shots] search not focused on open");
}

async function closePalette(page: Page): Promise<void> {
  for (let i = 0; i < 3; i++) {
    if (!(await page.locator(DIALOG).count())) break;
    await page.keyboard.press("Escape").catch(() => {});
    await settle(page, 150);
  }
  await page
    .locator(DIALOG)
    .waitFor({ state: "hidden", timeout: 5000 })
    .catch(() => {});
}

async function search(page: Page, query: string): Promise<void> {
  await page.locator(SEARCH).fill(query);
  await settle(page, 450);
}

/** Waits for a named row to rank first, so Enter / Alt+P act on the right one. */
async function expectFirst(page: Page, title: string): Promise<void> {
  await expect(page.locator(ROWS).first()).toContainText(title, { timeout: 5000 });
}

async function runAction(page: Page, title: string): Promise<void> {
  await openPalette(page);
  await search(page, title);
  await expectFirst(page, title);
  await page.keyboard.press("Enter");
  await settle(page, 400);
  await closePalette(page);
}

async function pinAction(page: Page, title: string): Promise<void> {
  await openPalette(page);
  await search(page, title);
  await expectFirst(page, title);
  await page.keyboard.press("Alt+P");
  await settle(page, 200);
  await closePalette(page);
}

/** Moves the cursor down until the selected row has the given section above it. */
async function selectFirstRowOfSection(page: Page, label: string): Promise<void> {
  for (let i = 0; i < 20; i++) {
    const section = await page.evaluate((dialog) => {
      const selected = document.querySelector(`${dialog} [role="option"][aria-selected="true"]`);
      let el = selected?.parentElement?.previousElementSibling ?? null;
      while (el && !el.getAttribute("aria-disabled")) el = el.previousElementSibling;
      return el?.textContent ?? null;
    }, DIALOG);
    if (section === label) return;
    await page.keyboard.press("ArrowDown");
    await settle(page, 60);
  }
  throw new Error(`never reached a row under "${label}"`);
}

async function scrollBody(page: Page, fraction: number): Promise<void> {
  const ok = await page.locator(DIALOG).evaluate((root, f) => {
    const scroller = Array.from(root.querySelectorAll<HTMLElement>("*")).find((el) => {
      const oy = getComputedStyle(el).overflowY;
      return (oy === "auto" || oy === "scroll") && el.scrollHeight > el.clientHeight + 1;
    });
    if (!scroller) return false;
    scroller.scrollTop = Math.round((scroller.scrollHeight - scroller.clientHeight) * f);
    return true;
  }, fraction);
  if (!ok) throw new Error("the palette body has no scrollable overflow to scroll");
}

type Expectation = { rows: true; text?: string[] } | { rows: false; text: string[] };

async function verify(page: Page, expectation: Expectation): Promise<void> {
  const count = await page.locator(ROWS).count();
  if (expectation.rows && count === 0) throw new Error("expected action rows, found none");
  if (!expectation.rows && count !== 0) throw new Error(`expected no rows, found ${count}`);
  const text = (await page.locator(DIALOG).innerText()).toLowerCase();
  for (const needle of expectation.text ?? []) {
    if (!text.includes(needle.toLowerCase())) throw new Error(`"${needle}" is not rendered`);
  }
}

const failures: string[] = [];
const written: string[] = [];
let planned = 0;
let zoomed = false;
let electronApp: ElectronApplication | undefined;

/** The palette box plus a margin, so its edge, shadow and the scrim behind it show. */
async function capture(page: Page, theme: string, name: string, expectation: Expectation) {
  await settle(page, 300);
  await verify(page, expectation);
  const file = `${name}--${theme}.png`;
  const out = path.join(OUTPUT_DIR, file);
  if (zoomed && electronApp) {
    const url = page.url();
    const png = await electronApp.evaluate(async ({ webContents }, target) => {
      const wc = webContents.getAllWebContents().find((c) => c.getURL() === target);
      if (!wc) throw new Error(`no renderer at ${target}`);
      return (await wc.capturePage()).toPNG().toString("base64");
    }, url);
    writeFileSync(out, Buffer.from(png, "base64"));
  } else {
    const box = await page.locator(SEARCH).evaluate((input) => {
      let el: HTMLElement | null = input as HTMLElement;
      // Climb to the palette card: the nearest bordered ancestor tall enough to
      // hold the list, which skips the bordered search field and header band.
      while (
        el &&
        (getComputedStyle(el).borderTopWidth === "0px" || el.getBoundingClientRect().height < 160)
      )
        el = el.parentElement;
      const r = (el ?? input).getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    });
    const pad = 32;
    const viewport = page.viewportSize() ?? WIDE;
    const x = Math.max(0, box.x - pad);
    const y = Math.max(0, box.y - pad);
    await page.screenshot({
      path: out,
      type: "png",
      animations: "disabled",
      caret: "hide",
      clip: {
        x,
        y,
        width: Math.min(box.width + pad * 2, viewport.width - x),
        height: Math.min(box.height + pad * 2, viewport.height - y),
      },
    });
  }
  written.push(file);
}

async function state(name: string, page: Page, fn: () => Promise<void>): Promise<void> {
  if (ONLY.length > 0 && !ONLY.includes(name)) return;
  planned++;
  try {
    await fn();
  } catch (error) {
    const detail = String(error).split("\n")[0];
    console.warn(`[cmdpalette-shots] state "${name}" FAILED:`, detail);
    failures.push(`${name}: ${detail}`);
  } finally {
    await closePalette(page);
  }
}

test("command palette review — every state, every theme", async () => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_COMMAND_PALETTE is required for the command-palette capture",
  });
  test.skip(!ENABLED, "Set DAINTREE_SHOT_COMMAND_PALETTE to run the command-palette capture");
  if (!OUTPUT_DIR) throw new Error("DAINTREE_SHOT_DIR is required — captures never go in the repo");
  test.setTimeout(10 * 60_000);

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const repo = createFixtureRepo();
  const userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-cmdpaletteshot-"));
  let ctx: AppContext | undefined;

  try {
    ctx = await launchApp({
      userDataDir,
      screenshotScale: SCALE,
      windowSize: WIDE,
      extraArgs: ["--disable-gpu", "--in-process-gpu", "--disable-breakpad", "--noerrdialogs"],
    });
    const app = ctx.app;
    electronApp = app;
    await setWindowSize(app, WIDE);
    const page = await openAndOnboardProject(app, ctx.window, repo.dir, "Helios Dashboard");

    for (const [i, theme] of THEMES.entries()) {
      await setWindowSize(app, WIDE);
      await setZoom(app, 1);
      zoomed = false;
      await setAppTheme(page, theme);
      await page.addStyleTag({ content: POLISH_CSS });
      await dismissBlockingPalette(page);
      await settle(page, 800);

      if (i === 0) {
        await state("first-open", page, async () => {
          await openPalette(page);
          await capture(page, theme, "00-first-open", { rows: true, text: ["Type"] });
        });
        for (const title of SEED_RUNS) await runAction(page, title);
        for (const title of SEED_PINS) await pinAction(page, title);
      }

      await state("rest", page, async () => {
        await openPalette(page);
        await capture(page, theme, "01-rest", { rows: true, text: ["Favorites", "Recently used"] });
      });

      await state("recent", page, async () => {
        await openPalette(page);
        await selectFirstRowOfSection(page, "Recently used");
        await capture(page, theme, "02-recent-selected", { rows: true, text: ["hide"] });
      });

      await state("browse", page, async () => {
        await openPalette(page);
        await scrollBody(page, 0.35);
        await capture(page, theme, "03-browse", { rows: true });
      });

      await state("search", page, async () => {
        await openPalette(page);
        await search(page, "theme");
        await capture(page, theme, "04-search", { rows: true });
      });

      await state("unavailable", page, async () => {
        await openPalette(page);
        await search(page, "undo layout change");
        await expectFirst(page, "Undo layout change");
        await capture(page, theme, "05-unavailable", {
          rows: true,
          text: ["No layout change to undo"],
        });
      });

      await state("danger", page, async () => {
        await openPalette(page);
        await search(page, "kill terminal");
        await expectFirst(page, "Kill terminal");
        await capture(page, theme, "06-danger", { rows: true, text: ["Permanently kills"] });
      });

      await state("no-match", page, async () => {
        await openPalette(page);
        await search(page, "zzqx flux");
        await capture(page, theme, "07-no-match", { rows: false, text: ["zzqx flux"] });
      });

      await state("path", page, async () => {
        await openPalette(page);
        await search(page, "src/app.tsx");
        await capture(page, theme, "08-path", { rows: false, text: ["search projects"] });
      });

      await state("commands", page, async () => {
        await openPalette(page);
        await page.keyboard.press(">");
        await settle(page, 200);
        await page.keyboard.type("git");
        await settle(page, 450);
        await capture(page, theme, "09-commands", { rows: true, text: ["Commands"] });
      });

      await setWindowSize(app, NARROW);
      await setZoom(app, NARROW_ZOOM);
      zoomed = true;
      await settle(page, 600);

      await state("narrow", page, async () => {
        await openPalette(page);
        await capture(page, theme, "10-narrow", { rows: true });
      });
    }

    const onDisk = new Set(readdirSync(OUTPUT_DIR).filter((f) => f.endsWith(".png")));
    const missing = written.filter((f) => !onDisk.has(f));
    expect(missing, "captures reported written but missing on disk").toEqual([]);
    expect(failures, "command palette capture states failed").toEqual([]);
    expect(written.length).toBe(planned);
  } finally {
    if (ctx?.app) await closeApp(ctx.app);
    repo.cleanup();
    if (existsSync(userDataDir)) rmSync(userDataDir, { recursive: true, force: true });
  }
});
