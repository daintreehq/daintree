/**
 * Popover headers visual-review harness.
 *
 * A dozen small popovers open off pane-header chips, toolbar pills and panel
 * footers, and each one grew its own header: a title strip with a refresh
 * button, a bare heading line, a search field, a count and an action. Whether
 * those headers read as one family — title weight and size, strip height and
 * padding, where the action sits, how the divider under it is drawn — can only
 * be judged with all of them open side by side. This spec opens each one the
 * way a person would and photographs a tight crop around trigger + open
 * surface, plus the resting hover state of the triggers that carry one.
 *
 * It reuses the existing `*-preview.html` pages: subagent chip, labels/badges
 * (the terminal notify chip), PR checks, forge stats (local commits), fleet,
 * worktree filter, project identity, recent calls, menus (notification
 * center), session tabs, panel header, pressed toggles (event filters) and
 * command HUD.
 *
 * Opt-in only: skips itself unless DAINTREE_SHOT_POPOVER_HEADERS is set.
 *
 *   DAINTREE_SHOT_POPOVER_HEADERS=1 DAINTREE_SHOT_DIR=/abs/out \
 *     npx playwright test --project=screenshots popover-headers-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_POPOVER_HEADERS  required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR              required — an ABSOLUTE output directory outside the repo
 *   DAINTREE_SHOT_THEMES           theme sweep (default daintree,bondi)
 *   DAINTREE_SHOT_ONLY             comma-separated state slugs to capture (default: all)
 *
 * Output: `<theme>-<slug>.png`. Never writes a PNG whose surface it has not
 * verified visible with a real box, and counts the files itself at the end.
 */

import { test, expect, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync } from "fs";
import path from "path";
import {
  startPreviewServer,
  stubViteHmrClient,
  type PreviewServer,
} from "../helpers/previewHarness";

const ENABLED = !!process.env.DAINTREE_SHOT_POPOVER_HEADERS;
const OUT_DIR = process.env.DAINTREE_SHOT_DIR ?? "";
const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);
const ONLY = new Set(
  (process.env.DAINTREE_SHOT_ONLY ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);

const PAD = 20;
const MIN_SURFACE = { width: 40, height: 20 };
const MIN_TARGET = { width: 12, height: 12 };
const MOD = process.platform === "darwin" ? "Meta" : "Control";

test.use({ deviceScaleFactor: 2 });

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

const POPPER = "[data-radix-popper-content-wrapper]";

interface Opened {
  /** The control a person clicked or hovered. */
  trigger: Locator;
  /** The open surface (or, for a hover state, the element whose hover is the point). */
  surface: Locator;
  /** Anything else the crop must hold (a tooltip, the header row around a chip). */
  extra?: Locator[];
  /** A hover shot's surface is a small control, not a popover. */
  small?: boolean;
}

interface Shot {
  slug: string;
  /** Page path + query, without the theme. */
  url: string;
  viewport: { width: number; height: number };
  /** Selector that proves the page mounted and styled its trigger. */
  ready: string;
  /** `attached` for a mount point with no box of its own until something opens. */
  readyState?: "visible" | "attached";
  /** How a person reaches it in the app. */
  path: string;
  open: (page: Page) => Promise<Opened>;
}

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
    if (file.endsWith(".png")) rmSync(path.join(OUT_DIR, file));
  }
  server = await startPreviewServer();
});

test.afterAll(async () => {
  await server?.close();
});

async function settle(page: Page, ms = 250): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
  );
  await page.waitForTimeout(ms);
}

async function clickOpen(page: Page, trigger: Locator, surface: Locator): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    await trigger.click();
    try {
      await expect(surface).toBeVisible({ timeout: 5_000 });
      return;
    } catch {
      await page.keyboard.press("Escape");
      await page.waitForTimeout(300);
    }
  }
  await expect(surface, "surface never opened").toBeVisible({ timeout: 2_000 });
}

/** Hover a trigger and give its hover fill (and any tooltip) time to land. */
async function hoverRest(page: Page, trigger: Locator): Promise<Locator[]> {
  await trigger.hover();
  await page.waitForTimeout(800);
  const tip = page.locator(`${POPPER}:visible`);
  return (await tip.count()) > 0 ? [tip.last()] : [];
}

