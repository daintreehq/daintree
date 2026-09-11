/**
 * Copy-context toolbar dropdown visual-review harness.
 *
 * Boots a fixture repo, stubs the per-project copy-tree history handler, then
 * drives the toolbar's copy-context button and writes PNGs of every state the
 * panel has — skeleton, empty, the two-recent shape a fresh project actually
 * has, a full five-row list with names long enough to truncate, hover, and
 * keyboard focus — so design work on the panel can be judged against real
 * rendered pixels rather than the JSX.
 *
 * History is re-seeded between shots through the `copy-tree-history:update`
 * push rather than the invoke handler: the renderer store pulls its snapshot
 * once per session behind a module-level guard, so a second open would
 * otherwise render whatever the first pull returned.
 *
 * Opt-in only — skips itself unless DAINTREE_SHOT_COPYTREE is set, so the
 * marketing screenshots workflow never runs it.
 *
 *   DAINTREE_SHOT_COPYTREE=1 npx playwright test --project=screenshots copy-tree-dropdown-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_COPYTREE  required — any truthy value
 *   DAINTREE_SHOT_TAG       optional suffix to keep rounds side by side
 *   DAINTREE_SHOT_THEME     optional theme id (default: the app default)
 *   DAINTREE_SHOT_THEMES    comma-separated theme ids to sweep in one session
 *   DAINTREE_SHOT_ONLY      comma-separated step filter
 *   DAINTREE_SHOT_DIR       output directory (default: artifacts/copytree-shots)
 *
 * Output: <dir>/<NN-slug>[-tag].png (gitignored).
 */

import { test, type Page, type Locator, type ElectronApplication } from "@playwright/test";
import { mkdirSync, readdirSync } from "fs";
import path from "path";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { createFixtureRepo } from "../helpers/fixtures";
import { openAndOnboardProject } from "../helpers/project";
import { dismissBlockingPalette } from "../helpers/overlays";
import { setAppTheme } from "../helpers/theme";
import { T_MEDIUM } from "../helpers/timeouts";
import type { CopyTreeHistoryRecord } from "../../shared/types";

const ENABLED = Boolean(process.env.DAINTREE_SHOT_COPYTREE);
const TAG = process.env.DAINTREE_SHOT_TAG ? `-${process.env.DAINTREE_SHOT_TAG}` : "";
const THEME = process.env.DAINTREE_SHOT_THEME ?? "";
const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "").split(",").filter(Boolean);
const SCALE = process.env.DAINTREE_SCREENSHOT_SCALE ?? "2";
const OUTPUT_DIR = path.resolve(
  process.env.DAINTREE_SHOT_DIR ?? path.join(process.cwd(), "artifacts", "copytree-shots")
);

const POLISH_CSS = `
  *, *::before, *::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
    caret-color: transparent !important;
  }
`;

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/**
 * Records are shaped exactly as Main stamps them. `lastUsedAt` is relative to
 * capture time so the rendered relative timestamps read the way they do in a
 * live session ("2 hours ago"), not as a frozen date.
 */
function record(
  id: string,
  name: string,
  fileCount: number,
  totalSize: number,
  agoMs: number,
  options: CopyTreeHistoryRecord["options"] = {}
): CopyTreeHistoryRecord {
  const lastUsedAt = Date.now() - agoMs;
  return {
    id,
    dedupeKey: `key-${id}`,
    name,
    options,
    source: "toolbar",
    worktreeId: "wt-main",
    stats: { fileCount, totalSize, duration: 1200 },
    createdAt: lastUsedAt - 7 * DAY,
    lastUsedAt,
    runCount: 3,
  };
}

/**
 * The shape a fresh project actually has, and the one the panel was reported
 * as looking wrong in: a full-context run sitting directly under the panel's
 * own "Copy full context" action, plus one scoped run.
 */
const TWO_RECENTS: CopyTreeHistoryRecord[] = [
  record("r1", "Full context", 3970, 39 * 1024 * 1024, 2_000),
  record("r2", "src", 1478, 13.3 * 1024 * 1024, 11 * DAY, { scopePaths: ["src"] }),
];

/**
 * Six records for five rows: enough real runs to hit the cap, with the
 * full-context record still in front of them so the filter is exercised at the
 * same time as the cap. If the two ever fight, this fixture renders four rows
 * and the count assertion says so.
 */
