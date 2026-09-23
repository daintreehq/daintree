/**
 * Main toolbar button-run visual-review harness.
 *
 * Drives `toolbar-preview.html`, which mounts the real `Toolbar` against seeded
 * stores with the native window controls painted where the OS draws them — the
 * macOS traffic lights and the Windows caption cluster. The question this
 * harness exists for is how the two button runs read as a whole: the sidebar
 * toggle, the launcher, the pinned agents (one of them with presets), the
 * panel buttons, the utilities, and how both ends balance against the window
 * controls. The dropdowns and the project/forge pills have harnesses of their
 * own.
 *
 * Opt-in only: skips itself unless DAINTREE_SHOT_MAINTOOLBAR is set.
 *
 *   DAINTREE_SHOT_MAINTOOLBAR=1 DAINTREE_SHOT_DIR=/abs/out \
 *     npx playwright test --project=screenshots main-toolbar-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_MAINTOOLBAR  required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR          required — an ABSOLUTE output directory outside the repo
 *   DAINTREE_SHOT_THEMES       themes for the theme sweep (default daintree,bondi,namib)
 *
 * Every shot also writes a JSON sidecar of the strip's geometry (each visible
 * button's box, each divider's box, the painted window controls), so spacing
 * claims can be checked against numbers rather than squinted at. Never writes a
 * PNG it has not verified, and counts the files itself at the end.
 */

import { test, expect, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from "fs";
import path from "path";
import {
  startPreviewServer,
  stubViteHmrClient,
  type PreviewServer,
} from "../helpers/previewHarness";

const ENABLED = !!process.env.DAINTREE_SHOT_MAINTOOLBAR;
const OUT_DIR = process.env.DAINTREE_SHOT_DIR ?? "";
const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi,namib")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

test.use({ deviceScaleFactor: 2 });

const STRIP = '[role="toolbar"][aria-label="Main toolbar"]';
const STRIP_HEIGHT = 48;

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

let server: PreviewServer | undefined;
const consoleErrors: string[] = [];
const expected: string[] = [];

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

interface OpenOptions {
  theme?: string;
  fixture?: string;
  platform?: "mac" | "windows";
  width?: number;
}

async function openToolbar(page: Page, opts: OpenOptions = {}): Promise<void> {
  const { theme = "daintree", fixture = "owner", platform = "mac" } = opts;
  await page.setViewportSize({ width: opts.width ?? 1440, height: 240 });
  const url = `${server!.baseURL}/toolbar-preview.html?theme=${theme}&fixture=${fixture}&platform=${platform}`;
  await page.goto(url, { waitUntil: "load" });
  await page.addStyleTag({ content: FREEZE_CSS });
  await page
    .locator(STRIP)
    .waitFor({ state: "visible", timeout: 30_000 })
    .catch((e: unknown) => {
      throw new Error(`toolbar never mounted (${url}): ${String(e)}\n${consoleErrors.join("\n")}`);
    });
  await page.locator(`[data-native-chrome="${platform}"]`).waitFor({ state: "attached" });
  // The launcher is always on the strip; waiting on it proves the measured row
  // rendered its buttons rather than an empty frame.
  await page
    .locator('[data-toolbar-button-id="launcher"] button')
    .first()
    .waitFor({ state: "visible", timeout: 15_000 });
  await settle(page);
}

async function settle(page: Page, ms = 300): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
  );
  await page.waitForTimeout(ms);
}

/** Geometry of everything on the strip, for the sidebar JSON. */
async function measure(page: Page) {
  return page.evaluate((stripSel) => {
    const strip = document.querySelector(stripSel)!;
    const rect = (el: Element) => {
      const r = el.getBoundingClientRect();
      return {
        x: Math.round(r.x),
        y: Math.round(r.y),
        w: Math.round(r.width),
        h: Math.round(r.height),
      };
    };
    const buttons = Array.from(strip.querySelectorAll("button"))
      .filter((b) => b.offsetParent !== null && !b.closest('[aria-hidden="true"]'))
      .map((b) => ({ label: b.getAttribute("aria-label"), ...rect(b) }));
    const dividers = Array.from(strip.querySelectorAll(".toolbar-divider")).map(rect);
    const nativeChrome = Array.from(
      document.querySelectorAll("[data-native-chrome], [data-native-chrome] > *")
    ).map(rect);
    return { buttons, dividers, nativeChrome };
  }, STRIP);
}

