/**
 * The terminal's find bar, in every state that carries design weight, across
 * themes.
 *
 * The bar floats over the top-right corner of a terminal pane. One terminal
 * prints a short build log so a query has real matches to land on, and each
 * state is reached the way a user reaches it: Cmd+F (or the find event the
 * keybinding dispatches), typing, the option toggles, Tab, the pointer.
 *
 *   DAINTREE_SHOT_TERMINAL_FIND=1 DESIGN_CAPTURE_DIR=/tmp/shots \
 *     npx playwright test --project=screenshots terminal-search-bar-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_TERMINAL_FIND  required — any truthy value runs the capture
 *   DESIGN_CAPTURE_DIR           required — output directory (never the repo)
 *   DAINTREE_SHOT_THEMES         comma-separated theme ids (default daintree,bondi,namib)
 *   DAINTREE_SCREENSHOT_SCALE    device scale factor (default 2)
 *
 * Output: <dir>/<state>--<theme>.png. Every frame is checked against the state
 * it claims to show (typed value, count text, pressed toggles, focus owner,
 * disabled steppers, open tooltip) after the settle and before it is written,
 * and the run fails if any frame is missing.
 */

import { expect, test, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import { execSync } from "child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readdirSync, realpathSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { openAndOnboardProject } from "../helpers/project";
import { dismissBlockingPalette } from "../helpers/overlays";
import { setAppTheme } from "../helpers/theme";
import { runTerminalCommand, waitForTerminalText } from "../helpers/terminal";
import { SEL } from "../helpers/selectors";
import { T_LONG } from "../helpers/timeouts";

const ENABLED = !!process.env.DAINTREE_SHOT_TERMINAL_FIND;
const OUTPUT_DIR = process.env.DESIGN_CAPTURE_DIR
  ? path.resolve(process.env.DESIGN_CAPTURE_DIR)
  : "";
const SCALE = process.env.DAINTREE_SCREENSHOT_SCALE ?? "2";
const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi,namib")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

const STATES = [
  "empty",
  "found",
  "options",
  "no-matches",
  "invalid-regex",
  "focus-toggle",
  "hover-close",
  "limit",
  "narrow",
] as const;
type State = (typeof STATES)[number];

const WINDOW = { width: 1440, height: 900 };
const NARROW_WINDOW = { width: 760, height: 700 };

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

const BUILD_LOG = [
  "> helios-dashboard@2.4.0 build",
  "> tsc -b && vite build",
  "",
  "src/api/client.ts(12,5): error TS2322: Type 'string' is not assignable to type 'URL'.",
  "src/panes/toolbar.ts(4,17): error TS6133: 'compact' is declared but never read.",
  "src/panes/stepper.ts(1,40): warning: prefer Error over a bare throw",
  "vite v8.0.14 building for production...",
  "transforming (412) src/main.tsx",
  "Found 2 errors in 2 files. Errors  Files",
  "     1  src/api/client.ts:12",
  "     1  src/panes/toolbar.ts:4",
  "",
].join("\n");

function git(cmd: string, cwd: string): void {
  execSync(`git ${cmd}`, { cwd, stdio: "ignore" });
}

function createRepo(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "daintree-terminal-find-"));
  git("init -b main", dir);
  git('config user.email "test@daintree.dev"', dir);
  git('config user.name "Daintree Test"', dir);
  writeFileSync(path.join(dir, "README.md"), "# Helios Dashboard\n");
  writeFileSync(path.join(dir, "build.log"), BUILD_LOG);
  writeFileSync(
    path.join(dir, "many.log"),
    Array.from({ length: 300 }, (_, i) => `job ${i + 1} ok ok ok ok`).join("\n") + "\n"
  );
  git("add -A", dir);
  git('commit -m "initial commit"', dir);
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

interface DispatchResult {
  ok?: boolean;
  error?: { message?: string };
  result?: { terminalId?: string };
}

async function dispatchAction(
  page: Page,
  actionId: string,
  args?: unknown
): Promise<DispatchResult> {
  return page.evaluate(
    ([id, a]) =>
      (
        window as unknown as {
          __daintreeDispatchAction: (id: string, a?: unknown) => Promise<DispatchResult>;
        }
      ).__daintreeDispatchAction(id, a),
    [actionId, args] as const
  );
}

async function settle(page: Page, ms = 350): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
  );
  await page.waitForTimeout(ms);
}

async function parkPointer(page: Page): Promise<void> {
  await page.mouse.move(2, 2);
}

