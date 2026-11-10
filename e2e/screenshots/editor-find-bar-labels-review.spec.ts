/**
 * The CodeMirror find bar's controls: their labels, names, focus and fit.
 *
 * Both editors mount one panel (`editorSearchPanel.ts`) docked above the
 * document: the read-only file viewer with the find row alone, and the editable
 * Markdown editor with the replace row under it. The states that carry the
 * controls' design are the rows at rest with a query, the options switched on,
 * keyboard focus on a text button, and panes narrow enough to wrap the row.
 * The editable bar is also swept across themes for a sheet.
 *
 * Beside the frames the run writes `metrics.json` (the width the find row needs
 * to stay on one line, and how many lines it takes at each width) and
 * `aria--<theme>.txt` (the panel's accessibility tree), so a label change can be
 * judged on its names and its fit as well as its pixels.
 *
 *   npm run build:e2e
 *   DAINTREE_SHOT_EDITOR_FIND_LABELS=1 DESIGN_CAPTURE_DIR=/tmp/out \
 *     npx playwright test --project=screenshots editor-find-bar-labels-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_EDITOR_FIND_LABELS  required — any truthy value runs the capture
 *   DESIGN_CAPTURE_DIR                required — output directory (never the repo)
 *   DAINTREE_SHOT_THEMES              themes for every state (default `daintree,bondi`)
 *   DAINTREE_SHOT_SWEEP_THEMES        themes for the editable-bar sweep (default:
 *                                     twelve built-ins; empty string skips it)
 *   DAINTREE_SCREENSHOT_SCALE         device scale factor (default 2)
 *
 * Output: <dir>/<state>--<theme>.png and <dir>/sweep-editable--<theme>.png.
 * Every frame asserts what it claims to show (the typed query, the option
 * state, the focused control) after the settle and before it is written, and
 * the run fails unless the files on disk match the manifest.
 */

import { expect, test, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import { mkdtempSync, mkdirSync, readdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { createFixtureRepo } from "../helpers/fixtures";
import { openAndOnboardProject } from "../helpers/project";
import { dismissBlockingPalette } from "../helpers/overlays";
import { setAppTheme } from "../helpers/theme";
import { dispatchAction } from "../helpers/actions";
import { T_LONG, T_MEDIUM } from "../helpers/timeouts";

const ENABLED = !!process.env.DAINTREE_SHOT_EDITOR_FIND_LABELS;
const OUTPUT_DIR = process.env.DESIGN_CAPTURE_DIR
  ? path.resolve(process.env.DESIGN_CAPTURE_DIR)
  : "";
const SCALE = process.env.DAINTREE_SCREENSHOT_SCALE ?? "2";
const list = (value: string): string[] =>
  value
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
const THEMES = list(process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi");
const SWEEP_THEMES = list(
  process.env.DAINTREE_SHOT_SWEEP_THEMES ??
    "daintree,arashiyama,fiordland,galapagos,highlands,namib,redwoods,svalbard,bondi,atacama,bali,hokkaido"
);

const WIDE = { width: 1440, height: 900 };
const NARROW = { width: 900, height: 900 };
// The app's minimum: a pane narrow enough that the query field shrinks to keep
// navigation beside it.
const NARROWEST = { width: 800, height: 900 };

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

const CODE_FILE = "src/services/retryPolicy.ts";
const NOTES_FILE = "docs/agent-notes.md";

const CODE_SOURCE = `import { sleep } from "../lib/sleep";
import type { Logger } from "../lib/logger";

/** How a failed request is retried: attempts, backoff and the retry budget. */
export interface RetryPolicy {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Fraction of the delay drawn at random so retries from many clients spread out. */
  jitter: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 5,
  baseDelayMs: 200,
  maxDelayMs: 8_000,
  jitter: 0.2,
};

/** The delay before retry number \`attempt\`, capped and jittered. */
export function retryDelay(policy: RetryPolicy, attempt: number, random = Math.random): number {
  const exponential = policy.baseDelayMs * 2 ** attempt;
  const capped = Math.min(policy.maxDelayMs, exponential);
  const spread = capped * policy.jitter;
  return Math.round(capped - spread + random() * spread * 2);
}

export function isRetryable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const status = (error as { status?: number }).status;
  if (status === undefined) return true;
  return status === 408 || status === 429 || status >= 500;
}
`;

const NOTES_SOURCE = `# Agent notes

Working notes for the agent fleet. Each agent gets its own worktree, and the
notes below record what every agent should know before it starts.

## Before an agent starts

- The agent reads \`AGENTS.md\` first, then this file.
- Never let an agent push to \`main\`; every agent works on a branch.
- An agent that stalls for ten minutes is parked, not killed.

## Handing work between agents

When one agent finishes and another picks up the branch, the first agent
leaves a short summary at the top of the PR.
`;

interface RowMetrics {
  state: string;
  theme: string;
  paneWidth: number;
  panelWidth: number;
  /**
   * Width the find row (query field through the last option, plus the panel's
   * insets) needs on one line: below it, the row wraps.
   */
  findRowWidth: number;
  /** Distinct line boxes the panel's controls occupy at this width. */
  lines: number;
  controls: { name: string; text: string; width: number }[];
}

const manifest: { file: string; state: string; theme: string }[] = [];
const metrics: RowMetrics[] = [];
const failures: string[] = [];

async function settle(page: Page, ms = 350): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
  );
  await page.waitForTimeout(ms);
}

async function setWindowSize(
  app: ElectronApplication,
  size: { width: number; height: number }
): Promise<void> {
  await app.evaluate(({ BrowserWindow }, s) => {
    const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.isVisible());
    win?.setSize(s.width, s.height);
  }, size);
}

