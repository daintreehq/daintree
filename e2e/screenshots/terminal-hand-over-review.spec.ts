/**
 * Terminal hand-over visual-review harness.
 *
 * Drives `terminal-hand-over-preview.html`, which renders the real consent
 * dialog and the real "Driven by" chip in a pane header (see
 * `src/components/Terminal/__preview__/terminalHandOver.tsx`). A hand-over
 * needs a live orchestrator holding a Daintree bearer, so the app reaches
 * these states only by hand; the preview reaches them on cue.
 *
 *   DAINTREE_SHOT_HAND_OVER=1 DAINTREE_SHOT_DIR=/abs/out \
 *     npx playwright test --project=screenshots terminal-hand-over-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_HAND_OVER  required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR        required — an ABSOLUTE output directory outside the repo
 *   DAINTREE_SHOT_THEMES     themes for the full state set (default daintree,bondi,namib)
 *   DAINTREE_SHOT_SWEEP      "0" skips the all-themes sweep of the dialog and tooltip
 *
 * Output: `<state>--<theme>.png`. Every state asserts what it is named for
 * after the settle, and the test counts the files itself at the end.
 */

import { test, expect, type Locator, type Page } from "@playwright/test";
import { mkdirSync, readdirSync, realpathSync, rmSync } from "fs";
import path from "path";
import { BUILT_IN_THEME_SOURCES } from "@shared/theme/builtInThemeSources";
import {
  startPreviewServer,
  stubViteHmrClient,
  type PreviewServer,
} from "../helpers/previewHarness";

const ENABLED = !!process.env.DAINTREE_SHOT_HAND_OVER;
const OUT_DIR = process.env.DAINTREE_SHOT_DIR ?? "";
const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi,namib")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);
const SWEEP = process.env.DAINTREE_SHOT_SWEEP !== "0";
const ALL_THEMES = BUILT_IN_THEME_SOURCES.map((t) => t.id);

test.use({ deviceScaleFactor: 2 });

const CARD = '[role="dialog"] > [tabindex="-1"], [role="alertdialog"] > [tabindex="-1"]';
const PAD = 16;

const FREEZE_CSS = `
  ::-webkit-scrollbar { display: none !important; }
  *, *::before, *::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
  }
`;

type State = "dialog" | "dialog-shell" | "dialog-refused" | "chip" | "chip-tooltip" | "chip-focus";

const QUERY: Record<State, string> = {
  dialog: "state=dialog",
  "dialog-shell": "state=dialog&pane=shell",
  "dialog-refused": "state=dialog&refuse=already-handed",
  chip: "state=chip",
  "chip-tooltip": "state=chip",
  "chip-focus": "state=chip",
};

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
    if (file.endsWith(".png")) rmSync(path.join(OUT_DIR, file), { force: true });
  }
  server = await startPreviewServer();
});

test.afterAll(async () => {
  await server?.close();
});

async function load(page: Page, state: State, theme: string): Promise<void> {
  await stubViteHmrClient(page);
  await page.mouse.move(0, 0);
  await page.setViewportSize({ width: 720, height: 640 });
  page.removeAllListeners("pageerror");
  page.on("pageerror", (error) =>
    console.warn(`[hand-over-shots] pageerror: ${error.stack ?? error.message}`)
  );
  const url = `${server!.baseURL}/terminal-hand-over-preview.html?theme=${theme}&${QUERY[state]}`;
  const ready = state.startsWith("dialog")
    ? page.locator(CARD).first()
    : page.locator('[data-testid="terminal-driven-by-badge"]');
  try {
    await page.goto(url);
    await expect(ready, `${state}: never rendered`).toBeVisible({ timeout: 30_000 });
  } catch {
    await page.goto("about:blank");
    await page.goto(url, { waitUntil: "load" });
    await expect(ready, `${state}: never rendered`).toBeVisible({ timeout: 30_000 });
  }
  await page.evaluate(() => document.fonts.ready);
}

