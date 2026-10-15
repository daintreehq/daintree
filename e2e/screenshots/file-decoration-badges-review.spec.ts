/**
 * Plugin file-decoration badges in the worktree card's changed-file list.
 *
 * A plugin can hang a small badge on a changed file: a count or a glyph, with a
 * tooltip, an optional provider colour, and an optional link. The badge sits
 * inside a row that is itself a button with its own path tooltip, so the
 * states worth photographing are the ones where the two meet:
 *
 *   rest          pointer parked off the page
 *   hover-link    pointer on a badge that carries a link
 *   hover-static  pointer on a badge with no link
 *   hover-long    pointer on a provider-coloured badge with a wrapping tooltip
 *   hover-row     pointer on a decorated row's file name
 *   focus-row     keyboard focus on a decorated row
 *   tab-out       one Tab press from that row
 *   menu-link     the row menu open on a row whose badge carries a link
 *
 *   DAINTREE_SHOT_DECORATIONS=1 DAINTREE_SHOT_DIR=/abs/out \
 *     ./node_modules/.bin/playwright test --project=screenshots file-decoration-badges-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_DECORATIONS  required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR          required — absolute output directory outside the repo
 *   DAINTREE_SHOT_THEMES       themes for every state (default: daintree,bondi)
 *   DAINTREE_SHOT_SWEEP        extra themes for the rest frame only (default: none)
 *
 * Output: decorations--<state>--<theme>.png, plus observations.json recording
 * what each frame showed (focused element, visible tooltip text). A frame is
 * written only after its state is verified, and the run counts the files on
 * disk against the plan.
 */

import { test, expect, type Locator, type Page } from "@playwright/test";
import { mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from "fs";
import path from "path";
import {
  makeSnap,
  startPreviewServer,
  stubViteHmrClient,
  type PreviewServer,
} from "../helpers/previewHarness";

const ENABLED = !!process.env.DAINTREE_SHOT_DECORATIONS;
const OUT_DIR = path.resolve(process.env.DAINTREE_SHOT_DIR ?? "");
const list = (value: string | undefined, fallback: string) =>
  (value ?? fallback)
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
const THEMES = list(process.env.DAINTREE_SHOT_THEMES, "daintree,bondi");
const SWEEP = list(process.env.DAINTREE_SHOT_SWEEP, "").filter((t) => !THEMES.includes(t));

const STATES = [
  "rest",
  "hover-link",
  "hover-static",
  "hover-long",
  "hover-row",
  "focus-row",
  "tab-out",
  "menu-link",
] as const;
type State = (typeof STATES)[number];

const plannedFiles = () => [
  ...THEMES.flatMap((theme) => STATES.map((state) => `decorations--${state}--${theme}.png`)),
  ...SWEEP.map((theme) => `decorations--rest--${theme}.png`),
];

test.use({ deviceScaleFactor: 2, viewport: { width: 640, height: 500 } });

let server: PreviewServer | undefined;
const observations: Record<string, unknown> = {};

test.beforeAll(async () => {
  if (!ENABLED) return;
  if (!process.env.DAINTREE_SHOT_DIR || !path.isAbsolute(OUT_DIR)) {
    throw new Error("DAINTREE_SHOT_DIR must be an absolute directory outside the repo");
  }
  const repoRoot = realpathSync(process.cwd());
  mkdirSync(OUT_DIR, { recursive: true });
  const outReal = realpathSync(OUT_DIR);
  if (outReal === repoRoot || outReal.startsWith(repoRoot + path.sep)) {
    throw new Error(`DAINTREE_SHOT_DIR must be outside the repo (${OUT_DIR})`);
  }
  for (const file of readdirSync(OUT_DIR)) {
    if (/^decorations--.+\.png$/.test(file) || file === "observations.json") {
      rmSync(path.join(OUT_DIR, file));
    }
  }
  server = await startPreviewServer();
});

test.afterAll(async () => {
  await server?.close();
});

const row = (page: Page, relativePath: string) =>
  page.locator(`[data-surface="card"] [aria-label="Open ${relativePath}"]`);

/** The badge's visible glyph: the innermost element whose whole text is the badge. */
const badge = (page: Page, relativePath: string, glyph: string) =>
  row(page, relativePath).getByText(glyph, { exact: true }).last();

const BADGES: Array<[string, string]> = [
  ["src/components/charts/Legend.tsx", "2"],
  ["src/components/charts/Tooltip.tsx", "3"],
  ["src/lib/format.ts", "128"],
  ["src/lib/credentials.ts", "!"],
  ["README.md", "12"],
];

async function load(page: Page, theme: string) {
  await stubViteHmrClient(page);
  await page.goto(`${server!.baseURL}/file-decoration-badges-preview.html?theme=${theme}`);
  // A cold server optimises dependencies on the first request and asks the page
  // to reload, which the inert HMR client cannot do. One reload picks it up.
  const first = row(page, "README.md");
  await first.waitFor({ timeout: 15_000 }).catch(() => page.reload());
  await expect(first).toBeVisible({ timeout: 30_000 });
  // The decorations arrive a tick after the rows: wait for every badge.
  for (const [file, glyph] of BADGES) {
    await expect(badge(page, file, glyph)).toBeVisible({ timeout: 10_000 });
  }
  // The first page of a cold server can paint before the webfonts land, and a
  // frame in the fallback face reads as a type change that never happened.
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  const fontsLoaded = await page.evaluate(() =>
    Array.from(document.fonts).every((face) => face.status !== "loading")
  );
  if (!fontsLoaded) throw new Error("webfonts still loading after fonts.ready");
  await page.mouse.move(1, 1);
  await page.waitForTimeout(250);
}

async function pointAt(page: Page, target: Locator) {
  const box = await target.boundingBox();
  if (!box) throw new Error("hover target has no box");
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x - 40, y);
  await page.mouse.move(x, y, { steps: 6 });
  const onTarget = await target.evaluate(
    (el, [px, py]) => {
      const hit = document.elementFromPoint(px!, py!);
      return !!hit && (el.contains(hit) || hit.contains(el));
    },
    [x, y]
  );
  if (!onTarget) throw new Error("pointer is not over the hover target");
  // Past the provider's open delay, with the 150ms entry settled.
  await page.waitForTimeout(1100);
}

