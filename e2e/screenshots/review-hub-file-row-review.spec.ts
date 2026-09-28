/**
 * Review Hub `FileStageRow` visual-review harness.
 *
 * The row's own states rather than the section around it: rest, row hover, the
 * stage/unstage control hovered and keyboard-focused, a file marked Viewed, and the
 * Viewed dim caught halfway through its transition. The mid-transition frames are the
 * only evidence of whether the dim eases or snaps, so they run with real transition
 * durations and freeze the row's running transitions at a fixed point instead of
 * zeroing them like the other shots.
 *
 * Opt-in only: skips itself unless DAINTREE_SHOT_FILEROW is set.
 *
 *   DAINTREE_SHOT_FILEROW=1 npx playwright test --project=screenshots review-hub-file-row
 *
 * Env knobs:
 *   DAINTREE_SHOT_FILEROW   required — any truthy value runs the capture
 *   DAINTREE_SHOT_THEMES    comma-separated theme ids (default: daintree,bondi)
 *   DAINTREE_SHOT_OUT       optional absolute output dir (default: artifacts/filerow-shots)
 *
 * Output: <out>/<theme>-<NN-slug>.png plus transitions.json, which records the CSS
 * transitions running on the row at each mid-transition frame.
 */

import { test, type Page } from "@playwright/test";
import { execSync } from "child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { openAndOnboardProject } from "../helpers/project";
import { dismissBlockingPalette } from "../helpers/overlays";
import { setAppTheme } from "../helpers/theme";
import { SEL } from "../helpers/selectors";
import { T_LONG, T_MEDIUM } from "../helpers/timeouts";

const ENABLED = !!process.env.DAINTREE_SHOT_FILEROW;
const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi").split(",").filter(Boolean);
const SCALE = process.env.DAINTREE_SCREENSHOT_SCALE ?? "2";
const OUTPUT_DIR =
  process.env.DAINTREE_SHOT_OUT ?? path.resolve(process.cwd(), "artifacts", "filerow-shots");

const FILE_LIST = '[role="listbox"][aria-label="Changed files"]';
const UNSTAGED_PATH = "src/renderer/store/worktreeTopologyStore.ts";
const STAGED_PATH = "src/renderer/orchestration/useOrchestrationScheduler.ts";
const MID_TRANSITION_MS = 75;

// Zeroes every duration except while a mid-transition step removes this tag.
const FREEZE_ID = "filerow-freeze";
const FREEZE_CSS = `
  ::-webkit-scrollbar { display: none !important; width: 0 !important; height: 0 !important; }
  *, *::before, *::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
    caret-color: transparent !important;
  }
`;

function git(cmd: string, cwd: string): void {
  execSync(`git ${cmd}`, { cwd, stdio: "ignore" });
}

function lines(prefix: string, n: number): string {
  return Array.from({ length: n }, (_, i) => `${prefix} line ${i + 1};`).join("\n") + "\n";
}

