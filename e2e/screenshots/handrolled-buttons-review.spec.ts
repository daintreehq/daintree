/**
 * Hand-rolled-button consolidation visual-review harness.
 *
 * Raw `<button>`s that hand-copied a `Button` variant are moving onto `Button`,
 * and the `link` variant is being redefined. This captures the before/after
 * evidence: the primitive's variants in every interaction state
 * (`handrolled-buttons-preview.html`, matrix section), the affected components
 * no other preview mounts (same page, surfaces section), and the affected
 * components that existing preview pages already render, driven into the state
 * that shows the button.
 *
 * Opt-in only, like every sibling review harness:
 *
 *   DAINTREE_SHOT_HANDROLLED_BUTTONS=1 DAINTREE_SHOT_DIR=/abs/out \
 *     npx playwright test --project=screenshots handrolled-buttons-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_HANDROLLED_BUTTONS  required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR                 required — absolute output directory (wiped first)
 *   DAINTREE_SHOT_THEMES              comma-separated theme sweep (default daintree,bondi)
 *
 * Output, per theme:
 *   matrix--rest--<theme>.png               the whole matrix (panel + canvas copies)
 *   matrix--hover-<id>--<theme>.png         one button hovered, padded clip
 *   matrix--focus-<id>--<theme>.png         one button keyboard-focused (:focus-visible)
 *   matrix--active-<id>--<theme>.png        one button pressed (mouse down, no up)
 *   surface--<Name>--<theme>.png            one real component card
 *   page--<slug>--<state>--<theme>.png      an existing preview page, cropped
 *
 * Never writes a PNG it has not verified, and counts the files itself at the end.
 */

import { test, expect, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readdirSync, rmSync } from "fs";
import path from "path";
import {
  makeSnap,
  startPreviewServer,
  stubViteHmrClient,
  type PreviewServer,
} from "../helpers/previewHarness";

const ENABLED = !!process.env.DAINTREE_SHOT_HANDROLLED_BUTTONS;

function requireOutDir(): string {
  const dir = process.env.DAINTREE_SHOT_DIR;
  if (!dir) {
    throw new Error("DAINTREE_SHOT_DIR is required (an absolute path outside the repo)");
  }
  return path.resolve(dir);
}

const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

const PAGE = "handrolled-buttons-preview.html";
const ATTACH_TIMEOUT_MS = 30_000;
const CLIP_PAD = 16;

const HOVER_IDS = [
  "link-default",
  "ghost-sm",
  "ghost-xs",
  "subtle-sm",
  "outline-sm",
  "contrast-sm",
];
const FOCUS_IDS = HOVER_IDS;
const ACTIVE_IDS = ["ghost-sm", "link-default"];

/** Pointer states must still apply: transitions are zeroed, not the rules behind them. */
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

type Driver = (page: Page) => Promise<Locator>;

interface SurfaceShot {
  name: string;
  /** The component name the preview entry mounts. */
  surface: string;
  query?: string;
  drive?: (card: Locator, page: Page) => Promise<void>;
  expect: (card: Locator) => Promise<void>;
}

