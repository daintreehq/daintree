/**
 * The CodeMirror find bar, in the read-only file viewer and the editable
 * Markdown editor.
 *
 * Both editors mount one panel (`editorSearchPanel.ts`), docked above the
 * document. The states that carry its design are the ones a search actually
 * passes through: just opened, a query with many hits, a step onto one of them,
 * a miss, a pattern that does not compile, a count past the cap in a large
 * file, the editable bar with its replace row, and a pane narrow enough to
 * wrap the row. The stepped state is also swept across themes for a sheet.
 *
 * One launch. Every panel is opened the way a user opens it (`file.openPanel`,
 * the editing hint, a click into the document, then Cmd+F), and every query is
 * typed through the keyboard.
 *
 *   npm run build
 *   DAINTREE_SHOT_EDITOR_FIND=1 DESIGN_CAPTURE_DIR=/tmp/out \
 *     npx playwright test --project=screenshots editor-find-bar-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_EDITOR_FIND   required — any truthy value runs the capture
 *   DESIGN_CAPTURE_DIR          required — output directory (never the repo)
 *   DAINTREE_SHOT_THEMES        themes for every state (default `daintree,bondi`)
 *   DAINTREE_SHOT_SWEEP_THEMES  themes for the stepped-state sweep (default:
 *                               twelve built-ins; empty string skips the sweep)
 *   DAINTREE_SCREENSHOT_SCALE   device scale factor (default 2)
 *
 * Output: <dir>/<state>--<theme>.png and <dir>/sweep-stepped--<theme>.png.
 * Every frame asserts what it claims to show (the typed query, the option
 * state, the highlighted or selected match) after the settle and before it is
 * written, and the run fails unless the files on disk match the manifest.
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

const ENABLED = !!process.env.DAINTREE_SHOT_EDITOR_FIND;
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
const LARGE_FILE = "src/generated/routeTable.ts";
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

export class RetryBudgetExceeded extends Error {
  constructor(readonly attempts: number) {
    super(\`retry budget exhausted after \${attempts} attempts\`);
  }
}

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

export async function retryWithBackoff<T>(
  task: (attempt: number) => Promise<T>,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
  logger?: Logger
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= policy.maxRetries; attempt++) {
    try {
      return await task(attempt);
    } catch (error) {
      lastError = error;
      if (!isRetryable(error) || attempt === policy.maxRetries) break;
      const delay = retryDelay(policy, attempt);
      logger?.warn(\`retry \${attempt + 1}/\${policy.maxRetries} in \${delay}ms\`, { error });
      await sleep(delay);
    }
  }
  if (lastError instanceof Error && !isRetryable(lastError)) throw lastError;
  throw new RetryBudgetExceeded(policy.maxRetries + 1);
}

/** Wraps a client method so every call goes through retryWithBackoff. */
export function withRetry<A extends unknown[], T>(
  method: (...args: A) => Promise<T>,
  policy?: Partial<RetryPolicy>
): (...args: A) => Promise<T> {
  const merged = { ...DEFAULT_RETRY_POLICY, ...policy };
  return (...args) => retryWithBackoff(() => method(...args), merged);
}
`;

function largeSource(): string {
  const rows: string[] = [
    "// Generated by scripts/build-routes.mjs. Do not edit by hand.",
    "export const routeTable = [",
  ];
  for (let i = 0; i < 1400; i++) {
    const n = String(i).padStart(4, "0");
    rows.push(
      `  { route: "/api/v1/resource-${n}", handler: "handleResource${n}", cache: ${i % 3} },`
    );
  }
  rows.push("] as const;", "");
  return rows.join("\n");
}

const NOTES_SOURCE = `# Agent notes

Working notes for the agent fleet. Each agent gets its own worktree, and the
notes below record what every agent should know before it starts.

## Before an agent starts