const FULL_RECENTS: CopyTreeHistoryRecord[] = [
  record("f0", "Full context", 3970, 39 * 1024 * 1024, 45_000),
  record("f1", "src/components/Layout", 212, 840 * 1024, 20 * MIN, {
    scopePaths: ["src/components/Layout"],
  }),
  record("f2", "Changed files only", 17, 96 * 1024, 3 * HOUR, { modified: true }),
  record(
    "f3",
    "electron/services/mcp-server + shared/types/ipc as markdown",
    64,
    1.2 * 1024 * 1024,
    2 * DAY,
    { format: "markdown", scopePaths: ["electron/services/mcp-server", "shared/types/ipc"] }
  ),
  record("f4", "*.test.ts", 486, 4.1 * 1024 * 1024, 11 * DAY, { filter: ["**/*.test.ts"] }),
  record("f5", "docs", 88, 410 * 1024, 26 * DAY, { scopePaths: ["docs"] }),
];

/*
 * How many rows each fixture actually renders.
 *
 * The panel drops runs whose options match its own pinned action, so the
 * full-context record at the head of both fixtures is expected NOT to appear.
 * It stays in the fixture on purpose: it is the shape the panel was reported
 * wrong in, and its absence from the list below the button is the fix.
 */
const TWO_RECENTS_ROWS = 1;
const FULL_RECENTS_ROWS = 5;

/**
 * Re-seed the renderer's history mirror. The store's own snapshot pull is
 * guarded to once per session, so every state after the first arrives on the
 * push channel — which is also the real path an MCP or context-menu copy takes
 * while the dropdown is closed.
 *
 * Typed events are multiplexed: `window.electron.events.on(name)` subscribes
 * through one `events:push` ipcRenderer listener that dispatches on the
 * envelope's `name`, so sending on the bare event name reaches nobody. This
 * mirrors `pushCopyTreeHistory` in `electron/services/copyTreeHistoryService.ts`
 * exactly, minus its project-to-webContents binding — the harness has no
 * registered project view to look up, so it fans out to every live view.
 */
async function pushHistory(
  app: ElectronApplication,
  records: CopyTreeHistoryRecord[]
): Promise<void> {
  await app.evaluate(
    ({ webContents }, { envelope }) => {
      for (const wc of webContents.getAllWebContents()) {
        if (wc.isDestroyed()) continue;
        try {
          wc.send("events:push", envelope);
        } catch {
          // Ignore sends to a view mid-teardown.
        }
      }
    },
    {
      envelope: {
        name: "copy-tree-history:update",
        payload: { projectId: "fixture", records },
      },
    }
  );
}

/**
 * Point the snapshot pull at a fixture. `delayMs` holds the first pull open long
 * enough for the panel to render its skeleton; resolving late rather than never
 * keeps the store's `loading` flag honest for every later state.
 */
async function stubHistoryPull(
  app: ElectronApplication,
  records: CopyTreeHistoryRecord[],
  delayMs = 0
): Promise<void> {
  await app.evaluate(
    ({ ipcMain }, { records, delayMs }) => {
      ipcMain.removeHandler("copy-tree-history:get-records");
      ipcMain.handle(
        "copy-tree-history:get-records",
        () => new Promise((resolve) => setTimeout(() => resolve(records), delayMs))
      );
    },
    { records, delayMs }
  );
}

/**
 * Put a fixture in front of the panel by both routes at once.
 *
 * The push alone is enough while the project view stays mounted, but applying a
 * theme tears the view down and the remounted store pulls a fresh snapshot from
 * the handler — so the handler has to agree with the last push, or every shot
 * after the first theme switch renders an empty list.
 */
async function seedHistory(
  app: ElectronApplication,
  records: CopyTreeHistoryRecord[]
): Promise<void> {
  await stubHistoryPull(app, records);
  await pushHistory(app, records);
}

async function settle(page: Page, ms = 600): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
  );
  await page.waitForTimeout(ms);
}

async function snap(page: Page, slug: string, locator?: Locator): Promise<void> {
  await settle(page);
  const file = path.join(OUTPUT_DIR, `${slug}${TAG}.png`);
  if (locator) {
    await locator.first().screenshot({ path: file, type: "png" });
  } else {
    await page.screenshot({ path: file, type: "png", animations: "disabled", caret: "hide" });
  }
}

const ONLY = (process.env.DAINTREE_SHOT_ONLY ?? "").split(",").filter(Boolean);
/* A step failure must not abort the remaining captures, but it must not pass
   silently either — a run where every step blew up would otherwise report PASS
   and write no PNGs. Failures are collected and rethrown at the end, and the
   output directory is counted on the way out. */
const stepFailures: string[] = [];
async function step(name: string, fn: () => Promise<void>): Promise<void> {
  if (ONLY.length > 0 && !ONLY.includes(name)) return;
  try {
    await fn();
  } catch (error) {
    stepFailures.push(`${name}: ${String(error).slice(0, 300)}`);
    console.warn(`[copytree-shots] step "${name}" skipped:`, String(error).slice(0, 300));
  }
}