async function step(page: Page, name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    failures.push(`${name}: ${String(error).slice(0, 500)}`);
    await dismissBlockingPalette(page).catch(() => {});
  }
}

/** The pane from its top edge to a few lines below the find bar. */
async function shoot(
  page: Page,
  panel: Locator,
  state: string,
  theme: string,
  below = 150,
  { keepPointer = false }: { keepPointer?: boolean } = {}
): Promise<void> {
  if (!keepPointer) await page.mouse.move(2, 2);
  await settle(page, 300);
  const box = await panel.boundingBox();
  const bar = await panel.locator(".cm-panels-top").first().boundingBox();
  if (!box || !bar) throw new Error(`${state}: pane or find bar has no box`);
  const viewport = page.viewportSize() ?? WIDE;
  const top = below < 100 ? bar.y : box.y;
  const bottom = Math.min(box.y + box.height, bar.y + bar.height + below, viewport.height);
  const file = `${state}--${theme}.png`;
  await page.screenshot({
    path: path.join(OUTPUT_DIR, file),
    type: "png",
    animations: "disabled",
    caret: "hide",
    clip: {
      x: box.x,
      y: top,
      width: Math.min(box.width, viewport.width - box.x),
      height: bottom - top,
    },
  });
  manifest.push({ file, state, theme });
}