type Box = { x: number; y: number; width: number; height: number };

async function snap(
  page: Page,
  state: State,
  theme: string,
  targets: Array<Locator | Box>,
  opts: { pad?: number } = {}
): Promise<void> {
  await settle(page);
  const boxes: Box[] = [];
  for (const target of targets) {
    const box = "boundingBox" in target ? await target.boundingBox() : target;
    if (!box || box.width < 4 || box.height < 4) {
      throw new Error(`${state}: crop target has no real box (${JSON.stringify(box)})`);
    }
    boxes.push(box);
  }
  const pad = opts.pad ?? 16;
  const view = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
  const left = Math.max(0, Math.min(...boxes.map((b) => b.x)) - pad);
  const top = Math.max(0, Math.min(...boxes.map((b) => b.y)) - pad);
  const bottom = Math.min(view.h, Math.max(...boxes.map((b) => b.y + b.height)) + pad);
  const right = Math.min(view.w, Math.max(...boxes.map((b) => b.x + b.width)) + pad);
  await page.screenshot({
    path: path.join(OUTPUT_DIR, `${state}--${theme}.png`),
    type: "png",
    animations: "disabled",
    caret: "hide",
    clip: { x: left, y: top, width: right - left, height: bottom - top },
  });
}

async function setWindowSize(
  app: ElectronApplication,
  size: { width: number; height: number }
): Promise<void> {
  await app.evaluate(({ BrowserWindow }, s) => {
    const win = BrowserWindow.getAllWindows()[0];
    win?.setSize(s.width, s.height);
  }, size);
}

async function closeTerminal(page: Page, panelId: string | undefined): Promise<void> {
  if (!panelId) return;
  await dispatchAction(page, "terminal.close", { terminalId: panelId }).catch(() => {});
  await page
    .locator(`[data-panel-id="${panelId}"]`)
    .waitFor({ state: "detached", timeout: 5000 })
    .catch(() => {});
  await settle(page, 300);
}

async function newTerminal(page: Page, command: string, sentinel: string): Promise<string> {
  const created = await dispatchAction(page, "terminal.new");
  const panelId = created.result?.terminalId;
  if (!panelId) throw new Error(`terminal.new gave no terminal: ${created.error?.message ?? "?"}`);
  const panel = page.locator(`[data-panel-id="${panelId}"]`);
  await panel.waitFor({ state: "visible", timeout: T_LONG });
  await runTerminalCommand(page, panel, command, { readyTimeout: 20_000 });
  await waitForTerminalText(panel, sentinel, 20_000);
  await settle(page, 500);
  return panelId;
}

/** The bar's root: the floating card that holds the field. */
function barOf(panel: Locator): Locator {
  return panel
    .locator("[data-terminal-search-input]")
    .locator(
      "xpath=ancestor::div[contains(concat(' ', @class, ' '), ' top-2 ') and contains(concat(' ', @class, ' '), ' right-2 ')][1]"
    );
}

async function openFind(page: Page, panel: Locator): Promise<Locator> {
  const input = panel.locator("[data-terminal-search-input]");
  if (!(await input.isVisible().catch(() => false))) {
    await panel.locator(".xterm").first().click({ force: true });
    await settle(page, 200);
    await page.keyboard.press("Meta+f");
    const shown = await input
      .waitFor({ state: "visible", timeout: 2500 })
      .then(() => true)
      .catch(() => false);
    if (!shown) {
      await page.evaluate(() => window.dispatchEvent(new CustomEvent("daintree:find-in-panel")));
      await input.waitFor({ state: "visible", timeout: 5000 });
    }
    await settle(page, 300);
  }
  return input;
}

async function setToggle(bar: Locator, name: RegExp, pressed: boolean): Promise<void> {
  const toggle = bar.getByRole("button", { name });
  if ((await toggle.getAttribute("aria-pressed")) !== String(pressed)) await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", String(pressed));
}

async function resetToggles(bar: Locator): Promise<void> {
  await setToggle(bar, /case/i, false);
  await setToggle(bar, /regular expression|regex/i, false);
  await setToggle(bar, /whole word/i, false);
}

async function query(page: Page, input: Locator, term: string): Promise<void> {
  await input.fill(term);
  await input.focus();
  await parkPointer(page);
  await settle(page, 600);
  await expect(input).toHaveValue(term);
}

function count(bar: Locator): Locator {
  return bar.locator("[data-terminal-search-status]");
}

interface Run {
  app: ElectronApplication;
  page: Page;
  theme: string;
  failures: string[];
}

