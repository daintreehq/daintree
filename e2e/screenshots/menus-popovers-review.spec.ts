/**
 * Menus and popovers visual-review harness.
 *
 * Daintree has two dozen menus and popovers built on the same Radix primitives
 * (plus a few hand-built lists), each reached from a different corner of the
 * app. Consistency between them — row height, icon column, text inset, surface
 * padding and radius, how far the surface sits from its trigger — can only be
 * judged with all of them open side by side. This spec opens every one of them
 * the way a person would (click, right-click, long-press, typing) and photographs
 * a tight crop around trigger + open surface.
 *
 * It reuses the existing `*-preview.html` pages wherever one already mounts the
 * component (toolbar, dock, portal, banners, PR checks, worktree sidebar, dev
 * preview toolbar, autocomplete, error list, recent calls), and drives
 * `menus-preview.html` (`src/components/ui/__preview__/menusPreview.tsx`) for the
 * rest: the toolbar seeded with live processes and plugin buttons, the browser
 * toolbar with navigation history, the diff notes send menu, the file browser
 * view options, the markdown text-size stepper and a worktree card with a
 * resource configured.
 *
 * Opt-in only: skips itself unless DAINTREE_SHOT_MENUS is set.
 *
 *   DAINTREE_SHOT_MENUS=1 DAINTREE_SHOT_DIR=/abs/out \
 *     npx playwright test --project=screenshots menus-popovers-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_MENUS    required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR      required — an ABSOLUTE output directory outside the repo
 *   DAINTREE_SHOT_THEMES   theme sweep (default daintree,bondi)
 *   DAINTREE_SHOT_ONLY     comma-separated state slugs to capture (default: all)
 *
 * Output: `<theme>-<slug>.png` plus a `<theme>-<slug>.json` sidecar with the open
 * surface's geometry — its box, padding, radius and colours, every row's text,
 * box, left padding, height, colour and icon placement, the trigger's box and the
 * measured trigger-to-surface gap — so consistency claims can be checked against
 * numbers. Never writes a PNG whose surface it has not verified open with a real
 * box, except the one allow-listed baseline below, and counts the files itself at
 * the end.
 */

import { test, expect, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from "fs";
import path from "path";
import {
  startPreviewServer,
  stubViteHmrClient,
  type PreviewServer,
} from "../helpers/previewHarness";

const ENABLED = !!process.env.DAINTREE_SHOT_MENUS;
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

/**
 * States whose surface is allowed to be absent. The Portal "+" button's
 * right-click still opens a NATIVE Electron menu over IPC, which the preview's
 * inert bridge swallows — so today there is nothing to photograph. The shot
 * still lands (a crop of the trigger, flagged in its sidecar) as the baseline a
 * React replacement will be compared against. Remove the entry once "+" opens a
 * `role="menu"`.
 */
const ALLOW_NO_SURFACE = new Set(["portal-plus"]);

const PAD = 24;
const MIN_SURFACE = { width: 40, height: 20 };

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

const MENU = '[role="menu"]:visible';
const POPOVER = '[data-radix-popper-content-wrapper] [role="dialog"]:visible';

interface Opened {
  /** The control a person clicked or right-clicked. */
  trigger: Locator;
  /** The open menu, popover or list — the element whose geometry is recorded. */
  surface: Locator;
  /** Where a context menu was invoked, when the menu opens at the pointer. */
  point?: { x: number; y: number };
  /** Crop to the pointer rather than the trigger (a trigger as wide as the window). */
  clipToPoint?: boolean;
}

interface Shot {
  slug: string;
  /** Page path + query, without the theme. */
  url: string;
  viewport: { width: number; height: number };
  /** Selector that proves the page mounted and styled its trigger. */
  ready: string;
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
    if (file.endsWith(".png") || file.endsWith(".json")) rmSync(path.join(OUT_DIR, file));
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

/** Radix menus load lazily; a cold right-click can miss once, so hover, then retry. */
async function rightClick(
  page: Page,
  trigger: Locator,
  surface: Locator
): Promise<{ x: number; y: number }> {
  for (let attempt = 0; attempt < 3; attempt++) {
    await trigger.hover();
    await page.waitForTimeout(150);
    await trigger.click({ button: "right" });
    try {
      await expect(surface).toBeVisible({ timeout: 3_000 });
      const box = await trigger.boundingBox();
      if (box) return centreOf(box);
      break;
    } catch {
      await page.keyboard.press("Escape");
      await page.waitForTimeout(200);
    }
  }
  await expect(surface, "context menu never opened").toBeVisible({ timeout: 1_000 });
  const box = await trigger.boundingBox();
  if (!box) throw new Error("context menu trigger has no box");
  return centreOf(box);
}

async function clickOpen(page: Page, trigger: Locator, surface: Locator): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    await trigger.click();
    try {
      await expect(surface).toBeVisible({ timeout: 3_000 });
      return;
    } catch {
      await page.keyboard.press("Escape");
      await page.waitForTimeout(200);
    }
  }
  await expect(surface, "surface never opened").toBeVisible({ timeout: 1_000 });
}

