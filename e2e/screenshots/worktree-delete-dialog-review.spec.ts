/**
 * Worktree-delete dialog visual-review harness (#11977).
 *
 * `WorktreeDeleteDialog` is the app's highest-consequence local surface: it
 * spans D2 and D3, its content is computed from live git status, and three
 * checkboxes rewrite what the delete will actually do. None of that is
 * reviewable from the JSX — the states that carry the design weight only exist
 * once a real worktree is dirty, a real terminal is attached, or the fresh
 * status fetch has actually failed. So the fixture builds four worktrees with
 * genuinely different git states and drives the real dialog through the real
 * actions menu.
 *
 * Opt-in only, like the other review specs: skips itself unless
 * DAINTREE_SHOT_DELETE is set, so the marketing screenshots workflow never
 * executes it.
 *
 *   DAINTREE_SHOT_DELETE=1 npx playwright test --project=screenshots worktree-delete-dialog-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_DELETE  required — any truthy value runs the capture
 *   DAINTREE_SHOT_THEME   optional theme id (default: the app default)
 *   DAINTREE_SHOT_TAG     optional suffix so review rounds sit side by side
 *   DAINTREE_SHOT_ONLY    comma-separated step filter (see step names below)
 *   DAINTREE_SHOT_OUT     output directory override
 *
 * Cross-theme sweep: switching themes in place crashes the project view under
 * this harness (same failure `worktree-dialog-review` documents), so the sweep
 * boots once per theme:
 *
 *   for t in daintree bondi highlands; do
 *     DAINTREE_SHOT_DELETE=1 DAINTREE_SHOT_THEME=$t DAINTREE_SHOT_TAG=$t \
 *     DAINTREE_SHOT_ONLY=force-tracked npx playwright test \
 *     --project=screenshots worktree-delete-dialog-review
 *   done
 *
 * Output: artifacts/delete-dialog-shots/<NN-slug>[-tag].png (gitignored).
 */

import { test, expect, type Page } from "@playwright/test";
import { execSync } from "child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { openAndOnboardProject } from "../helpers/project";
import { dismissBlockingPalette } from "../helpers/overlays";
import { setAppTheme } from "../helpers/theme";
import { SEL } from "../helpers/selectors";
import { T_LONG } from "../helpers/timeouts";

const ENABLED = !!process.env.DAINTREE_SHOT_DELETE;
/** The testid sits on the backdrop; the dialog panel is its first child. */
const PANEL = `${SEL.worktree.deleteDialog} > div`;
const THEME = process.env.DAINTREE_SHOT_THEME ?? "";
const TAG = process.env.DAINTREE_SHOT_TAG ? `-${process.env.DAINTREE_SHOT_TAG}` : "";
const SCALE = process.env.DAINTREE_SCREENSHOT_SCALE ?? "2";
const OUTPUT_DIR =
  process.env.DAINTREE_SHOT_OUT ?? path.resolve(process.cwd(), "artifacts", "delete-dialog-shots");

const POLISH_CSS = `
  ::-webkit-scrollbar { display: none !important; width: 0 !important; height: 0 !important; }
  *, *::before, *::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
    caret-color: transparent !important;
  }
`;

/** Branches the fixture builds a worktree for, each with a distinct git state. */
const WT_CLEAN = "feature/streaming-uploads";
const WT_TRACKED = "fix/retry-backoff-jitter";
const WT_UNTRACKED = "chore/bump-electron";
const WT_LONG = "feature/observability-pipeline-opentelemetry-span-exporter-backpressure";

function git(cmd: string, cwd: string): void {
  execSync(`git ${cmd}`, { cwd, stdio: "ignore" });
}

/**
 * A repo with four worktrees whose git states cover the dialog's tiers:
 * clean (D2, nothing to lose), tracked-dirty (D3 once forced), untracked-only
 * (D2 even when forced — the #4927 split), and a long-identifier worktree that
 * stresses every truncation point at once.
 */