const subagentChip = (page: Page) => page.getByRole("button", { name: /subagent/i }).first();
const notifyChip = (page: Page) => page.getByTestId("terminal-notify-chip").first();
const newSession = (page: Page) => page.getByRole("button", { name: "New session" }).first();

const SHOTS: Shot[] = [
  {
    slug: "subagent-chip",
    url: "/subagent-chip-preview.html?fixture=codex-mixed",
    viewport: { width: 820, height: 760 },
    ready: "[data-preview-pane]",
    path: "Click the subagent chip in an agent pane's header",
    open: async (page) => {
      const trigger = subagentChip(page);
      const surface = page.locator(POPPER).last();
      await clickOpen(page, trigger, surface);
      await expect(surface).toContainText(/subagents/);
      await expect(surface.getByRole("button", { name: /^Refresh/ })).toBeVisible();
      await page.mouse.move(0, 0);
      return { trigger, surface };
    },
  },
  {
    slug: "subagent-chip-hover",
    url: "/subagent-chip-preview.html?fixture=codex-mixed",
    viewport: { width: 820, height: 760 },
    ready: "[data-preview-pane]",
    path: "Hover the subagent chip in an agent pane's header",
    open: async (page) => {
      const trigger = subagentChip(page);
      const surface = page
        .locator('[data-preview-pane] [data-testid="panel-header-content"]')
        .locator("xpath=..");
      const extra = await hoverRest(page, trigger);
      return { trigger, surface, extra, small: true };
    },
  },
  {
    slug: "notify-chip",
    url: "/labels-badges-preview.html?fixture=chips",
    viewport: { width: 1400, height: 2400 },
    ready: '[data-testid="terminal-notify-chip"]',
    path: "Click the radar (notify) chip in a pane header while a notice is waiting",
    open: async (page) => {
      const trigger = notifyChip(page);
      await trigger.scrollIntoViewIfNeeded();
      const surface = page.locator(`${POPPER} [role="dialog"]:visible`).last();
      await clickOpen(page, trigger, surface);
      await expect(surface.getByRole("button", { name: "Stop notices" })).toBeVisible();
      await page.mouse.move(0, 0);
      return { trigger, surface };
    },
  },
  {
    slug: "notify-chip-hover",
    url: "/labels-badges-preview.html?fixture=chips",
    viewport: { width: 1400, height: 2400 },
    ready: '[data-testid="terminal-notify-chip"]',
    path: "Hover the radar (notify) chip in a pane header",
    open: async (page) => {
      const trigger = notifyChip(page);
      await trigger.scrollIntoViewIfNeeded();
      const extra = await hoverRest(page, trigger);
      return { trigger, surface: trigger, extra, small: true };
    },
  },
  {
    slug: "pr-checks",
    url: "/pr-checks-preview.html?fixture=mixed",
    viewport: { width: 820, height: 640 },
    ready: '[data-testid="pr-checks-trigger"]',
    path: "Click the CI status chip on a worktree card's PR badge (some checks failing)",
    open: async (page) => {
      const trigger = page.locator('[data-testid="pr-checks-trigger"]').first();
      const surface = page.locator('[data-testid="pr-checks-popover"]');
      await clickOpen(page, trigger, surface);
      await expect(surface.locator('[data-testid="pr-checks-list"]')).toBeVisible();
      await page.mouse.move(0, 0);
      return { trigger, surface };
    },
  },
  {
    slug: "pr-checks-loading",
    url: "/pr-checks-preview.html?fixture=loading",
    viewport: { width: 820, height: 640 },
    ready: '[data-testid="pr-checks-trigger"]',
    path: "Click the CI status chip before its checks have loaded",
    open: async (page) => {
      const trigger = page.locator('[data-testid="pr-checks-trigger"]').first();
      const surface = page.locator('[data-testid="pr-checks-popover"]');
      await clickOpen(page, trigger, surface);
      await page.mouse.move(0, 0);
      // The skeleton sits behind the loading gate.
      await page.waitForTimeout(900);
      await expect(surface.locator('[data-testid="pr-checks-skeleton"]')).toBeVisible();
      return { trigger, surface };
    },
  },
  {
    slug: "local-commits",
    url: "/forge-stats-preview.html?fixture=commits-only&commits=few",
    viewport: { width: 600, height: 640 },
    ready: '[data-testid="forge-stat-pill-commits"]',
    path: "Click the commits pill in the toolbar",
    open: async (page) => {
      const trigger = page.getByTestId("forge-stat-pill-commits");
      await expect(trigger).not.toContainText("—");
      const search = page.getByRole("combobox", { name: /search commits/i });
      const surface = search.locator('xpath=ancestor::div[contains(@class,"surface-overlay")][1]');
      await clickOpen(page, trigger, search);
      await page.waitForTimeout(500);
      await expect(surface.locator("[role=rowgroup] [role=row]").first()).toBeVisible({
        timeout: 10_000,
      });
      await page.mouse.move(0, 0);
      return { trigger, surface };
    },
  },
  {
    slug: "local-commits-refresh-error",
    url: "/forge-stats-preview.html?fixture=commits-only&commits=few",
    viewport: { width: 600, height: 640 },
    ready: '[data-testid="forge-stat-pill-commits"]',
    path: "Commits dropdown whose re-read fails after rows are already showing (e.g. a search refetch)",
    open: async (page) => {
      const trigger = page.getByTestId("forge-stat-pill-commits");
      await expect(trigger).not.toContainText("—");
      const search = page.getByRole("combobox", { name: /search commits/i });
      const surface = search.locator('xpath=ancestor::div[contains(@class,"surface-overlay")][1]');
      await clickOpen(page, trigger, search);
      await expect(surface.locator("[role=rowgroup] [role=row]").first()).toBeVisible({
        timeout: 10_000,
      });
      // From here on git answers with a failure, as when the repo goes away mid-session.
      await page.evaluate(() => {
        const git = (window as unknown as { electron: { git: Record<string, unknown> } }).electron
          .git;
        git.listCommits = () => Promise.reject(new Error("git log timed out"));
      });
      await search.fill("r");
      await expect(surface.getByRole("alert")).toContainText(/Couldn.t refresh commits/, {
        timeout: 10_000,
      });
      await page.mouse.move(0, 0);
      return { trigger, surface };
    },
  },
  {
    slug: "fleet-list",
    url: "/fleet-preview.html?fixture=armed-cross-worktree&width=1100",
    viewport: { width: 1100, height: 680 },
    ready: '[data-testid="fleet-armed-count-chip"]',
    path: "Click the armed-count chip on the fleet ribbon",
    open: async (page) => {
      const trigger = page.getByTestId("fleet-armed-count-chip");
      const surface = page.getByTestId("fleet-armed-list");
      await clickOpen(page, trigger, surface);
      await page.mouse.move(0, 0);
      return { trigger, surface };
    },
  },
  {
    slug: "fleet-picker",
    url: "/fleet-preview.html?fixture=armed-cross-worktree&width=1100",
    viewport: { width: 1100, height: 680 },
    ready: '[data-testid="fleet-armed-count-chip"]',
    path: "Click the armed-count chip on the fleet ribbon, then Add panes…",
    open: async (page) => {
      const trigger = page.getByTestId("fleet-armed-count-chip");
      const surface = page.getByTestId("fleet-armed-list");
      await clickOpen(page, trigger, surface);
      await page.getByTestId("fleet-armed-list-add-panes").click();
      await expect(page.getByTestId("fleet-picker-add-root")).toBeVisible();
      await page.mouse.move(0, 0);
      return { trigger, surface };
    },
  },
  {
    slug: "worktree-filter",
    url: "/worktree-filter-preview.html?fixture=default",
    viewport: { width: 820, height: 820 },
    ready: "[data-preview-shell]",
    path: "Click the filter button above the worktree sidebar",
    open: async (page) => {
      const trigger = page.getByRole("button", { name: /^Filter and sort worktrees/ });
      const surface = page.getByTestId("worktree-filter-popover");
      await clickOpen(page, trigger, surface);
      await page.mouse.move(0, 0);
      return { trigger, surface };
    },
  },
  {
    slug: "project-identity",
    url: "/project-identity-preview.html?fixture=rest",
    viewport: { width: 1180, height: 820 },
    ready: "[frimousse-root]",
    path: "Right-click the project pill, then Edit name and icon",
    open: async (page) => {
      const trigger = page.locator('[data-testid="project-switcher-trigger"]').first();
      const surface = page.locator(POPPER).first();
      await expect(surface).toBeVisible();
      await expect(page.locator("[frimousse-row][role=row] [frimousse-emoji]").nth(20)).toBeVisible(
        { timeout: 20_000 }
      );
      await page.mouse.move(1170, 810);
      return { trigger, surface };
    },
  },
  {
    slug: "recent-calls",
    url: "/recent-calls-preview.html?fixture=populated&width=380",
    viewport: { width: 520, height: 640 },
    ready: 'button[aria-label="Recent tool calls"]',
    path: "Click the recent tool calls strip in the assistant panel footer",
    open: async (page) => {
      const trigger = page.getByRole("button", { name: "Recent tool calls" }).first();
      const surface = page.locator(POPPER).first();
      await clickOpen(page, trigger, surface);
      await page.mouse.move(0, 0);
      return { trigger, surface };
    },
  },
  {
    slug: "recent-calls-empty",
    url: "/recent-calls-preview.html?fixture=empty&width=380",
    viewport: { width: 520, height: 640 },
    ready: 'button[aria-label="Recent tool calls"]',
    path: "Click the recent tool calls strip before the assistant has called any tool",
    open: async (page) => {
      const trigger = page.getByRole("button", { name: "Recent tool calls" }).first();
      const surface = page.locator(POPPER).first();
      await clickOpen(page, trigger, surface);
      await expect(surface.getByText(/tool calls here/i)).toBeVisible();
      await page.mouse.move(0, 0);
      return { trigger, surface };
    },
  },
  {
    slug: "notification-center",
    url: "/menus-preview.html?scene=notifications",
    viewport: { width: 520, height: 720 },
    ready: 'button[aria-label^="Options for "]',
    path: "Open the notification center from the toolbar bell and hover an entry",
    open: async (page) => {
      const surface = page.locator('[role="dialog"][aria-label="Notifications"]').first();
      const options = page.locator('button[aria-label^="Options for "]').first();
      // Row controls reveal on hover: point at the first entry.
      await options.hover();
      await page.waitForTimeout(400);
      await expect(page.locator('button[aria-label^="Dismiss "]').first()).toBeVisible();
      return { trigger: page.getByTestId("menus-notification-center"), surface };
    },
  },
  {
    slug: "session-tabs",
    url: "/session-tabs-preview.html?fixture=two-idle&width=380",
    viewport: { width: 1000, height: 640 },
    ready: '[role="tablist"][aria-label="Assistant sessions"]',
    path: "The assistant panel's session strip, with its New session (+) button",
    open: async (page) => {
      const trigger = newSession(page);
      const surface = page.getByRole("tablist", { name: "Assistant sessions" });
      await expect(trigger).toBeVisible();
      return { trigger, surface, small: true };
    },
  },
  {
    slug: "session-tabs-new-hover",
    url: "/session-tabs-preview.html?fixture=two-idle&width=380",
    viewport: { width: 1000, height: 640 },
    ready: '[role="tablist"][aria-label="Assistant sessions"]',
    path: "Hover New session (+) in the assistant panel's session strip",
    open: async (page) => {
      const trigger = newSession(page);
      const surface = page.getByRole("tablist", { name: "Assistant sessions" });
      const extra = await hoverRest(page, trigger);
      return { trigger, surface, extra, small: true };
    },
  },
  {
    slug: "panel-header-fleet-failed",
    url: "/panel-header-preview.html?fixture=fleet-failed",
    viewport: { width: 1240, height: 720 },
    ready: "[data-preview-pane] [data-pane-chrome]",
    path: "A pane header after the last fleet broadcast was rejected there (red dot beside the title)",
    open: async (page) => {
      const surface = page.locator("[data-pane-chrome]").first();
      const trigger = surface.getByTestId("panel-fleet-failure-dot");
      await expect(trigger).toBeVisible();
      return { trigger, surface, small: true };
    },
  },
  {
    slug: "event-filters",
    url: "/pressed-toggles-chips-preview.html",
    viewport: { width: 1200, height: 1600 },
    ready: '[data-shot="events"]',
    path: "Diagnostics dock › Events: click Filters",
    open: async (page) => {
      const trigger = page
        .locator('[data-shot="events"]')
        .getByRole("button", { name: /^More filters/ })
        .first();
      await trigger.scrollIntoViewIfNeeded();
      const surface = page.locator(`${POPPER} [role="dialog"]:visible`).last();
      await clickOpen(page, trigger, surface);
      await expect(surface.getByText("Trace ID")).toBeVisible();
      await page.mouse.move(0, 0);
      return { trigger, surface };
    },
  },
  {
    slug: "command-hud",
    url: "/command-hud-preview.html",
    viewport: { width: 1440, height: 900 },
    ready: "[data-preview-shell]",
    readyState: "attached",
    path: `Press ${MOD}+K`,
    open: async (page) => {
      const surface = page.locator("[data-command-hud]");
      for (let attempt = 0; attempt < 3; attempt++) {
        await page.keyboard.press(`${MOD}+K`);
        try {
          await expect(surface).toBeVisible({ timeout: 5_000 });
          break;
        } catch {
          await page.waitForTimeout(300);
        }
      }
      await expect(surface, "HUD never opened").toBeVisible({ timeout: 2_000 });
      await expect(surface.locator('[role="option"]').first()).toBeVisible();
      return { trigger: surface, surface };
    },
  },
];