function centreOf(box: { x: number; y: number; width: number; height: number }) {
  return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
}

const TOOLBAR = "/toolbar-preview.html?fixture=owner&platform=mac";
const TOOLBAR_READY = '[data-toolbar-button-id="launcher"] button';

const SHOTS: Shot[] = [
  {
    slug: "project-pill-ctx",
    url: "/menus-preview.html?scene=toolbar",
    viewport: { width: 1440, height: 520 },
    ready: '[role="group"][aria-label="Project"] button',
    path: "Right-click the project pill in the centre of the toolbar",
    open: async (page) => {
      const trigger = page.locator('[role="group"][aria-label="Project"] button').first();
      const surface = page.locator(MENU).last();
      const point = await rightClick(page, trigger, surface);
      await expect(surface.getByRole("menuitem", { name: "Stop all agents" })).toBeVisible();
      return { trigger, surface, point };
    },
  },
  {
    slug: "toolbar-button-ctx",
    url: TOOLBAR,
    viewport: { width: 1440, height: 520 },
    ready: TOOLBAR_READY,
    path: "Right-click the launcher (or any toolbar button)",
    open: async (page) => {
      const trigger = page.locator(TOOLBAR_READY).first();
      const surface = page.locator(MENU).last();
      const point = await rightClick(page, trigger, surface);
      return { trigger, surface, point };
    },
  },
  {
    slug: "toolbar-settings-menu",
    url: TOOLBAR,
    viewport: { width: 1440, height: 520 },
    ready: 'button[aria-label="Open settings"]',
    path: "Right-click the settings (sliders) button at the right of the toolbar",
    open: async (page) => {
      const trigger = page.locator('button[aria-label="Open settings"]').first();
      const surface = page.locator(MENU).last();
      const point = await rightClick(page, trigger, surface);
      return { trigger, surface, point };
    },
  },
  {
    slug: "agent-button-menu",
    url: TOOLBAR,
    viewport: { width: 1440, height: 520 },
    ready: '[data-toolbar-button-id="claude"] button',
    path: "Click the chevron on an agent toolbar button that has presets",
    open: async (page) => {
      const trigger = page.locator('[data-toolbar-button-id="claude"] button').last();
      const surface = page.locator(MENU).last();
      await clickOpen(page, trigger, surface);
      return { trigger, surface };
    },
  },
  {
    slug: "agent-button-ctx",
    url: TOOLBAR,
    viewport: { width: 1440, height: 520 },
    ready: '[data-toolbar-button-id="claude"] button',
    path: "Right-click an agent toolbar button",
    open: async (page) => {
      const trigger = page.locator('[data-toolbar-button-id="claude"] button').first();
      const surface = page.locator(MENU).last();
      const point = await rightClick(page, trigger, surface);
      return { trigger, surface, point };
    },
  },
  {
    slug: "plugin-tray-menu",
    url: "/menus-preview.html?scene=toolbar",
    viewport: { width: 1440, height: 520 },
    ready: 'button[aria-label="Plugin tray"]',
    path: "Click the plugin tray (package) button in the toolbar",
    open: async (page) => {
      const trigger = page.locator('button[aria-label="Plugin tray"]').first();
      const surface = page.locator(MENU).last();
      await clickOpen(page, trigger, surface);
      await expect(surface.getByRole("menuitem").first()).toBeVisible();
      return { trigger, surface };
    },
  },
  {
    slug: "banner-overflow",
    url: "/terminal-banners-preview.html?fixture=spawn-enoent&width=560",
    viewport: { width: 640, height: 480 },
    ready: 'button[aria-label="More recovery options"]',
    path: "Click the ⋯ on a terminal spawn-error banner",
    open: async (page) => {
      const trigger = page.locator('button[aria-label="More recovery options"]').first();
      const surface = page.locator(POPOVER).last();
      await clickOpen(page, trigger, surface);
      return { trigger, surface };
    },
  },
  {
    slug: "terminal-ctx",
    url: "/dock-preview.html?fixture=rest",
    viewport: { width: 1440, height: 900 },
    ready: "#dock-container",
    path: "Right-click a terminal (its header, or its chip in the dock)",
    open: async (page) => {
      const trigger = page
        .locator('#dock-container [aria-label^="Terminal"][aria-label*="Click to preview"]')
        .first();
      const surface = page.locator(MENU).last();
      const point = await rightClick(page, trigger, surface);
      await expect(surface.getByRole("menuitem", { name: /trash/i }).first()).toBeVisible();
      return { trigger, surface, point };
    },
  },
  {
    slug: "portal-tab-ctx",
    url: "/portal-preview.html?fixture=page-active",
    viewport: { width: 1000, height: 700 },
    ready: '[role="tab"]',
    path: "Right-click a tab in the Portal sidebar's tab strip",
    open: async (page) => {
      const trigger = page.locator('[role="tab"]').first();
      const surface = page.locator(MENU).last();
      const point = await rightClick(page, trigger, surface);
      return { trigger, surface, point };
    },
  },
  {
    slug: "portal-plus",
    url: "/portal-preview.html?fixture=page-active",
    viewport: { width: 1000, height: 700 },
    ready: 'button[aria-label="New Tab"]',
    path: "Right-click the + (New Tab) button in the Portal tab strip",
    open: async (page) => {
      const trigger = page.locator('button[aria-label="New Tab"]').first();
      const surface = page.locator(MENU).last();
      await trigger.hover();
      await trigger.click({ button: "right" });
      await page.waitForTimeout(600);
      return { trigger, surface };
    },
  },
  {
    slug: "dock-waiting-popover",
    url: "/dock-preview.html?fixture=rest",
    viewport: { width: 1440, height: 900 },
    ready: "#dock-container",
    path: "Click the Waiting pill at the right of the dock",
    open: async (page) => {
      const trigger = page.locator('#dock-container button[aria-label^="Waiting"]').first();
      const surface = page.locator('[role="dialog"][aria-label="Waiting panels"]');
      await clickOpen(page, trigger, surface);
      return { trigger, surface };
    },
  },
  {
    slug: "dock-trash-popover",
    url: "/dock-preview.html?fixture=busy",
    viewport: { width: 1440, height: 900 },
    ready: '[data-testid="trash-container"]',
    path: "Click the Trash pill at the right of the dock",
    open: async (page) => {
      const trigger = page.locator('[data-testid="trash-container"]').first();
      const surface = page.locator('[role="dialog"][aria-label="Recently closed terminals"]');
      await clickOpen(page, trigger, surface);
      return { trigger, surface };
    },
  },
  {
    slug: "dock-background-popover",
    url: "/dock-preview.html?fixture=busy",
    viewport: { width: 1440, height: 900 },
    ready: "#dock-container",
    path: "Click the Background pill at the right of the dock",
    open: async (page) => {
      const trigger = page.locator('#dock-container button[aria-label^="Background"]').first();
      const surface = page.locator('[role="dialog"][aria-label="Backgrounded panels"]');
      await clickOpen(page, trigger, surface);
      return { trigger, surface };
    },
  },
  {
    slug: "dock-errors-popover",
    url: "/dock-preview.html?fixture=busy",
    viewport: { width: 1440, height: 900 },
    ready: "#dock-container",
    path: "Click the Errors pill at the right of the dock",
    open: async (page) => {
      const trigger = page.locator('#dock-container button[aria-label^="Errors"]').first();
      const surface = page.locator('[role="dialog"][aria-label="Errored terminals"]');
      await clickOpen(page, trigger, surface);
      return { trigger, surface };
    },
  },
  {
    slug: "dock-launch-menu",
    url: "/dock-preview.html?fixture=local-only",
    viewport: { width: 1440, height: 900 },
    ready: "#dock-container",
    path: "Right-click an empty stretch of the dock",
    open: async (page) => {
      const trigger = page.locator("#dock-container");
      const surface = page.locator(MENU).last();
      // An empty stretch of the rail: a point inside the dock whose hit target
      // is not a chip, pill or button.
      const point = await trigger.evaluate((dock) => {
        const r = dock.getBoundingClientRect();
        const y = Math.round(r.top + r.height / 2);
        for (let x = Math.round(r.right - 40); x > r.left; x -= 8) {
          const hit = document.elementFromPoint(x, y);
          if (!hit || !dock.contains(hit)) continue;
          if (hit.closest("button, [role='button'], [role='group'], a, input")) continue;
          if (hit.closest("[aria-label*='Click to preview']")) continue;
          return { x, y };
        }
        return null;
      });
      if (!point) throw new Error("dock-launch-menu: no empty stretch of the dock to right-click");
      for (let attempt = 0; attempt < 3; attempt++) {
        await page.mouse.move(point.x, point.y);
        await page.waitForTimeout(150);
        await page.mouse.click(point.x, point.y, { button: "right" });
        if (await surface.isVisible()) break;
        await page.waitForTimeout(500);
        if (await surface.isVisible()) break;
        await page.keyboard.press("Escape");
      }
      await expect(surface).toBeVisible({ timeout: 3_000 });
      return { trigger, surface, point, clipToPoint: true };
    },
  },
  {
    slug: "pr-checks-popover",
    url: "/pr-checks-preview.html?fixture=mixed",
    viewport: { width: 820, height: 640 },
    ready: '[data-testid="pr-checks-trigger"]',
    path: "Click the CI status chip on a worktree card's PR badge",
    open: async (page) => {
      const trigger = page.locator('[data-testid="pr-checks-trigger"]').first();
      const surface = page.locator('[data-testid="pr-checks-popover"]');
      await clickOpen(page, trigger, surface);
      return { trigger, surface };
    },
  },
  {
    slug: "worktree-card-menu",
    url: "/worktree-overview-preview.html?fleet=busy&scene=sidebar",
    viewport: { width: 760, height: 1000 },
    ready: '[data-testid="worktree-actions-menu"]',
    path: "Hover a worktree card in the sidebar and click its ⋯ (More actions)",
    open: async (page) => {
      const trigger = page.locator('[data-testid="worktree-actions-menu"]').first();
      const surface = page.locator(MENU).last();
      await trigger.hover();
      await clickOpen(page, trigger, surface);
      return { trigger, surface };
    },
  },
  {
    slug: "worktree-details-resource-menu",
    url: "/menus-preview.html?scene=worktree-resource",
    viewport: { width: 760, height: 700 },
    ready: 'button[aria-label="Show details"]',
    path: "Right-click the collapsed details row of a worktree card with a resource configured (the trigger is an sr-only span; there is no visible affordance)",
    open: async (page) => {
      const trigger = page.locator('button[aria-label="Show details"]').first();
      const surface = page.locator(MENU).last();
      const box = await trigger.boundingBox();
      if (!box) throw new Error("worktree-details-resource-menu: details row has no box");
      const point = centreOf(box);
      // The menu's trigger is a visually hidden span, so a real pointer can never
      // land on it; deliver the contextmenu event to it directly, at the row.
      for (let attempt = 0; attempt < 3; attempt++) {
        await page.evaluate(({ x, y }) => {
          const span = Array.from(document.querySelectorAll("span.sr-only")).find(
            (s) => s.textContent?.trim() === "Resource actions"
          );
          if (!span) throw new Error("no Resource actions trigger in the card");
          span.dispatchEvent(
            new MouseEvent("contextmenu", {
              bubbles: true,
              cancelable: true,
              clientX: x,
              clientY: y,
              button: 2,
            })
          );
        }, point);
        try {
          await expect(surface).toBeVisible({ timeout: 2_000 });
          break;
        } catch {
          await page.keyboard.press("Escape");
        }
      }
      await expect(surface.getByRole("menuitem", { name: /Tear down resource/ })).toBeVisible();
      return { trigger, surface, point };
    },
  },
  {
    slug: "browser-history-menu",
    url: "/menus-preview.html?scene=browser-toolbar",
    viewport: { width: 960, height: 520 },
    ready: '[data-testid="browser-back"]',
    path: "Press and hold the Back button in a browser or dev-preview panel",
    open: async (page) => {
      const trigger = page.locator('[data-testid="browser-back"]').first();
      const surface = page
        .locator('.relative.flex:has([data-testid="browser-back"]) > div.surface-overlay')
        .first();
      await trigger.hover();
      await page.mouse.down();
      await page.waitForTimeout(650);
      await page.mouse.up();
      await expect(surface).toBeVisible({ timeout: 3_000 });
      return { trigger, surface };
    },
  },
  {
    slug: "browser-address-suggestions",
    url: "/dev-preview-toolbar-preview.html?fixture=rest",
    viewport: { width: 980, height: 600 },
    ready: '[data-testid="browser-address-bar"]',
    path: "Click into the address bar of a browser or dev-preview panel",
    open: async (page) => {
      const trigger = page.locator('[data-testid="browser-address-bar"]').first();
      const surface = page.locator('[role="listbox"]:visible').first();
      await trigger.click();
      await trigger.fill("");
      await expect(surface).toBeVisible({ timeout: 3_000 });
      await page.keyboard.press("ArrowDown");
      return { trigger, surface };
    },
  },
  {
    slug: "viewport-controls",
    url: "/dev-preview-toolbar-preview.html?fixture=device-menu",
    viewport: { width: 640, height: 720 },
    ready: '[data-testid="browser-address-bar"]',
    path: "Click the Device button in a dev-preview panel's toolbar",
    open: async (page) => {
      const trigger = page.locator('button[aria-label^="Device:"]').first();
      const surface = page.locator(MENU).last();
      await clickOpen(page, trigger, surface);
      return { trigger, surface };
    },
  },
  {
    slug: "autocomplete-menu",
    url: "/autocomplete-menu-preview.html?case=commands-run",
    viewport: { width: 900, height: 700 },
    ready: "[data-autocomplete-menu]",
    path: "Type / in an agent terminal's composer",
    open: async (page) => {
      const trigger = page.locator(".cm-editor").first();
      const surface = page.locator("[data-autocomplete-menu]").first();
      await expect(surface).toBeVisible();
      await expect.poll(() => surface.evaluate((el) => getComputedStyle(el).opacity)).toBe("1");
      return { trigger, surface };
    },
  },
  {
    slug: "diff-notes-send-menu",
    url: "/menus-preview.html?scene=diff-notes",
    viewport: { width: 720, height: 480 },
    ready: '[data-testid="diff-notes-send"]',
    path: "Click Send notes in a diff pane's footer (after adding review notes)",
    open: async (page) => {
      const trigger = page.locator('[data-testid="diff-notes-send"]').first();
      const surface = page.locator(MENU).last();
      await clickOpen(page, trigger, surface);
      return { trigger, surface };
    },
  },
  {
    slug: "file-browser-view-options",
    url: "/menus-preview.html?scene=file-browser-options",
    viewport: { width: 520, height: 480 },
    ready: '[data-testid="menus-file-browser-options"]',
    path: "Click the sliders (File tree options) button in a file browser panel's tree header",
    open: async (page) => {
      const trigger = page.locator('[data-testid="menus-file-browser-options"]').first();
      const surface = page.locator(MENU).last();
      await clickOpen(page, trigger, surface);
      return { trigger, surface };
    },
  },
  {
    slug: "markdown-text-size",
    url: "/menus-preview.html?scene=markdown-text-size",
    viewport: { width: 620, height: 380 },
    ready: '[data-testid="menus-markdown-text-size"]',
    path: "Click the Aa (Text size) button in a markdown file panel's toolbar",
    open: async (page) => {
      const trigger = page.locator('[data-testid="menus-markdown-text-size"]').first();
      const surface = page.locator(POPOVER).last();
      await clickOpen(page, trigger, surface);
      return { trigger, surface };
    },
  },
  {
    slug: "compact-error-list",
    url: "/error-banner-preview.html?scene=terminal-overflow",
    viewport: { width: 900, height: 700 },
    ready: '[data-testid="compact-error-overflow"]',
    path: "Click 'N more errors' under a terminal's error banners",
    open: async (page) => {
      const trigger = page.locator('[data-testid="compact-error-overflow"]').first();
      const surface = page.locator('[role="dialog"][aria-label="More errors"]');
      await clickOpen(page, trigger, surface);
      return { trigger, surface };
    },
  },
  {
    slug: "mcp-activity-strip",
    url: "/recent-calls-preview.html?fixture=populated&width=380",
    viewport: { width: 520, height: 640 },
    ready: 'button[aria-label="Recent tool calls"]',
    path: "Click the recent tool calls strip in the assistant (help) panel footer",
    open: async (page) => {
      const trigger = page.locator('button[aria-label="Recent tool calls"]').first();
      const surface = page
        .locator('[data-radix-popper-content-wrapper] [aria-label="Recent tool calls"]')
        .first();
      await clickOpen(page, trigger, surface);
      return { trigger, surface };
    },
  },
];

