/**
 * Tooltip-consistency visual-review harness.
 *
 * The question under review is whether every icon/action button explains itself
 * the same way: through the shared Radix `Tooltip` (`src/components/ui/tooltip.tsx`).
 * Many sites still use a native `title=`, which the OS draws and Playwright cannot
 * photograph — so a plain screenshot of those shows nothing and reads as "fine".
 *
 * This drives `tooltip-consistency-preview.html`, which mounts the REAL components
 * against seeded stores, and for every trigger photographs what a user gets when
 * hovering (and, for a few, keyboard-focusing) it:
 *   - the styled tooltip, measured (max-width, padding, weight, colour, gap …); or
 *   - when there is none, an injected, clearly labelled annotation box quoting the
 *     native `title` the OS would show instead (or saying there is no tooltip);
 *   - when there is BOTH a styled tooltip and a `title` on the trigger or an
 *     ancestor, the annotation is added as well — that is a double-tooltip defect.
 * The annotation is harness DOM, removed after each shot.
 *
 *   DAINTREE_SHOT_TOOLTIPS=1 DAINTREE_SHOT_DIR=/abs/out \
 *     npx playwright test --project=screenshots tooltip-consistency-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_TOOLTIPS  required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR       output directory (default artifacts/tooltip-shots)
 *   DAINTREE_SHOT_THEMES    comma-separated sweep (default daintree,svalbard)
 *
 * Writes `<dir>/manifest.json` with one entry per shot. Never writes a PNG it has
 * not verified: the clip must be non-empty and must contain the tooltip or the
 * annotation, and the test counts the files itself at the end.
 */