async function load(page: Page, shot: Shot, theme: string): Promise<void> {
  await page.setViewportSize(shot.viewport);
  await page.mouse.move(0, 0);
  const sep = shot.url.includes("?") ? "&" : "?";
  const url = `${server!.baseURL}${shot.url}${sep}theme=${theme}`;
  const ready = page.locator(shot.ready).first();
  // A first load after a dependency change can answer 504 "Outdated Optimize
  // Dep" while Vite re-optimises; a fresh navigation after it settles is enough.
  for (let attempt = 0; ; attempt++) {
    await page.goto(attempt === 0 ? url : "about:blank");
    if (attempt > 0) await page.goto(url, { waitUntil: "load" });
    try {
      await ready.waitFor({
        state: shot.readyState ?? "visible",
        timeout: attempt === 0 ? 45_000 : 90_000,
      });
      break;
    } catch (error) {
      if (attempt >= 2) {
        throw new Error(`${shot.slug}: ${shot.ready} never appeared at ${url}`, { cause: error });
      }
    }
  }
  await page.addStyleTag({ content: FREEZE_CSS });
  await page.evaluate(() => document.fonts.ready);
  await settle(page, 400);
}

async function realBox(target: Locator, file: string, min: { width: number; height: number }) {
  const box = await target.boundingBox({ timeout: 5_000 });
  if (!box || box.width < min.width || box.height < min.height) {
    throw new Error(`${file}: no real box (${JSON.stringify(box)}) — refusing to write`);
  }
  return box;
}

