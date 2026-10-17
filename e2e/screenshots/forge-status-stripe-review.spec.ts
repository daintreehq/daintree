/**
 * Forge status stripe visual-review harness.
 *
 * The loading / error bar under the toolbar's forge stats control is two CSS
 * pixels tall, so it is judged here at the scales people actually see it at (1x
 * and 2x, no upscaling) with every animation frozen at a chosen frame. A
 * background poll that raises the counts is captured too, to prove it leaves
 * the stripe alone and is told only by the counters' own chips. It drives the same
 * preview entry as `forge-stats-review` (`forge-stats-preview.html`), which
 * mounts the REAL `ForgeStatsToolbarButton`.
 *
 *   DAINTREE_SHOT_FORGESTRIPE=1 npx playwright test --project=screenshots forge-status-stripe-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_FORGESTRIPE  required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR          output directory (default artifacts/forge-stripe-shots)
 *   DAINTREE_SHOT_THEMES       comma-separated sweep at 2x (default: every built-in theme)
 *
 * The first two themes are also captured at 1x, with a keyboard-focused
 * counter over the error bar, and under reduced motion and forced colors. Each
 * PNG gets a JSON sidecar with the stripe's rect
 * and computed paint, and a frame is only written once the stripe is verified to
 * be in the state its name claims.
 */

import { test, expect, type Browser, type Locator, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "fs";
import path from "path";
import { startPreviewServer, stubViteHmrClient } from "../helpers/previewHarness";

const ENABLED = !!process.env.DAINTREE_SHOT_FORGESTRIPE;

const OUT_DIR = path.resolve(
  process.env.DAINTREE_SHOT_DIR ?? path.join(process.cwd(), "artifacts", "forge-stripe-shots")
);

const ALL_THEMES = [
  "daintree",
  "bondi",
  "arashiyama",
  "atacama",
  "bali",
  "fiordland",
  "galapagos",
  "highlands",
  "hokkaido",
  "movile",
  "namib",
  "redwoods",
  "serengeti",
  "svalbard",
  "table-mountain",
];

const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? ALL_THEMES.join(","))
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

type StripeState = "idle" | "loading" | "poll" | "error" | "error-focus";

/** Shimmer frame: halfway through the 1.5s sweep, band centred. */
const LOADING_FRAME_MS = 750;

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

function stripeOf(page: Page): Locator {
  return page.locator('.toolbar-stats > [role="status"]');
}

async function open(page: Page, fixture: string, theme: string): Promise<Locator> {
  await page.mouse.move(0, 0);
  await page.goto(`${baseURL}/forge-stats-preview.html?theme=${theme}&fixture=${fixture}`);
  const shell = page.locator("[data-preview-shell]");
  await expect(shell, `fixture "${fixture}" rendered no shell`).toBeAttached();
  await expect(page.locator('[data-testid^="forge-stat-pill-"]')).toHaveCount(3);
  if (fixture !== "loading") {
    await expect(page.getByTestId("forge-stat-pill-commits")).not.toContainText("—");
  }
  await page.evaluate(() => document.fonts.ready);
  // Width eases over 150ms when the budget changes; let it finish.
  await page.waitForTimeout(400);
  return shell;
}

/** Put the control into `state` and freeze its stripe on a known frame. */
async function drive(page: Page, state: StripeState, theme: string): Promise<Locator> {
  const fixture = state === "loading" ? "loading" : state.startsWith("error") ? "error" : "default";
  const shell = await open(page, fixture, theme);
  const stripe = stripeOf(page);

  if (state === "poll") {
    // A background poll with higher counts: the chips and the count change are
    // the signal, and the stripe must stay idle.
    const pushed = await page.evaluate(() =>
      (
        window as unknown as { __forgePreviewPushCounts: (i: number, p: number) => boolean }
      ).__forgePreviewPushCounts(9, 8)
    );
    expect(pushed, "no counts listener subscribed").toBe(true);
    await expect(page.getByTestId("forge-stat-pill-issues")).toContainText("9");
    await expect(stripe).toHaveClass(/opacity-0/);
  } else if (state === "loading") {
    await expect(stripe).toHaveClass(/forge-status-loading/);
  } else if (state.startsWith("error")) {
    await expect(stripe).toHaveClass(/forge-status-error/);
    if (state === "error-focus") {
      // A keypress first, so the programmatic focus lands as :focus-visible.
      await page.keyboard.press("Shift");
      await page.getByTestId("forge-stat-pill-issues").focus();
      await expect(page.getByTestId("forge-stat-pill-issues")).toBeFocused();
    }
  } else {
    await expect(stripe).toHaveClass(/opacity-0/);
  }

  await page.evaluate(
    ({ state, loadingMs }) => {
      for (const anim of document.getAnimations()) {
        const name = (anim as CSSAnimation).animationName ?? "";
        if (!name.startsWith("forge-status")) continue;
        anim.pause();
        if (state === "loading") anim.currentTime = loadingMs;
        else anim.finish();
      }
    },
    { state, loadingMs: LOADING_FRAME_MS }
  );
  // Let the activity chips' 200ms entrance and any colour fades settle.
  await page.waitForTimeout(300);
  return shell;
}

