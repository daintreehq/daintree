/**
 * Assistant pre-session visual-review harness: the launch skeleton and the CLI version gate.
 *
 * Neither state is easy to reach in the running app — the gate needs an outdated CLI, and
 * the launch hints need a launch that stalls for 8-20s — so this drives the preview entry
 * (`assistant-launching-preview.html`): the real components under the real panel header,
 * the theme's real tokens, the panel's real widths. The hint ladder is walked with
 * Playwright's fake clock instead of real waiting.
 *
 * Opt-in only: skips itself unless DAINTREE_SHOT_ASSISTANTLAUNCH is set.
 *
 *   DAINTREE_SHOT_ASSISTANTLAUNCH=1 npx playwright test --project=screenshots assistant-launching-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_ASSISTANTLAUNCH  required: any truthy value runs the capture
 *   DAINTREE_SHOT_DIR              output directory (default artifacts/assistant-launching-shots)
 *   DAINTREE_SHOT_THEMES           comma-separated theme sweep (default: daintree,bondi,namib)
 *
 * Never writes a PNG it has not verified, and counts the files itself rather than
 * trusting the exit code.
 */

import { test, expect, type Locator, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readdirSync, rmSync } from "fs";
import path from "path";
import {
  startPreviewServer,
  stubViteHmrClient,
  type PreviewServer,
} from "../helpers/previewHarness";

const ENABLED = !!process.env.DAINTREE_SHOT_ASSISTANTLAUNCH;

const DEFAULT_WIDTH = 380;
const MIN_WIDTH = 320;

const OUT_DIR = path.resolve(
  process.env.DAINTREE_SHOT_DIR ??
    path.join(process.cwd(), "artifacts", "assistant-launching-shots")
);

const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi,namib")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

/**
 * Each capture is a fixture from the preview entry plus how long the fake clock runs
 * before the shot. 700ms clears the 400ms Doherty gate; 8.5s / 13.5s / 20.5s sit just
 * past each rung of `SkeletonHint`'s ladder.
 */
const SHOTS = [
  { name: "launch-version-checking", fixture: "launch-version-checking", elapsed: 700 },
  { name: "launch-provisioning", fixture: "launch-provisioning", elapsed: 700 },
  { name: "launch-launching", fixture: "launch-launching", elapsed: 700 },
  { name: "launch-hibernating", fixture: "launch-hibernating", elapsed: 700 },
  { name: "launch-hint-first", fixture: "launch-launching", elapsed: 8_500 },
  { name: "launch-hint-second", fixture: "launch-launching", elapsed: 13_500 },
  { name: "launch-hint-action", fixture: "launch-launching", elapsed: 20_500 },
  { name: "gate", fixture: "gate", elapsed: 0 },
  { name: "gate-checking", fixture: "gate-checking", elapsed: 0 },
  { name: "gate-long", fixture: "gate-long", elapsed: 0 },
] as const;

const NARROW_SHOTS = ["launch-hint-first", "gate-long"] as const;

test.use({ deviceScaleFactor: 2 });

let server: PreviewServer | undefined;

test.beforeAll(async () => {
  if (!ENABLED) return;
  if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });
  server = await startPreviewServer();
});

test.afterAll(async () => {
  await server?.close();
});

async function snap(target: Locator, file: string): Promise<string> {
  await expect(target).toBeAttached();
  const box = await target.boundingBox();
  if (!box || box.width < 8 || box.height < 8) {
    throw new Error(`${file}: target has no real box (${JSON.stringify(box)}) — refusing to write`);
  }
  const out = path.join(OUT_DIR, file);
  await target.screenshot({ path: out });
  return out;
}