async function capture(page: Page, shot: Shot, theme: string): Promise<string> {
  const file = `${theme}-${shot.slug}.png`;
  await load(page, shot, theme);
  const opened = await shot.open(page);
  await settle(page, 300);

  if (!(await opened.surface.isVisible().catch(() => false))) {
    throw new Error(`${file}: surface is not visible — refusing to write`);
  }
  await expect
    .poll(() => opened.surface.evaluate((el) => getComputedStyle(el).opacity), {
      message: `${file}: surface never finished fading in`,
      timeout: 5_000,
    })
    .toBe("1");
  const surfaceBox = await realBox(opened.surface, file, opened.small ? MIN_TARGET : MIN_SURFACE);
  const triggerBox = await realBox(opened.trigger, file, { width: 4, height: 4 });
  const boxes = [triggerBox, surfaceBox];
  for (const extra of opened.extra ?? []) {
    const box = await extra.boundingBox().catch(() => null);
    if (box && box.width > 0 && box.height > 0) boxes.push(box);
  }

  const vp = page.viewportSize()!;
  const x0 = Math.max(0, Math.floor(Math.min(...boxes.map((b) => b.x)) - PAD));
  const y0 = Math.max(0, Math.floor(Math.min(...boxes.map((b) => b.y)) - PAD));
  const x1 = Math.min(vp.width, Math.ceil(Math.max(...boxes.map((b) => b.x + b.width)) + PAD));
  const y1 = Math.min(vp.height, Math.ceil(Math.max(...boxes.map((b) => b.y + b.height)) + PAD));
  const clip = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  if (clip.width < MIN_TARGET.width || clip.height < MIN_TARGET.height) {
    throw new Error(`${file}: crop is empty (${JSON.stringify(clip)}) — refusing to write`);
  }

  const out = path.join(OUT_DIR, file);
  await page.screenshot({ path: out, clip });
  if (!existsSync(out)) throw new Error(`${file}: screenshot did not land`);
  return file;
}

