/**
 * Terminal agent state chip and exit badge — visual-review harness.
 *
 * Drives `agent-indicator-preview.html`, which mounts one REAL `ContentPanel`
 * per state: the working, waiting and directing chips, and an agent and a
 * plain shell exiting clean, non-zero and with no code at all, plus the real
 * indicator mounted alone for its exit tooltip. Also flips a
 * live chip from working to waiting to photograph it mid-transition, with and
 * without the app's reduce-animations flag.
 *
 *   DAINTREE_SHOT_AGENT_INDICATOR=1 DESIGN_CAPTURE_DIR=/tmp/shots \
 *     npx playwright test --project=screenshots agent-indicator-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_AGENT_INDICATOR  required — any truthy value runs the capture
 *   DESIGN_CAPTURE_DIR             output directory (default artifacts/agent-indicator-shots)
 *   DAINTREE_SHOT_THEMES           comma-separated sweep (default daintree,svalbard,bondi)
 *
 * Never writes a PNG it has not verified: each frame asserts what it is named
 * for first, and the test counts the files itself at the end.
 */

import { test, expect, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readdirSync, rmSync } from "fs";
import path from "path";
import { makeSnap, startPreviewServer, stubViteHmrClient } from "../helpers/previewHarness";

const ENABLED = !!process.env.DAINTREE_SHOT_AGENT_INDICATOR;

const OUT_DIR = path.resolve(
  process.env.DESIGN_CAPTURE_DIR ?? path.join(process.cwd(), "artifacts", "agent-indicator-shots")
);

const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,svalbard,bondi")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

const EXPECTED_BADGES: Record<string, string> = {
  "agent-exit-0": "[exit 0]",
  "agent-exit-1": "[exit 1]",
  "agent-exit-signal": "[exited]",
  "shell-exit-0": "[exit 0]",
  "shell-exit-130": "[exit 130]",
  "shell-exit-signal": "[exited]",
};

/** Mounted on their own: an exited pane's header drops the chip entirely. */
const TOOLTIP_ROWS: Record<string, RegExp> = {
  "tip-exit-0": /Exit code: 0/,
  "tip-exit-1": /Exit code: 1/,
  "tip-exit-signal": /Exited without an exit code/,
};

test.use({ deviceScaleFactor: 2 });

let server: Awaited<ReturnType<typeof startPreviewServer>> | undefined;
let baseURL = "";

test.beforeAll(async () => {
  if (!ENABLED) return;
  if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });
  server = await startPreviewServer();
  baseURL = server.baseURL;
});

test.afterAll(async () => {
  await server?.close();
});

async function open(page: Page, theme: string, reduceMotion = false): Promise<void> {
  await stubViteHmrClient(page);
  await page.mouse.move(0, 0);
  await page.setViewportSize({ width: 720, height: 1300 });
  await page.goto(
    `${baseURL}/agent-indicator-preview.html?theme=${theme}${reduceMotion ? "&rm=1" : ""}`
  );
  await expect(page.locator('[data-shot="shell-exit-signal"]')).toBeAttached({ timeout: 20_000 });
  await page.evaluate(() => document.fonts.ready);
  for (const [row, text] of Object.entries(EXPECTED_BADGES)) {
    await expect(
      page
        .locator(`[data-shot="${row}"] [role="status"][aria-live="off"]`)
        .filter({ hasText: text })
    ).toHaveCount(1);
  }
}

function chip(page: Page, row: string) {
  return page.locator(`[data-shot="${row}"]`).getByRole("status", { name: /Agent state/ });
}