async function load(page: Page, shot: Shot, theme: string): Promise<void> {
  await page.setViewportSize(shot.viewport);
  await page.mouse.move(0, 0);
  const sep = shot.url.includes("?") ? "&" : "?";
  const url = `${server!.baseURL}${shot.url}${sep}theme=${theme}`;
  const ready = page.locator(shot.ready).first();
  // The first load after a dependency change can answer 504 "Outdated Optimize
  // Dep" while Vite re-optimises and reloads; one more navigation after it
  // settles is enough.
  for (let attempt = 0; ; attempt++) {
    await page.goto(attempt === 0 ? url : "about:blank");
    if (attempt > 0) await page.goto(url, { waitUntil: "load" });
    try {
      await ready.waitFor({ state: "visible", timeout: attempt === 0 ? 30_000 : 60_000 });
      break;
    } catch (error) {
      if (attempt >= 2) {
        throw new Error(`${shot.slug}: ${shot.ready} never appeared at ${url}`, { cause: error });
      }
    }
  }
  await page.addStyleTag({ content: FREEZE_CSS });
  await page.evaluate(() => document.fonts.ready);
  await settle(page, 300);
}

/** Geometry of the open surface and its trigger, for the sidecar JSON. */
async function measure(trigger: Locator, surface: Locator | null) {
  const triggerHandle = await trigger.elementHandle();
  const surfaceHandle = surface ? await surface.elementHandle() : null;
  return trigger.page().evaluate(
    ([t, s]) => {
      const round = (n: number) => Math.round(n * 10) / 10;
      const box = (el: Element) => {
        const r = el.getBoundingClientRect();
        return { x: round(r.x), y: round(r.y), w: round(r.width), h: round(r.height) };
      };
      const triggerBox = t ? box(t) : null;
      if (!s) return { trigger: triggerBox, surface: null, rows: [], separators: [] };
      const cs = getComputedStyle(s);
      const surfaceBox = box(s);
      const surfaceInfo = {
        tag: s.tagName.toLowerCase(),
        role: s.getAttribute("role"),
        ariaLabel: s.getAttribute("aria-label"),
        box: surfaceBox,
        padding: {
          top: cs.paddingTop,
          right: cs.paddingRight,
          bottom: cs.paddingBottom,
          left: cs.paddingLeft,
        },
        borderRadius: cs.borderRadius,
        borderWidth: cs.borderTopWidth,
        borderColor: cs.borderTopColor,
        backgroundColor: cs.backgroundColor,
        boxShadow: cs.boxShadow,
        minWidth: cs.minWidth,
        fontSize: cs.fontSize,
        className: typeof s.className === "string" ? s.className : null,
      };

      const ROW_ROLES =
        '[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="option"]';
      let rowEls = Array.from(s.querySelectorAll(ROW_ROLES));
      let rowKind = "role";
      if (rowEls.length === 0) {
        // Hand-built lists and popovers: every visible button, outermost only.
        rowEls = Array.from(s.querySelectorAll("button")).filter(
          (b) => !b.parentElement?.closest("button")
        );
        rowKind = "button";
      }
      const firstTextLeft = (el: Element): number | null => {
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          if (!n.textContent?.trim()) continue;
          const parent = n.parentElement;
          if (parent && parent.closest(".sr-only")) continue;
          const range = document.createRange();
          range.selectNodeContents(n);
          const r = range.getBoundingClientRect();
          if (r.width > 0) return r.left;
        }
        return null;
      };
      const rows = rowEls
        .filter((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        })
        .slice(0, 60)
        .map((el) => {
          const rcs = getComputedStyle(el);
          const r = el.getBoundingClientRect();
          const svg = el.querySelector("svg");
          const svgInfo = svg
            ? (() => {
                const sr = svg.getBoundingClientRect();
                const scs = getComputedStyle(svg);
                return {
                  xOffset: round(sr.left - r.left),
                  yOffset: round(sr.top - r.top),
                  w: round(sr.width),
                  h: round(sr.height),
                  color: scs.color,
                  opacity: scs.opacity,
                };
              })()
            : null;
          const textLeft = firstTextLeft(el);
          return {
            role: el.getAttribute("role") ?? el.tagName.toLowerCase(),
            text: (el as HTMLElement).innerText.replace(/\s+/g, " ").trim().slice(0, 80),
            disabled:
              el.hasAttribute("data-disabled") ||
              el.getAttribute("aria-disabled") === "true" ||
              (el as HTMLButtonElement).disabled === true,
            box: box(el),
            insetFromSurface: round(r.left - surfaceBox.x),
            paddingLeft: rcs.paddingLeft,
            paddingRight: rcs.paddingRight,
            height: round(r.height),
            color: rcs.color,
            fontSize: rcs.fontSize,
            fontWeight: rcs.fontWeight,
            borderRadius: rcs.borderRadius,
            textXOffset: textLeft === null ? null : round(textLeft - r.left),
            hasSvg: !!svg,
            svg: svgInfo,
          };
        });
      const separators = Array.from(s.querySelectorAll('[role="separator"]')).map((el) => {
        const scs = getComputedStyle(el);
        return {
          box: box(el),
          marginTop: scs.marginTop,
          marginBottom: scs.marginBottom,
          marginLeft: scs.marginLeft,
          marginRight: scs.marginRight,
          backgroundColor: scs.backgroundColor,
        };
      });

      let side = "overlap";
      let gap: number | null = null;
      let alignStart: number | null = null;
      let alignEnd: number | null = null;
      if (triggerBox) {
        const tb = triggerBox;
        const sb = surfaceBox;
        if (sb.y >= tb.y + tb.h - 1) {
          side = "bottom";
          gap = round(sb.y - (tb.y + tb.h));
        } else if (sb.y + sb.h <= tb.y + 1) {
          side = "top";
          gap = round(tb.y - (sb.y + sb.h));
        } else if (sb.x >= tb.x + tb.w - 1) {
          side = "right";
          gap = round(sb.x - (tb.x + tb.w));
        } else if (sb.x + sb.w <= tb.x + 1) {
          side = "left";
          gap = round(tb.x - (sb.x + sb.w));
        }
        alignStart = round(sb.x - tb.x);
        alignEnd = round(sb.x + sb.w - (tb.x + tb.w));
      }
      return {
        trigger: triggerBox,
        surface: surfaceInfo,
        placement: { side, sideOffset: gap, alignStartDelta: alignStart, alignEndDelta: alignEnd },
        rowKind,
        rows,
        separators,
      };
    },
    [triggerHandle, surfaceHandle] as const
  );
}