/** The full strip plus a few px of the canvas under it, so its bottom edge is in the picture. */
async function snapStrip(page: Page, file: string, crop?: "left" | "right"): Promise<void> {
  expected.push(file);
  await settle(page, 150);
  const box = await page.locator(STRIP).boundingBox();
  if (!box || box.height < STRIP_HEIGHT - 1 || box.width < 400) {
    throw new Error(`${file}: toolbar has no real box (${JSON.stringify(box)})`);
  }
  const visibleButtons = await page.locator(`${STRIP} button:visible`).count();
  if (visibleButtons < 5) throw new Error(`${file}: only ${visibleButtons} visible buttons`);
  const half = 620;
  const clip = {
    x: crop === "right" ? box.width - half : 0,
    y: 0,
    width: crop ? half : box.width,
    height: box.height + 8,
  };
  const out = path.join(OUT_DIR, file);
  await page.screenshot({ path: out, clip });
  if (!existsSync(out)) throw new Error(`${file}: screenshot did not land`);
  writeFileSync(out.replace(/\.png$/, ".json"), JSON.stringify(await measure(page), null, 2));
}

async function agentButton(page: Page, agentId: string) {
  return page.locator(`[data-toolbar-button-id="${agentId}"]`);
}

test.describe("main toolbar review", () => {
  test("captures", async ({ page }) => {
    test.info().annotations.push({
      type: "conditional-skip",
      description: "DAINTREE_SHOT_MAINTOOLBAR is required for the main toolbar capture",
    });
    test.skip(!ENABLED, "Set DAINTREE_SHOT_MAINTOOLBAR to run the main toolbar capture");
    test.setTimeout(600_000);
    await stubViteHmrClient(page);
    const errors: string[] = [];
    page.on("pageerror", (e) => {
      errors.push(String(e));
      consoleErrors.push(e.stack ?? String(e));
    });
    page.on("console", (m) => {
      if (m.type() === "error") consoleErrors.push(m.text());
    });

    // Every fixture on both platforms, in the default theme.
    const fixtures = ["owner", "owner-no-presets", "multi-presets", "presets-mid", "fresh"];
    for (const platform of ["mac", "windows"] as const) {
      for (const fixture of fixtures) {
        await openToolbar(page, { fixture, platform });
        await snapStrip(page, `${platform}-${fixture}.png`);
      }
    }

    // Close-ups of each end at the owner's composition, for pip- and seam-level judgement.
    for (const platform of ["mac", "windows"] as const) {
      await openToolbar(page, { platform });
      await snapStrip(page, `${platform}-owner-left.png`, "left");
      await snapStrip(page, `${platform}-owner-right.png`, "right");
    }

    // Interaction states on the preset button.
    await openToolbar(page);
    const claude = await agentButton(page, "claude");
    await claude.locator("button").first().hover();
    await snapStrip(page, "mac-owner-hover-primary-left.png", "left");
    await claude.locator("button").last().hover();
    await snapStrip(page, "mac-owner-hover-chevron-left.png", "left");
    await page.mouse.move(700, 200);
    await page.locator('[data-toolbar-button-id="launcher"] button').first().focus();
    await page.keyboard.press("ArrowRight");
    await snapStrip(page, "mac-owner-focus-primary-left.png", "left");
    await page.keyboard.press("ArrowRight");
    await snapStrip(page, "mac-owner-focus-chevron-left.png", "left");
    await page.keyboard.press("Enter");
    await expect(page.locator('[role="menu"]')).toBeVisible();
    await snapStrip(page, "mac-owner-armed-left.png", "left");
    await page.keyboard.press("Escape");

    // Narrow window: the overflow engine starts evicting.
    await openToolbar(page, { width: 1100 });
    await snapStrip(page, "mac-owner-narrow.png");
    await openToolbar(page, { width: 1100, platform: "windows" });
    await snapStrip(page, "windows-owner-narrow.png");

    // Theme sweep at the owner's composition.
    for (const theme of THEMES) {
      if (theme === "daintree") continue;
      await openToolbar(page, { theme });
      await snapStrip(page, `theme-${theme}-mac-owner.png`);
      await openToolbar(page, { theme, platform: "windows" });
      await snapStrip(page, `theme-${theme}-windows-owner.png`);
    }

    expect(errors, errors.join("\n")).toEqual([]);
    const landed = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
    const missing = expected.filter((f) => !landed.includes(f));
    expect(missing, `missing captures: ${missing.join(", ")}`).toEqual([]);
  });
});