const PANEL = "[data-copy-tree-panel]";
const TRIGGER = 'button[aria-label="Copy context"]';

function panel(page: Page): Locator {
  return page.locator(PANEL);
}

async function openPanel(page: Page): Promise<void> {
  const trigger = page.locator(TRIGGER);
  await trigger.waitFor({ state: "visible", timeout: T_MEDIUM });
  await trigger.click();
  await page.locator(PANEL).waitFor({ state: "visible", timeout: T_MEDIUM });
}

/**
 * Prove the seeded state actually rendered before anything is written to disk.
 * The push is fire-and-forget across every live view, so a silently-dropped
 * envelope would otherwise produce a plausible-looking PNG of the previous
 * state under the new state's filename — the exact wrong artifact this harness
 * must never report as a pass.
 */
async function expectRows(page: Page, expected: number): Promise<void> {
  const rows = page.locator(`${PANEL} [data-copy-tree-recent]`);
  await page
    .waitForFunction(
      ({ panel, expected }) =>
        document.querySelectorAll(`${panel} [data-copy-tree-recent]`).length === expected,
      { panel: PANEL, expected },
      { timeout: T_MEDIUM }
    )
    .catch(async () => {
      throw new Error(
        `[copytree-shots] expected ${expected} recent row(s), rendered ${await rows.count()} — ` +
          `the history push did not reach the renderer store`
      );
    });
}

async function closePanel(page: Page): Promise<void> {
  await page.keyboard.press("Escape").catch(() => {});
  await page
    .locator(PANEL)
    .waitFor({ state: "detached", timeout: T_MEDIUM })
    .catch(() => {});
  await settle(page, 300);
}

