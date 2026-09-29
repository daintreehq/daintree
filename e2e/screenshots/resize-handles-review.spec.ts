/**
 * Resize-handle visual-review harness.
 *
 * Drives `resize-handles-preview.html`, which renders each real handle (or the
 * component that owns it) in a frame shaped like its home, with a real mouse and
 * real keys rather than booting Electron.
 *
 * Opt-in only:
 *
 *   DAINTREE_SHOT_RESIZE_HANDLES=1 DESIGN_CAPTURE_DIR=/abs/out \
 *     npx playwright test --project=screenshots resize-handles-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_RESIZE_HANDLES  required: any truthy value runs the capture
 *   DESIGN_CAPTURE_DIR            an ABSOLUTE directory outside the repo
 *   DAINTREE_SHOT_THEMES          theme sweep (default daintree,bondi)
 *
 * Output: `<scene>-<rest|hover|focus|drag>--<theme>.png`. Never writes a PNG it has
 * not verified, and counts the files itself.
 */

import { test, expect, type Page } from "@playwright/test";
import { mkdirSync, readdirSync, realpathSync, rmSync } from "fs";
import path from "path";
import {
  startPreviewServer,
  stubViteHmrClient,
  type PreviewServer,
} from "../helpers/previewHarness";

const ENABLED = !!process.env.DAINTREE_SHOT_RESIZE_HANDLES;
const OUT_DIR = process.env.DESIGN_CAPTURE_DIR ?? "";
const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

const ALL_SCENES = ["assistant", "dock-popover", "two-pane", "dev-drawer", "diagnostics"] as const;
const ONLY = (process.env.DAINTREE_SHOT_ONLY ?? "").split(",").filter(Boolean);
const SCENES = ALL_SCENES.filter((s) => ONLY.length === 0 || ONLY.includes(s));
const STATES = ["rest", "hover", "focus", "drag"] as const;
type State = (typeof STATES)[number];

const SEPARATOR = '[role="separator"]';

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

test.use({ deviceScaleFactor: 2 });

let server: PreviewServer | undefined;

test.beforeAll(async () => {
  if (!ENABLED) return;
  if (!path.isAbsolute(OUT_DIR)) {
    throw new Error("DESIGN_CAPTURE_DIR must be an absolute directory outside the repo");
  }
  const repoRoot = realpathSync(process.cwd());
  mkdirSync(OUT_DIR, { recursive: true });
  const outReal = realpathSync(OUT_DIR);
  if (outReal === repoRoot || outReal.startsWith(repoRoot + path.sep)) {
    throw new Error(`DESIGN_CAPTURE_DIR must be outside the repo (${OUT_DIR})`);
  }
  for (const file of readdirSync(OUT_DIR)) {
    if (file.endsWith(".png")) rmSync(path.join(OUT_DIR, file), { force: true });
  }
  server = await startPreviewServer();
});

test.afterAll(async () => {
  await server?.close();
});

async function openScene(page: Page, scene: string, theme: string): Promise<void> {
  await page.setViewportSize({ width: 480, height: 720 });
  const url = `${server!.baseURL}/resize-handles-preview.html?scene=${scene}&theme=${theme}`;
  const frame = page.locator("[data-preview-scene]");
  // A cold dev server re-optimises deps the dynamic imports discover, answering 504
  // "Outdated Optimize Dep" until it settles; reload until the page mounts.
  for (let attempt = 1; ; attempt += 1) {
    try {
      await page.goto("about:blank");
      await page.goto(url, { waitUntil: "load" });
      await expect(frame).toBeAttached({ timeout: 15_000 });
      break;
    } catch (err) {
      if (attempt >= 5) throw err;
    }
  }
  await expect(page.locator(SEPARATOR)).toHaveCount(1);
  await page.addStyleTag({ content: FREEZE_CSS });
  await page.evaluate(() => document.fonts.ready);
  await page.mouse.move(0, 0);
  await page.waitForTimeout(250);
}

async function handlePoint(page: Page): Promise<{ x: number; y: number; vertical: boolean }> {
  const separator = page.locator(SEPARATOR);
  const box = await separator.boundingBox();
  if (!box || Math.min(box.width, box.height) < 2) throw new Error("handle has no box");
  const vertical = (await separator.getAttribute("aria-orientation")) === "vertical";
  // Inside the frame: a straddling handle's outer half can sit under a neighbour.
  return {
    x: box.x + box.width / 2 + (vertical ? 1 : 0),
    y: box.y + box.height / 2 + (vertical ? 0 : 1),
    vertical,
  };
}

async function enter(page: Page, state: State): Promise<void> {
  const separator = page.locator(SEPARATOR);
  const { x, y, vertical } = await handlePoint(page);
  if (state === "hover") {
    await page.mouse.move(x, y);
    await page.waitForTimeout(400);
    if (!(await separator.evaluate((el) => el.matches(":hover")))) {
      throw new Error("hover: handle is not hovered — refusing to write");
    }
    // Both outer portions of the 12px target must reach the handle, not a clipping
    // host or a neighbour painted over it.
    const box = (await separator.boundingBox())!;
    const probes = vertical
      ? [
          [box.x + box.width / 2 - 5, y],
          [box.x + box.width / 2 + 5, y],
        ]
      : [
          [x, box.y + box.height / 2 - 5],
          [x, box.y + box.height / 2 + 5],
        ];
    for (const [px, py] of probes) {
      const hit = await separator.evaluate(
        (el, [cx, cy]) => el.contains(document.elementFromPoint(cx!, cy!)),
        [px, py]
      );
      if (!hit) throw new Error(`hover: target misses the handle at (${px}, ${py})`);
    }
  } else if (state === "focus") {
    await separator.evaluate((el) => (el as HTMLElement).blur());
    for (let i = 0; i < 40; i += 1) {
      await page.keyboard.press("Tab");
      if (await separator.evaluate((el) => el === document.activeElement)) break;
    }
    if (!(await separator.evaluate((el) => el.matches(":focus-visible")))) {
      throw new Error("focus: keyboard focus never reached the handle");
    }
  } else if (state === "drag") {
    const before = await separator.getAttribute("aria-valuenow");
    await page.mouse.move(x, y);
    await page.mouse.down();
    for (let step = 1; step <= 6; step += 1) {
      const d = (-30 * step) / 6;
      await page.mouse.move(vertical ? x + d : x, vertical ? y : y + d);
    }
    await page.waitForTimeout(250);
    const after = await separator.getAttribute("aria-valuenow");
    if (before === after) throw new Error(`drag: value did not move (${before})`);
  }
}

test("resize handles — scenes, states and themes", async ({ page }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_RESIZE_HANDLES is required for the resize-handle capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_RESIZE_HANDLES=1 to run the capture");
  test.setTimeout(600_000);

  await stubViteHmrClient(page);
  page.on("pageerror", (err) => console.log(`[resize-handle-shots] pageerror: ${err.message}`));
  const written: string[] = [];

  for (const theme of THEMES) {
    for (const scene of SCENES) {
      for (const state of STATES) {
        await openScene(page, scene, theme);
        await enter(page, state);
        const out = path.join(OUT_DIR, `${scene}-${state}--${theme}.png`);
        await page.locator("[data-preview-scene]").screenshot({ path: out });
        written.push(out);
        if (state === "drag") await page.mouse.up();
      }
    }
  }

  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(written.length);
  expect(onDisk.length).toBe(THEMES.length * SCENES.length * STATES.length);
  console.log(`[resize-handle-shots] ${onDisk.length} PNGs in ${OUT_DIR}`);
});