import { test, expect, type Locator, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from "fs";
import path from "path";
import { createServer, searchForWorkspaceRoot, type Plugin } from "vite";
import { stubViteHmrClient, type PreviewServer } from "../helpers/previewHarness";

const ENABLED = !!process.env.DAINTREE_SHOT_TOOLTIPS;

const OUT_DIR = path.resolve(
  process.env.DAINTREE_SHOT_DIR ?? path.join(process.cwd(), "artifacts", "tooltip-shots")
);

const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,svalbard")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

const VIEWPORT = { width: 1720, height: 1000 };
const CLIP_PAD = 12;

const PAGE_MODES = ["grid", "plugin-manager", "update-cwd", "update-cwd-long"] as const;
type PageMode = (typeof PAGE_MODES)[number];

/** Pages whose surface is a modal dialog: the frame is the dialog, not a cell. */
const DIALOG_PAGES: readonly PageMode[] = ["update-cwd", "update-cwd-long"];

interface TriggerDef {
  cell: string;
  trigger: string;
  /** CSS selector, scoped to the cell. */
  selector: string;
  /** Also capture the keyboard-focus case. */
  kbd?: boolean;
  /**
   * `cell` clips to the whole cell; `around` to a window around the trigger inside
   * the cell, for cells too large to be a useful frame.
   */
  region?: "cell" | "around";
  page?: PageMode;
}

const TRIGGERS: TriggerDef[] = [
  { cell: "reference", trigger: "plain", selector: '[data-tip-trigger="plain"]' },
  { cell: "reference", trigger: "shortcut", selector: '[data-tip-trigger="shortcut"]' },
  { cell: "help-tabs", trigger: "task-tab", selector: '[role="tab"][aria-selected="true"]' },
  {
    cell: "help-tabs",
    trigger: "close-active",
    selector: '[role="tab"][aria-selected="true"] + button',
  },
  {
    cell: "help-tabs",
    trigger: "new-session",
    selector: 'button[aria-label="New session"]',
    kbd: true,
  },
  { cell: "help-tabs-max", trigger: "new-session", selector: 'button[aria-label="New session"]' },
  { cell: "voice-input", trigger: "mic", selector: 'button[aria-label="Start voice recording"]' },
  {
    cell: "dev-servers",
    trigger: "restart",
    selector: 'button[aria-label="Restart dev server for main"]',
    kbd: true,
  },
  { cell: "dev-servers", trigger: "stop", selector: 'button[aria-label^="Stop dev server for"]' },
  {
    cell: "dev-servers",
    trigger: "dismiss-error",
    selector: 'button[aria-label^="Dismiss error for"]',
  },
  { cell: "dev-servers", trigger: "hide", selector: 'button[aria-label="Hide dev servers"]' },
  {
    cell: "env-vars",
    trigger: "override",
    selector: 'button[aria-label^="Override "]',
    kbd: true,
  },
  { cell: "env-vars", trigger: "revert", selector: 'button[aria-label^="Revert "]' },
  { cell: "env-vars", trigger: "delete", selector: '[data-testid="env-editor-remove"]' },
  { cell: "env-vars", trigger: "reveal", selector: '[data-testid="env-editor-reveal"]' },
  { cell: "preset-chrome", trigger: "rename", selector: 'button[aria-label^="Edit "]' },
  { cell: "fallback-chain", trigger: "move-up", selector: '[data-fallback-action="p-mid:up"]' },
  {
    cell: "fallback-chain",
    trigger: "move-down",
    selector: '[data-fallback-action="p-mid:down"]',
  },
  {
    cell: "fallback-chain",
    trigger: "remove",
    selector: '[data-fallback-action="p-mid:remove"]',
    kbd: true,
  },
  { cell: "diff-note", trigger: "edit", selector: 'button[aria-label="Edit note"]' },
  { cell: "diff-note", trigger: "delete", selector: 'button[aria-label="Delete note"]' },
  { cell: "banner-overflow", trigger: "more", selector: 'button[aria-label="More options"]' },
  { cell: "running-task", trigger: "command", selector: "[data-task-focus]" },
  {
    cell: "saved-fleets",
    trigger: "long-chip",
    selector: '[data-testid="fleet-picker-saved-fleet"]:has-text("Release train")',
  },
  {
    cell: "saved-fleets",
    trigger: "short-chip",
    selector: '[data-testid="fleet-picker-saved-fleet"]:has-text("Bugfix pair")',
  },
  {
    cell: "color-picker",
    trigger: "swatch",
    selector: '[data-testid="preset-color-picker-trigger"]',
  },
  { cell: "turn-outcome", trigger: "pip", selector: 'button[aria-label^="Dismiss repeated"]' },
  {
    cell: "toolbar-indicators",
    trigger: "pr-paused",
    selector: '[data-harness-slot="pr-paused"] [aria-label^="PR detection paused"]',
  },
  {
    cell: "toolbar-indicators",
    trigger: "host-memory",
    selector: '[data-harness-slot="host-memory"] [data-testid="host-memory-pause-indicator"]',
  },
  {
    cell: "toolbar-indicators",
    trigger: "voice-recording",
    selector: '[data-harness-slot="voice-recording"] button',
  },
  { cell: "trash", trigger: "pill", selector: '[data-testid="trash-container"]' },
  { cell: "project-plugin", trigger: "row", selector: "li button.row-select-target" },
  {
    cell: "toolbar",
    trigger: "project-pill",
    selector: '[data-testid="project-switcher-trigger"]',
    region: "around",
  },
  {
    cell: "toolbar",
    trigger: "copy-context",
    selector: 'button[aria-label="Copy context"]',
    region: "around",
  },
  {
    cell: "project-swatches",
    trigger: "swatch-blue",
    selector: 'button[aria-label="Set project color to Blue"]',
    region: "around",
  },
  {
    cell: "project-swatches",
    trigger: "emoji",
    selector: 'button[aria-label="Change project emoji"]',
    region: "around",
  },
  {
    cell: "project-swatches",
    trigger: "custom-color",
    selector: 'input[aria-label="Pick a custom color"]',
    region: "around",
  },
  { cell: "github-list", trigger: "refresh", selector: 'button[aria-label^="Refresh"]' },
  { cell: "github-list", trigger: "sort", selector: 'button[aria-label^="Sort"]', kbd: true },
  { cell: "github-list", trigger: "select", selector: 'button[aria-label^="Select"]' },
  {
    cell: "update-cwd",
    trigger: "app-first",
    selector: 'button[aria-label^="Use "]',
    page: "update-cwd",
  },
  {
    cell: "update-cwd",
    trigger: "app-second",
    selector: 'button[aria-label="Use /Users/greg/worktrees/app"]',
    page: "update-cwd",
  },
  {
    cell: "update-cwd",
    trigger: "long-chip",
    selector: 'button[aria-label^="Use /Users/greg/worktrees/"]',
    page: "update-cwd-long",
    kbd: true,
  },
  {
    cell: "plugin-manager",
    trigger: "installed-row-long",
    selector: 'li button.row-select-target:has-text("Enterprise Compliance")',
    region: "around",
    page: "plugin-manager",
  },
  {
    cell: "plugin-manager",
    trigger: "project-row",
    selector: 'li button.row-select-target:has-text("Release checklist")',
    region: "around",
    page: "plugin-manager",
  },
];

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Measurements {
  rect: Rect;
  side: string | null;
  gapPx: number | null;
  maxWidth: string;
  padding: string;
  fontSize: string;
  fontWeight: string;
  lineHeight: string;
  color: string;
  backgroundColor: string;
  textAlign: string;
  borderRadius: string;
}

interface Probe {
  kind: "styled" | "native" | "none";
  text: string | null;
  nativeTitle: string | null;
  nativeTitleOn: string | null;
  /** Every further `title` up the ancestor chain, nearest first. */
  outerTitles: string[];
  measurements: Measurements | null;
  triggerRect: Rect;
  tooltipRect: Rect | null;
  annotationRect: Rect | null;
}

interface ManifestEntry {
  cell: string;
  trigger: string;
  theme: string;
  mode: "hover" | "kbd";
  kind: Probe["kind"];
  text: string | null;
  nativeTitle: string | null;
  nativeTitleOn: string | null;
  outerTitles: string[];
  doubleTooltip: boolean;
  measurements: Measurements | null;
  focusVia?: "tab" | "focus()";
  file: string;
}

test.use({ deviceScaleFactor: 2 });

/**
 * Files whose dev compile the React Compiler refuses (`panicThreshold:
 * "critical_errors"` in dev), so the whole page would fail to boot. Each is kept
 * away from the compiler's babel pass for THIS harness only — the tooltip wiring
 * under review does not depend on memoization. A module-level `"use no memo"`
 * does not help: the compiler still validates opted-out functions and panics.
 * The refusal itself is a product defect; the spec logs every file it skipped.
 *
 * EnvVarEditor.tsx: "Cannot access refs during render" at `ref={focus.registerFallback}`.
 */
const COMPILER_OPT_OUT = ["/src/components/Settings/EnvVarEditor.tsx"];

function isOptedOut(id: string): boolean {
  const file = id.split("?")[0]!;
  return COMPILER_OPT_OUT.some((suffix) => file.endsWith(suffix));
}

type TransformHandler = (this: unknown, code: string, id: string, ...rest: unknown[]) => unknown;

function compilerOptOutPlugin(): Plugin {
  return {
    name: "tooltip-harness-compiler-opt-out",
    configResolved(config) {
      const babel = config.plugins.find((p) => p.name === "@rolldown/plugin-babel");
      const hook = babel?.transform as { handler?: TransformHandler } | undefined;
      const handler = hook?.handler;
      if (!hook || !handler) {
        throw new Error("compiler opt-out: @rolldown/plugin-babel transform hook not found");
      }
      hook.handler = function (code, id, ...rest) {
        if (isOptedOut(id)) {
          console.log(`[tooltip-harness] React Compiler skipped (dev panic): ${id}`);
          return null;
        }
        return handler.call(this, code, id, ...rest);
      };
    },
  };
}

/** `startPreviewServer`, plus the compiler opt-out above. */
async function startServer(): Promise<PreviewServer> {
  const fsAllow = [searchForWorkspaceRoot(process.cwd())];
  try {
    fsAllow.push(realpathSync(path.join(process.cwd(), "node_modules")));
  } catch {
    // no node_modules to resolve — Vite will say so itself
  }
  const vite = await createServer({
    server: { port: 0, strictPort: false, fs: { allow: fsAllow } },
    plugins: [compilerOptOutPlugin()],
    logLevel: "error",
  });
  await vite.listen();
  const address = vite.httpServer?.address();
  if (!address || typeof address === "string") throw new Error("vite gave no TCP address");
  return { baseURL: `http://127.0.0.1:${address.port}`, close: () => vite.close() };
}

let server: PreviewServer | undefined;
let baseURL = "";

test.beforeAll(async () => {
  if (!ENABLED) return;
  if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });
  server = await startServer();
  baseURL = server.baseURL;
});