test("copy-tree dropdown review — recents panel states", async () => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_COPYTREE is required for the copy-tree dropdown capture",
  });
  test.skip(!ENABLED, "Set DAINTREE_SHOT_COPYTREE to run the copy-tree dropdown capture");

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const repo = createFixtureRepo({ name: "copytree-shots" });
  let ctx: AppContext | undefined;
  try {
    /* No explicit `userDataDir`: `launchApp` skips its window-sizing pass
       whenever one is supplied (it preserves persisted window state for the
       restart specs), and the default 1200x800 window overflows the copy-context
       button out of the toolbar and into the "..." menu, where none of these
       steps can reach it. Letting the helper own the profile also lets it size
       the window up and clean the directory up. */
    ctx = await launchApp({
      screenshotScale: SCALE,
      env: { DAINTREE_E2E_FAULT_MODE: "1" },
      extraArgs: ["--disable-gpu", "--in-process-gpu", "--disable-breakpad", "--noerrdialogs"],
    });

    // Armed before the project view mounts: the panel is lazy, but the store's
    // snapshot pull fires on its first mount and there is only ever one.
    await stubHistoryPull(ctx.app, [], 4_000);

    const page = await openAndOnboardProject(ctx.app, ctx.window, repo.dir, "Daintree");
    if (THEME) await setAppTheme(page, THEME);
    await page.addStyleTag({ content: POLISH_CSS }).catch(() => {});
    await dismissBlockingPalette(page);
    await settle(page, 1200);
    await dismissBlockingPalette(page);

    /* Fail loudly and specifically if the trigger is not on the toolbar. The
       button overflows into the "..." menu on a narrow window, and every step
       below would otherwise time out identically with nothing naming the cause. */
    await page
      .locator(TRIGGER)
      .waitFor({ state: "visible", timeout: T_MEDIUM })
      .catch(() => {
        throw new Error(
          `[copytree-shots] the copy-context trigger (${TRIGGER}) is not visible on the toolbar — ` +
            `the window is probably too narrow and the button has overflowed into the "..." menu`
        );
      });

    // Skeleton first and once: the pull resolves four seconds in and the store
    // never asks again, so this is the only window in which `loading` is true.
    await step("loading", async () => {
      await openPanel(page);
      await settle(page, 900);
      await snap(page, "10-loading-skeleton", panel(page));
      await closePanel(page);
    });

    await step("empty", async () => {
      await seedHistory(ctx!.app, []);
      await openPanel(page);
      await settle(page, 700);
      await snap(page, "20-empty", panel(page));
      await closePanel(page);
    });

    await step("two-recents", async () => {
      await seedHistory(ctx!.app, TWO_RECENTS);
      await openPanel(page);
      await expectRows(page, TWO_RECENTS_ROWS);
      await settle(page, 700);
      await snap(page, "30-two-recents", panel(page));
      await snap(page, "31-two-recents-in-context");
      await closePanel(page);
    });

    await step("full", async () => {
      await seedHistory(ctx!.app, FULL_RECENTS);
      await openPanel(page);
      await expectRows(page, FULL_RECENTS_ROWS);
      await settle(page, 700);
      await snap(page, "40-full-list", panel(page));
      await snap(page, "41-full-list-in-context");
      await closePanel(page);
    });

    // Focus lands on the primary action when the panel opens; the ring is the
    // region's only emphasis signal, so it gets its own shot.
    await step("focus", async () => {
      // Self-seeding, like every step: DAINTREE_SHOT_ONLY must be able to run
      // any one of these alone.
      await seedHistory(ctx!.app, FULL_RECENTS);
      await openPanel(page);
      await expectRows(page, FULL_RECENTS_ROWS);
      await settle(page, 500);
      await snap(page, "50-open-focus", panel(page));
      // A menu: the arrow keys walk the highlight; Tab would leave it. Two
      // presses — the first lands on the pinned entry, the second on the
      // first recent.
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("ArrowDown");
      await settle(page, 400);
      await snap(page, "51-focus-first-row", panel(page));
      await closePanel(page);
    });

    await step("hover", async () => {
      await seedHistory(ctx!.app, FULL_RECENTS);
      await openPanel(page);
      await expectRows(page, FULL_RECENTS_ROWS);
      await settle(page, 500);
      const row = page.locator(`${PANEL} [data-copy-tree-recent]`).first();
      const resting = await row.evaluate((el) => getComputedStyle(el).backgroundColor);
      await row.hover();
      await settle(page, 400);
      const hovered = await row.evaluate((el) => getComputedStyle(el).backgroundColor);
      /* Read the computed style rather than trusting the PNG. An element
         screenshot re-lays-out the page and can drop the pointer state before
         the pixels are written, so a screenshot alone cannot distinguish "this
         row has no hover treatment" from "the capture lost the hover". */
      console.log(`[copytree-shots] row hover background: ${resting} -> ${hovered}`);
      if (resting === hovered) {
        throw new Error(
          `[copytree-shots] hovering a recent row did not change its background (${resting}) — ` +
            `the rows have no rendered pointer affordance`
        );
      }
      /* A clipped page screenshot, NOT `locator.screenshot()`. The element
         path re-lays-out the node before capturing and the pointer state does
         not survive it, so every hover shot this harness took came out
         byte-identical to the resting one — which read as "these rows have no
         hover treatment" to two separate reviewers, while the computed style
         above proves the fill is applied. Clipping the page leaves the hovered
         element untouched. */
      await settle(page);
      const box = await panel(page).boundingBox();
      if (!box) throw new Error("[copytree-shots] the panel has no bounding box to clip to");
      await page.screenshot({
        path: path.join(OUTPUT_DIR, `60-row-hover${TAG}.png`),
        clip: box,
        type: "png",
        caret: "hide",
      });
      await closePanel(page);
    });

    await step("themes", async () => {
      for (const themeId of THEMES) {
        await setAppTheme(page, themeId);
        await page.addStyleTag({ content: POLISH_CSS }).catch(() => {});
        await settle(page, 800);
        // Re-seed after every switch: applying a theme remounts the project
        // view, which takes the renderer's history mirror down with it and
        // sends the remounted store back to the pull handler.
        await seedHistory(ctx!.app, FULL_RECENTS);
        await openPanel(page);
        await expectRows(page, FULL_RECENTS_ROWS);
        await settle(page, 800);
        await snap(page, `70-theme-${themeId}-full`, panel(page));
        await closePanel(page);
      }
    });
  } finally {
    if (ctx) await closeApp(ctx.app);
    repo.cleanup();
  }

  /* Never trust the exit code: count what actually landed. A session that
     launched, navigated and closed cleanly while writing nothing is the exact
     failure this harness must not report as a pass. */
  const written = readdirSync(OUTPUT_DIR).filter(
    (f) => f.endsWith(".png") && (TAG === "" || f.includes(TAG))
  );
  if (written.length === 0) {
    throw new Error(`[copytree-shots] no PNGs written to ${OUTPUT_DIR}`);
  }
  console.log(`[copytree-shots] wrote ${written.length} PNG(s) to ${OUTPUT_DIR}`);

  if (stepFailures.length > 0) {
    throw new Error(
      `[copytree-shots] ${stepFailures.length} step(s) failed:\n${stepFailures.join("\n")}`
    );
  }
});