- The agent reads \`AGENTS.md\` first, then this file.
- Never let an agent push to \`main\`; every agent works on a branch.
- An agent that stalls for ten minutes is parked, not killed.

## Handing work between agents

When one agent finishes and another picks up the branch, the first agent
leaves a short summary at the top of the PR. The next agent reads it before
touching code.

## Known issues

- The review agent sometimes re-raises findings an earlier agent already fixed.
- Broadcasting to every agent at once can starve the slowest agent of CPU.
`;

const manifest: { file: string; state: string; theme: string }[] = [];
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
  below = 330
): Promise<void> {
  await page.mouse.move(2, 2);
  await settle(page, 300);
  const box = await panel.boundingBox();
  const bar = await panel.locator(".cm-panels-top").first().boundingBox();
  if (!box || !bar) throw new Error(`${state}: pane or find bar has no box`);
  const viewport = page.viewportSize() ?? WIDE;
  const bottom = Math.min(box.y + box.height, bar.y + bar.height + below, viewport.height);
  const file = `${state}--${theme}.png`;
  await page.screenshot({
    path: path.join(OUTPUT_DIR, file),
    type: "png",
    animations: "disabled",
    caret: "hide",
    clip: {
      x: box.x,
      y: box.y,
      width: Math.min(box.width, viewport.width - box.x),
      height: bottom - box.y,
    },
  });
  manifest.push({ file, state, theme });
}