async function observe(page: Page) {
  return page.evaluate(() => {
    const active = document.activeElement as HTMLElement | null;
    const describe = (el: HTMLElement | null) =>
      el && el !== document.body
        ? {
            tag: el.tagName.toLowerCase(),
            role: el.getAttribute("role"),
            label: el.getAttribute("aria-label"),
            text: (el.textContent ?? "").trim().slice(0, 60),
          }
        : null;
    const tooltips = Array.from(
      document.querySelectorAll<HTMLElement>("[data-radix-popper-content-wrapper]")
    )
      .filter((el) => el.offsetParent !== null || el.getBoundingClientRect().width > 0)
      .map((el) => (el.innerText ?? "").trim())
      .filter(Boolean);
    return { activeElement: describe(active), visibleOverlays: tooltips };
  });
}

async function capture(page: Page, state: State, theme: string) {
  const frame = page.locator("[data-preview-frame]");
  const snap = makeSnap(OUT_DIR);
  await load(page, theme);
  const legend = row(page, "src/components/charts/Legend.tsx");

  switch (state) {
    case "rest":
      break;
    case "hover-link":
      await pointAt(page, badge(page, "src/components/charts/Legend.tsx", "2"));
      break;
    case "hover-static":
      await pointAt(page, badge(page, "src/components/charts/Tooltip.tsx", "3"));
      break;
    case "hover-long":
      await pointAt(page, badge(page, "src/lib/credentials.ts", "!"));
      break;
    case "hover-row":
      await pointAt(page, legend.getByText("Legend.tsx", { exact: true }));
      break;
    case "focus-row":
    case "tab-out": {
      // A real key press first, so the programmatic focus below is ringed the
      // way keyboard focus is.
      await page.keyboard.press("Shift");
      await legend.focus();
      await expect(legend).toBeFocused();
      if (state === "tab-out") await page.keyboard.press("Tab");
      await page.waitForTimeout(1100);
      break;
    }
    case "menu-link": {
      await legend.click({ button: "right" });
      const menu = page.getByRole("menu");
      await expect(menu).toBeVisible();
      await expect(legend).toHaveAttribute("data-state", "open");
      // Pointer parked in empty frame space below the card: on an item it would
      // highlight one, and on the Copy row it opens the submenu over the frame.
      await page.mouse.move(40, 470, { steps: 4 });
      await page.waitForTimeout(250);
      await expect(menu).toBeVisible();
      break;
    }
  }

  observations[`${state}--${theme}`] = await observe(page);
  await snap(frame, `decorations--${state}--${theme}.png`);
}

// One test, not one per theme: each test gets its own worker, and each
// worker's beforeAll would clear the frames the other one wrote.
test("file decoration badges", async ({ page }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_DECORATIONS is required for the decoration badge capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_DECORATIONS=1 to capture");
  test.setTimeout(300_000);
  for (const theme of THEMES) {
    for (const state of STATES) await capture(page, state, theme);
  }
  for (const theme of SWEEP) await capture(page, "rest", theme);
  writeFileSync(path.join(OUT_DIR, "observations.json"), JSON.stringify(observations, null, 2));
});

test.afterAll(() => {
  if (!ENABLED) return;
  const onDisk = new Set(readdirSync(OUT_DIR));
  const missing = plannedFiles().filter((f) => !onDisk.has(f));
  if (missing.length > 0) throw new Error(`missing frames: ${missing.join(", ")}`);
});
