/**
 * "Edit name and icon" visual-review harness.
 *
 * The toolbar pill's context menu opens `ProjectIdentityEditor`: a name field
 * and the shared `EmojiPicker` in one anchored popover. Most of what that
 * surface can look like only exists mid-interaction — a hovered or
 * arrow-keyed emoji, a search with and without results, an emptied name, a
 * name too long for the field, the picker scrolled under a sticky header,
 * emoji data still loading — so each state is a fixture page plus the input
 * that produces it, driven through the real keyboard and pointer. The dialog
 * row's `ProjectEmojiButton`, the picker's other popover consumer, is
 * captured beside it.
 *
 * Served by Vite from `project-identity-preview.html`, not Electron. Sibling of
 * `project-pill-review.spec.ts`.
 *
 * Opt-in only:
 *
 *   DAINTREE_SHOT_IDENTITY=1 DAINTREE_SHOT_DIR=/abs/out \
 *     npx playwright test --project=screenshots project-identity-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_IDENTITY  required — enables the capture
 *   DAINTREE_SHOT_DIR       required — absolute output dir. No default: an in-repo
 *                           fallback would put PNGs into someone's tree.
 *   DAINTREE_SHOT_THEMES    themes that get the full state set (default daintree,bondi,namib)
 *   DAINTREE_SCREENSHOT_SCALE  device scale factor (default 2)
 *
 * Output: <dir>/<state>-<theme>.png, <dir>/theme-sweep.png
 */

import { test, expect, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "fs";
import path from "path";
import { startPreviewServer, stubViteHmrClient } from "../helpers/previewHarness";

const ENABLED = !!process.env.DAINTREE_SHOT_IDENTITY;
const OUT_DIR = process.env.DAINTREE_SHOT_DIR ?? "";
const SCALE = Number(process.env.DAINTREE_SCREENSHOT_SCALE ?? "2");

const FULL_THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi,namib")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

/** Every built-in theme, for the hover-state sweep. */
const ALL_THEMES = [
  "daintree",
  "arashiyama",
  "fiordland",
  "galapagos",
  "highlands",
  "movile",
  "namib",
  "redwoods",
  "atacama",
  "bali",
  "bondi",
  "hokkaido",
  "serengeti",
  "svalbard",
  "table-mountain",
];

interface State {
  slug: string;
  /** Fixture in the preview entry (`FIXTURES` there). */
  fixture: "rest" | "suggestion" | "long-name" | "emoji-button";
  /** Hold the emoji data request so the picker stays in its loading state. */
  holdData?: boolean;
  /** Emulated OS contrast mode, where fills and shadows can be stripped. */
  media?: { forcedColors?: "active"; contrast?: "more" };
  drive?: (page: Page) => Promise<void>;
}

const search = (page: Page) => page.locator("[frimousse-search]");
const cell = (page: Page, n: number) =>
  page.locator("[frimousse-row][role=row] [frimousse-emoji]").nth(n);

/** Tab from the autofocused name field until the picker's search box has focus. */
async function tabToSearch(page: Page): Promise<void> {
  for (let i = 0; i < 4; i++) {
    if (await search(page).evaluate((el) => el === document.activeElement)) return;
    await page.keyboard.press("Tab");
  }
  if (!(await search(page).evaluate((el) => el === document.activeElement))) {
    throw new Error("search never took focus by Tab");
  }
}

const STATES: State[] = [
  { slug: "rest", fixture: "rest" },
  { slug: "suggestion", fixture: "suggestion" },
  { slug: "long-name", fixture: "long-name" },
  {
    // Autofocus leaves the caret at the end, so the head of a long name is the
    // part a user has to go looking for.
    slug: "long-name-start",
    fixture: "long-name",
    drive: async (page) => {
      await page.keyboard.press("Home");
    },
  },
  {
    slug: "empty-name",
    fixture: "rest",
    drive: async (page) => {
      await page.keyboard.press("ControlOrMeta+a");
      await page.keyboard.press("Backspace");
    },
  },
  {
    slug: "picker-hover",
    fixture: "rest",
    drive: async (page) => {
      await cell(page, 12).hover();
    },
  },
  {
    slug: "picker-keyboard",
    fixture: "rest",
    drive: async (page) => {
      await tabToSearch(page);
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("ArrowRight");
    },
  },
  {
    slug: "search",
    fixture: "rest",
    drive: async (page) => {
      await tabToSearch(page);
      await page.keyboard.type("tree");
    },
  },
  {
    // The project's own emoji among results, where the current-value mark shows.
    slug: "search-current",
    fixture: "rest",
    drive: async (page) => {
      await tabToSearch(page);
      await page.keyboard.type("palm");
    },
  },
  {
    slug: "search-empty",
    fixture: "rest",
    drive: async (page) => {
      await tabToSearch(page);
      await page.keyboard.type("zzqqxx");
    },
  },
  {
    slug: "scrolled",
    fixture: "rest",
    drive: async (page) => {
      await page.locator("[frimousse-viewport]").evaluate((el) => {
        el.scrollTop = 1180;
      });
    },
  },
  { slug: "loading", fixture: "rest", holdData: true },
  {
    // The active cell and the current-value badge, with fills and box-shadows
    // stripped as Windows High Contrast does.
    slug: "forced-colors",
    fixture: "rest",
    media: { forcedColors: "active" },
    drive: async (page) => {
      await tabToSearch(page);
      await page.keyboard.type("palm");
    },
  },
  {
    slug: "contrast-more",
    fixture: "rest",
    media: { contrast: "more" },
    drive: async (page) => {
      await tabToSearch(page);
      await page.keyboard.type("palm");
    },
  },
  {
    slug: "emoji-button",
    fixture: "emoji-button",
    drive: async (page) => {
      await page.getByRole("button", { name: /Choose project emoji/ }).click();
    },
  },
];

let server: Awaited<ReturnType<typeof startPreviewServer>> | undefined;

test.beforeAll(async () => {
  if (!ENABLED) return;
  if (!OUT_DIR || !path.isAbsolute(OUT_DIR)) {
    throw new Error("DAINTREE_SHOT_DIR must be an absolute path");
  }
  if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });
  server = await startPreviewServer();
});