async function capture(page: Page, shot: Shot, theme: string): Promise<string> {
  const file = `${theme}-${shot.slug}.png`;
  await load(page, shot, theme);
  const opened = await shot.open(page);
  await settle(page, 250);

  const allowEmpty = ALLOW_NO_SURFACE.has(shot.slug);
  const surfaceOpen = await opened.surface.isVisible().catch(() => false);
  let surfaceBox: { x: number; y: number; width: number; height: number } | null = null;
  if (surfaceOpen) {
    await expect
      .poll(() => opened.surface.evaluate((el) => getComputedStyle(el).opacity), {
        message: `${file}: surface never finished fading in`,
        timeout: 3_000,
      })
      .toBe("1");
    surfaceBox = await opened.surface.boundingBox();
    if (
      !surfaceBox ||
      surfaceBox.width < MIN_SURFACE.width ||
      surfaceBox.height < MIN_SURFACE.height
    ) {
      throw new Error(`${file}: surface has no real box (${JSON.stringify(surfaceBox)})`);
    }
  } else if (!allowEmpty) {
    throw new Error(`${file}: surface is not open — refusing to write`);
  }

  const triggerBox = await opened.trigger.boundingBox({ timeout: 5_000 });
  if (!triggerBox) throw new Error(`${file}: trigger has no box`);
  const anchor =
    opened.clipToPoint && opened.point
      ? { x: opened.point.x - 8, y: opened.point.y - 8, width: 16, height: 16 }
      : triggerBox;
  const boxes = surfaceBox ? [anchor, surfaceBox] : [anchor];
  const vp = page.viewportSize()!;
  const x0 = Math.max(0, Math.floor(Math.min(...boxes.map((b) => b.x)) - PAD));
  const y0 = Math.max(0, Math.floor(Math.min(...boxes.map((b) => b.y)) - PAD));
  const x1 = Math.min(vp.width, Math.ceil(Math.max(...boxes.map((b) => b.x + b.width)) + PAD));
  const y1 = Math.min(vp.height, Math.ceil(Math.max(...boxes.map((b) => b.y + b.height)) + PAD));
  const clip = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };

  const geometry = await measure(opened.trigger, surfaceOpen ? opened.surface : null);
  const out = path.join(OUT_DIR, file);
  await page.screenshot({ path: out, clip });
  if (!existsSync(out)) throw new Error(`${file}: screenshot did not land`);
  writeFileSync(
    out.replace(/\.png$/, ".json"),
    JSON.stringify(
      {
        slug: shot.slug,
        theme,
        page: shot.url,
        howToReach: shot.path,
        surfaceOpen,
        note: surfaceOpen
          ? undefined
          : "Allow-listed baseline: no React surface opened (native Electron menu in the app).",
        viewport: vp,
        clip,
        point: opened.point ?? null,
        pointOffset:
          opened.point && surfaceBox
            ? {
                dx: Math.round(surfaceBox.x - opened.point.x),
                dy: Math.round(surfaceBox.y - opened.point.y),
              }
            : null,
        ...geometry,
      },
      null,
      2
    )
  );
  return file;
}

/**
 * Runs in the page before any module. The preview pages' inert bridge shim
 * answers every call with `undefined`, but an agent chip in the dock asks its
 * agent for subagents on mount and reads `.status` off the reply — so every
 * dock page would throw. The real bridge always answers with a result; this
 * wraps whatever bridge the page installs so those two lookups answer the way
 * a session-less agent does, and every other name is left untouched.
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
            get: (inner, name) =>
              name === "listSubagents" ? unavailable : Reflect.get(inner, name),
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

test.describe("menus and popovers review", () => {
  test("captures", async ({ context }) => {
    test.info().annotations.push({
      type: "conditional-skip",
      description: "DAINTREE_SHOT_MENUS is required for the menus and popovers capture",
    });
    test.skip(!ENABLED, "Set DAINTREE_SHOT_MENUS to run the menus and popovers capture");
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