async function openFilePanel(page: Page, filePath: string): Promise<Locator> {
  const opened = await dispatchAction<{ panelId?: string }>(page, "file.openPanel", {
    path: filePath.replace(/\\/g, "/"),
  });
  const panelId = opened.ok ? opened.result?.panelId : undefined;
  if (!panelId) throw new Error(`file.openPanel failed: ${JSON.stringify(opened)}`);
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

async function typeQuery(page: Page, searchPanel: Locator, query: string): Promise<void> {
  const input = searchPanel.locator("input[name=search]");
  await input.focus();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Backspace");
  if (query) await input.pressSequentially(query, { delay: 25 });
  await expect(input).toHaveValue(query);
  await settle(page, 250);
}

/** An option, as a pressed-state toggle or (before #16640) CodeMirror's checkbox. */
async function setOption(searchPanel: Locator, name: string, on: boolean): Promise<void> {
  const toggle = searchPanel.locator(`button[name=${name}]`);
  if ((await toggle.count()) > 0) {
    if (((await toggle.getAttribute("aria-pressed")) === "true") !== on) await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", String(on));
    return;
  }
  const box = searchPanel.locator(`input[name=${name}]`);
  if ((await box.isChecked()) !== on) await box.click();
  await expect(box).toBeChecked({ checked: on });
}

/** The count, when the bar has one (it did not before #16640). */
async function expectStatus(searchPanel: Locator, expected: string | RegExp): Promise<void> {
  const status = searchPanel.locator("[data-find-status]");
  if ((await status.count()) === 0) return;
  await expect(status).toHaveText(expected, { timeout: T_MEDIUM });
}

async function pressEnter(page: Page, searchPanel: Locator, times: number): Promise<void> {
  const input = searchPanel.locator("input[name=search]");
  for (let i = 0; i < times; i++) {
    await input.press("Enter");
    await settle(page, 120);
  }
  await settle(page, 250);
}

async function expectHits(panel: Locator): Promise<void> {
  await expect
    .poll(() => panel.locator(".cm-searchMatch").count(), { timeout: T_MEDIUM })
    .toBeGreaterThan(0);
}

async function expectSelectedHit(panel: Locator): Promise<void> {
  await expect(panel.locator(".cm-searchMatch-selected").first()).toBeVisible({
    timeout: T_MEDIUM,
  });
}

async function expectNoHits(panel: Locator): Promise<void> {
  await expect(panel.locator(".cm-searchMatch")).toHaveCount(0, { timeout: T_MEDIUM });
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

test("editor find bar review", async () => {
  test.setTimeout(30 * 60_000);
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_EDITOR_FIND is required for the editor find bar capture",
  });
  test.skip(!ENABLED, "Set DAINTREE_SHOT_EDITOR_FIND to run the editor find bar capture");
  if (!OUTPUT_DIR) throw new Error("DESIGN_CAPTURE_DIR is required");
  mkdirSync(OUTPUT_DIR, { recursive: true });

  const repo = createFixtureRepo({ name: "editor-find-bar" });
  for (const [relative, source] of [
    [CODE_FILE, CODE_SOURCE],
    [LARGE_FILE, largeSource()],
    [NOTES_FILE, NOTES_SOURCE],
  ] as const) {
    mkdirSync(path.dirname(path.join(repo.dir, relative)), { recursive: true });
    writeFileSync(path.join(repo.dir, relative), source);
  }
  const userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-editor-find-"));
  let ctx: AppContext | undefined;

  try {
    ctx = await launchApp({ userDataDir, screenshotScale: SCALE, windowSize: WIDE });
    const app = ctx.app;
    const page = await openAndOnboardProject(ctx.app, ctx.window, repo.dir, "Editor Find");
    const project = await page.evaluate(() => window.electron.project.getCurrent());
    if (!project) throw new Error("no current project");
    const abs = (relative: string) => path.join(project.path, relative);

    const prepare = async (theme: string): Promise<void> => {
      if (theme !== "daintree" || manifest.length > 0) await setAppTheme(page, theme);
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

        await expect(find.locator("input[name=search]")).toHaveValue("");
        await shoot(page, panel, "01-ro-open-empty", theme);

        await typeQuery(page, find, "retry");
        await expectHits(panel);
        await expectStatus(find, /^\d+ matches$/);
        await shoot(page, panel, "02-ro-typed-many", theme);

        await pressEnter(page, find, 3);
        await expectSelectedHit(panel);
        await expectStatus(find, /^3 of \d+$/);
        await shoot(page, panel, "03-ro-stepped", theme);

        await typeQuery(page, find, "zebra");
        await pressEnter(page, find, 1);
        await expectNoHits(panel);
        await expectStatus(find, "No matches");
        await shoot(page, panel, "04-ro-miss", theme);

        await setOption(find, "re", true);
        await typeQuery(page, find, "retry(");
        await expect(find.locator("input[name=search]")).toHaveAttribute("aria-invalid", "true");
        await expectStatus(find, "Invalid regex");
        await shoot(page, panel, "05-ro-invalid-regex", theme);
        await setOption(find, "re", false);

        // A query that only hits at the end of the file: stepping onto it
        // scrolls the document, so the bar meets the sticky scope line.
        await typeQuery(page, find, "merged");
        await pressEnter(page, find, 1);
        await expectSelectedHit(panel);
        await expectStatus(find, "1 of 2");
        await shoot(page, panel, "11-ro-scrolled", theme, 2000);
        await typeQuery(page, find, "");

        await closePanel(page, panel);
      });

      await step(page, `large file ${theme}`, async () => {
        const panel = await openFilePanel(page, abs(LARGE_FILE));
        const find = await openFind(page, panel);
        await typeQuery(page, find, "route");
        await expectHits(panel);
        await expectStatus(find, "1000+ matches");
        await shoot(page, panel, "06-ro-capped-typed", theme);
        await pressEnter(page, find, 2);
        await expectSelectedHit(panel);
        await expectStatus(find, "2 of 1000+");
        await shoot(page, panel, "07-ro-capped-stepped", theme);
        // Back past the first match wraps to the last, well beyond the cap.
        await find.locator("input[name=search]").press("Shift+Enter");
        await find.locator("input[name=search]").press("Shift+Enter");
        await settle(page, 400);
        await expectSelectedHit(panel);
        await expectStatus(find, /^14\d\d of 1000\+$/);
        await shoot(page, panel, "13-ro-capped-last", theme, 2000);
        await typeQuery(page, find, "");
        await closePanel(page, panel);
      });

      await step(page, `editable ${theme}`, async () => {
        const panel = await openFilePanel(page, abs(NOTES_FILE));
        await enterEditMode(page, panel);
        const find = await openFind(page, panel);
        await expect(find.locator("input[name=replace]")).toBeVisible();
        await typeQuery(page, find, "agent");
        await pressEnter(page, find, 2);
        await expectSelectedHit(panel);
        await expectStatus(find, /^\d+ of \d+$/);
        await shoot(page, panel, "08-ed-stepped", theme);

        await typeQuery(page, find, "zebra");
        await pressEnter(page, find, 1);
        await expectNoHits(panel);
        await expectStatus(find, "No matches");
        await shoot(page, panel, "09-ed-miss", theme);
        await typeQuery(page, find, "");
        await closePanel(page, panel);
      });

      await step(page, `narrow ${theme}`, async () => {
        await setWindowSize(app, NARROW);
        await settle(page, 600);
        const panel = await openFilePanel(page, abs(CODE_FILE));
        const find = await openFind(page, panel);
        await typeQuery(page, find, "retry");
        await pressEnter(page, find, 3);
        await expectSelectedHit(panel);
        await shoot(page, panel, "10-ro-narrow-stepped", theme);
        await typeQuery(page, find, "");
        await closePanel(page, panel);
        await setWindowSize(app, WIDE);
        await settle(page, 500);
      });

      await step(page, `editable narrow unwrapped ${theme}`, async () => {
        // Wrap off while the toolbar is wide enough to show the toggle; the
        // narrow pane then scrolls the long lines sideways.
        const panel = await openFilePanel(page, abs(NOTES_FILE));
        await enterEditMode(page, panel);
        const wrap = panel.getByRole("button", { name: "Wrap long lines" });
        if ((await wrap.getAttribute("aria-pressed")) === "true") await wrap.click();
        await expect(wrap).toHaveAttribute("aria-pressed", "false");
        await setWindowSize(app, NARROW);
        await settle(page, 600);
        const find = await openFind(page, panel);
        await typeQuery(page, find, "branch");
        await pressEnter(page, find, 1);
        await expectSelectedHit(panel);
        await expectStatus(find, /^1 of \d+$/);
        await shoot(page, panel, "12-ed-narrow-unwrapped", theme);
        await typeQuery(page, find, "");
        await setWindowSize(app, WIDE);
        await settle(page, 500);
        if ((await wrap.getAttribute("aria-pressed")) === "false") await wrap.click();
        await closePanel(page, panel);
      });
    }

    for (const theme of SWEEP_THEMES) {
      await step(page, `sweep ${theme}`, async () => {
        await prepare(theme);
        const panel = await openFilePanel(page, abs(CODE_FILE));
        const find = await openFind(page, panel);
        await typeQuery(page, find, "retry");
        await pressEnter(page, find, 3);
        await expectSelectedHit(panel);
        await shoot(page, panel, "sweep-stepped", theme, 120);
        await typeQuery(page, find, "");
        await closePanel(page, panel);
      });
    }
  } finally {
    if (ctx) await closeApp(ctx.app);
    repo.cleanup();
  }

  const written = new Set(readdirSync(OUTPUT_DIR).filter((f) => f.endsWith(".png")));
  const missing = manifest.filter((m) => !written.has(m.file)).map((m) => m.file);
  const report = `${manifest.length} frames in the manifest, ${written.size} PNGs on disk`;
  if (failures.length > 0 || missing.length > 0) {
    throw new Error(
      `[editor-find-shots] ${failures.length} step(s) failed, ${missing.length} frame(s) missing (${report}):\n` +
        [...failures, ...missing.map((m) => `missing ${m}`)].join("\n")
    );
  }
  if (manifest.length === 0) throw new Error("[editor-find-shots] no frames were captured");
  console.log(`[editor-find-shots] ${report} in ${OUTPUT_DIR}`);
});