test.afterAll(async () => {
  await server?.close();
});

async function load(page: Page, theme: string, state: State): Promise<void> {
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await stubViteHmrClient(page);
  if (state.holdData) {
    // Never fulfilled: the picker sits in its loading state for the capture.
    await page.route("**/emojibase/**", () => {});
  }
  await page.emulateMedia({
    forcedColors: state.media?.forcedColors ?? "none",
    contrast: state.media?.contrast ?? "no-preference",
  });
  await page.setViewportSize({ width: 1180, height: 820 });
  await page.goto(
    `${server!.baseURL}/project-identity-preview.html?theme=${theme}&fixture=${state.fixture}`
  );
  await expect(page.locator("[data-preview-shell]")).toBeAttached();
  await page.evaluate(() => document.fonts.ready);
  await page.mouse.move(1170, 810);
  if (state.fixture !== "emoji-button") {
    await expect(page.locator("[frimousse-root]"), `${state.slug}: picker not open`).toBeVisible();
    if (!state.holdData) {
      await expect(cell(page, 20), `${state.slug}: emoji data never loaded`).toBeVisible();
    }
  }
}

/** Crop the strip and the popover together, with a margin of canvas. */
async function snap(page: Page, state: State, file: string): Promise<string> {
  const strip = await page.locator("[data-preview-strip]").boundingBox();
  const popover = await page.locator("[data-radix-popper-content-wrapper]").first().boundingBox();
  if (!strip || !popover || popover.width < 100 || popover.height < 100) {
    throw new Error(`${state.slug}: no real box (${JSON.stringify({ strip, popover })})`);
  }
  const margin = 24;
  // The pill as well as the popover, so a long name's pill is never cut.
  const pillLocator = page.locator('[data-testid="project-switcher-trigger"]');
  const pill = (await pillLocator.count()) > 0 ? await pillLocator.boundingBox() : null;
  const x = Math.max(0, Math.min(popover.x, pill?.x ?? popover.x) - margin);
  const right = Math.max(popover.x + popover.width, pill ? pill.x + pill.width : 0) + margin;
  const y = Math.max(0, strip.y - 8);
  const bottom = popover.y + popover.height + margin;
  const out = path.join(OUT_DIR, file);
  await page.screenshot({ path: out, clip: { x, y, width: right - x, height: bottom - y } });
  return out;
}