async function measure(panel: Locator, state: string, theme: string): Promise<void> {
  const measured = await panel.evaluate((pane) => {
    const search = pane.querySelector<HTMLElement>(".cm-panel.cm-search");
    if (!search) throw new Error("no search panel");
    const px = (value: string) => parseFloat(value) || 0;
    const outer = (el: Element) => {
      const style = getComputedStyle(el);
      return el.getBoundingClientRect().width + px(style.marginLeft) + px(style.marginRight);
    };
    const inFlow = (el: Element) =>
      el.tagName !== "BR" && getComputedStyle(el).position !== "absolute";
    // The width an element needs to keep its controls on one line: a row or
    // group sums its children and gaps, and a field that shrinks to make room
    // counts at its flex basis, the narrowest it gets before anything wraps.
    const oneLine = (el: Element): number => {
      const style = getComputedStyle(el);
      if (el.classList.contains("cm-search-row") || el.classList.contains("cm-search-group")) {
        const kids = Array.from(el.children).filter(inFlow);
        return (
          kids.reduce((sum, kid) => sum + oneLine(kid), 0) +
          px(style.columnGap) * Math.max(0, kids.length - 1) +
          px(style.paddingLeft) +
          px(style.paddingRight)
        );
      }
      if (px(style.flexGrow) > 0 && style.flexBasis.endsWith("px")) {
        return px(style.flexBasis) + px(style.marginLeft) + px(style.marginRight);
      }
      return outer(el);
    };
    const style = getComputedStyle(search);
    const row = search.querySelector(".cm-search-row");
    let findRowWidth: number;
    if (row) {
      findRowWidth = oneLine(row);
    } else {
      // CodeMirror's own layout: inline controls up to the <br>.
      findRowWidth = 0;
      for (const el of Array.from(search.children)) {
        if (el.tagName === "BR") break;
        if (inFlow(el)) findRowWidth += outer(el);
      }
    }
    findRowWidth += px(style.paddingLeft) + px(style.paddingRight);
    // A control that starts left of the one before it opened a new line; tops
    // can't tell, since the field and the buttons are different heights.
    const leaves = Array.from(
      search.querySelectorAll(".search-field, button:not([name=close]), label, .cm-textfield")
    );
    let lines = leaves.length > 0 ? 1 : 0;
    for (let i = 1; i < leaves.length; i++) {
      if (leaves[i].getBoundingClientRect().left < leaves[i - 1].getBoundingClientRect().left) {
        lines++;
      }
    }
    return {
      paneWidth: Math.round(pane.getBoundingClientRect().width),
      panelWidth: Math.round(search.getBoundingClientRect().width),
      findRowWidth: Math.round(findRowWidth),
      lines,
      controls: Array.from(
        search.querySelectorAll(".search-field, button, label, .cm-textfield")
      ).map((el) => ({
        name:
          el.getAttribute("name") ??
          el.querySelector("input")?.getAttribute("name") ??
          (el.classList.contains("search-field") ? "search" : ""),
        text: (el.textContent ?? "").trim(),
        width: Math.round(outer(el)),
      })),
    };
  });
  metrics.push({ state, theme, ...measured });
}

async function openFilePanel(page: Page, filePath: string): Promise<Locator> {
  const opened = await dispatchAction<{ panelId?: string }>(page, "file.openPanel", {
    path: filePath.replace(/\\/g, "/"),
  });
  const panelId = opened.result?.panelId;
  if (!opened.ok || !panelId) throw new Error(`file.openPanel failed: ${JSON.stringify(opened)}`);
  const panel = page.locator(`[data-panel-id="${panelId}"]`);
  await panel.waitFor({ state: "visible", timeout: T_LONG });
  await panel.locator(".cm-content").first().waitFor({ state: "visible", timeout: T_LONG });
  await settle(page, 600);
  return panel;
}

async function closePanel(page: Page, panel: Locator): Promise<void> {
  const panelId = await panel.getAttribute("data-panel-id");
  if (panelId) await dispatchAction(page, "terminal.close", { terminalId: panelId });
  await settle(page, 500);
}

/** Into the document, then Cmd+F; the bus event the keybinding fires is the fallback. */
async function openFind(page: Page, panel: Locator): Promise<Locator> {
  const searchPanel = panel.locator(".cm-panel.cm-search");
  if (await searchPanel.isVisible().catch(() => false)) return searchPanel;
  await panel
    .locator(".cm-content")
    .first()
    .click({ position: { x: 40, y: 8 } });
  await settle(page, 200);
  await page.keyboard.press("Meta+f");
  const shown = await searchPanel
    .waitFor({ state: "visible", timeout: 2500 })
    .then(() => true)
    .catch(() => false);
  if (!shown) {
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("daintree:find-in-panel")));
    await searchPanel.waitFor({ state: "visible", timeout: T_MEDIUM });
  }
  await expect(searchPanel.locator("input[name=search]")).toBeFocused();
  await settle(page, 250);
  return searchPanel;
}

async function fill(page: Page, input: Locator, value: string): Promise<void> {
  await input.focus();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Backspace");
  if (value) await input.pressSequentially(value, { delay: 20 });
  await expect(input).toHaveValue(value);
  await settle(page, 250);
}

async function setOption(searchPanel: Locator, name: string, on: boolean): Promise<void> {
  const box = searchPanel.locator(`input[name=${name}]`);
  if ((await box.isChecked()) !== on) await box.click();
  await expect(box).toBeChecked({ checked: on });
}