async function shoot(page: Page, targets: Locator[], file: string): Promise<string> {
  const boxes = [];
  for (const target of targets) {
    const box = await target.boundingBox();
    if (!box || box.width < 8 || box.height < 8) {
      throw new Error(`${file}: target has no real box — refusing to write`);
    }
    boxes.push(box);
  }
  const viewport = page.viewportSize()!;
  const x = Math.max(0, Math.min(...boxes.map((b) => b.x)) - PAD);
  const y = Math.max(0, Math.min(...boxes.map((b) => b.y)) - PAD);
  const right = Math.min(viewport.width, Math.max(...boxes.map((b) => b.x + b.width)) + PAD);
  const bottom = Math.min(viewport.height, Math.max(...boxes.map((b) => b.y + b.height)) + PAD);
  const out = path.join(OUT_DIR, file);
  await page.screenshot({ path: out, clip: { x, y, width: right - x, height: bottom - y } });
  return out;
}

async function capture(page: Page, state: State, theme: string, file: string): Promise<string> {
  await load(page, state, theme);

  if (state.startsWith("dialog")) {
    await page.addStyleTag({ content: FREEZE_CSS });
    const card = page.locator(CARD).first();
    await expect(card).toHaveCSS("border-top-style", "solid");
    const dialog = page.locator('[role="alertdialog"], [role="dialog"]').first();
    await expect(dialog).toContainText(state === "dialog-shell" ? /npm run dev/ : /Codex/);
    await expect(dialog).toContainText(/Claude/);
    if (state === "dialog-refused") {
      await dialog.getByRole("button", { name: /hand over/i }).click();
      await expect(dialog.getByRole("status")).toContainText(/Gemini/);
    }
    await page.waitForTimeout(150);
    return shoot(page, [card], file);
  }

  const pane = page.locator("[data-preview-pane]");
  const chip = page.locator('[data-testid="terminal-driven-by-badge"]');
  await expect(chip).toContainText(/Driven by Claude/);
  if (state === "chip") {
    await page.addStyleTag({ content: FREEZE_CSS });
    return shoot(page, [pane], file);
  }
  if (state === "chip-focus") {
    // A keypress first, so Chromium treats the programmatic focus as keyboard focus.
    await page.keyboard.press("Shift");
    await chip.focus();
    await expect(chip).toBeFocused();
  } else {
    await chip.hover();
  }
  const tip = page.locator("[data-radix-popper-content-wrapper]").last();
  await expect(tip, "tooltip never opened").toBeVisible({ timeout: 3_000 });
  await expect(tip).toContainText(/Claude/);
  await page.addStyleTag({ content: FREEZE_CSS });
  await page.waitForTimeout(200);
  return shoot(page, [pane, tip], file);
}

test("Terminal hand-over — dialog and chip", async ({ page }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_HAND_OVER is required for the capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_HAND_OVER=1 to run the capture");
  test.setTimeout(15 * 60_000);

  const unknown = THEMES.filter((theme) => !ALL_THEMES.includes(theme));
  if (unknown.length > 0) {
    throw new Error(`Unknown theme(s) in DAINTREE_SHOT_THEMES: ${unknown.join(", ")}`);
  }

  const states: State[] = [
    "dialog",
    "dialog-shell",
    "dialog-refused",
    "chip",
    "chip-tooltip",
    "chip-focus",
  ];
  const written: string[] = [];
  for (const theme of THEMES) {
    for (const state of states) {
      written.push(await capture(page, state, theme, `${state}--${theme}.png`));
    }
  }
  if (SWEEP) {
    for (const theme of ALL_THEMES) {
      written.push(await capture(page, "dialog", theme, `sweep-dialog--${theme}.png`));
      written.push(await capture(page, "chip-tooltip", theme, `sweep-tooltip--${theme}.png`));
    }
  }

  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(written.length);
  console.log(`[hand-over-shots] ${onDisk.length} PNGs in ${OUT_DIR}`);
});