test.afterAll(async () => {
  await server?.close();
});

const OPEN_TOOLTIP =
  '[data-radix-popper-content-wrapper] > [data-state="delayed-open"], [data-radix-popper-content-wrapper] > [data-state="instant-open"]';

async function open(page: Page, theme: string, mode: PageMode): Promise<void> {
  await page.setViewportSize(VIEWPORT);
  const url = `${baseURL}/tooltip-consistency-preview.html?theme=${theme}&mode=${mode}`;
  const shell = page.locator("[data-preview-shell]");
  const bootErrors: string[] = [];
  const onBootError = (e: Error) => bootErrors.push(e.message);
  page.on("pageerror", onBootError);
  for (let attempt = 0; ; attempt++) {
    await page.goto(url);
    try {
      await expect(shell).toBeAttached({ timeout: attempt === 0 ? 20_000 : 40_000 });
      break;
    } catch (error) {
      if (attempt >= 2) {
        throw new Error(`theme "${theme}" (${mode}) rendered no shell:\n${bootErrors.join("\n")}`, {
          cause: error,
        });
      }
    }
  }
  page.off("pageerror", onBootError);
  await page.evaluate(() => document.fonts.ready);
  if (mode === "grid") {
    // Radix is lazy-loaded; a trigger only carries `data-state` once it has mounted.
    await expect(page.locator('[data-tip-trigger="plain"][data-state]')).toBeAttached({
      timeout: 15_000,
    });
    // Async fixtures that arrive after the first paint.
    await expect(
      page.locator('[data-shot="dev-servers"] button[aria-label="Restart dev server for main"]')
    ).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[role="toolbar"][aria-label="Main toolbar"]')).toBeVisible({
      timeout: 15_000,
    });
    await expect(
      page.locator('[data-shot="github-list"] button[aria-label^="Select"]:enabled')
    ).toBeVisible({ timeout: 15_000 });
  } else if (DIALOG_PAGES.includes(mode)) {
    // Both suggestions are confirmed asynchronously after the dialog opens.
    await expect(page.locator('[role="dialog"] button[aria-label^="Use "]')).toHaveCount(2, {
      timeout: 15_000,
    });
  } else {
    await expect(page.locator("li button.row-select-target").first()).toBeVisible({
      timeout: 15_000,
    });
  }
  await page.mouse.move(0, 0);
  await page.waitForTimeout(600);
}