const SURFACES: SurfaceShot[] = [
  {
    name: "TerminalCountWarning",
    surface: "TerminalCountWarning",
    expect: (card) => expect(card.getByRole("button", { name: /completed agent/ })).toBeVisible(),
  },
  {
    name: "SystemToolsStep",
    surface: "SystemToolsStep",
    expect: (card) => expect(card.getByRole("button", { name: "How to install" })).toBeVisible(),
  },
  {
    name: "SystemRequirementsSection-ok",
    surface: "SystemRequirementsSection",
    drive: async (card) => {
      const header = card.locator("button[aria-controls='system-requirements-panel']");
      await expect(header).toBeVisible();
      await expect(card.getByText("Checking", { exact: false })).toHaveCount(0, {
        timeout: 5_000,
      });
      await header.click();
    },
    expect: (card) => expect(card.getByRole("button", { name: "Re-check" })).toBeVisible(),
  },
  {
    name: "SystemRequirementsSection-git-missing",
    surface: "SystemRequirementsSection",
    query: "git=missing",
    expect: (card) => expect(card.getByRole("button", { name: "Check again" })).toBeVisible(),
  },
  {
    name: "AgentCliStep",
    surface: "AgentCliStep",
    expect: (card) => expect(card.getByRole("button", { name: /^Install/ }).first()).toBeVisible(),
  },
  {
    name: "ProjectPulseCard",
    surface: "ProjectPulseCard",
    expect: (card) =>
      expect(card.getByRole("button", { name: "Refresh", exact: true })).toBeVisible(),
  },
  {
    name: "ProjectPulseCard-error",
    surface: "ProjectPulseCard-error",
    expect: (card) => expect(card.getByRole("button", { name: "Retry now" })).toBeVisible(),
  },
  {
    name: "ResumeSessionLine",
    surface: "ResumeSessionLine",
    expect: (card) => expect(card.getByRole("button").first()).toBeVisible(),
  },
];

interface PageShot {
  slug: string;
  state: string;
  url: string;
  viewport?: { width: number; height: number };
  drive: Driver;
  expect: (target: Locator, page: Page) => Promise<void>;
}

const popper = (page: Page) => page.locator("[data-radix-popper-content-wrapper]").last();
const dialogCard = (page: Page) =>
  page.locator('[role="dialog"] > div, [role="alertdialog"] > div').first();