test("Agent indicator and exit badge — states and themes", async ({ page }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_AGENT_INDICATOR is required for the agent indicator capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_AGENT_INDICATOR=1 to run the capture");
  test.setTimeout(10 * 60_000);

  const snap = makeSnap(OUT_DIR);
  const written: string[] = [];
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));

  for (const theme of THEMES) {
    await open(page, theme);
    written.push(await snap(page.locator("[data-preview-root]"), `rows--${theme}.png`));

    for (const [row, marker] of Object.entries(TOOLTIP_ROWS)) {
      await open(page, theme);
      const target = chip(page, row);
      await target.hover();
      const tip = page.locator("[data-radix-popper-content-wrapper]").last();
      await expect(tip).toContainText(marker, { timeout: 5_000 });
      await page.waitForTimeout(250);
      const rowBox = await page.locator(`[data-shot="${row}"]`).boundingBox();
      // The tooltip's exit line must say the same thing as the badge rule.
      if (row !== "tip-exit-1")
        await expect(tip.getByText(marker)).not.toHaveClass(/text-status-error/);
      else await expect(tip.getByText(marker)).toHaveClass(/text-status-error/);
      const tipBox = await tip.boundingBox();
      if (!rowBox || !tipBox) throw new Error(`${row}: no box — refusing to write`);
      const x = Math.min(rowBox.x, tipBox.x) - 8;
      const y = Math.min(rowBox.y, tipBox.y) - 8;
      const out = path.join(OUT_DIR, `tooltip-${row}--${theme}.png`);
      await page.screenshot({
        path: out,
        clip: {
          x: Math.max(0, x),
          y: Math.max(0, y),
          width: Math.max(rowBox.x + rowBox.width, tipBox.x + tipBox.width) - x + 8,
          height: Math.max(rowBox.y + rowBox.height, tipBox.y + tipBox.height) - y + 8,
        },
      });
      written.push(out);
    }

    for (const reduceMotion of [false, true]) {
      await open(page, theme, reduceMotion);
      const target = chip(page, "working");
      // `transition-none` clears the property list, not the duration.
      const { property, duration } = await target.evaluate((el) => {
        const style = getComputedStyle(el);
        return { property: style.transitionProperty, duration: style.transitionDuration };
      });
      if (reduceMotion) {
        expect(property, "reduced motion keeps a transition").toBe("none");
      } else {
        expect(property).toContain("background-color");
        expect(duration).toBe("0.15s");
      }
      // Sample the chip one frame into the flip and again once it has settled:
      // eased, the two differ; reduced, the first frame is already the last.
      const [early, settled] = await target.evaluate(async (el) => {
        const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
        (Reflect.get(window, "__setAgentState") as (id: string, s: string) => void)(
          "working",
          "waiting"
        );
        await frame();
        await frame();
        const first = getComputedStyle(el).backgroundColor;
        await new Promise((resolve) => setTimeout(resolve, 400));
        return [first, getComputedStyle(el).backgroundColor];
      });
      await expect(target).toHaveAttribute("aria-label", /waiting/i);
      if (reduceMotion) expect(early, "reduced motion interpolated the chip").toBe(settled);
      else expect(early, "the chip snapped instead of easing").not.toBe(settled);
      // Flip it back and freeze the chip's own transitions half-way, so the
      // "mid" frame shows the blend itself rather than whatever a timer caught.
      const paused = await target.evaluate(async (el) => {
        const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
        (Reflect.get(window, "__setAgentState") as (id: string, s: string) => void)(
          "working",
          "working"
        );
        await frame();
        const transitions = el.getAnimations().filter((a) => a instanceof CSSTransition);
        for (const t of transitions) {
          t.pause();
          t.currentTime = 75;
        }
        return { count: transitions.length, background: getComputedStyle(el).backgroundColor };
      });
      if (reduceMotion) {
        expect(paused.count, "reduced motion started a transition").toBe(0);
      } else {
        expect(paused.count, "no transition to pause").toBeGreaterThan(0);
        expect(paused.background).not.toBe(early);
        expect(paused.background).not.toBe(settled);
      }
      written.push(
        await snap(
          page.locator('[data-shot="working"]'),
          `transition-${reduceMotion ? "reduced" : "mid"}--${theme}.png`
        )
      );
    }
  }

  expect(pageErrors, `page errors during capture:\n${pageErrors.join("\n")}`).toEqual([]);
  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(written.length);
});