/** Move away, drop focus, and wait for every tooltip to be gone. */
async function reset(page: Page): Promise<void> {
  await page.mouse.move(0, 0);
  await page.evaluate(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement) active.blur();
  });
  await expect
    .poll(() => page.locator(OPEN_TOOLTIP).count(), { timeout: 4_000 })
    .toBe(0)
    .catch(() => {
      throw new Error("a tooltip stayed open after reset — later probes would be ambiguous");
    });
  // Let the close animation finish and the provider's skip-delay window lapse.
  await page.waitForTimeout(700);
}

function cellLocator(page: Page, def: TriggerDef): Locator {
  const pageMode = def.page ?? "grid";
  if (DIALOG_PAGES.includes(pageMode)) return page.locator('[role="dialog"]');
  return pageMode === "plugin-manager"
    ? page.locator("body")
    : page.locator(`[data-shot="${def.cell}"]`);
}

/** Scroll so the frame we will clip fits in the viewport. */
async function scrollIntoFrame(page: Page, cell: Locator, trigger: Locator, def: TriggerDef) {
  await trigger.scrollIntoViewIfNeeded();
  const cellBox = await cell.boundingBox();
  const trigBox = await trigger.boundingBox();
  if (!cellBox || !trigBox) return;
  if ((def.region ?? "cell") === "cell" && cellBox.height < VIEWPORT.height - 32) {
    await page.evaluate((dy) => window.scrollBy(0, dy), cellBox.y - 16);
  } else {
    await page.evaluate(
      (dy) => window.scrollBy(0, dy),
      trigBox.y + trigBox.height / 2 - VIEWPORT.height / 2
    );
  }
  await page.waitForTimeout(100);
}

