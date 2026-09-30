/**
 * Subagent chip visual-review harness.
 *
 * The chip only appears once an agent has actually spawned children, and the
 * states worth judging — a child blocked on approval, a transcript read that
 * failed or never answered, a refresh in flight, fourteen children in a narrow
 * pane — are ones a real session reaches rarely and never on cue. So this
 * drives the preview entry (`subagent-chip-preview.html`), which mounts the
 * REAL `ContentPanel` for an agent pane and answers the chip's own
 * `codex` / `claude` bridge calls from a fixture.
 *
 *   DAINTREE_SHOT_SUBAGENTS=1 npx playwright test --project=screenshots subagent-chip-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_SUBAGENTS  required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR        output directory (default artifacts/subagent-chip-shots)
 *   DAINTREE_SHOT_THEMES     themes for the full state set (default daintree,svalbard,namib,bondi)
 *   DAINTREE_SHOT_SWEEP      themes for the open-popover sweep (default: every built-in)
 *
 * Output: `<fixture>--<state>--<theme>.png`. Never writes a PNG it has not
 * verified: each state asserts what it is named for after the settle, and the
 * test counts the files itself at the end.
 */

import { test, expect, type Locator, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readdirSync, rmSync } from "fs";
import path from "path";
import { startPreviewServer, stubViteHmrClient } from "../helpers/previewHarness";

const ENABLED = !!process.env.DAINTREE_SHOT_SUBAGENTS;

const OUT_DIR = path.resolve(
  process.env.DAINTREE_SHOT_DIR ?? path.join(process.cwd(), "artifacts", "subagent-chip-shots")
);

function list(value: string | undefined, fallback: string): string[] {
  return (value ?? fallback)
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

const THEMES = list(process.env.DAINTREE_SHOT_THEMES, "daintree,svalbard,namib,bondi");
const SWEEP = list(
  process.env.DAINTREE_SHOT_SWEEP,
  "arashiyama,atacama,bali,bondi,daintree,fiordland,galapagos,highlands,hokkaido,movile,namib,redwoods,serengeti,svalbard,table-mountain"
);

type State =
  | "header"
  | "chip-focus"
  | "chip-hover"
  | "open"
  | "expanded"
  | "row-focus"
  | "refreshing"
  | "refresh-failed";

/** Which states each fixture is photographed in. Mirrors `FIXTURES` in the preview. */
const PLAN: Record<string, State[]> = {
  "codex-mixed": ["header", "chip-focus", "chip-hover", "open", "expanded", "row-focus"],
  "codex-long-transcript": ["expanded"],
  "codex-transcript-empty": ["expanded"],
  "codex-transcript-unavailable": ["expanded"],
  "codex-transcript-loading": ["expanded"],
  "codex-refreshing": ["refreshing"],
  "codex-refresh-failed": ["refresh-failed"],
  "claude-single": ["header", "open", "expanded"],
  "codex-dense": ["open"],
  "codex-narrow": ["header", "open"],
};

/** Text the expanded row must show for each transcript mode before it is photographed. */
const EXPANDED_MARKER: Record<string, RegExp> = {
  "codex-mixed": /Found two problems/,
  "codex-long-transcript": /Suggested fix/,
  "codex-transcript-empty": /No messages/,
  "codex-transcript-unavailable": /too long to respond/,
  "codex-transcript-loading": /Loading transcript/,
  "claude-single": /Found two problems/,
};

test.use({ deviceScaleFactor: 2 });

let baseURL = "";
let closeServer: (() => Promise<void>) | undefined;

test.beforeAll(async () => {
  if (!ENABLED) return;
  if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });
  const server = await startPreviewServer();
  baseURL = server.baseURL;
  closeServer = server.close;
});

test.afterAll(async () => {
  await closeServer?.();
});

async function load(page: Page, fixture: string, theme: string): Promise<Locator> {
  await stubViteHmrClient(page);
  await page.mouse.move(0, 0);
  await page.setViewportSize({ width: 820, height: 760 });
  await page.goto(`${baseURL}/subagent-chip-preview.html?theme=${theme}&fixture=${fixture}`);
  const pane = page.locator("[data-preview-pane]");
  await expect(pane, `${fixture}: no pane`).toBeVisible({ timeout: 20_000 });
  const chip = page.getByRole("button", { name: /subagent/i }).first();
  await expect(chip, `${fixture}: the chip never appeared`).toBeVisible({ timeout: 10_000 });
  await page.evaluate(() => document.fonts.ready);
  return chip;
}