function createFixtureRepo(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "daintree-filerow-shots-"));
  const wtRoot = path.join(path.dirname(dir), path.basename(dir) + "-worktrees");
  mkdirSync(wtRoot, { recursive: true });
  git("init -b main", dir);
  git('config user.email "test@daintree.dev"', dir);
  git('config user.name "Daintree Test"', dir);
  const write = (rel: string, body: string): void => {
    const abs = path.join(dir, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  };

  write("README.md", "# Helios Dashboard\n");
  write("src/renderer/orchestration/OrchestrationPreferencesPanel.tsx", lines("panel", 220));
  write(STAGED_PATH, lines("sched", 140));
  write("docs/architecture/notification-system.md", lines("- doc", 120));
  write("src/main/services/workspace/reconciliationTelemetry.ts", lines("telem", 90));
  write("src/renderer/hooks/useDeferredWorkspaceSnapshot.ts", lines("snap", 110));
  write(UNSTAGED_PATH, lines("topo", 200));
  write("src/renderer/components/CommandPalette/commandPaletteScoring.ts", lines("score", 130));
  git("add -A", dir);
  git('commit -m "initial commit"', dir);
  git("checkout -b feature/orchestration-preferences", dir);

  write("src/renderer/orchestration/OrchestrationPreferencesPanel.tsx", lines("panel-v2", 640));
  write(STAGED_PATH, lines("sched-v2", 310));
  write("docs/architecture/notification-system.md", lines("- doc v2", 260));
  git("add -A", dir);

  write("src/main/services/workspace/reconciliationTelemetry.ts", lines("telem-v2", 210));
  write("src/renderer/hooks/useDeferredWorkspaceSnapshot.ts", lines("snap-v2", 190));
  write(UNSTAGED_PATH, lines("topo-v2", 430));
  write("src/renderer/components/CommandPalette/commandPaletteScoring.ts", lines("score-v2", 250));
  write("src/renderer/store/__generated__/topologySelectors.generated.ts", lines("sel", 260));

  return {
    dir,
    cleanup: () => {
      if (existsSync(wtRoot)) rmSync(wtRoot, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function settle(page: Page, ms = 300): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
  );
  await page.waitForTimeout(ms);
}

const rowSel = (p: string) => `[data-testid="file-stage-row-${p}"]`;
const viewedSel = (p: string) => `[aria-label="Mark ${p} as viewed"]`;

const written: string[] = [];
const transitionLog: Record<string, unknown> = {};

/** The target row with its neighbours above and below, so hover and dim read in context. */
async function snapRow(page: Page, file: string, filePath: string): Promise<void> {
  const box = await page.locator(rowSel(filePath)).first().boundingBox();
  if (!box) throw new Error(`row ${filePath} has no box`);
  const out = path.join(OUTPUT_DIR, file);
  // Shot unclipped, then cropped: a clipped capture re-emulates the viewport,
  // which drops the pointer's :hover and made every hover frame read as rest.
  await page.screenshot({ path: out, type: "png", caret: "hide" });
  const scale = Number(SCALE);
  const x = Math.round(Math.max(0, box.x - 12) * scale);
  const y = Math.round(Math.max(0, box.y - box.height * 1.5) * scale);
  const w = Math.round((box.width + 24) * scale);
  const h = Math.round(box.height * 4 * scale);
  execSync(`sips -c ${h} ${w} --cropOffset ${y} ${x} "${out}" --out "${out}"`, { stdio: "ignore" });
  written.push(file);
}

async function setFreeze(page: Page, on: boolean): Promise<void> {
  await page.evaluate(
    ({ id, css, on }) => {
      document.getElementById(id)?.remove();
      if (!on) return;
      const tag = document.createElement("style");
      tag.id = id;
      tag.textContent = css;
      document.head.appendChild(tag);
    },
    { id: FREEZE_ID, css: FREEZE_CSS, on }
  );
}

async function setViewed(page: Page, filePath: string, viewed: boolean): Promise<void> {
  const box = page.locator(viewedSel(filePath)).first();
  const checked = (await box.getAttribute("aria-checked")) === "true";
  if (checked !== viewed) await box.click();
}

/**
 * Toggle Viewed with real transition durations, then freeze every CSS transition
 * running inside the row at MID_TRANSITION_MS. A dim that snaps has no transition to
 * freeze, and the frame shows the end state — which is the evidence.
 */
async function snapMidTransition(
  page: Page,
  file: string,
  filePath: string,
  viewed: boolean
): Promise<void> {
  await page.mouse.move(5, 5);
  await settle(page, 200);
  await setFreeze(page, false);
  await settle(page, 50);
  await page.locator(viewedSel(filePath)).first().click();
  const running = await page.evaluate(
    ({ sel, at }) =>
      new Promise<Array<{ property: string; duration: number; easing: string; target: string }>>(
        (resolve) => {
          requestAnimationFrame(() => {
            const row = document.querySelector(sel);
            const found: Array<{
              property: string;
              duration: number;
              easing: string;
              target: string;
            }> = [];
            for (const anim of row?.getAnimations({ subtree: true }) ?? []) {
              if (!(anim instanceof CSSTransition)) continue;
              anim.pause();
              anim.currentTime = at;
              const timing = anim.effect?.getTiming();
              const el = (anim.effect as KeyframeEffect | null)?.target as Element | null;
              found.push({
                property: anim.transitionProperty,
                duration: Number(timing?.duration ?? 0),
                easing: String(timing?.easing ?? ""),
                target: el?.getAttribute("data-testid") ?? el?.tagName.toLowerCase() ?? "?",
              });
            }
            resolve(found);
          });
        }
      ),
    { sel: rowSel(filePath), at: MID_TRANSITION_MS }
  );
  transitionLog[file] = running;
  await snapRow(page, file, filePath);
  await setFreeze(page, true);
  await settle(page, 100);
  const state = await page.locator(viewedSel(filePath)).first().getAttribute("aria-checked");
  if ((state === "true") !== viewed) throw new Error(`${file}: viewed did not become ${viewed}`);
}

async function openHub(page: Page): Promise<void> {
  await dismissBlockingPalette(page);
  const hub = page.locator(SEL.reviewHub.container);
  if (!(await hub.isVisible().catch(() => false))) {
    const btn = page.locator(SEL.worktree.reviewHubButton).first();
    await btn.waitFor({ state: "visible", timeout: T_LONG });
    await btn.click();
    await hub.waitFor({ state: "visible", timeout: T_MEDIUM });
  }
  const toggle = hub.locator(SEL.reviewHub.fileListToggle);
  await toggle.waitFor({ state: "visible", timeout: T_MEDIUM });
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  await page.locator(FILE_LIST).waitFor({ state: "visible", timeout: T_MEDIUM });
  await page.locator(rowSel(UNSTAGED_PATH)).first().waitFor({ state: "visible" });
  await settle(page, 600);
}

test("review hub file row review — viewed dim and stage control", async () => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_FILEROW is required for the file-row capture",
  });
  test.skip(!ENABLED, "Set DAINTREE_SHOT_FILEROW to run the file-row capture");

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const repo = createFixtureRepo();
  const userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-filerowshot-"));
  let ctx: AppContext | undefined;

  try {
    ctx = await launchApp({
      userDataDir,
      screenshotScale: SCALE,
      windowSize: { width: 1400, height: 900 },
      extraArgs: ["--disable-gpu", "--in-process-gpu", "--disable-breakpad", "--noerrdialogs"],
    });
    const page = await openAndOnboardProject(ctx.app, ctx.window, repo.dir, "Helios Dashboard");
    await page
      .locator(SEL.worktree.mainCard)
      .waitFor({ state: "visible", timeout: T_LONG })
      .catch(() => {});
    await settle(page, 1500);

    for (const theme of THEMES) {
      await setAppTheme(page, theme);
      await settle(page, 800);
      await openHub(page);
      await setFreeze(page, true);
      await page.evaluate(() => {
        delete document.body.dataset.reduceAnimations;
      });
      await page.emulateMedia({ reducedMotion: "no-preference" });
      await setViewed(page, UNSTAGED_PATH, false);
      await page.mouse.move(5, 5);
      await settle(page);

      const shot = (slug: string) => `${theme}-${slug}.png`;

      await snapRow(page, shot("10-rest"), UNSTAGED_PATH);

      await page
        .locator(rowSel(UNSTAGED_PATH))
        .first()
        .hover({ position: { x: 40, y: 8 } });
      await settle(page);
      await snapRow(page, shot("11-row-hover"), UNSTAGED_PATH);

      await page.locator(SEL.reviewHub.stageButton(UNSTAGED_PATH)).first().hover();
      await settle(page, 700);
      transitionLog[shot("12-stage-button-hover")] = await page
        .locator(SEL.reviewHub.stageButton(UNSTAGED_PATH))
        .first()
        .evaluate((el) => ({
          hovered: el.matches(":hover"),
          color: getComputedStyle(el).color,
          background: getComputedStyle(el).backgroundColor,
          glyph: getComputedStyle(el.querySelector("svg")!).color,
        }));
      await snapRow(page, shot("12-stage-button-hover"), UNSTAGED_PATH);

      await page.locator(SEL.reviewHub.unstageButton(STAGED_PATH)).first().hover();
      await settle(page, 700);
      await snapRow(page, shot("13-unstage-button-hover"), STAGED_PATH);

      await page.mouse.move(5, 5);
      await page.keyboard.press("Shift");
      await page.locator(SEL.reviewHub.stageButton(UNSTAGED_PATH)).first().focus();
      await settle(page);
      await snapRow(page, shot("14-stage-button-focus"), UNSTAGED_PATH);
      await page.locator(FILE_LIST).focus();

      await snapMidTransition(page, shot("20-viewed-dimming-mid"), UNSTAGED_PATH, true);
      await page.mouse.move(5, 5);
      await settle(page);
      await snapRow(page, shot("21-viewed"), UNSTAGED_PATH);

      await page
        .locator(rowSel(UNSTAGED_PATH))
        .first()
        .hover({ position: { x: 40, y: 8 } });
      await settle(page);
      await snapRow(page, shot("22-viewed-row-hover"), UNSTAGED_PATH);

      await snapMidTransition(page, shot("23-unviewed-restoring-mid"), UNSTAGED_PATH, false);

      // Reduced motion, via the in-app flag and the OS query at once.
      await page.evaluate(() => {
        document.body.dataset.reduceAnimations = "true";
      });
      await page.emulateMedia({ reducedMotion: "reduce" });
      await snapMidTransition(page, shot("30-reduced-viewed-mid"), UNSTAGED_PATH, true);
      await setViewed(page, UNSTAGED_PATH, false);
      await page.evaluate(() => {
        delete document.body.dataset.reduceAnimations;
      });
      await page.emulateMedia({ reducedMotion: "no-preference" });
      await settle(page);
    }
  } finally {
    if (ctx?.app) await closeApp(ctx.app).catch(() => {});
    try {
      repo.cleanup();
    } catch {
      /* best effort */
    }
    try {
      rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }

  writeFileSync(
    path.join(OUTPUT_DIR, "transitions.json"),
    JSON.stringify(transitionLog, null, 2) + "\n"
  );
  const onDisk = readdirSync(OUTPUT_DIR).filter((f) => f.endsWith(".png"));
  console.log(`[filerow-shots] wrote ${written.length} shot(s), ${onDisk.length} on disk`);
  if (written.length !== THEMES.length * 10) {
    throw new Error(
      `[filerow-shots] expected ${THEMES.length * 10} shots, wrote ${written.length}`
    );
  }
  const missing = written.filter((f) => !onDisk.includes(f));
  if (missing.length > 0) throw new Error(`[filerow-shots] missing on disk: ${missing.join(", ")}`);
});
