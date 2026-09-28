/**
 * Content dock cue and scroll visual-review harness.
 *
 * The plain-terminal "finished" check, the chips' state icons and the rail's
 * scroll chevrons are all judged in motion, so a rest frame says little about
 * them. This drives the `cues` fixture of the dock preview entry and flips the
 * real store through `window.__dockPreview`, then pauses the transitions the
 * flip started and seeks them to a fixed moment, so mid-flight frames are
 * deterministic rather than a race against the screenshot.
 *
 * Opt-in only, like every sibling review harness:
 *
 *   DAINTREE_SHOT_DOCK_CUES=1 npx playwright test --project=screenshots dock-cues-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_DOCK_CUES  required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR        output directory (default artifacts/dock-cues-shots)
 *   DAINTREE_SHOT_THEMES     comma-separated theme sweep (default: daintree,bondi)
 *
 * Output, per theme:
 *   working-<theme>.png          a plain command running, an agent working
 *   finished-<theme>.png         the finished check, settled
 *   rail-mid-<theme>.png         the rail scrolled to its middle — both chevrons
 * Plus, in the first theme only:
 *   finished-enter-20ms.png      the check 20ms into its entry
 *   finished-enter-50ms.png      the check 50ms into its entry
 *   finished-exit-940ms.png      the check 60ms before the dwell ends
 *   finished-enter-reduced.png   20ms in, under prefers-reduced-motion
 *   state-colour-75ms.png        an agent icon 75ms into working → waiting
 *   rail-start.png               the rail at rest, scrolled to the start
 *   rail-end-fading.png          the right chevron, under the cursor, mid-fade at the end
 *   rail-end.png                 the same, settled
 *   rail-wheel.png               the rail after one vertical wheel notch
 * and `scroll-log.json` with the check's computed opacity/scale at each frozen
 * frame and the rail's scrollLeft around the wheel notch.
 *
 * Never writes a PNG it has not verified, and counts the files itself.
 */

import { test, expect, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from "fs";
import path from "path";
import {
  makeSnap,
  startPreviewServer,
  stubViteHmrClient,
  type PreviewServer,
} from "../helpers/previewHarness";

const ENABLED = !!process.env.DAINTREE_SHOT_DOCK_CUES;

const OUT_DIR = path.resolve(
  process.env.DAINTREE_SHOT_DIR || path.join(process.cwd(), "artifacts", "dock-cues-shots")
);

const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

const WIDTH = 1000;
const DOCK = "#dock-container";
const RAIL = '#dock-container [role="toolbar"][aria-label="Docked panels"]';
const ATTACH_TIMEOUT_MS = 30_000;

test.use({ deviceScaleFactor: 2 });

let server: PreviewServer | undefined;
const snap = makeSnap(OUT_DIR);

test.beforeAll(async () => {
  if (!ENABLED) return;
  const cwd = process.cwd();
  if (OUT_DIR === cwd || cwd.startsWith(OUT_DIR + path.sep)) {
    throw new Error(`DAINTREE_SHOT_DIR resolves to the checkout (${OUT_DIR}) — refusing`);
  }
  mkdirSync(OUT_DIR, { recursive: true });
  for (const f of readdirSync(OUT_DIR)) {
    if (f.endsWith(".png") || f.endsWith(".json")) unlinkSync(path.join(OUT_DIR, f));
  }
  server = await startPreviewServer();
});

test.afterAll(async () => {
  await server?.close();
});

async function settleDevServer(context: BrowserContext) {
  const page = await context.newPage();
  await stubViteHmrClient(page);
  let navigations = 0;
  page.on("framenavigated", () => navigations++);
  await page.goto(`${server!.baseURL}/dock-preview.html?fixture=cues`);
  for (let attempt = 0; attempt < 8; attempt++) {
    const before = navigations;
    await page.waitForTimeout(2_500);
    const shellCount = await page.locator("[data-preview-shell]").count();
    if (navigations === before && shellCount === 1) break;
  }
  await page.close();
}

async function withPage<T>(
  context: BrowserContext,
  what: string,
  body: (page: Page) => Promise<T>
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const page = await context.newPage();
    await stubViteHmrClient(page);
    let crashed = false;
    const errors: string[] = [];
    page.on("crash", () => {
      crashed = true;
    });
    page.on("pageerror", (error) => errors.push(error.stack ?? error.message));
    try {
      const result = await body(page);
      if (errors.length > 0) throw new Error(`${what}: page threw: ${errors.join(" | ")}`);
      return result;
    } catch (error) {
      if (crashed && attempt === 1) {
        console.warn(`[dock-cues-shots] renderer crashed on ${what}; retrying once`);
        continue;
      }
      throw new Error(`${what}: ${String(error)}`, { cause: error });
    } finally {
      await page.close().catch(() => undefined);
    }
  }
}

