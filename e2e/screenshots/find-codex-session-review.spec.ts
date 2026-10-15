/**
 * "Find session" popover visual-review harness.
 *
 * The popover only appears on a Codex pane whose conversation restore couldn't
 * name, so a real session reaches it rarely and never with the lists worth
 * judging: a dozen sessions that open with the same words, previews with
 * fences and unbreakable paths, a folder with nothing in it. This drives the
 * preview entry (`find-codex-session-preview.html`), which mounts the REAL
 * `FindCodexSessionAction` in its real hosts and answers its
 * `codex.findSessions` bridge call from a fixture.
 *
 *   DAINTREE_SHOT_FIND_SESSION=1 DAINTREE_SHOT_DIR=/abs/out \
 *     npx playwright test --project=screenshots find-codex-session-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_FIND_SESSION  required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR           required — an ABSOLUTE output directory outside the repo
 *   DAINTREE_SHOT_THEMES        themes for the full state set (default daintree,bondi)
 *   DAINTREE_SHOT_SWEEP         themes for the open-list sweep (default: every built-in)
 *
 * Output: `<state>--<theme>.png`, plus `sweep--<theme>.png` for the sweep.
 * Never writes a PNG it has not verified: each state asserts what it is named
 * for after the settle, and the test counts the files itself at the end.
 */

import { test, expect, type Locator, type Page } from "@playwright/test";
import { mkdirSync, readdirSync, realpathSync, rmSync } from "fs";
import path from "path";
import { startPreviewServer, stubViteHmrClient } from "../helpers/previewHarness";

const ENABLED = !!process.env.DAINTREE_SHOT_FIND_SESSION;
const OUT_DIR = process.env.DAINTREE_SHOT_DIR ?? "";

function list(value: string | undefined, fallback: string): string[] {
  return (value ?? fallback)
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

const THEMES = list(process.env.DAINTREE_SHOT_THEMES, "daintree,bondi");
const SWEEP = list(
  process.env.DAINTREE_SHOT_SWEEP,
  "arashiyama,atacama,bali,bondi,daintree,fiordland,galapagos,highlands,hokkaido,movile,namib,redwoods,serengeti,svalbard,table-mountain"
);

const VIEWPORT = { width: 960, height: 820 };

type State =
  | "trigger"
  | "trigger-focus"
  | "loading"
  | "empty"
  | "unavailable"
  | "three"
  | "three-row-focus"
  | "many"
  | "long"
  | "long-row-hover"
  | "offer"
  | "narrow"
  | "gate";

const STATES: State[] = [
  "trigger",
  "trigger-focus",
  "loading",
  "empty",
  "unavailable",
  "three",
  "three-row-focus",
  "many",
  "long",
  "long-row-hover",
  "offer",
  "narrow",
  "gate",
];

/** Which fixture and host each state is photographed against. */
const SETUP: Record<State, { fixture: string; host: "banner" | "offer" | "gate"; width?: number }> =
  {
    trigger: { fixture: "three", host: "banner" },
    "trigger-focus": { fixture: "three", host: "banner" },
    loading: { fixture: "loading", host: "banner" },
    empty: { fixture: "empty", host: "banner" },
    unavailable: { fixture: "unavailable", host: "banner" },
    three: { fixture: "three", host: "banner" },
    "three-row-focus": { fixture: "three", host: "banner" },
    many: { fixture: "many", host: "banner" },
    long: { fixture: "long", host: "banner" },
    "long-row-hover": { fixture: "long", host: "banner" },
    offer: { fixture: "three", host: "offer" },
    // A four-column grid's pane: narrower than the popover's own width.
    narrow: { fixture: "many", host: "banner", width: 300 },
    gate: { fixture: "three", host: "gate" },
  };

test.use({ deviceScaleFactor: 2 });

let baseURL = "";
let closeServer: (() => Promise<void>) | undefined;

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
  const server = await startPreviewServer();
  baseURL = server.baseURL;
  closeServer = server.close;
});

test.afterAll(async () => {
  await closeServer?.();
});

const FREEZE_CSS = `
  *, *::before, *::after {
    transition-duration: 0s !important;
    transition-delay: 0s !important;
    caret-color: transparent !important;
  }
`;

async function load(page: Page, state: State, theme: string): Promise<Locator> {
  const { fixture, host, width = 560 } = SETUP[state];
  await page.mouse.move(0, 0);
  await page.setViewportSize(VIEWPORT);
  const url = `${baseURL}/find-codex-session-preview.html?theme=${theme}&fixture=${fixture}&host=${host}&width=${width}`;
  const pane = page.locator("[data-preview-pane]");
  try {
    await page.goto(url);
    await expect(pane).toBeVisible({ timeout: 30_000 });
  } catch {
    console.warn(`[find-session-shots] first mount of ${state}/${theme} failed; retrying once`);
    await page.goto("about:blank");
    await page.goto(url, { waitUntil: "load" });
    await expect(pane).toBeVisible({ timeout: 30_000 });
  }
  const trigger = pane.getByRole("button", { name: "Find session" });
  await expect(trigger, `${state}: the trigger never appeared`).toBeVisible({ timeout: 10_000 });
  await page.addStyleTag({ content: FREEZE_CSS });
  await page.evaluate(() => document.fonts.ready);
  return trigger;
}

function popover(page: Page): Locator {
  return page.locator("[data-radix-popper-content-wrapper]").first();
}