/**
 * Runs in the page before any module. Agent chips ask their agent for
 * subagents on mount and read `.status` off the reply, but the preview pages'
 * inert bridge answers `undefined`; answer those two lookups the way a
 * session-less agent does and leave every other name untouched. The subagent
 * chip preview installs real answers, which pass through.
 */
function answerSubagentLookups(): void {
  let bridge: unknown;
  const unavailable = async () => ({ status: "unavailable", reason: "no-session" });
  Object.defineProperty(window, "electron", {
    configurable: true,
    get: () => bridge,
    set: (value: object) => {
      bridge = new Proxy(value, {
        get: (target, key) => {
          const ns: unknown = Reflect.get(target, key);
          if ((key !== "claude" && key !== "codex") || !ns || typeof ns !== "object") return ns;
          return new Proxy(ns, {
            get: (inner, name) => {
              const own: unknown = Reflect.get(inner, name);
              if (name !== "listSubagents") return own;
              if (typeof own !== "function") return unavailable;
              // An inert shim answers `undefined`; a fixture's own answer passes through.
              return async (...args: unknown[]) => {
                const reply: unknown = await (own as (...a: unknown[]) => unknown).apply(
                  inner,
                  args
                );
                return reply && typeof reply === "object" ? reply : unavailable();
              };
            },
          });
        },
      });
    },
  });
}

