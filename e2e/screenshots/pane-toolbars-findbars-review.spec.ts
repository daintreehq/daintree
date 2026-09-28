/**
 * Pane toolbars and find bars, across themes.
 *
 * Every pane that shows a file, a diff, a page or a terminal carries a control
 * row, and the ones that search carry a floating find bar. They are meant to be
 * one family, so the only useful review lays them side by side: the file pane's
 * toolbar, the file browser's tree header (at rest and with View options open),
 * the diff pane's header and footer, the diff's sticky per-file header, the
 * cross-worktree compare stepper, the browser pane toolbar, the Portal's top
 * rows, the notification center header, and the terminal and browser find bars.
 *
 * One launch, one pass per theme: the theme is switched through the real
 * app-theme IPC (`setAppTheme`, which reloads the view), and each surface is
 * reached the way a user reaches it — through the action a menu, keybinding or
 * toolbar button dispatches, or the keybinding itself.
 *
 *   DAINTREE_SHOT_PANE_TOOLBARS=1 DESIGN_CAPTURE_DIR=/tmp/shots \
 *     npx playwright test --project=screenshots pane-toolbars-findbars-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_PANE_TOOLBARS  required — any truthy value runs the capture
 *   DESIGN_CAPTURE_DIR           required — output directory (never the repo)
 *   DAINTREE_SHOT_THEMES         comma-separated theme ids (default daintree,bondi,namib)
 *   DAINTREE_SCREENSHOT_SCALE    device scale factor (default 2)
 *
 * Output: <dir>/<state>--<theme>.png, each a tight crop of the control row.
 * Every frame is checked against the state it claims to show (typed value,
 * pressed toggle, open menu, focus owner, disabled control) after the settle
 * and before it is written, and the run fails if any frame is missing.
 */

import { expect, test, type Locator, type Page } from "@playwright/test";
import { execSync } from "child_process";
import { createServer, type Server } from "http";
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  existsSync,
  readdirSync,
  realpathSync,
} from "fs";
import { tmpdir } from "os";
import path from "path";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { openAndOnboardProject } from "../helpers/project";
import { dismissBlockingPalette } from "../helpers/overlays";
import { setAppTheme } from "../helpers/theme";
import { seedNotificationHistory } from "../helpers/notifications";
import { openBrowser } from "../helpers/panels";
import { runTerminalCommand, waitForTerminalText } from "../helpers/terminal";
import { SEL } from "../helpers/selectors";
import { T_LONG, T_MEDIUM } from "../helpers/timeouts";

const ENABLED = !!process.env.DAINTREE_SHOT_PANE_TOOLBARS;
const OUTPUT_DIR = process.env.DESIGN_CAPTURE_DIR
  ? path.resolve(process.env.DESIGN_CAPTURE_DIR)
  : "";
const SCALE = process.env.DAINTREE_SCREENSHOT_SCALE ?? "2";
const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi,namib")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

const STATES = [
  "filepane-toolbar",
  "filebrowser-header",
  "filebrowser-options-open",
  "filepane-focus",
  "diffpane-toolbar",
  "diffpane-footer",
  "diffpane-footer-pressed",
  "diffviewer-fileheader",
  "crossdiff-toolbar",
  "browser-toolbar",
  "portal-toolbar",
  "notification-center-header",
  "terminal-findbar",
  "terminal-findbar-empty",
  "browser-findbar",
  "browser-findbar-empty",
] as const;
type State = (typeof STATES)[number];

/**
 * States that cannot be reached in the E2E environment, with the reason. A
 * state listed here is skipped (and logged) rather than written as a wrong
 * frame, and is excluded from the final count.
 */
const UNREACHABLE: Partial<Record<State, string>> = {};

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

const MARKDOWN_REL =
  "docs/architecture/decisions/2026/pane-chrome/find-bar-and-toolbar-rhythm-across-panes.md";
const WT_FEATURE = "feature/pane-toolbar-rhythm";
const DEFAULT_BROWSER_PORT = 3000;

const MARKDOWN = `# Find bar and toolbar rhythm

Every pane that shows content carries one control row. The row is 36px tall,
its icon buttons share one glyph size, and its path pill collapses from the
middle so the file name always survives.

## Rules

1. One tab stop per row; arrow keys move between controls.
2. A pressed toggle is membership, not the accent.
3. Disabled steppers keep their place in the arrow-key order.

> The find bar floats over the top-right corner of the pane it searches.
`;