async function openPopover(page: Page, trigger: Locator): Promise<Locator> {
  await trigger.click();
  const content = popover(page);
  await expect(content, "popover never opened").toBeVisible();
  await expect(content).toContainText("Codex sessions in this folder");
  return content;
}

/**
 * The refresh glyph finishes its turn after a load lands; photographing it
 * mid-turn shows a tilted icon that the app only ever shows in motion.
 */
async function settleRefresh(content: Locator): Promise<void> {
  await expect(content.locator(".animate-spin")).toHaveCount(0, { timeout: 5_000 });
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
  const pad = 12;
  const x = Math.max(0, Math.min(...boxes.map((b) => b.x)) - pad);
  const y = Math.max(0, Math.min(...boxes.map((b) => b.y)) - pad);
  const right = Math.min(VIEWPORT.width, Math.max(...boxes.map((b) => b.x + b.width)) + pad);
  const bottom = Math.min(VIEWPORT.height, Math.max(...boxes.map((b) => b.y + b.height)) + pad);
  const out = path.join(OUT_DIR, file);
  await page.screenshot({ path: out, clip: { x, y, width: right - x, height: bottom - y } });
  return out;
}

/** Any layer opened over the popover (a row's full-text tooltip), so the frame includes it. */
async function openTooltips(page: Page): Promise<Locator[]> {
  const layers = page.locator("[data-radix-popper-content-wrapper]");
  const count = await layers.count();
  const open: Locator[] = [];
  for (let i = 1; i < count; i += 1) {
    if (await layers.nth(i).isVisible()) open.push(layers.nth(i));
  }
  return open;
}

function rows(content: Locator): Locator {
  return content.locator("li button, [role='option']");
}

async function capture(page: Page, state: State, theme: string, file: string): Promise<string> {
  const trigger = await load(page, state, theme);
  const pane = page.locator("[data-preview-pane]");

  switch (state) {
    case "trigger":
      return shoot(page, [pane], file);
    case "trigger-focus": {
      // A keypress first, so Chromium treats the programmatic focus as keyboard focus.
      await page.keyboard.press("Shift");
      await trigger.focus();
      await expect(trigger).toBeFocused();
      return shoot(page, [pane], file);
    }
    case "loading": {
      const content = await openPopover(page, trigger);
      // The skeleton waits out the Doherty gate before it shows.
      await expect(content.getByRole("status", { name: "Looking for sessions" })).toBeVisible({
        timeout: 5_000,
      });
      return shoot(page, [pane, content], file);
    }
    case "empty": {
      const content = await openPopover(page, trigger);
      await expect(content).toContainText("No other sessions found here", { timeout: 5_000 });
      await settleRefresh(content);
      return shoot(page, [pane, content], file);
    }
    case "unavailable": {
      const content = await openPopover(page, trigger);
      await expect(content).toContainText("Codex took too long to respond", { timeout: 5_000 });
      await settleRefresh(content);
      return shoot(page, [pane, content], file);
    }
    case "three":
    case "offer":
    case "gate": {
      const content = await openPopover(page, trigger);
      await expect(rows(content)).toHaveCount(3, { timeout: 5_000 });
      await expect(content).toContainText("Tighten the retry loop");
      await settleRefresh(content);
      return shoot(page, [pane, content], file);
    }
    case "three-row-focus": {
      const content = await openPopover(page, trigger);
      await expect(rows(content)).toHaveCount(3, { timeout: 5_000 });
      await settleRefresh(content);
      await page.keyboard.press("Shift");
      await rows(content).nth(1).focus();
      await expect(rows(content).nth(1)).toBeFocused();
      await page.waitForTimeout(600);
      return shoot(page, [pane, content, ...(await openTooltips(page))], file);
    }
    case "many":
    case "narrow": {
      const content = await openPopover(page, trigger);
      await expect(rows(content)).toHaveCount(12, { timeout: 5_000 });
      await expect(content).toContainText("agentResume.test.ts");
      await settleRefresh(content);
      return shoot(page, [pane, content], file);
    }
    case "long": {
      const content = await openPopover(page, trigger);
      await expect(rows(content)).toHaveCount(5, { timeout: 5_000 });
      await expect(content).toContainText("lost-session banner");
      await settleRefresh(content);
      return shoot(page, [pane, content], file);
    }
    case "long-row-hover": {
      const content = await openPopover(page, trigger);
      await expect(rows(content)).toHaveCount(5, { timeout: 5_000 });
      await settleRefresh(content);
      await rows(content).first().hover();
      await page.waitForTimeout(900);
      return shoot(page, [pane, content, ...(await openTooltips(page))], file);
    }
  }
}

test("Find Codex session popover — states and themes", async ({ page }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_FIND_SESSION is required for the find-session capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_FIND_SESSION=1 to run the capture");
  test.setTimeout(15 * 60_000);

  await stubViteHmrClient(page);
  const written: string[] = [];
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));

  for (const theme of THEMES) {
    for (const state of STATES) {
      written.push(await capture(page, state, theme, `${state}--${theme}.png`));
    }
  }
  for (const theme of SWEEP) {
    written.push(await capture(page, "three", theme, `sweep--${theme}.png`));
  }

  expect(pageErrors, `page errors during capture:\n${pageErrors.join("\n")}`).toEqual([]);
  // Count the files ourselves. A harness that trusts its own exit code is how a
  // review ends up reasoning about screenshots that were never written.
  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(written.length);
  expect(onDisk.length).toBe(THEMES.length * STATES.length + SWEEP.length);
  console.log(`[find-session-shots] ${onDisk.length} PNGs in ${OUT_DIR}`);
});