const PAGES: PageShot[] = [
  {
    slug: "panel-limit",
    state: "batch",
    url: "panel-limit-preview.html?fixture=batch",
    drive: async (page) => dialogCard(page),
    expect: (t) => expect(t.getByText("change your panel limits")).toBeVisible(),
  },
  {
    slug: "recovery-banners",
    state: "safe-mode-confirm",
    url: "recovery-banners-preview.html?fixture=safe-mode&width=1100",
    drive: async (page) => {
      await page.getByRole("button", { name: "Restart normally" }).first().click();
      return dialogCard(page);
    },
    expect: (t) => expect(t.getByText("View logs")).toBeVisible(),
  },
  {
    slug: "assistant-launching",
    state: "gate",
    url: "assistant-launching-preview.html?fixture=gate",
    drive: async (page) => page.locator("[data-preview-body]").first(),
    expect: (t) => expect(t.getByText(/docs/i).last()).toBeVisible(),
  },
  {
    slug: "sidebar-footer",
    state: "plugin-popover",
    url: "sidebar-footer-preview.html?fixture=plugin-row&width=320",
    viewport: { width: 420, height: 900 },
    drive: async (page) => {
      await page.getByRole("button", { name: /^Project plugins/ }).click();
      return popper(page);
    },
    expect: (t) => expect(t.getByText("Open plugin manager")).toBeVisible(),
  },
  {
    slug: "sidebar-footer",
    state: "resource-popover",
    url: "sidebar-footer-preview.html?fixture=busy-session&width=320",
    viewport: { width: 420, height: 1180 },
    drive: async (page) => {
      await page.locator("[data-status-readout]").click();
      const content = popper(page);
      await expect(content).toBeVisible();
      await expect(content.getByLabel("Loading resource details")).toHaveCount(0);
      return content;
    },
    expect: (t) => expect(t.getByRole("button", { name: "Diagnostics" })).toBeVisible(),
  },
  {
    slug: "sidebar-footer",
    state: "running-tasks",
    url: "sidebar-footer-preview.html?fixture=running-tasks&width=320",
    viewport: { width: 420, height: 900 },
    drive: async (page) => {
      await page
        .getByRole("button", { name: /run command/i })
        .first()
        .click();
      await expect(page.locator("#quick-run-panel")).toBeVisible();
      return page.locator("[data-footer-region]");
    },
    expect: (t) => expect(t.getByText("npm run dev").first()).toBeVisible(),
  },
  {
    slug: "worktree-filter",
    state: "busy",
    url: "worktree-filter-preview.html?fixture=busy",
    drive: async (page) => {
      await page.getByRole("button", { name: /^Filter and sort worktrees/ }).click();
      const popover = page.getByTestId("worktree-filter-popover");
      // The "N more" toggle lives inside the Branch type facet, which may rest shut.
      const facet = popover.locator("button[aria-expanded]", { hasText: "Branch type" }).first();
      if ((await facet.getAttribute("aria-expanded")) !== "true") await facet.click();
      await expect(facet).toHaveAttribute("aria-expanded", "true");
      await page.mouse.move(0, 0);
      return popover;
    },
    expect: (t) =>
      expect(t.getByRole("button", { name: /\d+ (more|with no matches)$/ }).first()).toBeVisible(),
  },
  {
    slug: "worktree-filter",
    state: "active",
    url: "worktree-filter-preview.html?fixture=active",
    drive: async (page) => {
      await page.getByRole("button", { name: /^Filter and sort worktrees/ }).click();
      return page.getByTestId("worktree-filter-popover");
    },
    expect: (t) => expect(t.getByRole("button", { name: "Clear Status filters" })).toBeVisible(),
  },
  {
    slug: "recipes",
    state: "runner-three",
    url: "recipes-preview.html?view=runner&fixture=three",
    drive: async (page) => page.locator("[data-preview-canvas]").first(),
    expect: (t) => expect(t.getByRole("button", { name: "Manage recipes" })).toBeVisible(),
  },
  {
    slug: "fleet",
    state: "picker-palette",
    url: "fleet-preview.html?fixture=picker-palette",
    drive: async (page) => page.locator("[data-preview-frame]").first(),
    expect: (_t, page) =>
      expect(page.getByRole("button", { name: "Select agents" }).first()).toBeVisible(),
  },
  {
    slug: "worktree-sessions",
    state: "mixed",
    url: "worktree-sessions-preview.html?fixture=mixed",
    drive: async (page) => page.locator("[data-preview-card]").first(),
    expect: (t) => expect(t.getByRole("button").first()).toBeVisible(),
  },
  {
    slug: "first-run",
    state: "welcome",
    url: "first-run-preview.html?projects=3&onboarding=skipped",
    drive: async (page) => page.locator("[data-preview-shell]").first(),
    expect: (t) => expect(t.getByRole("button", { name: "Set up agents" })).toBeVisible(),
  },
  {
    slug: "first-run",
    state: "project-open",
    // Opened mid-session from a fresh welcome, as the first-run spec's state 63
    // does: that is the path on which the checklist first shows.
    url: "first-run-preview.html?projects=1&onboarding=fresh&agents=ready",
    drive: async (page) => {
      await page.evaluate(() =>
        (Reflect.get(window, "__firstRun") as { openProject: () => void }).openProject()
      );
      await page.waitForTimeout(900);
      // The checklist portals to <body>, outside the preview shell.
      return page.locator("body");
    },
    expect: async (t) => {
      await expect(t.getByLabel("Getting started checklist")).toBeVisible();
      await expect(t.getByRole("button", { name: "Dismiss checklist" })).toHaveCount(1);
    },
  },
  {
    slug: "subagent-chip",
    state: "transcript-unavailable",
    url: "subagent-chip-preview.html?fixture=codex-transcript-unavailable",
    viewport: { width: 820, height: 760 },
    drive: async (page) => {
      const chip = page.getByRole("button", { name: /subagent/i }).first();
      await expect(chip).toBeVisible({ timeout: 10_000 });
      await chip.click();
      const content = popper(page);
      await expect(content).toBeVisible();
      await content.locator("li button").first().click();
      return content;
    },
    expect: (t) => expect(t.getByRole("button", { name: "Retry" })).toBeVisible(),
  },
];

test.use({ deviceScaleFactor: 2 });

let OUT_DIR = "";
let snap: ReturnType<typeof makeSnap>;
let server: PreviewServer | undefined;