async function load(page: Page, theme: string): Promise<Locator> {
  await page.setViewportSize({ width: WIDTH, height: 700 });
  await page.goto(
    `${server!.baseURL}/dock-preview.html?theme=${theme}&fixture=cues&width=${WIDTH}&density=normal`
  );
  await expect(page.locator("[data-preview-shell]").first()).toBeAttached({
    timeout: ATTACH_TIMEOUT_MS,
  });
  await page.evaluate(() => document.fonts.ready);
  const dock = page.locator(DOCK);
  await expect(dock).toBeVisible();
  await expect(page.locator('[data-dock-activity-state="working"]')).toBeVisible();
  await page.waitForTimeout(400);
  return dock;
}

type PanelPatch = Record<string, unknown>;

/** Patches one panel through the real store and returns the timeline time of the flip. */
async function patchPanel(page: Page, id: string, patch: PanelPatch): Promise<number> {
  return page.evaluate(
    ({ id, patch }) => {
      const { usePanelStore } = (
        window as unknown as {
          __dockPreview: {
            usePanelStore: {
              getState: () => { panelsById: Record<string, object> };
              setState: (s: object) => void;
            };
          };
        }
      ).__dockPreview;
      const t0 = Number(document.timeline.currentTime ?? 0);
      const { panelsById } = usePanelStore.getState();
      usePanelStore.setState({
        panelsById: { ...panelsById, [id]: { ...panelsById[id], ...patch } },
      });
      return t0;
    },
    { id, patch }
  );
}

/**
 * Waits briefly for the animations started at or after `t0`, pauses them all
 * and seeks each to `ms` of its own local time. Returns how many it froze —
 * zero is a legitimate answer for a surface that does not animate.
 */
async function freezeAt(page: Page, t0: number, ms: number): Promise<number> {
  return page.evaluate(
    async ({ t0, ms }) => {
      const started = (): Animation[] =>
        document.getAnimations().filter((a) => {
          const timing = a.effect?.getComputedTiming();
          if (!timing || timing.iterations === Infinity) return false;
          return a.startTime === null || Number(a.startTime) >= t0 - 1;
        });
      const deadline = performance.now() + 250;
      let picked: Animation[] = [];
      let lastCount = -1;
      for (;;) {
        await new Promise((r) => requestAnimationFrame(() => r(null)));
        picked = started();
        if (picked.length > 0 && picked.length === lastCount) break;
        lastCount = picked.length;
        if (performance.now() > deadline) break;
      }
      for (const a of picked) {
        a.pause();
        a.currentTime = ms;
      }
      return picked.length;
    },
    { t0, ms }
  );
}

/** The finished check's computed opacity and scale — the numbers behind a 14px glyph. */
async function checkStyle(page: Page) {
  return page.evaluate(() => {
    const svg = document.querySelector('[data-dock-activity-state="finished"] svg');
    if (!svg) return null;
    const style = getComputedStyle(svg);
    return { opacity: style.opacity, scale: style.scale };
  });
}

async function railMetrics(page: Page) {
  return page.locator(RAIL).evaluate((el) => ({
    scrollLeft: Math.round(el.scrollLeft),
    max: el.scrollWidth - el.clientWidth,
  }));
}

async function scrollRailTo(page: Page, left: number) {
  await page.locator(RAIL).evaluate((el, left) => {
    el.scrollTo({ left, behavior: "instant" });
  }, left);
  await page.waitForTimeout(300);
}