/** Tabs from `from` until the control named `target` holds keyboard focus. */
async function tabTo(page: Page, from: Locator, searchPanel: Locator, target: string) {
  await from.focus();
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press("Tab");
    const name = await page.evaluate(() => document.activeElement?.getAttribute("name") ?? "");
    if (name === target) break;
  }
  await expect(searchPanel.locator(`[name=${target}]`)).toBeFocused();
  const visible = await searchPanel
    .locator(`[name=${target}]`)
    .evaluate((el) => el.matches(":focus-visible"));
  if (!visible) throw new Error(`${target} is focused but not :focus-visible`);
  await settle(page, 200);
}

async function expectHits(panel: Locator): Promise<void> {
  await expect
    .poll(() => panel.locator(".cm-searchMatch").count(), { timeout: T_MEDIUM })
    .toBeGreaterThan(0);
}

/** Turns the editor on for a Markdown pane: the hint the first time, the Edit radio after. */
async function enterEditMode(page: Page, panel: Locator): Promise<void> {
  const edit = panel.getByRole("radio", { name: "Edit", exact: true });
  const hint = panel.locator('[data-testid="file-editor-hint-action"]');
  if (await hint.isVisible().catch(() => false)) {
    await hint.click();
  } else if ((await edit.getAttribute("aria-checked").catch(() => null)) !== "true") {
    await edit.click();
  }
  await expect(edit).toHaveAttribute("aria-checked", "true", { timeout: T_LONG });
  await panel
    .locator('[data-testid="markdown-editor"] .cm-content')
    .first()
    .waitFor({ state: "visible", timeout: T_LONG });
  await settle(page, 600);
}

async function openEditableFind(page: Page, abs: (p: string) => string) {
  const panel = await openFilePanel(page, abs(NOTES_FILE));
  await enterEditMode(page, panel);
  const find = await openFind(page, panel);
  await expect(find.locator("input[name=replace]")).toBeVisible();
  await fill(page, find.locator("input[name=search]"), "agent");
  await expectHits(panel);
  await fill(page, find.locator("input[name=replace]"), "worker");
  return { panel, find };
}