test.beforeAll(async () => {
  // The skip lives in the test body: `test.info()` is unavailable in beforeAll.
  if (!ENABLED) return;
  OUT_DIR = requireOutDir();
  if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });
  snap = makeSnap(OUT_DIR);
  server = await startPreviewServer();
});

test.afterAll(async () => {
  await server?.close();
});

/** Hold a throwaway page open until Vite's dependency optimizer stops reloading it. */
async function settleDevServer(context: BrowserContext) {
  const page = await context.newPage();
  await stubViteHmrClient(page);
  let navigations = 0;
  page.on("framenavigated", () => navigations++);
  // Every entry this spec visits, so the optimizer discovers all their deps up front.
  for (const url of [`${PAGE}`, ...new Set(PAGES.map((p) => p.url))]) {
    await page.goto(`${server!.baseURL}/${url}`);
    for (let attempt = 0; attempt < 6; attempt++) {
      const before = navigations;
      await page.waitForTimeout(1_500);
      if (navigations === before) break;
    }
  }
  await page.close();
}

/** Every capture gets its own page; a renderer that dies under load gets one more go. */
async function withPage<T>(
  context: BrowserContext,
  what: string,
  body: (page: Page) => Promise<T>
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const page = await context.newPage();
    await stubViteHmrClient(page);
    let crashed = false;
    const errors: string[] = [];
    page.on("crash", () => {
      crashed = true;
    });
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      const result = await body(page);
      if (errors.length > 0) throw new Error(`${what}: page threw: ${errors.join(" | ")}`);
      return result;
    } catch (error) {
      if (crashed && attempt === 1) {
        console.warn(`[handrolled-buttons-shots] renderer crashed on ${what}; retrying once`);
        continue;
      }
      throw new Error(`${what}: ${String(error)}`, { cause: error });
    } finally {
      await page.close().catch(() => undefined);
    }
  }
}

async function settle(page: Page) {
  await page.addStyleTag({ content: FREEZE_CSS });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
}

async function openMatrix(page: Page, theme: string): Promise<Locator> {
  await page.setViewportSize({ width: 960, height: 1400 });
  await page.goto(`${server!.baseURL}/${PAGE}?theme=${theme}&section=matrix`);
  const matrix = page.locator('[data-capture="matrix"]');
  await expect(matrix).toBeVisible({ timeout: ATTACH_TIMEOUT_MS });
  await settle(page);
  // Park the pointer off every button so the rest state has no stray hover.
  await page.mouse.move(2, 2);
  return matrix;
}

function button(page: Page, id: string): Locator {
  return page.locator(`[data-capture-id="${id}"]`);
}

/** A padded clip around one button, after proving the state it claims is live. */
async function snapState(page: Page, id: string, pseudo: string, file: string): Promise<string> {
  const target = button(page, id);
  await expect(target).toBeVisible();
  const live = await target.evaluate((el, sel) => el.matches(sel), pseudo);
  if (!live) throw new Error(`${file}: ${id} does not match ${pseudo} — refusing to write`);
  const box = await target.boundingBox();
  if (!box || box.width < 8 || box.height < 8) {
    throw new Error(`${file}: ${id} has no real box — refusing to write`);
  }
  const out = path.join(OUT_DIR, file);
  await page.screenshot({
    path: out,
    clip: {
      x: Math.max(0, box.x - CLIP_PAD),
      y: Math.max(0, box.y - CLIP_PAD),
      width: box.width + CLIP_PAD * 2,
      height: box.height + CLIP_PAD * 2,
    },
  });
  return out;
}

async function openSurface(page: Page, shot: SurfaceShot, theme: string): Promise<Locator> {
  await page.setViewportSize({ width: 900, height: 1000 });
  const extra = shot.query ? `&${shot.query}` : "";
  await page.goto(
    `${server!.baseURL}/${PAGE}?theme=${theme}&surface=${encodeURIComponent(shot.surface)}${extra}`
  );
  const card = page.locator(`[data-capture-surface="${shot.surface}"]`);
  await expect(card, `${shot.name}: no card`).toBeVisible({ timeout: ATTACH_TIMEOUT_MS });
  await settle(page);
  await page.mouse.move(2, 2);
  if (shot.drive) await shot.drive(card, page);
  await page.waitForTimeout(300);
  await shot.expect(card);
  return card;
}