test("content dock — cues and rail scrolling, mid-flight", async ({ context }) => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_DOCK_CUES is required for the dock cue capture",
  });
  test.skip(!ENABLED, "set DAINTREE_SHOT_DOCK_CUES=1 to run the capture");
  test.setTimeout(300_000);

  await settleDevServer(context);
  const written: string[] = [];
  const log: Record<string, unknown> = {};

  for (const theme of THEMES) {
    written.push(
      await withPage(context, `working ${theme}`, async (page) =>
        snap(await load(page, theme), `working-${theme}.png`)
      )
    );
    written.push(
      await withPage(context, `finished ${theme}`, async (page) => {
        const dock = await load(page, theme);
        await patchPanel(page, "c-build", { activityStatus: "success" });
        await expect(page.locator('[data-dock-activity-state="finished"]')).toBeVisible();
        await page.waitForTimeout(350);
        return snap(dock, `finished-${theme}.png`);
      })
    );
    written.push(
      await withPage(context, `rail mid ${theme}`, async (page) => {
        const dock = await load(page, theme);
        const { max } = await railMetrics(page);
        expect(max, "the cues fixture must overflow the rail").toBeGreaterThan(40);
        await scrollRailTo(page, Math.round(max / 2));
        return snap(dock, `rail-mid-${theme}.png`);
      })
    );
  }

  const theme = THEMES[0]!;

  for (const ms of [20, 50, 940]) {
    const name = ms > 500 ? `finished-exit-${ms}ms.png` : `finished-enter-${ms}ms.png`;
    written.push(
      await withPage(context, name, async (page) => {
        const dock = await load(page, theme);
        const t0 = await patchPanel(page, "c-build", { activityStatus: "success" });
        log[name] = { frozen: await freezeAt(page, t0, ms), check: await checkStyle(page) };
        await expect(page.locator('[data-dock-activity-state="finished"]')).toBeAttached();
        return snap(dock, name);
      })
    );
  }

  written.push(
    await withPage(context, "finished reduced", async (page) => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      const dock = await load(page, theme);
      const t0 = await patchPanel(page, "c-build", { activityStatus: "success" });
      log["finished-enter-reduced.png"] = {
        frozen: await freezeAt(page, t0, 20),
        check: await checkStyle(page),
      };
      await expect(page.locator('[data-dock-activity-state="finished"]')).toBeAttached();
      return snap(dock, "finished-enter-reduced.png");
    })
  );

  written.push(
    await withPage(context, "state colour", async (page) => {
      const dock = await load(page, theme);
      const t0 = await patchPanel(page, "c-agent", {
        agentState: "waiting",
        waitingReason: "prompt",
      });
      log["state-colour-75ms.png"] = { frozen: await freezeAt(page, t0, 75) };
      return snap(dock, "state-colour-75ms.png");
    })
  );

  written.push(
    await withPage(context, "rail start", async (page) =>
      snap(await load(page, theme), "rail-start.png")
    )
  );

  await withPage(context, "rail end", async (page) => {
    const dock = await load(page, theme);
    const { max } = await railMetrics(page);
    await scrollRailTo(page, Math.max(0, max - 30));
    const chevron = page.getByRole("button", { name: "Scroll right", includeHidden: true });
    await chevron.hover();
    await page.waitForTimeout(200);
    const t0 = await page.evaluate(() => Number(document.timeline.currentTime ?? 0));
    await page.locator(RAIL).evaluate((el) => {
      el.scrollTo({ left: el.scrollWidth, behavior: "instant" });
    });
    log["rail-end-fading.png"] = { frozen: await freezeAt(page, t0, 75) };
    written.push(await snap(dock, "rail-end-fading.png"));
    await page.evaluate(() => {
      for (const a of document.getAnimations()) if (a.playState === "paused") a.play();
    });
    await page.waitForTimeout(600);
    written.push(await snap(dock, "rail-end.png"));
  });

  written.push(
    await withPage(context, "rail wheel", async (page) => {
      const dock = await load(page, theme);
      const before = await railMetrics(page);
      const box = await page.locator(RAIL).boundingBox();
      await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
      await page.mouse.wheel(0, 100);
      await page.waitForTimeout(500);
      const after = await railMetrics(page);
      log["rail-wheel.png"] = { before, after };
      return snap(dock, "rail-wheel.png");
    })
  );

  writeFileSync(path.join(OUT_DIR, "scroll-log.json"), JSON.stringify(log, null, 2));

  const onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
  expect(onDisk.length).toBe(written.length);
  expect(onDisk.length).toBe(THEMES.length * 3 + 9);
  console.log(`[dock-cues-shots] ${onDisk.length} PNGs in ${OUT_DIR}`);
});