async function sidecar(page: Page, file: string): Promise<void> {
  const data = await page.evaluate(() => {
    const stripe = document.querySelector<HTMLElement>('.toolbar-stats > [role="status"]');
    const box = document.querySelector<HTMLElement>(".toolbar-stats");
    if (!stripe || !box) return null;
    const cs = getComputedStyle(stripe);
    const after = getComputedStyle(stripe, "::after");
    const bs = getComputedStyle(box);
    const r = stripe.getBoundingClientRect();
    const b = box.getBoundingClientRect();
    return {
      dpr: window.devicePixelRatio,
      className: stripe.className,
      stripe: {
        rect: { x: r.x, y: r.y, width: r.width, height: r.height },
        background: cs.backgroundColor,
        opacity: cs.opacity,
        transform: cs.transform,
        afterBackground: after.backgroundImage,
        afterTransform: after.transform,
        afterDisplay: after.display,
      },
      container: {
        rect: { x: b.x, y: b.y, width: b.width, height: b.height },
        borderBottom: `${bs.borderBottomWidth} ${bs.borderBottomColor}`,
        radius: bs.borderBottomLeftRadius,
        background: bs.backgroundColor,
      },
    };
  });
  if (!data) throw new Error(`${file}: stripe or container missing — refusing to write`);
  writeFileSync(path.join(OUT_DIR, file.replace(/\.png$/, ".json")), JSON.stringify(data, null, 2));
}

async function snap(page: Page, shell: Locator, file: string, written: string[]): Promise<void> {
  const box = await shell.boundingBox();
  if (!box || box.width < 8 || box.height < 8) {
    throw new Error(`${file}: shell has no real box (${JSON.stringify(box)}) — refusing to write`);
  }
  const out = path.join(OUT_DIR, file);
  await shell.screenshot({ path: out });
  await sidecar(page, file);
  written.push(out);
}

async function newPage(
  browser: Browser,
  scale: number,
  media: Parameters<Page["emulateMedia"]>[0] = {}
): Promise<Page> {
  const context = await browser.newContext({
    deviceScaleFactor: scale,
    viewport: { width: 640, height: 200 },
  });
  const page = await context.newPage();
  await stubViteHmrClient(page);
  await page.emulateMedia(media);
  return page;
}

const STATES: StripeState[] = ["idle", "loading", "poll", "error"];

test("Forge status stripe — states, scales, themes", async ({ browser }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_FORGESTRIPE is required for the forge status stripe capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_FORGESTRIPE=1 to run the capture");
  test.setTimeout(15 * 60_000);

  const written: string[] = [];
  const pageErrors: string[] = [];

  const runs: Array<{
    scale: number;
    themes: string[];
    media?: Parameters<Page["emulateMedia"]>[0];
    tag: string;
    states: StripeState[];
  }> = [
    { scale: 2, themes: THEMES, tag: "2x", states: STATES },
    { scale: 2, themes: THEMES.slice(0, 2), tag: "2x", states: ["error-focus"] },
    { scale: 1, themes: THEMES.slice(0, 2), tag: "1x", states: [...STATES, "error-focus"] },
    {
      scale: 2,
      themes: THEMES.slice(0, 2),
      media: { reducedMotion: "reduce" },
      tag: "2x-reduced",
      states: ["loading", "error"],
    },
    {
      scale: 2,
      themes: THEMES.slice(0, 1),
      media: { forcedColors: "active" },
      tag: "2x-forced",
      states: ["loading", "error", "error-focus"],
    },
  ];

  for (const run of runs) {
    const page = await newPage(browser, run.scale, run.media);
    page.on("pageerror", (e) => pageErrors.push(e.message));
    for (const theme of run.themes) {
      for (const state of run.states) {
        const shell = await drive(page, state, theme);
        await snap(page, shell, `${state}-${theme}-${run.tag}.png`, written);
      }
    }
    await page.context().close();
  }

  expect(pageErrors, `page errors during capture:\n${pageErrors.join("\n")}`).toEqual([]);
  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(written.length);
  expect(written.length).toBe(runs.reduce((n, r) => n + r.themes.length * r.states.length, 0));
});