test("editor find bar labels review", async () => {
  test.setTimeout(30 * 60_000);
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_EDITOR_FIND_LABELS is required for the find bar labels capture",
  });
  test.skip(!ENABLED, "Set DAINTREE_SHOT_EDITOR_FIND_LABELS to run the find bar labels capture");
  if (!OUTPUT_DIR) throw new Error("DESIGN_CAPTURE_DIR is required");
  mkdirSync(OUTPUT_DIR, { recursive: true });

  const repo = createFixtureRepo({ name: "editor-find-labels" });
  for (const [relative, source] of [
    [CODE_FILE, CODE_SOURCE],
    [NOTES_FILE, NOTES_SOURCE],
  ] as const) {
    mkdirSync(path.dirname(path.join(repo.dir, relative)), { recursive: true });
    writeFileSync(path.join(repo.dir, relative), source);
  }
  const userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-editor-find-labels-"));
  let ctx: AppContext | undefined;
  let themed = false;

  try {
    ctx = await launchApp({ userDataDir, screenshotScale: SCALE, windowSize: WIDE });
    const app = ctx.app;
    const page = await openAndOnboardProject(ctx.app, ctx.window, repo.dir, "Editor Find");
    const project = await page.evaluate(() => window.electron.project.getCurrent());
    if (!project) throw new Error("no current project");
    const abs = (relative: string) => path.join(project.path, relative);

    const prepare = async (theme: string): Promise<void> => {
      if (theme !== "daintree" || themed) await setAppTheme(page, theme);
      themed = true;
      await page.addStyleTag({ content: POLISH_CSS }).catch(() => {});
      await dismissBlockingPalette(page);
      await settle(page, 600);
    };

    for (const theme of THEMES) {
      await prepare(theme);
      await setWindowSize(app, WIDE);
      await settle(page, 500);

      await step(page, `read-only ${theme}`, async () => {
        const panel = await openFilePanel(page, abs(CODE_FILE));
        const find = await openFind(page, panel);
        const query = find.locator("input[name=search]");

        await fill(page, query, "retry");
        await expectHits(panel);
        await shoot(page, panel, "01-ro-typed", theme);
        await measure(panel, "01-ro-typed", theme);

        for (const name of ["case", "re", "word"]) await setOption(find, name, true);
        await fill(page, query, "retry");
        await shoot(page, panel, "02-ro-options-on", theme);
        for (const name of ["case", "re", "word"]) await setOption(find, name, false);

        await fill(page, query, "retry");
        const firstButton = await find
          .locator("button[name]:not([name=close])")
          .first()
          .evaluate((el) => el.getAttribute("name") ?? "");
        await tabTo(page, query, find, firstButton);
        await shoot(page, panel, "03-ro-focus-button", theme);

        await fill(page, query, "");
        await closePanel(page, panel);
      });

      await step(page, `editable ${theme}`, async () => {
        const { panel, find } = await openEditableFind(page, abs);
        await shoot(page, panel, "04-ed-typed", theme);
        await measure(panel, "04-ed-typed", theme);
        writeFileSync(path.join(OUTPUT_DIR, `aria--${theme}.txt`), await find.ariaSnapshot());

        await tabTo(page, find.locator("input[name=replace]"), find, "replaceAll");
        await shoot(page, panel, "05-ed-focus-replace-all", theme);

        await fill(page, find.locator("input[name=replace]"), "");
        await fill(page, find.locator("input[name=search]"), "");
        await closePanel(page, panel);
      });

      await step(page, `narrow ${theme}`, async () => {
        await setWindowSize(app, NARROW);
        await settle(page, 600);

        const ro = await openFilePanel(page, abs(CODE_FILE));
        const roFind = await openFind(page, ro);
        await fill(page, roFind.locator("input[name=search]"), "retry");
        await expectHits(ro);
        await shoot(page, ro, "06-ro-narrow", theme);
        await measure(ro, "06-ro-narrow", theme);
        await fill(page, roFind.locator("input[name=search]"), "");
        await closePanel(page, ro);

        const { panel, find } = await openEditableFind(page, abs);
        await shoot(page, panel, "07-ed-narrow", theme);
        await measure(panel, "07-ed-narrow", theme);

        await setWindowSize(app, NARROWEST);
        await settle(page, 600);
        await shoot(page, panel, "08-ed-narrowest", theme);
        await measure(panel, "08-ed-narrowest", theme);

        await fill(page, find.locator("input[name=replace]"), "");
        await fill(page, find.locator("input[name=search]"), "");
        await closePanel(page, panel);

        await setWindowSize(app, WIDE);
        await settle(page, 500);
      });
    }

    for (const theme of SWEEP_THEMES) {
      await step(page, `sweep ${theme}`, async () => {
        await prepare(theme);
        const { panel, find } = await openEditableFind(page, abs);
        await shoot(page, panel, "sweep-editable", theme, 24);
        await fill(page, find.locator("input[name=replace]"), "");
        await fill(page, find.locator("input[name=search]"), "");
        await closePanel(page, panel);
      });
    }
  } finally {
    if (ctx) await closeApp(ctx.app);
    repo.cleanup();
  }

  writeFileSync(path.join(OUTPUT_DIR, "metrics.json"), JSON.stringify(metrics, null, 2));
  const written = new Set(readdirSync(OUTPUT_DIR).filter((f) => f.endsWith(".png")));
  const missing = manifest.filter((m) => !written.has(m.file)).map((m) => m.file);
  const report = `${manifest.length} frames in the manifest, ${written.size} PNGs on disk`;
  if (failures.length > 0 || missing.length > 0) {
    throw new Error(
      `[editor-find-labels-shots] ${failures.length} step(s) failed, ${missing.length} frame(s) missing (${report}):\n` +
        [...failures, ...missing.map((m) => `missing ${m}`)].join("\n")
    );
  }
  if (manifest.length === 0) throw new Error("[editor-find-labels-shots] no frames were captured");
  console.log(`[editor-find-labels-shots] ${report} in ${OUTPUT_DIR}`);
});