async function open(
  page: Page,
  fixture: string,
  theme: string,
  width: number,
  elapsed: number
): Promise<{ panel: Locator; body: Locator }> {
  await page.setViewportSize({ width: 800, height: 640 });
  await page.clock.install({ time: 0 });
  const url = `${server!.baseURL}/assistant-launching-preview.html?theme=${theme}&fixture=${fixture}&width=${width}`;
  const panel = page.locator("[data-preview-panel]").first();
  const body = page.locator("[data-preview-body]").first();
  await page.goto(url);
  await expect(panel).toBeAttached({ timeout: 30_000 });
  await expect(panel).toHaveCSS("display", "flex");
  await page.evaluate(() => document.fonts.ready);
  if (elapsed > 0) {
    // Two steps, not one. The Doherty gate's timer fires inside the first, but React
    // commits the skeleton on a real-time task, so the hint's own 8s ladder is only
    // armed once the page gets a real tick. One long `runFor` would arm it at the END
    // of the jump and photograph a hint that has not appeared yet.
    await page.clock.runFor(Math.min(elapsed, 700));
    await page.waitForTimeout(100);
    if (elapsed > 700) await page.clock.runFor(elapsed - 700);
  }
  await page.waitForTimeout(150);
  // Pin every CSS animation to a known frame. The skeleton pulse is an infinite loop
  // whose first keyframe is opacity 0 (it doubles as the 400ms onset delay), so neither
  // Playwright's `animations: "disabled"` nor a lucky real-time wait photographs a bone
  // reliably. Park each pulse just past its delay, at full opacity, and finish fades.
  await page.evaluate(() => {
    for (const animation of document.getAnimations()) {
      const timing = animation.effect?.getComputedTiming();
      if (timing && timing.iterations === Infinity) {
        animation.pause();
        animation.currentTime = Number(timing.delay ?? 0) + 20;
      } else {
        animation.finish();
      }
    }
  });
  return { panel, body };
}

/** A state that renders nothing is the defect a loading-state harness exists to catch. */
async function expectPainted(body: Locator, name: string, kind: "launch" | "gate") {
  if (kind === "gate") {
    await expect(body.getByTestId("help-version-too-old"), `${name}: gate missing`).toBeVisible();
  } else {
    // The announcer is sr-only, so "painted" means it carries a phase and the
    // visible spinner group beside it has a real box.
    await expect(body.locator('[role="status"]').first(), `${name}: no phase`).not.toHaveText("");
    await expect(
      body.locator('[aria-hidden="true"] p').first(),
      `${name}: label missing`
    ).toBeVisible();
  }
}

test("assistant launching + version gate — states, widths and themes", async ({ browser }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_ASSISTANTLAUNCH is required for the capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_ASSISTANTLAUNCH=1 to run the capture");
  test.setTimeout(10 * 60_000);

  const written: string[] = [];

  // A fresh page per shot: the fake clock is installed once per page and must start at 0.
  async function capture(
    shot: (typeof SHOTS)[number],
    theme: string,
    width: number,
    suffix = ""
  ): Promise<{ page: Page; panel: Locator }> {
    const page = await browser.newPage({ deviceScaleFactor: 2 });
    await stubViteHmrClient(page);
    const { panel, body } = await open(page, shot.fixture, theme, width, shot.elapsed);
    await expectPainted(body, shot.name, shot.fixture.startsWith("gate") ? "gate" : "launch");
    if (!suffix) written.push(await snap(panel, `${shot.name}-${theme}-${width}.png`));
    return { page, panel };
  }

  for (const theme of THEMES) {
    for (const shot of SHOTS) {
      const { page } = await capture(shot, theme, DEFAULT_WIDTH);
      await page.close();
    }
  }

  const narrowTheme = THEMES[0]!;
  for (const name of NARROW_SHOTS) {
    const shot = SHOTS.find((s) => s.name === name)!;
    const { page } = await capture(shot, narrowTheme, MIN_WIDTH);
    await page.close();
  }

  // Keyboard focus inside each body, through real Tabs so :focus-visible fires. The
  // header and strip own the first stops, so tab until focus lands in the body.
  for (const name of ["gate", "launch-hint-first"] as const) {
    const shot = SHOTS.find((s) => s.name === name)!;
    const { page, panel } = await capture(shot, narrowTheme, DEFAULT_WIDTH, "focus");
    const body = page.locator("[data-preview-body]").first();
    let inside = false;
    for (let i = 0; i < 12 && !inside; i++) {
      await page.keyboard.press("Tab");
      inside = await body.evaluate((el) => el.contains(document.activeElement));
    }
    if (!inside) throw new Error(`${name}: Tab never reached the body — refusing to write`);
    await page.waitForTimeout(250);
    written.push(await snap(panel, `${name}-${narrowTheme}-${DEFAULT_WIDTH}-focus.png`));
    await page.close();
  }

  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(written.length);
  expect(onDisk.length).toBe(THEMES.length * SHOTS.length + NARROW_SHOTS.length + 2);
  console.log(`[assistant-launching-shots] ${onDisk.length} PNGs in ${OUT_DIR}`);
});