async function withPage<T>(
  context: BrowserContext,
  what: string,
  errors: string[],
  body: (page: Page) => Promise<T>
): Promise<T> {
  const page = await context.newPage();
  await stubViteHmrClient(page);
  await page.addInitScript(answerSubagentLookups);
  const consoleErrors: string[] = [];
  page.on("pageerror", (error) => errors.push(`${what}: ${error.stack ?? error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text().slice(0, 300));
  });
  try {
    return await body(page);
  } catch (error) {
    throw new Error(
      `${what}: ${String(error)}\n  console: ${consoleErrors.join(" | ") || "(none)"}`,
      { cause: error }
    );
  } finally {
    await page.close().catch(() => undefined);
  }
}

test.describe("popover headers review", () => {
  test("captures", async ({ context }) => {
    test.info().annotations.push({
      type: "conditional-skip",
      description: "DAINTREE_SHOT_POPOVER_HEADERS is required for the popover headers capture",
    });
    test.skip(!ENABLED, "Set DAINTREE_SHOT_POPOVER_HEADERS to run the popover headers capture");
    test.setTimeout(3_600_000);

    const shots = SHOTS.filter((s) => ONLY.size === 0 || ONLY.has(s.slug));
    const unknown = [...ONLY].filter((slug) => !SHOTS.some((s) => s.slug === slug));
    expect(unknown, `unknown DAINTREE_SHOT_ONLY slugs: ${unknown.join(", ")}`).toEqual([]);

    const errors: string[] = [];
    const expected: string[] = [];
    for (const theme of THEMES) {
      for (const shot of shots) {
        const file = await withPage(context, `${theme}-${shot.slug}`, errors, (page) =>
          capture(page, shot, theme)
        );
        expected.push(file);
      }
    }

    expect(errors, `preview pages threw:\n${errors.join("\n")}`).toEqual([]);
    const landed = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
    const missing = expected.filter((f) => !landed.includes(f));
    expect(missing, `missing captures: ${missing.join(", ")}`).toEqual([]);
    expect(landed.length, `expected ${expected.length} PNGs, found ${landed.length}`).toBe(
      expected.length
    );
  });
});