async function shoot(run: Run, state: State, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    const message = `${state}--${run.theme}: ${String(error).split("\n")[0]}`;
    run.failures.push(message);
    console.warn(`[terminal-find] FAILED ${message}`);
  }
}

async function captureMain(run: Run): Promise<void> {
  const { page, theme } = run;
  const panelId = await newTerminal(page, "cat build.log", "Found 2 errors");
  const panel = page.locator(`[data-panel-id="${panelId}"]`);
  try {
    const input = await openFind(page, panel);
    const bar = barOf(panel);
    const stepper = (name: string) => bar.getByRole("button", { name, exact: true });
    // The bar plus the strip of pane beneath it, so highlights read in context.
    const context = async (): Promise<Box> => {
      const p = await panel.boundingBox();
      const b = await bar.boundingBox();
      if (!p || !b) throw new Error("no pane box");
      return { x: p.x, y: p.y, width: p.width, height: b.y - p.y + b.height + 220 };
    };

    await shoot(run, "empty", async () => {
      await resetToggles(bar);
      await query(page, input, "");
      await expect(input).toBeFocused();
      await expect(stepper("Previous match")).toBeDisabled();
      await expect(stepper("Next match")).toBeDisabled();
      await snap(page, "empty", theme, [await context()], { pad: 0 });
    });

    await shoot(run, "found", async () => {
      await resetToggles(bar);
      await query(page, input, "error");
      await input.press("Enter");
      await settle(page, 400);
      await expect(count(bar)).toHaveText(/of/);
      await expect(stepper("Next match")).toBeEnabled();
      await snap(page, "found", theme, [await context()], { pad: 0 });
    });

    await shoot(run, "options", async () => {
      await query(page, input, "Error");
      await setToggle(bar, /case/i, true);
      await setToggle(bar, /whole word/i, true);
      await input.focus();
      await parkPointer(page);
      await settle(page, 600);
      await expect(count(bar)).toHaveText(/of|match/);
      await snap(page, "options", theme, [bar]);
    });

    await shoot(run, "no-matches", async () => {
      await resetToggles(bar);
      await query(page, input, "segfault");
      await expect(count(bar)).toHaveText(/no (matches|results)/i);
      await expect(stepper("Next match")).toBeDisabled();
      await snap(page, "no-matches", theme, [bar]);
    });

    await shoot(run, "invalid-regex", async () => {
      await resetToggles(bar);
      await setToggle(bar, /regular expression|regex/i, true);
      await query(page, input, "error(TS");
      await expect(input).toHaveAttribute("aria-invalid", "true");
      const tip = page.getByRole("tooltip").first();
      await tip.waitFor({ state: "visible", timeout: 3000 });
      await snap(page, "invalid-regex", theme, [bar, tip]);
    });

    await shoot(run, "focus-toggle", async () => {
      await resetToggles(bar);
      await query(page, input, "error");
      await input.focus();
      await page.keyboard.press("Tab");
      await settle(page, 600);
      const focused = await page.evaluate(
        () => document.activeElement?.getAttribute("aria-label") ?? ""
      );
      if (!/case/i.test(focused)) throw new Error(`Tab landed on "${focused}"`);
      const tip = page.getByRole("tooltip").first();
      const boxes: Array<Locator> = [bar];
      if (await tip.isVisible().catch(() => false)) boxes.push(tip);
      await snap(page, "focus-toggle", theme, boxes);
    });

    await shoot(run, "hover-close", async () => {
      await query(page, input, "error");
      const close = bar.getByRole("button", { name: /close/i });
      await close.hover();
      await settle(page, 900);
      const tip = page.getByRole("tooltip").first();
      await tip.waitFor({ state: "visible", timeout: 3000 });
      await snap(page, "hover-close", theme, [bar, tip]);
    });

    await input.focus();
    await page.keyboard.press("Escape");
    await settle(page, 300);
    if (await input.isVisible().catch(() => false)) await page.keyboard.press("Escape");
  } finally {
    await closeTerminal(page, panelId);
  }
}

