/**
 * Agent-state glyph family — visual-review harness.
 *
 * Drives `agent-state-glyphs-preview.html`, which draws the glyphs alone at
 * every size they ship at and magnified over their geometry, then the REAL
 * surfaces that draw them: the pane title bar, the sidebar session list and its
 * collapsed summary, the quick-state bar, Pilot's row glyphs and filter bar,
 * the dock strip and its plain-terminal cue. Hand-backs go through the fleet
 * snapshot store, so unread and finished are reached the way the app reaches
 * them.
 *
 *   DAINTREE_SHOT_AGENT_GLYPHS=1 DESIGN_CAPTURE_DIR=/tmp/shots \
 *     npx playwright test --project=screenshots agent-state-glyphs-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_AGENT_GLYPHS  required — any truthy value runs the capture
 *   DESIGN_CAPTURE_DIR          required — output directory, never in the repo
 *   DAINTREE_SHOT_THEMES        comma-separated sweep (default daintree,bondi,svalbard)
 *
 * Never writes a PNG it has not verified: each section asserts what it is
 * named for first, and the test counts the files itself at the end.
 */

import { test, expect, type Browser, type Page } from "@playwright/test";
import { mkdirSync, readdirSync } from "fs";
import path from "path";
import { startPreviewServer, stubViteHmrClient } from "../helpers/previewHarness";

const ENABLED = !!process.env.DAINTREE_SHOT_AGENT_GLYPHS;
const OUT = process.env.DESIGN_CAPTURE_DIR;

const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi,svalbard")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

const SECTIONS = [
  "family",
  "geometry",
  "title-bar",
  "sidebar",
  "quick-state",
  "pilot",
  "dock",
  "dock-cue",
];
/** Forced colours and 1x are judged on the default theme only. */
const FORCED_SECTIONS = ["family", "title-bar", "sidebar", "dock", "dock-cue"];
const ONE_X_SECTIONS = ["family", "title-bar", "sidebar", "dock-cue"];

const STATE_GLYPHS = '[data-agent-state-glyph], [data-glyph-box="spinner"]';

test.use({ deviceScaleFactor: 2 });

let server: Awaited<ReturnType<typeof startPreviewServer>> | undefined;
let baseURL = "";

test.beforeAll(async ({ browser }) => {
  if (!ENABLED) return;
  if (!OUT) throw new Error("DESIGN_CAPTURE_DIR must be set to a directory outside the repo");
  mkdirSync(OUT, { recursive: true });
  server = await startPreviewServer();
  baseURL = server.baseURL;
  // Vite's dependency optimizer re-bundles after the first page asks for the
  // graph and force-reloads it, which detaches whatever a capture was holding.
  // Hold one throwaway page open until navigations stop before any capture.
  const warm = await browser.newPage();
  let lastNav = Date.now();
  warm.on("framenavigated", () => (lastNav = Date.now()));
  await stubViteHmrClient(warm);
  await warm.goto(`${baseURL}/agent-state-glyphs-preview.html`);
  const deadline = Date.now() + 60_000;
  while (Date.now() - lastNav < 5_000 && Date.now() < deadline) {
    await warm.waitForTimeout(500); // e2e-wait: ok — polling for the optimizer reload to stop
  }
  await warm.close();
});

test.afterAll(async () => {
  await server?.close();
});

async function open(page: Page, theme: string): Promise<void> {
  await stubViteHmrClient(page);
  await page.mouse.move(0, 0);
  await page.setViewportSize({ width: 1260, height: 2400 });
  await page.goto(`${baseURL}/agent-state-glyphs-preview.html?theme=${theme}`);
  await expect(page.locator('[data-shot="dock"]')).toBeAttached({ timeout: 30_000 });
  await page.evaluate(() => document.fonts.ready);
}

/** What each section must show before it may be written. */
async function verify(page: Page, shot: string): Promise<void> {
  const section = page.locator(`[data-shot="${shot}"]`);
  await expect(section, `${shot}: section missing`).toBeVisible();
  switch (shot) {
    case "title-bar": {
      const chips = section.locator('[role="status"][aria-label^="Agent state:"]');
      await expect(chips, "title bar: one state glyph per pane").toHaveCount(5);
      await expect(section.locator('[aria-label="Agent state: unread"]')).toHaveCount(1);
      await expect(section.locator('[aria-label="Agent state: finished"]')).toHaveCount(1);
      break;
    }
    case "sidebar":
      await expect(section.locator(STATE_GLYPHS).first()).toBeVisible();
      expect(await section.locator(STATE_GLYPHS).count(), "sidebar glyphs").toBeGreaterThanOrEqual(
        6
      );
      break;
    case "dock":
      await expect(section.getByText("Codex").first()).toBeVisible();
      expect(await section.locator(STATE_GLYPHS).count(), "dock glyphs").toBeGreaterThanOrEqual(5);
      break;
    case "pilot":
      expect(await section.locator(STATE_GLYPHS).count(), "pilot glyphs").toBeGreaterThanOrEqual(6);
      break;
    default:
      expect(
        await section.locator("svg, [data-glyph-box]").count(),
        `${shot}: glyphs`
      ).toBeGreaterThan(0);
  }
}

async function snap(page: Page, shot: string, file: string, written: string[]): Promise<void> {
  await verify(page, shot);
  const target = page.locator(`[data-shot="${shot}"]`);
  const box = await target.boundingBox();
  if (!box || box.width < 8 || box.height < 8) {
    throw new Error(`${file}: no real box (${JSON.stringify(box)}) — refusing to write`);
  }
  const out = path.join(OUT!, file);
  await target.screenshot({ path: out, animations: "disabled" });
  written.push(out);
}

async function onePass(
  browser: Browser,
  opts: { theme: string; scale: number; forced: boolean; sections: string[]; suffix: string },
  written: string[]
): Promise<void> {
  const context = await browser.newContext({
    deviceScaleFactor: opts.scale,
    reducedMotion: "reduce",
    forcedColors: opts.forced ? "active" : "none",
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  try {
    await open(page, opts.theme);
    for (const shot of opts.sections) {
      await snap(page, shot, `glyphs--${shot}--${opts.theme}${opts.suffix}.png`, written);
    }
    expect(errors, `${opts.theme}${opts.suffix}: page errors`).toEqual([]);
  } finally {
    await context.close();
  }
}

test("capture the agent-state glyph family across surfaces and themes", async ({ browser }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_AGENT_GLYPHS is required for the glyph capture",
  });
  test.skip(!ENABLED, "visual-review harness — set DAINTREE_SHOT_AGENT_GLYPHS=1");
  test.setTimeout(300_000);
  const written: string[] = [];

  for (const theme of THEMES) {
    await onePass(
      browser,
      { theme, scale: 2, forced: false, sections: SECTIONS, suffix: "" },
      written
    );
  }
  const base = THEMES[0]!;
  await onePass(
    browser,
    { theme: base, scale: 2, forced: true, sections: FORCED_SECTIONS, suffix: "--forced" },
    written
  );
  await onePass(
    browser,
    { theme: base, scale: 1, forced: false, sections: ONE_X_SECTIONS, suffix: "--1x" },
    written
  );

  const expected = THEMES.length * SECTIONS.length + FORCED_SECTIONS.length + ONE_X_SECTIONS.length;
  const onDisk = readdirSync(OUT!).filter((f) => f.startsWith("glyphs--") && f.endsWith(".png"));
  expect(written).toHaveLength(expected);
  expect(onDisk.length, "files on disk").toBeGreaterThanOrEqual(expected);
});