/**
 * Runs in the page against the trigger element: finds the open styled tooltip (if
 * any), measures it, finds the nearest `title` on the trigger or an ancestor, and
 * injects the annotation when the reviewer needs one.
 */
function probeInPage(el: Element, openSelector: string): Probe {
  const toRect = (r: DOMRect): Rect => ({ x: r.x, y: r.y, width: r.width, height: r.height });
  const trig = el.getBoundingClientRect();

  const contents = Array.from(document.querySelectorAll<HTMLElement>(openSelector));
  const content = contents[contents.length - 1] ?? null;

  let text: string | null = null;
  let measurements: Measurements | null = null;
  let tooltipRect: Rect | null = null;
  if (content) {
    // What a sighted user reads: hide the visually-hidden a11y copies (Radix's
    // role=tooltip mirror, `.sr-only` chord names) and read the rendered text.
    const hidden = Array.from(
      content.querySelectorAll<HTMLElement>('[role="tooltip"], .sr-only')
    ).map((n) => [n, n.style.display] as const);
    for (const [n] of hidden) n.style.display = "none";
    text = content.innerText.replace(/\s+/g, " ").trim();
    for (const [n, display] of hidden) n.style.display = display;
    const r = content.getBoundingClientRect();
    tooltipRect = toRect(r);
    const cs = getComputedStyle(content);
    const side = content.getAttribute("data-side");
    const gap =
      side === "bottom"
        ? r.top - trig.bottom
        : side === "top"
          ? trig.top - r.bottom
          : side === "left"
            ? trig.left - r.right
            : side === "right"
              ? r.left - trig.right
              : null;
    measurements = {
      rect: tooltipRect,
      side,
      gapPx: gap === null ? null : Math.round(gap * 100) / 100,
      maxWidth: cs.maxWidth,
      padding: cs.padding,
      fontSize: cs.fontSize,
      fontWeight: cs.fontWeight,
      lineHeight: cs.lineHeight,
      color: cs.color,
      backgroundColor: cs.backgroundColor,
      textAlign: cs.textAlign,
      borderRadius: cs.borderRadius,
    };
  }

  const titled = el.closest("[title]");
  const nativeTitle = titled ? titled.getAttribute("title") : null;
  const nativeTitleOn = titled
    ? titled === el
      ? `self <${el.tagName.toLowerCase()}>`
      : `ancestor <${titled.tagName.toLowerCase()}>`
    : null;

  const outerTitles: string[] = [];
  for (
    let n = titled?.parentElement?.closest("[title]");
    n;
    n = n.parentElement?.closest("[title]")
  ) {
    outerTitles.push(`<${n.tagName.toLowerCase()}> "${n.getAttribute("title")}"`);
  }

  const kind: Probe["kind"] = content ? "styled" : nativeTitle ? "native" : "none";

  let annotationRect: Rect | null = null;
  if (kind !== "styled" || nativeTitle !== null) {
    const box = document.createElement("div");
    box.setAttribute("data-harness-annotation", "");
    box.textContent =
      kind === "styled"
        ? `ALSO NATIVE title (${nativeTitleOn}): "${nativeTitle}"`
        : kind === "native"
          ? `NATIVE title (OS tooltip — not rendered) on ${nativeTitleOn}: "${nativeTitle}"`
          : "NO TOOLTIP — no styled tooltip and no title attribute";
    if (outerTitles.length > 0) box.textContent += ` · ALSO outer title ${outerTitles.join(" · ")}`;
    Object.assign(box.style, {
      position: "fixed",
      zIndex: "2147483647",
      maxWidth: "420px",
      padding: "4px 8px",
      border: "2px dashed #d0021b",
      background: "#fff6d6",
      color: "#1a1a1a",
      font: "11px/1.35 ui-monospace, SFMono-Regular, Menlo, monospace",
      whiteSpace: "normal",
      overflowWrap: "anywhere",
      pointerEvents: "none",
      left: "0px",
      top: "0px",
    });
    document.body.appendChild(box);
    const b = box.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const left = Math.max(8, Math.min(trig.left, vw - b.width - 8));
    let top: number;
    if (content && measurements?.side === "bottom") {
      top = trig.top - 8 - b.height;
    } else {
      const below =
        content && (measurements?.side === "left" || measurements?.side === "right")
          ? Math.max(trig.bottom, tooltipRect!.y + tooltipRect!.height)
          : trig.bottom;
      top = below + 8;
    }
    box.style.left = `${left}px`;
    box.style.top = `${top}px`;
    annotationRect = toRect(box.getBoundingClientRect());
  }

  return {
    kind,
    text,
    nativeTitle,
    nativeTitleOn,
    outerTitles,
    measurements,
    triggerRect: toRect(trig),
    tooltipRect,
    annotationRect,
  };
}