async function captureLimit(run: Run): Promise<void> {
  const { page, theme } = run;
  const panelId = await newTerminal(page, "cat many.log", "job 300 ok");
  const panel = page.locator(`[data-panel-id="${panelId}"]`);
  try {
    await shoot(run, "limit", async () => {
      const input = await openFind(page, panel);
      const bar = barOf(panel);
      await resetToggles(bar);
      await query(page, input, "ok");
      await settle(page, 800);
      const shown = (await count(bar).textContent()) ?? "";
      if (!/1000\+/.test(shown)) throw new Error(`count reads "${shown}", not the capped 1000+`);
      await count(bar).hover();
      await settle(page, 900);
      const tip = page.getByRole("tooltip").first();
      const boxes: Array<Locator> = [bar];
      if (await tip.isVisible().catch(() => false)) boxes.push(tip);
      await snap(page, "limit", theme, boxes);
      await input.focus();
      await page.keyboard.press("Escape");
    });
  } finally {
    await closeTerminal(page, panelId);
  }
}

async function captureNarrow(run: Run): Promise<void> {
  const { app, page, theme } = run;
  const ids: string[] = [];
  try {
    await setWindowSize(app, NARROW_WINDOW);
    await settle(page, 600);
    ids.push(await newTerminal(page, "cat build.log", "Found 2 errors"));
    ids.push(await newTerminal(page, "cat build.log", "Found 2 errors"));
    ids.push(await newTerminal(page, "cat build.log", "Found 2 errors"));
    await settle(page, 800);
    await shoot(run, "narrow", async () => {
      const panel = page.locator(`[data-panel-id="${ids[0]}"]`);
      const input = await openFind(page, panel);
      const bar = barOf(panel);
      await resetToggles(bar);
      await query(page, input, "error");
      const p = await panel.boundingBox();
      if (!p) throw new Error("no pane box");
      await snap(page, "narrow", theme, [{ x: p.x, y: p.y, width: p.width, height: 160 }], {
        pad: 8,
      });
      await input.focus();
      await page.keyboard.press("Escape");
    });
  } finally {
    for (const id of ids) await closeTerminal(page, id);
    await setWindowSize(app, WINDOW);
    await settle(page, 600);
  }
}

test("terminal find bar — every state, every theme", async () => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_TERMINAL_FIND is required for the terminal find bar capture",
  });
  test.skip(!ENABLED, "Set DAINTREE_SHOT_TERMINAL_FIND=1 to run the terminal find bar capture");
  if (!OUTPUT_DIR)
    throw new Error("DESIGN_CAPTURE_DIR must be set to a directory outside the repo");
  test.setTimeout(20 * 60_000);

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const repoRoot = realpathSync(process.cwd());
  const outReal = realpathSync(OUTPUT_DIR);
  if (outReal === repoRoot || outReal.startsWith(repoRoot + path.sep)) {
    throw new Error(`DESIGN_CAPTURE_DIR must be outside the repo (${OUTPUT_DIR})`);
  }
  for (const file of readdirSync(OUTPUT_DIR)) {
    if (file.endsWith(".png")) rmSync(path.join(OUTPUT_DIR, file), { force: true });
  }

  const repo = createRepo();
  const userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-terminalfind-"));
  let ctx: AppContext | undefined;
  const failures: string[] = [];
  try {
    ctx = await launchApp({
      userDataDir,
      screenshotScale: SCALE,
      windowSize: WINDOW,
      extraArgs: ["--disable-gpu", "--in-process-gpu", "--disable-breakpad", "--noerrdialogs"],
    });
    const page = await openAndOnboardProject(ctx.app, ctx.window, repo.dir, "Helios Dashboard");
    await dismissBlockingPalette(page);

    for (const theme of THEMES) {
      try {
        await setAppTheme(page, theme);
        await page.addStyleTag({ content: POLISH_CSS });
        await dismissBlockingPalette(page);
        await page.locator(SEL.worktree.mainCard).waitFor({ state: "visible", timeout: T_LONG });
        await settle(page, 1000);
        const run: Run = { app: ctx.app, page, theme, failures };
        await captureMain(run);
        await captureLimit(run);
        await captureNarrow(run);
      } catch (error) {
        failures.push(`${theme}: ${String(error).split("\n")[0]}`);
      }
    }

    const written = new Set(readdirSync(OUTPUT_DIR).filter((f) => f.endsWith(".png")));
    const missing = THEMES.flatMap((t) =>
      STATES.map((s) => `${s}--${t}.png`).filter((f) => !written.has(f))
    );
    console.log(
      `[terminal-find] wrote ${written.size}/${STATES.length * THEMES.length} PNGs to ${OUTPUT_DIR}`
    );
    expect(failures, "state captures failed").toEqual([]);
    expect(missing, "frames missing from the output directory").toEqual([]);
  } finally {
    if (ctx?.app) await closeApp(ctx.app).catch(() => {});
    repo.cleanup();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