async function openPage(page: Page, shot: PageShot, theme: string): Promise<Locator> {
  await page.setViewportSize(shot.viewport ?? { width: 1280, height: 800 });
  await page.goto(`${server!.baseURL}/${shot.url}&theme=${theme}`);
  await expect(page.locator("#root > *").first()).toBeAttached({ timeout: ATTACH_TIMEOUT_MS });
  await settle(page);
  const target = await shot.drive(page);
  await expect(target, `${shot.slug}/${shot.state}: target missing`).toBeVisible({
    timeout: 10_000,
  });
  await page.waitForTimeout(350);
  await shot.expect(target, page);
  return target;
}

test("hand-rolled buttons — variant matrix, surfaces and pages", async ({ context }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_HANDROLLED_BUTTONS is required for the hand-rolled-buttons capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_HANDROLLED_BUTTONS=1 to run the capture");
  test.setTimeout(30 * 60_000);

  await settleDevServer(context);
  const written: string[] = [];

  for (const theme of THEMES) {
    written.push(
      await withPage(context, `matrix rest ${theme}`, async (page) =>
        snap(await openMatrix(page, theme), `matrix--rest--${theme}.png`)
      )
    );

    for (const id of HOVER_IDS) {
      written.push(
        await withPage(context, `hover ${id} ${theme}`, async (page) => {
          await openMatrix(page, theme);
          await button(page, id).hover();
          await page.waitForTimeout(150);
          return snapState(page, id, ":hover", `matrix--hover-${id}--${theme}.png`);
        })
      );
    }

    for (const id of FOCUS_IDS) {
      written.push(
        await withPage(context, `focus ${id} ${theme}`, async (page) => {
          await openMatrix(page, theme);
          let reached = false;
          for (let i = 0; i < 120 && !reached; i++) {
            await page.keyboard.press("Tab");
            reached = await page.evaluate(
              (want) => document.activeElement?.getAttribute("data-capture-id") === want,
              id
            );
          }
          if (!reached) throw new Error(`Tab never reached ${id}`);
          await page.waitForTimeout(150);
          return snapState(page, id, ":focus-visible", `matrix--focus-${id}--${theme}.png`);
        })
      );
    }

    for (const id of ACTIVE_IDS) {
      written.push(
        await withPage(context, `active ${id} ${theme}`, async (page) => {
          await openMatrix(page, theme);
          await button(page, id).hover();
          await page.mouse.down();
          await page.waitForTimeout(150);
          try {
            return await snapState(page, id, ":active", `matrix--active-${id}--${theme}.png`);
          } finally {
            await page.mouse.up();
          }
        })
      );
    }

    for (const shot of SURFACES) {
      written.push(
        await withPage(context, `surface ${shot.name} ${theme}`, async (page) =>
          snap(await openSurface(page, shot, theme), `surface--${shot.name}--${theme}.png`)
        )
      );
    }

    for (const shot of PAGES) {
      written.push(
        await withPage(context, `page ${shot.slug}/${shot.state} ${theme}`, async (page) =>
          snap(await openPage(page, shot, theme), `page--${shot.slug}--${shot.state}--${theme}.png`)
        )
      );
    }
  }

  const expected =
    THEMES.length *
    (1 + HOVER_IDS.length + FOCUS_IDS.length + ACTIVE_IDS.length + SURFACES.length + PAGES.length);
  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(new Set(written).size).toBe(expected);
  expect(onDisk.length).toBe(expected);
  console.log(`[handrolled-buttons-shots] ${onDisk.length} PNGs in ${OUT_DIR}`);
});