const PAGE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Pane chrome fixture</title>
<style>body{font:15px/1.6 -apple-system,system-ui,sans-serif;margin:32px;color:#222;background:#fafafa}</style>
</head><body>
<h1>Daintree pane chrome</h1>
<p>Daintree keeps every pane toolbar on one rhythm. The Daintree find bar floats top-right.</p>
<p>daintree in lower case should not match once case sensitivity is on.</p>
<p>Another Daintree paragraph, so stepping has somewhere to go.</p>
</body></html>`;

function git(cmd: string, cwd: string): void {
  execSync(`git ${cmd}`, { cwd, stdio: "ignore" });
}

function write(root: string, rel: string, content: string): void {
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  writeFileSync(path.join(root, rel), content);
}

/**
 * `main` with a dirty working tree (four changed files, so the changes diff
 * opens in workspace mode) plus one worktree whose branch has diverged by a
 * committed change set (so the compare dialog has files to step between).
 */
function createRepo(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "daintree-pane-toolbars-"));
  const wtRoot = path.join(path.dirname(dir), path.basename(dir) + "-worktrees");
  mkdirSync(wtRoot, { recursive: true });
  git("init -b main", dir);
  git('config user.email "test@daintree.dev"', dir);
  git('config user.name "Daintree Test"', dir);
  write(dir, "README.md", "# Helios Dashboard\n\nOperational dashboard for Helios.\n");
  write(dir, MARKDOWN_REL, MARKDOWN);
  write(
    dir,
    "src/panes/toolbar.ts",
    [
      "export const TOOLBAR_HEIGHT = 36;",
      "export const ICON_SIZE = 14;",
      "export function toolbarClass(compact: boolean): string {",
      '  return compact ? "toolbar toolbar--compact" : "toolbar";',
      "}",
      "",
    ].join("\n")
  );
  write(
    dir,
    "src/panes/findBar.ts",
    [
      "export interface FindState {",
      "  query: string;",
      "  caseSensitive: boolean;",
      "}",
      "export const EMPTY_FIND: FindState = { query: '', caseSensitive: false };",
      "",
    ].join("\n")
  );
  write(
    dir,
    "src/panes/stepper.ts",
    "export const step = (i: number, n: number) => (i + 1) % n;\n"
  );
  write(dir, "src/api/client.ts", "export const BASE_URL = 'http://localhost:4000';\n");
  git("add -A", dir);
  git('commit -m "initial commit"', dir);

  const featureDir = path.join(wtRoot, WT_FEATURE.replace(/\//g, "-"));
  git(`branch ${WT_FEATURE}`, dir);
  git(`worktree add ${JSON.stringify(featureDir)} ${WT_FEATURE}`, dir);
  write(
    featureDir,
    "src/panes/toolbar.ts",
    [
      "export const TOOLBAR_HEIGHT = 36;",
      "export const ICON_SIZE = 14;",
      "export const GAP = 6;",
      "export function toolbarClass(compact: boolean, dense = false): string {",
      '  const base = compact ? "toolbar toolbar--compact" : "toolbar";',
      "  return dense ? `${base} toolbar--dense` : base;",
      "}",
      "",
    ].join("\n")
  );
  write(
    featureDir,
    "src/panes/stepper.ts",
    "export const step = (i: number, n: number, d = 1) => (i + d + n) % n;\n"
  );
  write(
    featureDir,
    "src/panes/findBarCounter.ts",
    "export const counter = (a: number, n: number) => `${a} of ${n}`;\n"
  );
  write(
    featureDir,
    "README.md",
    "# Helios Dashboard\n\nOperational dashboard for Helios, with one toolbar rhythm.\n"
  );
  git("add -A", featureDir);
  git('commit -m "toolbar rhythm"', featureDir);

  // Dirty the main working tree: four changed files for the changes diff.
  write(
    dir,
    "src/panes/toolbar.ts",
    [
      "export const TOOLBAR_HEIGHT = 36;",
      "export const ICON_SIZE = 14;",
      "export const ROW_PADDING_X = 8;",
      "export function toolbarClass(compact: boolean): string {",
      '  return compact ? "toolbar toolbar--compact px-2" : "toolbar px-2";',
      "}",
      "",
    ].join("\n")
  );
  write(
    dir,
    "src/panes/findBar.ts",
    [
      "export interface FindState {",
      "  query: string;",
      "  caseSensitive: boolean;",
      "  wholeWord: boolean;",
      "}",
      "export const EMPTY_FIND: FindState = { query: '', caseSensitive: false, wholeWord: false };",
      "",
    ].join("\n")
  );
  write(
    dir,
    "src/api/client.ts",
    "export const BASE_URL = process.env.API_URL ?? 'http://localhost:4000';\n"
  );
  write(
    dir,
    "README.md",
    "# Helios Dashboard\n\nOperational dashboard for Helios.\n\n## Panes\n\nOne toolbar rhythm.\n"
  );

  return {
    dir,
    cleanup: () => {
      if (existsSync(wtRoot)) rmSync(wtRoot, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

interface DispatchResult {
  ok?: boolean;
  error?: { message?: string };
  result?: {
    worktrees?: Array<{ id: string; isMain?: boolean }>;
    panelId?: string;
    terminalId?: string;
  };
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

async function mainWorktreeId(page: Page): Promise<string> {
  for (let attempt = 0; attempt < 40; attempt++) {
    const listed = await dispatchAction(page, "worktree.list");
    const id = (listed.result?.worktrees ?? []).find((w) => w.isMain)?.id;
    if (id !== undefined) return id;
    await page.waitForTimeout(250);
  }
  throw new Error("main worktree never resolved");
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

async function blur(page: Page): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

type Box = { x: number; y: number; width: number; height: number };

/**
 * Writes the union of the given boxes, padded, clamped to the window. `maxBottom`
 * cuts the crop off below a point (the top of an open menu, say).
 */
async function snap(
  page: Page,
  state: State,
  theme: string,
  targets: Array<Locator | Box>,
  opts: { pad?: number; maxBottom?: number } = {}
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
  const pad = opts.pad ?? 20;
  const view = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
  const left = Math.max(0, Math.min(...boxes.map((b) => b.x)) - pad);
  const top = Math.max(0, Math.min(...boxes.map((b) => b.y)) - pad);
  let bottom = Math.min(view.h, Math.max(...boxes.map((b) => b.y + b.height)) + pad);
  if (opts.maxBottom !== undefined) bottom = Math.min(bottom, opts.maxBottom);
  const right = Math.min(view.w, Math.max(...boxes.map((b) => b.x + b.width)) + pad);
  await page.screenshot({
    path: path.join(OUTPUT_DIR, `${state}--${theme}.png`),
    type: "png",
    animations: "disabled",
    caret: "hide",
    clip: { x: left, y: top, width: right - left, height: bottom - top },
  });
}

async function expectAttr(
  locator: Locator,
  name: string,
  value: string,
  what: string
): Promise<void> {
  const actual = await locator.getAttribute(name);
  if (actual !== value) throw new Error(`${what}: expected ${name}="${value}", saw ${actual}`);
}

/**
 * Escape until the surface is gone; if Escape is consumed inside it (a dialog
 * that clears its selection first), fall back to its own close button. A
 * surface left open blocks every later state in the pass.
 */
async function escapeUntilGone(page: Page, target: string | Locator): Promise<void> {
  const surface = (typeof target === "string" ? page.locator(target) : target).first();
  const open = () => surface.isVisible().catch(() => false);
  for (let i = 0; i < 5; i++) {
    if (!(await open())) return;
    await page.keyboard.press("Escape").catch(() => {});
    await settle(page, 250);
  }
  if (!(await open())) return;
  const close = page
    .locator(
      '[role="dialog"] [aria-label="Close dialog"], [role="dialog"] [aria-label="Close"], [role="dialog"] button[aria-label^="Close"]'
    )
    .first();
  await close.click({ timeout: 3000 }).catch(() => {});
  await settle(page, 400);
  if (await open()) throw new Error("surface would not close");
}

async function closePanel(page: Page, panelId: string | undefined): Promise<void> {
  if (!panelId) return;
  await dispatchAction(page, "terminal.close", { terminalId: panelId }).catch(() => {});
  await page
    .locator(`[data-panel-id="${panelId}"]`)
    .waitFor({ state: "detached", timeout: 5000 })
    .catch(() => {});
  await settle(page, 300);
}

async function findBarRoot(input: Locator): Promise<Locator> {
  return input.locator(
    "xpath=ancestor::div[contains(concat(' ', @class, ' '), ' top-2 ') and contains(concat(' ', @class, ' '), ' right-2 ')][1]"
  );
}

interface Run {
  page: Page;
  theme: string;
  repoDir: string;
  baseUrl: string;
  defaultUrlServed: boolean;
  failures: string[];
}

async function shoot(run: Run, state: State, fn: () => Promise<void>): Promise<void> {
  if (UNREACHABLE[state]) {
    console.log(`[pane-toolbars] skip ${state}--${run.theme}: ${UNREACHABLE[state]}`);
    return;
  }
  try {
    await fn();
  } catch (error) {
    const message = `${state}--${run.theme}: ${String(error).split("\n")[0]}`;
    run.failures.push(message);
    console.warn(`[pane-toolbars] FAILED ${message}`);
  }
}

// ---------------------------------------------------------------------------
// Surfaces

async function captureFilePane(run: Run): Promise<void> {
  const { page, theme } = run;
  const opened = await dispatchAction(page, "file.openPanel", {
    path: path.join(run.repoDir, MARKDOWN_REL),
  });
  const panelId = opened.result?.panelId;
  if (!panelId) throw new Error(`file.openPanel gave no panel: ${opened.error?.message ?? "?"}`);
  try {
    const panel = page.locator(`[data-panel-id="${panelId}"]`);
    await panel.waitFor({ state: "visible", timeout: T_MEDIUM });
    const toolbar = panel.locator('[role="toolbar"][aria-label="File viewer controls"]');
    await toolbar.waitFor({ state: "visible", timeout: T_MEDIUM });
    await settle(page, 1200);
    // Markdown opens in Source; the text-size control only exists in Rendered.
    const textSize = toolbar.locator('[data-testid="file-pane-text-size"]');
    if (!(await textSize.isVisible().catch(() => false))) {
      await toolbar.getByRole("button", { name: "Rendered", exact: true }).click();
      await textSize.waitFor({ state: "visible", timeout: T_MEDIUM });
      await settle(page, 800);
    }

    await shoot(run, "filepane-toolbar", async () => {
      await blur(page);
      await parkPointer(page);
      await expect(toolbar.locator("[data-toolbar-path]")).toContainText("rhythm");
      await expect(toolbar.locator('[data-testid="file-pane-text-size"]')).toBeVisible();
      await expect(toolbar.getByRole("button", { name: "Refresh" })).toBeVisible();
      await snap(page, "filepane-toolbar", theme, [toolbar]);
    });

    await shoot(run, "filepane-focus", async () => {
      // Land on the row from the keyboard so the ring is :focus-visible: focus
      // its roving tab stop, then arrow along to the first plain icon button.
      await blur(page);
      const stop = toolbar.locator('button[tabindex="0"]').first();
      if ((await stop.count()) > 0) await stop.focus();
      else await toolbar.locator("button").first().focus();
      let landed = false;
      for (let i = 0; i < 12 && !landed; i++) {
        await page.keyboard.press("ArrowRight");
        landed = await page.evaluate(() => {
          const el = document.activeElement as HTMLElement | null;
          const label = el?.getAttribute("aria-label") ?? "";
          return (
            !!el &&
            el.tagName === "BUTTON" &&
            !!el.closest('[role="toolbar"][aria-label="File viewer controls"]') &&
            /^(Refresh|Copy contents|Copy file contents|Show in file browser)/.test(label)
          );
        });
      }
      await parkPointer(page);
      await settle(page, 600);
      const focus = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        return {
          inToolbar: !!el?.closest('[role="toolbar"][aria-label="File viewer controls"]'),
          isButton: el?.tagName === "BUTTON",
          visible: !!el?.matches(":focus-visible"),
          label: el?.getAttribute("aria-label") ?? "",
        };
      });
      if (!landed || !focus.inToolbar || !focus.isButton || !focus.visible) {
        throw new Error(
          `focus not on a toolbar icon button with :focus-visible (${JSON.stringify(focus)})`
        );
      }
      const targets: Locator[] = [toolbar];
      const tooltip = page.locator('[role="tooltip"]').first();
      if (await tooltip.isVisible().catch(() => false)) targets.push(tooltip);
      await snap(page, "filepane-focus", theme, targets);
      await blur(page);
    });
  } finally {
    await closePanel(page, panelId);
  }
}

async function captureFileBrowser(run: Run, worktreeId: string): Promise<void> {
  const { page, theme } = run;
  const opened = await dispatchAction(page, "worktree.openFileBrowserPanel", { worktreeId });
  const panelId = opened.result?.panelId;
  if (!panelId)
    throw new Error(`openFileBrowserPanel gave no panel: ${opened.error?.message ?? "?"}`);
  try {
    const panel = page.locator(`[data-panel-id="${panelId}"]`);
    await panel.waitFor({ state: "visible", timeout: T_MEDIUM });
    const header = panel.locator('[role="toolbar"][aria-label="File tree controls"]');
    await header.waitFor({ state: "visible", timeout: T_MEDIUM });
    await settle(page, 1200);
    const trigger = header.locator('[data-testid="file-browser-view-options"]');
    const viewerToggle = header.locator('[data-testid="file-browser-viewer-toggle"]');

    await shoot(run, "filebrowser-header", async () => {
      await blur(page);
      await parkPointer(page);
      await expect(trigger).toBeVisible();
      await expect(viewerToggle).toBeVisible();
      await expectAttr(trigger, "aria-expanded", "false", "view options at rest");
      await snap(page, "filebrowser-header", theme, [header]);
    });

    await shoot(run, "filebrowser-options-open", async () => {
      await trigger.click();
      const menu = page.locator('[role="menu"]').first();
      await menu.waitFor({ state: "visible", timeout: 5000 });
      await parkPointer(page);
      await settle(page, 400);
      await expectAttr(trigger, "aria-expanded", "true", "view options trigger");
      await expect(menu.getByText("Sort by").first()).toBeAttached();
      const menuBox = await menu.boundingBox();
      if (!menuBox) throw new Error("menu has no box");
      await snap(page, "filebrowser-options-open", theme, [header, menu], {
        maxBottom: menuBox.y + Math.min(menuBox.height, 150),
      });
      await page.keyboard.press("Escape");
      await menu.waitFor({ state: "hidden", timeout: 5000 }).catch(() => {});
    });
  } finally {
    await closePanel(page, panelId);
  }
}

const DIFF_BODY = '[data-testid="diff-pane-body"]';

async function captureDiffPane(run: Run, worktreeId: string): Promise<void> {
  const { page, theme } = run;
  // WorktreeMonitor fills the change set asynchronously; the action opens
  // nothing until it has, so retry until the pane body is on screen.
  let open = false;
  for (let attempt = 0; attempt < 15 && !open; attempt++) {
    await dispatchAction(page, "worktree.openChanges", { worktreeId });
    open = await page
      .locator(DIFF_BODY)
      .first()
      .waitFor({ state: "visible", timeout: 2000 })
      .then(() => true)
      .catch(() => false);
  }
  if (!open) throw new Error("worktree.openChanges never opened the diff pane");
  try {
    const toolbar = page.locator('[role="toolbar"][aria-label="Diff viewer controls"]').first();
    const footer = page.locator('[data-testid="diff-pane-footer"]').first();
    await toolbar.waitFor({ state: "visible", timeout: T_MEDIUM });
    await footer.waitFor({ state: "visible", timeout: T_MEDIUM });
    const fileHeader = page.locator(`${DIFF_BODY} div.sticky.top-0`).first();
    await fileHeader.waitFor({ state: "visible", timeout: T_MEDIUM }).catch(() => {});
    await settle(page, 1200);

    const listToggle = footer.getByRole("button", { name: "Toggle file list" });
    const viewed = footer.getByRole("button", { name: "Viewed" });
    const prev = footer.getByRole("button", { name: "Previous file" });
    const position = footer.locator('[data-testid="diff-file-position-indicator"]');

    // A preference left on by an earlier pass would make "at rest" a lie.
    if ((await listToggle.getAttribute("aria-expanded")) === "true") {
      await listToggle.click();
      await settle(page, 300);
    }
    if ((await viewed.getAttribute("aria-pressed")) === "true") {
      await viewed.click();
      await settle(page, 300);
    }

    await shoot(run, "diffpane-toolbar", async () => {
      await blur(page);
      await parkPointer(page);
      await expect(toolbar.locator("[data-toolbar-path]")).toBeVisible();
      await expect(toolbar.getByRole("group", { name: "Diff layout" })).toBeVisible();
      await snap(page, "diffpane-toolbar", theme, [toolbar]);
    });

    await shoot(run, "diffviewer-fileheader", async () => {
      await blur(page);
      await parkPointer(page);
      await expect(fileHeader).toBeVisible();
      await expect(
        fileHeader.getByRole("button", { name: /Copy file diff|Copied!/ })
      ).toBeVisible();
      await snap(page, "diffviewer-fileheader", theme, [fileHeader]);
    });

    await shoot(run, "diffpane-footer", async () => {
      await blur(page);
      await parkPointer(page);
      const text = (await position.textContent())?.trim() ?? "";
      const match = /^1 of (\d+)$/.exec(text);
      if (!match || Number(match[1]) < 3) throw new Error(`position indicator reads "${text}"`);
      await expectAttr(prev, "aria-disabled", "true", "Previous file on the first file");
      await expectAttr(listToggle, "aria-expanded", "false", "file list toggle");
      await expectAttr(viewed, "aria-pressed", "false", "Viewed toggle");
      await snap(page, "diffpane-footer", theme, [footer]);
    });

    await shoot(run, "diffpane-footer-pressed", async () => {
      await listToggle.click();
      await settle(page, 400);
      await viewed.click();
      await blur(page);
      await parkPointer(page);
      await settle(page, 500);
      await expectAttr(listToggle, "aria-expanded", "true", "file list toggle");
      await expectAttr(viewed, "aria-pressed", "true", "Viewed toggle");
      await snap(page, "diffpane-footer-pressed", theme, [footer]);
      await viewed.click();
      await settle(page, 300);
      await listToggle.click();
      await settle(page, 300);
    });
  } finally {
    await escapeUntilGone(page, DIFF_BODY);
  }
}

async function captureCrossDiff(run: Run): Promise<void> {
  const { page, theme } = run;
  await shoot(run, "crossdiff-toolbar", async () => {
    try {
      const card = page.locator(SEL.worktree.mainCard).first();
      await card.scrollIntoViewIfNeeded().catch(() => {});
      await card.hover().catch(() => {});
      await card.locator(SEL.worktree.actionsMenu).first().click();
      await page.locator('[role="menu"]').first().waitFor({ state: "visible", timeout: 5000 });
      await settle(page, 300);
      const review = page.getByRole("menuitem", { name: /^Review$/ }).first();
      await review.hover();
      await settle(page, 400);
      const item = page.getByRole("menuitem", { name: /compare with another worktree/i }).first();
      if (!(await item.isVisible().catch(() => false))) {
        await review.click();
        await settle(page, 400);
      }
      await item.click({ timeout: 10000 });
      const dialog = page.getByRole("dialog", { name: "Compare worktrees" });
      await dialog.waitFor({ state: "visible", timeout: 8000 });
      await settle(page, 600);

      const target = dialog.locator("select").nth(1);
      const value = await target.evaluate((el, b) => {
        const opt = Array.from((el as HTMLSelectElement).options).find((o) =>
          o.textContent?.includes(b)
        );
        return opt?.value ?? "";
      }, WT_FEATURE);
      if (!value) throw new Error(`no compare option for ${WT_FEATURE}`);
      await target.selectOption(value);
      await settle(page, 1500);

      const rows = dialog.locator("button[data-file-path]");
      await rows.first().waitFor({ state: "visible", timeout: 10000 });
      const rowCount = await rows.count();
      if (rowCount < 3) throw new Error(`compare lists ${rowCount} files, need at least 3`);
      await rows.first().click();
      const toolbar = dialog.locator('[role="toolbar"][aria-label="Comparison controls"]');
      await toolbar.waitFor({ state: "visible", timeout: 8000 });
      await settle(page, 800);
      // The list may group rows differently from the stepper's order; step back
      // to the stepper's first file so "Previous" is honestly disabled.
      const prev = toolbar.getByRole("button", { name: "Previous file" });
      for (let i = 0; i < rowCount && (await prev.getAttribute("aria-disabled")) !== "true"; i++) {
        await prev.click();
        await settle(page, 400);
      }
      await blur(page);
      await parkPointer(page);
      await settle(page, 600);
      const position = (
        (await toolbar.locator('[data-testid="cross-worktree-file-position"]').textContent()) ?? ""
      ).trim();
      const match = /^1 of (\d+)$/.exec(position);
      if (!match || Number(match[1]) < 3) throw new Error(`compare position reads "${position}"`);
      await expectAttr(prev, "aria-disabled", "true", "compare Previous file");
      await expect(toolbar.getByRole("button", { name: "Wrap long lines" })).toBeVisible();
      await snap(page, "crossdiff-toolbar", theme, [toolbar]);
    } finally {
      await escapeUntilGone(page, page.getByRole("dialog", { name: "Compare worktrees" }));
    }
  });
}

async function captureBrowser(run: Run): Promise<void> {
  const { page, theme } = run;
  const url = `${run.baseUrl}/chrome`;
  // Through the toolbar's Open browser command (button, overflow or launcher
  // row), then the address bar — the path a user takes.
  await openBrowser(page);
  const result = { route: "toolbar" };
  const anyToolbar = page.locator('[data-testid="browser-toolbar"]').first();
  const shown = await anyToolbar
    .waitFor({ state: "visible", timeout: T_LONG })
    .then(() => true)
    .catch(() => false);
  if (!shown) {
    const kinds = await page.evaluate(() =>
      Array.from(document.querySelectorAll("[data-panel-id]")).map(
        (el) => `${el.getAttribute("data-panel-kind")}@${el.getAttribute("data-panel-location")}`
      )
    );
    throw new Error(
      `no browser toolbar after Open browser (${JSON.stringify(result)}; panels ${kinds.join(",")})`
    );
  }
  const panelId =
    (await anyToolbar.evaluate((el) =>
      el.closest("[data-panel-id]")?.getAttribute("data-panel-id")
    )) ?? undefined;
  const panel = page.locator(`[data-panel-id="${panelId}"]`).first();
  try {
    const toolbar = panel.locator('[data-testid="browser-toolbar"]');
    const address = panel.locator(SEL.browser.addressBar);
    if (run.defaultUrlServed) {
      await expect(address).toHaveValue(new RegExp(`localhost:${DEFAULT_BROWSER_PORT}`), {
        timeout: T_LONG,
      });
    } else {
      await address.click();
      await address.fill(url);
      await page.keyboard.press("Enter");
      await expect(address).toHaveValue(/127\.0\.0\.1/, { timeout: T_LONG });
    }
    await settle(page, 2000);

    await shoot(run, "browser-toolbar", async () => {
      await blur(page);
      await parkPointer(page);
      await expect(panel.locator(SEL.browser.backButton)).toBeDisabled();
      await snap(page, "browser-toolbar", theme, [toolbar]);
    });

    const input = panel.locator('[data-testid="find-bar-input"]');
    const openFind = async (): Promise<void> => {
      if (await input.isVisible().catch(() => false)) return;
      // Focus the pane through its chrome (not the guest page), then the real
      // keybinding; the bus event the keybinding dispatches is the fallback.
      await toolbar.click({ position: { x: 4, y: 4 } }).catch(() => {});
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
    };

    await shoot(run, "browser-findbar", async () => {
      await openFind();
      const bar = await findBarRoot(input);
      await input.fill("");
      await input.pressSequentially("Daintree", { delay: 40 });
      const matchCase = bar.getByRole("button", { name: "Match case" });
      if ((await matchCase.getAttribute("aria-pressed")) !== "true") await matchCase.click();
      const counter = bar.locator('[role="status"]');
      // Step once: a fresh find session can report before the guest has laid
      // out the matches; a findNext pass re-counts against the painted page.
      await settle(page, 600);
      if (!/^\d+ of \d+$/.test(((await counter.textContent()) ?? "").trim())) {
        await input.press("Enter");
      }
      await expect(counter)
        .toHaveText(/^\d+ of \d+$/, { timeout: 8000 })
        .catch(async () => {
          const guest = await panel
            .locator("webview")
            .first()
            .evaluate(async (el) => {
              const wv = el as unknown as {
                getURL: () => string;
                executeJavaScript: (c: string) => Promise<string>;
              };
              try {
                return `${wv.getURL()} :: ${(await wv.executeJavaScript("document.body.innerText")).slice(0, 80)}`;
              } catch (e) {
                return `unreadable: ${String(e)}`;
              }
            })
            .catch((e) => `no webview: ${String(e)}`);
          throw new Error(
            `find counter reads "${(await counter.textContent()) ?? ""}" — guest ${guest}`
          );
        });
      await parkPointer(page);
      await settle(page, 500);
      await expect(input).toHaveValue("Daintree");
      await expectAttr(matchCase, "aria-pressed", "true", "Match case");
      await expect(bar.getByRole("button", { name: "Next match" })).toBeEnabled();
      await snap(page, "browser-findbar", theme, [bar]);
    });

    await shoot(run, "browser-findbar-empty", async () => {
      await openFind();
      const bar = await findBarRoot(input);
      const matchCase = bar.getByRole("button", { name: "Match case" });
      if ((await matchCase.getAttribute("aria-pressed")) === "true") await matchCase.click();
      await input.fill("");
      await parkPointer(page);
      await settle(page, 500);
      await expect(input).toHaveValue("");
      await expect(bar.getByRole("button", { name: "Previous match" })).toBeDisabled();
      await expect(bar.getByRole("button", { name: "Next match" })).toBeDisabled();
      await snap(page, "browser-findbar-empty", theme, [bar]);
      await input.press("Escape").catch(() => {});
    });
  } finally {
    await closePanel(page, panelId);
  }
}

async function capturePortal(run: Run): Promise<void> {
  const { page, theme } = run;
  await shoot(run, "portal-toolbar", async () => {
    const region = page.locator(SEL.portal.region);
    try {
      const result = await dispatchAction(page, "portal.openUrl", {
        url: `${run.baseUrl}/portal`,
        title: "Helios docs",
      });
      if (result.ok === false) throw new Error(`portal.openUrl failed: ${result.error?.message}`);
      await region.waitFor({ state: "visible", timeout: T_MEDIUM });
      const back = region.locator(SEL.portal.goBack);
      await back.waitFor({ state: "visible", timeout: T_MEDIUM });
      const tabs = region.locator('[role="tablist"][aria-label="Portal tabs"] [role="tab"]');
      await expect(tabs.first()).toBeVisible({ timeout: T_MEDIUM });
      await settle(page, 1500);
      await blur(page);
      await parkPointer(page);
      await settle(page, 400);
      const chrome = back.locator("xpath=ancestor::div[contains(@class,'h-10')][1]/..");
      await expect(region.getByRole("button", { name: "New Tab" })).toBeVisible();
      await expect(region.getByRole("button", { name: "Close portal" })).toBeVisible();
      await expect(region.getByRole("button", { name: "Dev servers" })).toBeVisible();
      await snap(page, "portal-toolbar", theme, [chrome], { pad: 0 });
    } finally {
      await dispatchAction(page, "portal.closeAllTabs").catch(() => {});
      await settle(page, 400);
      if (await region.isVisible().catch(() => false)) {
        await dispatchAction(page, "portal.toggle").catch(() => {});
        await settle(page, 400);
      }
    }
  });
}

async function captureNotificationCenter(run: Run): Promise<void> {
  const { page, theme } = run;
  await shoot(run, "notification-center-header", async () => {
    const popover = page.locator(SEL.notifications.center);
    try {
      const now = Date.now();
      await seedNotificationHistory(page, [
        {
          id: "shot-1",
          type: "success",
          title: "Agent finished",
          message: "Claude finished refactoring the toolbar rhythm in feature/pane-toolbar-rhythm.",
          timestamp: now - 2 * 60_000,
        },
        {
          id: "shot-2",
          type: "warning",
          title: "Agent waiting",
          message: "Codex is waiting for approval to run the migration.",
          timestamp: now - 9 * 60_000,
        },
        {
          id: "shot-3",
          type: "info",
          message: "Dev server restarted on port 5173.",
          timestamp: now - 40 * 60_000,
        },
      ]);
      await page.locator(SEL.notifications.bellButton).first().click();
      await popover.waitFor({ state: "visible", timeout: 8000 });
      await settle(page, 600);
      const markAll = popover.locator(SEL.notifications.markAllReadButton).first();
      await expect(markAll).toBeVisible();
      await blur(page);
      await parkPointer(page);
      await settle(page, 400);
      await expect(markAll).toBeVisible();
      const header = markAll.locator("xpath=ancestor::div[contains(@class,'justify-between')][1]");
      await expect(header).toContainText("Notifications");
      await snap(page, "notification-center-header", theme, [header], { pad: 0 });
    } finally {
      await escapeUntilGone(page, SEL.notifications.center);
    }
  });
}

async function captureTerminal(run: Run): Promise<void> {
  const { page, theme } = run;
  const created = await dispatchAction(page, "terminal.new");
  const panelId = created.result?.terminalId;
  if (!panelId) throw new Error(`terminal.new gave no terminal: ${created.error?.message ?? "?"}`);
  try {
    const panel = page.locator(`[data-panel-id="${panelId}"]`);
    await panel.waitFor({ state: "visible", timeout: T_LONG });
    await runTerminalCommand(
      page,
      panel,
      "printf 'Daintree build ok\\nDaintree tests ok\\ndaintree lint ok\\n'",
      { readyTimeout: 20_000 }
    );
    await waitForTerminalText(panel, "Daintree tests ok", 20_000);
    await settle(page, 600);

    const input = panel.locator("[data-terminal-search-input]");
    const openFind = async (): Promise<void> => {
      if (await input.isVisible().catch(() => false)) return;
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
    };

    await shoot(run, "terminal-findbar", async () => {
      await openFind();
      const bar = await findBarRoot(input);
      await input.fill("Daintree");
      const caseToggle = bar.getByRole("button", { name: "Toggle case sensitivity" });
      if ((await caseToggle.getAttribute("aria-pressed")) !== "true") await caseToggle.click();
      await parkPointer(page);
      await settle(page, 700);
      await expect(input).toHaveValue("Daintree");
      await expectAttr(caseToggle, "aria-pressed", "true", "case sensitivity");
      await expect(bar.getByRole("button", { name: "Next match" })).toBeEnabled();
      await snap(page, "terminal-findbar", theme, [bar]);
    });

    await shoot(run, "terminal-findbar-empty", async () => {
      await openFind();
      const bar = await findBarRoot(input);
      const caseToggle = bar.getByRole("button", { name: "Toggle case sensitivity" });
      if ((await caseToggle.getAttribute("aria-pressed")) === "true") await caseToggle.click();
      await input.fill("");
      await input.focus();
      await parkPointer(page);
      await settle(page, 500);
      await expect(input).toHaveValue("");
      await expect(bar.getByRole("button", { name: "Previous match" })).toBeDisabled();
      await expect(bar.getByRole("button", { name: "Next match" })).toBeDisabled();
      await snap(page, "terminal-findbar-empty", theme, [bar]);
      await input.press("Escape").catch(() => {});
    });
  } finally {
    await closePanel(page, panelId);
  }
}

async function captureTheme(run: Run): Promise<void> {
  const { page, theme } = run;
  await setAppTheme(page, theme);
  await page.addStyleTag({ content: POLISH_CSS });
  await dismissBlockingPalette(page);
  await page.locator(SEL.worktree.mainCard).waitFor({ state: "visible", timeout: T_LONG });
  await settle(page, 1000);
  const worktreeId = await mainWorktreeId(page);

  const group = async (name: string, fn: () => Promise<void>): Promise<void> => {
    try {
      await fn();
    } catch (error) {
      const message = `${name}--${theme}: ${String(error).split("\n")[0]}`;
      run.failures.push(message);
      console.warn(`[pane-toolbars] FAILED ${message}`);
    }
    await dismissBlockingPalette(page);
  };

  await group("file-pane", () => captureFilePane(run));
  await group("file-browser", () => captureFileBrowser(run, worktreeId));
  await group("diff-pane", () => captureDiffPane(run, worktreeId));
  await group("cross-diff", () => captureCrossDiff(run));
  await group("browser", () => captureBrowser(run));
  await group("portal", () => capturePortal(run));
  await group("notifications", () => captureNotificationCenter(run));
  await group("terminal", () => captureTerminal(run));
}

function pageServer(): Server {
  return createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(PAGE_HTML);
  });
}

function startServer(): Promise<{ server: Server; baseUrl: string }> {
  return new Promise((resolve) => {
    const server = pageServer();
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

/**
 * A fresh browser pane opens on http://localhost:3000 with no history, so
 * serving the fixture page there is the only way to photograph a loaded page
 * with Back honestly disabled (navigating anywhere pushes history). Null when
 * the port is taken.
 */
function startDefaultUrlServer(): Promise<Server | null> {
  return new Promise((resolve) => {
    const server = pageServer();
    server.once("error", () => resolve(null));
    server.listen(DEFAULT_BROWSER_PORT, "::", () => resolve(server));
  });
}

test("pane toolbars and find bars — every theme", async () => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_PANE_TOOLBARS is required for the pane toolbar capture",
  });
  test.skip(!ENABLED, "Set DAINTREE_SHOT_PANE_TOOLBARS=1 to run the pane toolbar capture");
  if (!OUTPUT_DIR)
    throw new Error("DESIGN_CAPTURE_DIR must be set to a directory outside the repo");
  test.setTimeout(30 * 60_000);

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
  const userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-panetoolbars-"));
  const { server, baseUrl } = await startServer();
  const defaultServer = await startDefaultUrlServer();
  if (!defaultServer) {
    console.warn(
      `[pane-toolbars] port ${DEFAULT_BROWSER_PORT} is taken; browser-toolbar will fail (Back enabled after navigating)`
    );
  }
  let ctx: AppContext | undefined;
  const failures: string[] = [];
  try {
    ctx = await launchApp({
      userDataDir,
      screenshotScale: SCALE,
      windowSize: { width: 1440, height: 900 },
      extraArgs: ["--disable-gpu", "--in-process-gpu", "--disable-breakpad", "--noerrdialogs"],
    });
    const page = await openAndOnboardProject(ctx.app, ctx.window, repo.dir, "Helios Dashboard");
    await dismissBlockingPalette(page);

    for (const theme of THEMES) {
      try {
        await captureTheme({
          page,
          theme,
          repoDir: repo.dir,
          baseUrl,
          defaultUrlServed: !!defaultServer,
          failures,
        });
      } catch (error) {
        failures.push(`${theme}: ${String(error).split("\n")[0]}`);
      }
    }

    const reachable = STATES.filter((s) => !UNREACHABLE[s]);
    const written = new Set(readdirSync(OUTPUT_DIR).filter((f) => f.endsWith(".png")));
    const missing = THEMES.flatMap((t) =>
      reachable.map((s) => `${s}--${t}.png`).filter((f) => !written.has(f))
    );
    console.log(
      `[pane-toolbars] wrote ${written.size}/${reachable.length * THEMES.length} PNGs to ${OUTPUT_DIR}`
    );
    expect(failures, "state captures failed").toEqual([]);
    expect(missing, "frames missing from the output directory").toEqual([]);
    expect(written.size, "unexpected extra frames").toBe(reachable.length * THEMES.length);
  } finally {
    if (ctx?.app) await closeApp(ctx.app).catch(() => {});
    server.close();
    defaultServer?.close();
    repo.cleanup();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