function union(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
  };
}

function intersect(a: Rect, b: Rect): Rect {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - x),
    height: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - y),
  };
}

function contains(outer: Rect, inner: Rect): boolean {
  const e = 0.5;
  return (
    inner.x >= outer.x - e &&
    inner.y >= outer.y - e &&
    inner.x + inner.width <= outer.x + outer.width + e &&
    inner.y + inner.height <= outer.y + outer.height + e
  );
}

async function focusByKeyboard(page: Page, trigger: Locator): Promise<"tab" | "focus()"> {
  const hasPrev = await trigger.evaluate((el) => {
    const focusable = Array.from(
      document.querySelectorAll<HTMLElement>(
        'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])'
      )
    ).filter(
      (n) =>
        n.tabIndex >= 0 &&
        !(n as HTMLButtonElement).disabled &&
        n.offsetParent !== null &&
        !n.closest("[data-radix-popper-content-wrapper]")
    );
    const i = focusable.indexOf(el as HTMLElement);
    const prev = i > 0 ? focusable[i - 1] : undefined;
    if (!prev) return false;
    prev.focus();
    return true;
  });
  if (hasPrev) {
    await page.keyboard.press("Tab");
    const landed = await trigger.evaluate((el) => document.activeElement === el);
    if (landed) return "tab";
  }
  await trigger.focus();
  return "focus()";
}