function popover(page: Page): Locator {
  return page.locator("[data-radix-popper-content-wrapper]").last();
}

async function openPopover(page: Page, chip: Locator): Promise<Locator> {
  await chip.click();
  const content = popover(page);
  await expect(content, "popover never opened").toBeVisible();
  await expect(content).toContainText(/subagents/);
  return content;
}

async function shoot(page: Page, targets: Locator[], file: string): Promise<string> {
  // Overlay entry motion.
  await page.waitForTimeout(350);
  const boxes = [];
  for (const target of targets) {
    const box = await target.boundingBox();
    if (!box || box.width < 8 || box.height < 8) {
      throw new Error(`${file}: target has no real box — refusing to write`);
    }
    boxes.push(box);
  }
  const pad = 10;
  const x = Math.max(0, Math.min(...boxes.map((b) => b.x)) - pad);
  const y = Math.max(0, Math.min(...boxes.map((b) => b.y)) - pad);
  const right = Math.max(...boxes.map((b) => b.x + b.width)) + pad;
  const bottom = Math.max(...boxes.map((b) => b.y + b.height)) + pad;
  const out = path.join(OUT_DIR, file);
  await page.screenshot({ path: out, clip: { x, y, width: right - x, height: bottom - y } });
  return out;
}

async function capture(page: Page, fixture: string, state: State, theme: string) {
  const chip = await load(page, fixture, theme);
  const pane = page.locator("[data-preview-pane]");
  // The header row is the chip's context; the pane body below it is filler.
  const headerTarget = pane.locator('[data-testid="panel-header-content"]').locator("xpath=..");
  const file = `${fixture}--${state}--${theme}.png`;

  switch (state) {
    case "header":
      return shoot(page, [headerTarget], file);
    case "chip-focus": {
      // A keypress first, so Chromium treats the programmatic focus as keyboard focus.
      await page.keyboard.press("Shift");
      await chip.focus();
      await expect(chip).toBeFocused();
      return shoot(page, [headerTarget], file);
    }
    case "chip-hover": {
      await chip.hover();
      await page.waitForTimeout(700);
      const tip = page.locator("[data-radix-popper-content-wrapper]");
      const targets = [headerTarget];
      if ((await tip.count()) > 0 && (await tip.last().isVisible())) targets.push(tip.last());
      return shoot(page, targets, file);
    }
    case "open": {
      const content = await openPopover(page, chip);
      return shoot(page, [pane, content], file);
    }
    case "expanded": {
      const content = await openPopover(page, chip);
      await content.locator("li button").first().click();
      await expect(content).toContainText(EXPANDED_MARKER[fixture]!, { timeout: 5_000 });
      return shoot(page, [pane, content], file);
    }
    case "row-focus": {
      const content = await openPopover(page, chip);
      const rows = content.locator("li button");
      await page.keyboard.press("Shift");
      await rows.nth(1).focus();
      await expect(rows.nth(1)).toBeFocused();
      return shoot(page, [pane, content], file);
    }
    case "refreshing": {
      const content = await openPopover(page, chip);
      await content.getByRole("button", { name: /^Refresh/ }).click();
      await expect(content.getByRole("button", { name: /^Refresh/ })).toHaveAttribute(
        "aria-disabled",
        "true"
      );
      return shoot(page, [pane, content], file);
    }
    case "refresh-failed": {
      const content = await openPopover(page, chip);
      await content.getByRole("button", { name: /^Refresh/ }).click();
      await expect(content).toContainText(/Couldn't refresh/);
      await expect(content).toContainText(/Meitner/);
      return shoot(page, [pane, content], file);
    }
  }
}

test("Subagent chip — states and themes", async ({ page }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_SUBAGENTS is required for the subagent chip capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_SUBAGENTS=1 to run the capture");
  test.setTimeout(15 * 60_000);

  const written: string[] = [];
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));

  for (const theme of THEMES) {
    for (const [fixture, states] of Object.entries(PLAN)) {
      for (const state of states) written.push(await capture(page, fixture, state, theme));
    }
  }
  for (const theme of SWEEP.filter((t) => !THEMES.includes(t))) {
    written.push(await capture(page, "codex-mixed", "open", theme));
  }

  expect(pageErrors, `page errors during capture:\n${pageErrors.join("\n")}`).toEqual([]);
  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(written.length);
});