function createFixtureRepo(): { dir: string; wtRoot: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "daintree-delete-shots-"));
  const wtRoot = path.join(path.dirname(dir), path.basename(dir) + "-worktrees");
  mkdirSync(wtRoot, { recursive: true });

  git("init -b main", dir);
  git('config user.email "test@daintree.dev"', dir);
  git('config user.name "Daintree Test"', dir);
  mkdirSync(path.join(dir, "src"), { recursive: true });
  writeFileSync(path.join(dir, "README.md"), "# Helios Dashboard\n");
  writeFileSync(path.join(dir, "src", "index.ts"), "export const main = (): number => 0;\n");
  writeFileSync(path.join(dir, "src", "queue.ts"), "export const queue: string[] = [];\n");
  writeFileSync(path.join(dir, "src", "retry.ts"), "export const retries = 3;\n");
  git("add -A", dir);
  git('commit -m "initial commit"', dir);
  git("branch develop", dir);
  git("checkout develop", dir);

  for (const branch of [WT_CLEAN, WT_TRACKED, WT_UNTRACKED, WT_LONG]) {
    git(`branch ${branch}`, dir);
    const wtPath = path.join(wtRoot, branch.replace(/\//g, "-"));
    git(`worktree add ${JSON.stringify(wtPath)} ${branch}`, dir);
  }

  // Tracked changes: modified + deleted + a couple of untracked, so the file
  // list renders more than one status glyph and the counts split.
  const tracked = path.join(wtRoot, WT_TRACKED.replace(/\//g, "-"));
  writeFileSync(path.join(tracked, "src", "retry.ts"), "export const retries = 7;\n");
  writeFileSync(path.join(tracked, "src", "queue.ts"), "export const queue: number[] = [];\n");
  rmSync(path.join(tracked, "src", "index.ts"));
  writeFileSync(path.join(tracked, "src", "jitter.ts"), "export const jitter = 0.3;\n");
  writeFileSync(path.join(tracked, ".env.local"), "TOKEN=dev\n");

  // Untracked only: the D2-that-must-not-escalate case (#4927).
  const untracked = path.join(wtRoot, WT_UNTRACKED.replace(/\//g, "-"));
  writeFileSync(path.join(untracked, "notes.md"), "# scratch\n");
  writeFileSync(path.join(untracked, "electron-42.log"), "upgrade log\n");

  // Long identifiers: a deep path, a long branch, and enough files to overflow
  // the preview's 12-row cap so the "…and N more" tail renders too.
  const long = path.join(wtRoot, WT_LONG.replace(/\//g, "-"));
  mkdirSync(path.join(long, "packages", "telemetry-exporter", "src", "internal"), {
    recursive: true,
  });
  for (let i = 0; i < 16; i++) {
    writeFileSync(
      path.join(
        long,
        "packages",
        "telemetry-exporter",
        "src",
        "internal",
        `span-exporter-backpressure-strategy-${i}.ts`
      ),
      `export const strategy${i} = ${i};\n`
    );
  }
  writeFileSync(path.join(long, "src", "retry.ts"), "export const retries = 99;\n");

  return {
    dir,
    wtRoot,
    cleanup: () => {
      if (existsSync(wtRoot)) rmSync(wtRoot, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function settle(page: Page, ms = 500): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
  );
  await page.waitForTimeout(ms);
}

/** Written shots, so the run can assert it produced what it claimed to. */
const written: string[] = [];

async function snap(page: Page, slug: string, locator?: string): Promise<void> {
  await settle(page);
  const file = path.join(OUTPUT_DIR, `${slug}${TAG}.png`);
  if (locator) {
    await page.locator(locator).first().screenshot({ path: file, type: "png" });
  } else {
    await page.screenshot({ path: file, type: "png", animations: "disabled", caret: "hide" });
  }
  written.push(path.basename(file));
}

const ONLY = (process.env.DAINTREE_SHOT_ONLY ?? "").split(",").filter(Boolean);
/**
 * Steps report their failure but never abort the run — one unreachable state
 * shouldn't cost the other twelve. The file-count assertion at the end is what
 * turns a silently-empty run into a failure.
 */
async function step(name: string, fn: () => Promise<void>): Promise<void> {
  if (ONLY.length > 0 && !ONLY.includes(name)) return;
  try {
    await fn();
  } catch (error) {
    console.warn(`[delete-shots] step "${name}" FAILED:`, String(error).slice(0, 400));
    // A step that threw mid-dialog leaves the modal open, and the next step
    // then spends 30s failing to click a worktree card the dialog is covering.
    // One failure should cost one shot, not the rest of the run.
    if (activePage) {
      for (let i = 0; i < 3; i++) {
        await activePage.keyboard.press("Escape").catch(() => {});
        await activePage.waitForTimeout(200);
      }
    }
  }
}

/** Set once the app is up, so `step` can recover the UI after a failure. */
let activePage: Page | undefined;

/**
 * Open the card's actions menu — the same route `core-worktree-lifecycle`
 * takes. Closes any menu left open by a previous step first: a Radix trigger
 * whose `aria-expanded` is already true swallows the click, and the failure
 * then cascades into every later step as a 30s timeout.
 */
async function openActionsMenu(page: Page, branch: string): Promise<void> {
  if (
    await page
      .locator('[role="menu"]')
      .first()
      .isVisible()
      .catch(() => false)
  ) {
    await page.keyboard.press("Escape");
    await settle(page, 250);
  }
  const card = page.locator(SEL.worktree.card(branch)).first();
  await card.scrollIntoViewIfNeeded().catch(() => {});
  await card.hover().catch(() => {});
  const trigger = card.locator(SEL.worktree.actionsMenu).first();
  await trigger.click();
  await page.locator('[role="menu"]').first().waitFor({ state: "visible", timeout: 5000 });
  await settle(page, 300);
}

/** Open the actions menu's "Launch" submenu and pick one of its items. */
async function launchFromMenu(page: Page, branch: string, item: RegExp): Promise<void> {
  await openActionsMenu(page, branch);
  const launch = page.getByRole("menuitem", { name: /^Launch$/ }).first();
  // Radix SubTriggers open on hover, but a hover that lands before the menu
  // finishes its enter animation is dropped — click is the reliable fallback.
  await launch.hover();
  await settle(page, 400);
  const target = page.getByRole("menuitem", { name: item }).first();
  if (!(await target.isVisible().catch(() => false))) {
    await launch.click();
    await settle(page, 400);
  }
  await target.click({ timeout: 10000 });
}

/** Open the delete dialog for a worktree card via its real actions menu. */
async function openDialog(page: Page, branch: string): Promise<void> {
  await openActionsMenu(page, branch);
  const deleteItem = page.getByRole("menuitem", { name: /delete worktree/i }).first();
  await deleteItem.hover();
  await deleteItem.click();
  await page.locator(SEL.worktree.deleteDialog).waitFor({ state: "visible", timeout: 8000 });
  // `useWorktreeTerminals` debounces `counts` by 250ms while `terminals` is not
  // debounced, and the fresh git-status fetch resolves over a MessagePort —
  // settle past both or the terminal row and the file list capture stale.
  await settle(page, 1200);
}

async function closeDialog(page: Page): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press("Escape").catch(() => {});
    await settle(page, 200);
  }
}

/** Click a checkbox inside the dialog by its visible label text. */
async function toggle(page: Page, labelText: string): Promise<void> {
  await page
    .locator(`${SEL.worktree.deleteDialog} label`, { hasText: labelText })
    .first()
    .locator('input[type="checkbox"]')
    .click();
  await settle(page, 400);
}

test("worktree-delete dialog review — every consequence tier", async () => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_DELETE is required for the delete-dialog capture",
  });
  test.skip(!ENABLED, "Set DAINTREE_SHOT_DELETE to run the delete-dialog capture");

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const repo = createFixtureRepo();
  const userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-deleteshot-"));
  let ctx: AppContext | undefined;
  try {
    ctx = await launchApp({
      userDataDir,
      screenshotScale: SCALE,
      windowSize: { width: 1680, height: 1050 },
      extraArgs: ["--disable-gpu", "--in-process-gpu", "--disable-breakpad", "--noerrdialogs"],
    });
    const page = await openAndOnboardProject(ctx.app, ctx.window, repo.dir, "Helios Dashboard");
    activePage = page;
    if (THEME) await setAppTheme(page, THEME);
    await page.addStyleTag({ content: POLISH_CSS }).catch(() => {});
    await dismissBlockingPalette(page);
    await page
      .locator(SEL.worktree.mainCard)
      .waitFor({ state: "visible", timeout: T_LONG })
      .catch(() => {});
    // The worktree monitors have to finish their first git-status pass before
    // the dirty fixtures read as dirty; without this the "clean" shot and the
    // "tracked" shot are the same picture.
    await settle(page, 4000);
    await dismissBlockingPalette(page);

    // 1. Clean worktree, no terminals — the D2 floor, and the shot that shows
    //    how much of the dialog is spent on things that will not happen.
    await step("clean", async () => {
      await openDialog(page, WT_CLEAN);
      await snap(page, "10-clean", PANEL);
      await snap(page, "11-clean-in-window");
      await closeDialog(page);
    });

    // 2. Clean + delete-branch checked — the one optional consequence that is
    //    reachable without any dirt.
    await step("clean-branch", async () => {
      await openDialog(page, WT_CLEAN);
      await toggle(page, "Delete branch");
      await snap(page, "15-clean-delete-branch", PANEL);
      await closeDialog(page);
    });

    // 3. Tracked changes, force OFF — the warning tier that tells the user the
    //    standard delete is going to fail.
    await step("dirty", async () => {
      await openDialog(page, WT_TRACKED);
      await snap(page, "20-tracked-force-off", PANEL);
      await closeDialog(page);
    });

    // 4. Tracked changes, force ON — D3. Error banner + real file list + the
    //    typed-name gate all on screen at once. The money shot.
    await step("force-tracked", async () => {
      await openDialog(page, WT_TRACKED);
      await toggle(page, "Force delete");
      await snap(page, "30-tracked-force-on", PANEL);
      await snap(page, "31-tracked-force-on-in-window");
      await closeDialog(page);
    });

    // 5. D3 with the name typed — the only state where the destructive button
    //    is live.
    await step("typed", async () => {
      await openDialog(page, WT_TRACKED);
      await toggle(page, "Force delete");
      await page.locator(SEL.worktree.deleteConfirmInput).fill(WT_TRACKED);
      await snap(page, "35-tracked-force-on-typed", PANEL);
      await closeDialog(page);
    });

    // 6. Untracked only, force ON — D2 that must NOT escalate (#4927). Visually
    //    near-identical to the D3 shot, which is the thing worth checking.
    await step("untracked", async () => {
      await openDialog(page, WT_UNTRACKED);
      await toggle(page, "Force delete");
      await snap(page, "40-untracked-force-on", PANEL);
      await closeDialog(page);
    });

    // 7. Long branch, deep path, 17 changed files — every truncation point at
    //    once, including the preview's "…and N more" tail.
    await step("long", async () => {
      await openDialog(page, WT_LONG);
      await toggle(page, "Force delete");
      await snap(page, "50-long-identifiers", PANEL);
      await snap(page, "51-long-identifiers-in-window");
      await closeDialog(page);
    });

    // 8. Terminals attached. Opening a terminal on the card is the real seam —
    //    `useWorktreeTerminals` reads the panel store, so a spawned pane is
    //    what the dialog actually counts.
    await step("terminals", async () => {
      for (let i = 0; i < 2; i++) {
        await launchFromMenu(page, WT_CLEAN, /^Terminal$/);
        await settle(page, 2500);
        await dismissBlockingPalette(page);
      }
      await openDialog(page, WT_CLEAN);
      await snap(page, "60-with-terminals", PANEL);
      await closeDialog(page);
    });

    // 9. Fail-closed verification. The fresh status ride is a MessagePort
    //    request, not an IPC invoke, so the fault goes in at that seam — the
    //    same one `worktreeClient.getFreshChanges` calls — rather than at the
    //    UI. This is the only way to see the `verifyFailed` banner, and it is
    //    the banner that guards the worst case.
    // 9. Fail-closed verification. No mocking: the worktree directory is
    //    removed from disk behind the app's back — a real scenario (someone
    //    rm -rf'd it, or a volume unmounted) — so the fresh `git status` the
    //    dialog runs on open genuinely fails and the dialog falls back to its
    //    D3 fail-closed path. Patching the IPC bridge is not an option here:
    //    `worktreePort` is a non-configurable contextBridge property, so both
    //    assignment and defineProperty are rejected in the isolated world.
    //    This runs LAST among the dirty-state steps because it destroys its
    //    own fixture.
    await step("verify-failed", async () => {
      rmSync(path.join(repo.wtRoot, WT_UNTRACKED.replace(/\//g, "-")), {
        recursive: true,
        force: true,
      });
      await settle(page, 1500);
      await openDialog(page, WT_UNTRACKED);
      // The fail-closed banner is the whole point of this shot — refuse to
      // write a PNG that does not contain it rather than ship a lookalike.
      await page
        .locator(SEL.worktree.deleteDialog)
        .getByText(/Couldn't (verify|check)/i)
        .waitFor({ state: "visible", timeout: 8000 });
      await snap(page, "70-verify-failed", PANEL);
      await closeDialog(page);
    });

    // 10. Keyboard focus. A destructive dialog opens focus on Cancel, and the
    //     force checkbox is the control that changes the blast radius — both
    //     rings have to be visible against the destructive surface.
    await step("focus", async () => {
      await openDialog(page, WT_TRACKED);
      const describeFocus = () =>
        page.evaluate(() => {
          const el = document.activeElement as HTMLElement | null;
          if (!el) return "none";
          const label = (el.closest("label")?.textContent ?? el.textContent ?? "").trim();
          return `${el.tagName.toLowerCase()}${
            el.getAttribute("type") ? `[${el.getAttribute("type")}]` : ""
          } :: ${label.slice(0, 60)}`;
        });
      const initial = await describeFocus();
      await snap(page, "80-focus-initial", PANEL);
      await page.keyboard.press("Tab");
      await settle(page, 300);
      const next = await describeFocus();
      await snap(page, "81-focus-next", PANEL);
      // Recorded, not asserted: WHERE initial focus lands is the finding, and
      // it is the thing under review — the harness must report it, not judge it.
      console.log(`[delete-shots] initial focus: ${initial}`);
      console.log(`[delete-shots] focus after Tab: ${next}`);
      if (initial === next) {
        // Recorded, not thrown: in the packaged app the dialog lives in a
        // per-project WebContentsView, so `document.activeElement` read from
        // the top frame is not authoritative. The real focus contract is
        // asserted against the actual AppDialog in
        // `WorktreeDeleteDialog.focus.test.tsx`; this line is a hint, not a
        // verdict, and it must not cost the later shots.
        console.warn(`[delete-shots] Tab did not move focus in this frame (${initial})`);
      }
      await closeDialog(page);
    });

    // 11. Forced-colors, on the highest tier. The dialog leans on colour to
    //     separate its warning tiers; forced-colors is where that collapses.
    await step("forced-colors", async () => {
      await page.emulateMedia({ forcedColors: "active" }).catch(() => {});
      await openDialog(page, WT_TRACKED);
      await toggle(page, "Force delete");
      await snap(page, "90-forced-colors", PANEL);
      await closeDialog(page);
      await page.emulateMedia({ forcedColors: "none" }).catch(() => {});
    });

    // 12. prefers-contrast: more — the macOS "increase contrast" path, which
    //     is a separate block from forced-colors in this codebase.
    await step("high-contrast", async () => {
      await page.emulateMedia({ contrast: "more" }).catch(() => {});
      await openDialog(page, WT_TRACKED);
      await toggle(page, "Force delete");
      await snap(page, "95-high-contrast", PANEL);
      await closeDialog(page);
      await page.emulateMedia({ contrast: "no-preference" }).catch(() => {});
    });
    // LAST. Dev preview running — the other cascade the dialog discloses. Opened
    //     through the same Launch submenu so the real IPC session exists.
    await step("dev-preview", async () => {
      await launchFromMenu(page, WT_CLEAN, /^Dev preview$/);
      await settle(page, 5000);
      await dismissBlockingPalette(page);
      await openDialog(page, WT_CLEAN);
      // The row only un-strikes when a session exists and is not "stopped".
      // Assert it rather than writing a PNG identical to the previous state —
      // a lookalike shot is worse than a missing one, because it reads as
      // evidence for a state nobody actually reached.
      const devRow = page
        .locator(`${SEL.worktree.deleteDialog} li`, { hasText: "Dev server will be stopped" })
        .first();
      const struck = await devRow.evaluate(
        (el) => getComputedStyle(el).textDecorationLine.includes("line-through"),
        undefined
      );
      if (struck) throw new Error("dev preview never reported running — row still struck through");
      await snap(page, "65-with-dev-preview", PANEL);
      await closeDialog(page);
    });
  } finally {
    if (ctx) await closeApp(ctx.app).catch(() => {});
    repo.cleanup();
    rmSync(userDataDir, { recursive: true, force: true });
  }

  // Never report success on an artifact we did not verify: a harness that
  // swallows per-step errors will happily exit 0 having written nothing.
  const onDisk = readdirSync(OUTPUT_DIR).filter(
    (f) => f.endsWith(`${TAG}.png`) || (!TAG && f.endsWith(".png"))
  );
  console.log(`[delete-shots] wrote ${written.length} shots to ${OUTPUT_DIR}`);
  expect(written.length, "capture produced no screenshots").toBeGreaterThan(0);
  expect(onDisk.length, "screenshots were not written to disk").toBeGreaterThanOrEqual(
    written.length
  );
});