async function capture(
  page: Page,
  def: TriggerDef,
  theme: string,
  mode: "hover" | "kbd"
): Promise<ManifestEntry> {
  const label = `${def.cell}/${def.trigger} (${mode}, ${theme})`;
  await reset(page);

  const cell = cellLocator(page, def);
  const trigger = cell.locator(def.selector).first();
  await expect(trigger, `${label}: trigger not found`).toBeVisible({ timeout: 10_000 });
  await scrollIntoFrame(page, cell, trigger, def);

  let focusVia: ManifestEntry["focusVia"];
  if (mode === "hover") {
    const box = await trigger.boundingBox();
    if (!box) throw new Error(`${label}: trigger has no box`);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 6 });
  } else {
    focusVia = await focusByKeyboard(page, trigger);
  }

  // Styled tooltips open after UI_TOOLTIP_DELAY_DURATION (500ms) on hover.
  const appeared = await page
    .locator(OPEN_TOOLTIP)
    .first()
    .waitFor({ state: "visible", timeout: 1_500 })
    .then(() => true)
    .catch(() => false);
  // Entry animation.
  if (appeared) await page.waitForTimeout(250);

  const probe = await trigger.evaluate(probeInPage, OPEN_TOOLTIP);

  try {
    const cellBox = await cell.boundingBox();
    if (!cellBox) throw new Error(`${label}: cell has no box`);
    const viewport: Rect = { x: 0, y: 0, width: VIEWPORT.width, height: VIEWPORT.height };
    let region: Rect = cellBox;
    if ((def.region ?? "cell") === "around") {
      const t = probe.triggerRect;
      region = intersect(cellBox, {
        x: t.x - 300,
        y: t.y - 110,
        width: t.width + 600,
        height: t.height + 220,
      });
    }
    // The trigger always belongs in the frame, even when a tall surface's region
    // band misses it.
    let clip = union(region, probe.triggerRect);
    if (probe.tooltipRect) clip = union(clip, probe.tooltipRect);
    if (probe.annotationRect) clip = union(clip, probe.annotationRect);
    clip = intersect(
      {
        x: clip.x - CLIP_PAD,
        y: clip.y - CLIP_PAD,
        width: clip.width + CLIP_PAD * 2,
        height: clip.height + CLIP_PAD * 2,
      },
      viewport
    );
    if (clip.width < 8 || clip.height < 8) {
      throw new Error(`${label}: empty clip ${JSON.stringify(clip)} — refusing to write`);
    }
    for (const [what, r] of [
      ["trigger", probe.triggerRect],
      ["tooltip", probe.tooltipRect],
      ["annotation", probe.annotationRect],
    ] as const) {
      if (r && !contains(clip, r)) {
        throw new Error(
          `${label}: ${what} ${JSON.stringify(r)} falls outside clip ${JSON.stringify(clip)}`
        );
      }
    }
    if (!probe.tooltipRect && !probe.annotationRect) {
      throw new Error(`${label}: neither a tooltip nor an annotation to photograph`);
    }

    const file = `${def.cell}--${def.trigger}${mode === "kbd" ? "--kbd" : ""}-${theme}.png`;
    await page.screenshot({ path: path.join(OUT_DIR, file), clip });
    return {
      cell: def.cell,
      trigger: def.trigger,
      theme,
      mode,
      kind: probe.kind,
      text: probe.text,
      nativeTitle: probe.nativeTitle,
      nativeTitleOn: probe.nativeTitleOn,
      outerTitles: probe.outerTitles,
      doubleTooltip: probe.kind === "styled" && probe.nativeTitle !== null,
      measurements: probe.measurements,
      ...(focusVia ? { focusVia } : {}),
      file,
    };
  } finally {
    await page.evaluate(() =>
      document.querySelectorAll("[data-harness-annotation]").forEach((n) => n.remove())
    );
  }
}

test("Tooltip consistency — every trigger, hover and keyboard", async ({ page }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_TOOLTIPS is required for the tooltip capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_TOOLTIPS=1 to run the capture");
  test.setTimeout(20 * 60_000);

  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  await stubViteHmrClient(page);

  const manifest: ManifestEntry[] = [];
  const written: string[] = [];

  for (const theme of THEMES) {
    for (const pageMode of PAGE_MODES) {
      await open(page, theme, pageMode);
      if (pageMode === "grid") {
        const file = `overview-${theme}.png`;
        const shell = page.locator("[data-preview-shell]");
        const box = await shell.boundingBox();
        if (!box || box.width < 8 || box.height < 8) {
          throw new Error(`${file}: shell has no real box — refusing to write`);
        }
        await page.screenshot({ path: path.join(OUT_DIR, file), fullPage: true });
        written.push(file);
      }
      for (const def of TRIGGERS.filter((d) => (d.page ?? "grid") === pageMode)) {
        for (const mode of def.kbd ? (["hover", "kbd"] as const) : (["hover"] as const)) {
          const entry = await capture(page, def, theme, mode);
          manifest.push(entry);
          written.push(entry.file);
        }
      }
    }
  }

  writeFileSync(path.join(OUT_DIR, "manifest.json"), JSON.stringify(manifest, null, 2));
  if (consoleErrors.length > 0) {
    writeFileSync(path.join(OUT_DIR, "console-errors.txt"), consoleErrors.join("\n"));
  }

  expect(pageErrors, `page errors during capture:\n${pageErrors.join("\n")}`).toEqual([]);
  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(written.length);
  expect(new Set(written).size).toBe(written.length);
});