async function verify(page: Page, state: State): Promise<void> {
  const q = await search(page)
    .inputValue()
    .catch(() => "");
  switch (state.slug) {
    case "empty-name":
      expect(await page.locator("#project-identity-name").inputValue()).toBe("");
      break;
    case "picker-hover":
    case "picker-keyboard":
      await expect(
        page.locator("[frimousse-row][role=row] [frimousse-emoji][data-active]")
      ).toHaveCount(1);
      break;
    case "search":
      expect(q).toBe("tree");
      await expect(cell(page, 0)).toBeVisible();
      break;
    case "search-current":
    case "forced-colors":
    case "contrast-more":
      expect(q).toBe("palm");
      await expect(page.locator('[frimousse-emoji][aria-current="true"]')).toHaveCount(1);
      break;
    case "search-empty":
      expect(q).toBe("zzqqxx");
      await expect(page.locator("[frimousse-empty]")).toBeVisible();
      break;
    case "loading":
      await expect(page.locator("[frimousse-loading]")).toBeVisible();
      break;
    case "emoji-button":
      await expect(cell(page, 20)).toBeVisible();
      break;
  }
}

test("Project identity editor — states and themes", async ({ browser }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_IDENTITY is required for the identity-editor capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_IDENTITY=1 to run the capture");
  test.setTimeout(15 * 60_000);

  const context = await browser.newContext({ deviceScaleFactor: SCALE });
  const page = await context.newPage();
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  const written: string[] = [];

  for (const theme of FULL_THEMES) {
    for (const state of STATES) {
      await load(page, theme, state);
      await state.drive?.(page);
      await page.waitForTimeout(350);
      await verify(page, state);
      written.push(await snap(page, state, `${state.slug}-${theme}.png`));
    }
  }

  // The hover state in every theme, composed into one sheet: the cell
  // highlight is the part most likely to collapse into a theme's surface.
  const sweepDir = path.join(OUT_DIR, ".sweep");
  mkdirSync(sweepDir, { recursive: true });
  const sweep: { theme: string; file: string }[] = [];
  const hover = STATES.find((s) => s.slug === "picker-hover")!;
  for (const theme of ALL_THEMES) {
    await load(page, theme, hover);
    await hover.drive!(page);
    await page.waitForTimeout(300);
    await verify(page, hover);
    const file = path.join(sweepDir, `${theme}.png`);
    await page.locator("[data-radix-popper-content-wrapper]").first().screenshot({ path: file });
    sweep.push({ theme, file });
  }
  const sheet = await context.newPage();
  await sheet.setViewportSize({ width: 1800, height: 400 });
  const tiles = sweep
    .map(
      ({ theme, file }) =>
        `<div style="display:flex;flex-direction:column;gap:4px"><code style="font:12px monospace;color:#ddd">${theme}</code><img src="data:image/png;base64,${readFileSync(file).toString("base64")}" style="width:340px;display:block"/></div>`
    )
    .join("");
  await sheet.setContent(
    `<body style="margin:0;background:#777;padding:8px"><div id="sheet" style="display:grid;grid-template-columns:repeat(5,340px);gap:10px">${tiles}</div></body>`
  );
  const sweepOut = path.join(OUT_DIR, "theme-sweep.png");
  await sheet.locator("#sheet").screenshot({ path: sweepOut });
  written.push(sweepOut);
  rmSync(sweepDir, { recursive: true, force: true });

  await context.close();
  expect(pageErrors, `preview page threw: ${pageErrors.join(" | ")}`).toEqual([]);

  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(written.length);
  expect(onDisk.length).toBe(FULL_THEMES.length * STATES.length + 1);
  console.log(`[project-identity-shots] ${onDisk.length} PNGs in ${OUT_DIR}`);
});
