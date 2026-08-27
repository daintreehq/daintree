/**
 * `GitPullRebaseConfirmDialog` visual-review harness (#11980).
 *
 * The sibling of `git-push-confirm-review.spec.ts` (#11979), and deliberately its
 * mirror image: a push confirms commits LEAVING for a destination, a pull-rebase
 * confirms an upstream arriving and the local sequence being rewritten on top of it.
 * The states that matter are therefore different — there is no "creates the branch",
 * and the interesting empty state is "nothing of yours would be replayed", not
 * "the remote already has everything".
 *
 * Every state here is driven through the REAL seams, never a renderer mock:
 *
 *   - the loaded states come from a real fixture repo with two real bare remotes, so
 *     `resolveGitUpstream` resolves a real upstream — including the triangular case
 *     where the branch pulls from one remote and pushes to another. Switching state
 *     means `git checkout` in the fixture, exactly as a user would arrive at it.
 *   - loading and load-failure come from the main-process fault registry
 *     (`DAINTREE_E2E_FAULT_MODE=1` + `e2e/helpers/ipcFaults`), so the app takes its
 *     genuine error path rather than a stubbed one.
 *   - the dialog is opened by dispatching `git.pullRebase` itself. It is NEVER
 *     confirmed — every step leaves by Escape, which resolves the deferred promise
 *     `false`. A confirmed rebase would rewrite the fixture out from under the
 *     remaining steps.
 *
 *   DAINTREE_SHOT_GITREBASE=1 npx playwright test --project=screenshots git-pull-rebase-confirm-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_GITREBASE  required — any truthy value runs the capture
 *   DAINTREE_SHOT_THEME      optional theme id (default: the app default)
 *   DAINTREE_SHOT_TAG        optional suffix so rounds sit side by side
 *   DAINTREE_SHOT_ONLY       comma-separated step filter (see step names below)
 *   DAINTREE_SHOT_OUT        optional absolute output dir (default artifacts/git-pull-rebase-confirm-shots)
 *
 * Output: <out>/<NN-slug>[-tag].png (artifacts/ is gitignored).
 */

import { test, type Page } from "@playwright/test";
import { execFileSync } from "child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { openAndOnboardProject } from "../helpers/project";
import { dismissBlockingPalette } from "../helpers/overlays";
import { setAppTheme } from "../helpers/theme";
import { injectDelay, injectFault, clearAllFaults } from "../helpers/ipcFaults";
import { SEL } from "../helpers/selectors";
import { T_LONG } from "../helpers/timeouts";

const ENABLED = !!process.env.DAINTREE_SHOT_GITREBASE;
const THEME = process.env.DAINTREE_SHOT_THEME ?? "";
const TAG = process.env.DAINTREE_SHOT_TAG ? `-${process.env.DAINTREE_SHOT_TAG}` : "";
const SCALE = process.env.DAINTREE_SCREENSHOT_SCALE ?? "2";
const OUTPUT_DIR =
  process.env.DAINTREE_SHOT_OUT ??
  path.resolve(process.cwd(), "artifacts", "git-pull-rebase-confirm-shots");

/**
 * The dialog CARD, not the surface element.
 *
 * `AppDialog` puts `role="dialog"` on the `fixed inset-0` scrim, so screenshotting
 * the role selector silently returns the whole window — a full-window PNG that looks
 * like a successful crop until you compare its dimensions.
 */
const DIALOG = "[data-app-dialog-surface] > div";

/**
 * The stable testid contract this harness asserts against. The redesign may move,
 * restyle, or re-shape any of these — it must not delete them, or the harness stops
 * being able to prove the state it captured is the state it meant to capture.
 */
const TID = {
  noUpstream: '[data-testid="git-pull-rebase-no-destination"]',
  unfetched: '[data-testid="git-pull-rebase-empty-unfetched"]',
  behindOnly: '[data-testid="git-pull-rebase-behind-only"]',
  loading: '[data-testid="git-pull-rebase-commits-loading"]',
  retry: '[data-testid="git-pull-rebase-commits-retry"]',
  commitRow: '[data-testid="git-pull-rebase-commit-row"]',
} as const;

const CH = {
  listCommits: "git:list-commits",
  stagingStatus: "git:get-staging-status",
  listPushCommits: "git:list-push-commits",
  listRebaseCommits: "git:list-rebase-commits",
} as const;

const POLISH_CSS = `
  ::-webkit-scrollbar { display: none !important; width: 0 !important; height: 0 !important; }
  *, *::before, *::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
    caret-color: transparent !important;
  }
  /*
   * Skeleton bones start at opacity 0 and are faded in by the pulse keyframes
   * after the 400ms Doherty delay, so the animation freeze above leaves them
   * INVISIBLE — a loading shot that looks like an empty panel and sends the
   * whole review off reviewing a screen that does not exist. Pin them visible.
   */
  [class*="animate-pulse-"] { opacity: 1 !important; }
`;

/**
 * execFile, not execSync with an interpolated string: commit messages and branch
 * names here deliberately contain the punctuation a shell would eat.
 */
function git(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function commit(dir: string, file: string, body: string, message: string, author: string): void {
  const target = path.join(dir, file);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, body);
  git(["add", "-A"], dir);
  git(
    ["-c", `user.name=${author}`, "-c", "user.email=dev@daintree.dev", "commit", "-m", message],
    dir
  );
}

/** Realistic subjects: a mix of lengths, conventional-commit prefixes, and one that clips. */
const SUBJECTS: Array<[string, string]> = [
  ["fix(pty): stop the resize observer firing during a parser drain", "Ada Lovelace"],
  ["refactor(store): collapse the two worktree selectors into one", "Grace Hopper"],
  ["feat(review): show the CI status pill inline on each pull-request row", "Katherine Johnson"],
  ["chore: bump electron to 42.0.3", "Ada Lovelace"],
  ["fix(theme): raise the working-state contrast in namib and svalbard", "Radia Perlman"],
  [
    "fix(worktree): resolve the push destination through git rather than assuming origin, so a branch configured to push to a fork stops writing to the wrong repository",
    "Barbara Liskov",
  ],
  ["test(e2e): unflake the terminal-identity transition spec", "Grace Hopper"],
  ["docs: describe the destructive-action tiers", "Ada Lovelace"],
  ["perf(grid): memoise the panel layout measurement", "Margaret Hamilton"],
  ["fix(mcp): reject an output schema that is not an object", "Radia Perlman"],
  ["feat(pilot): land focus in the search box on open", "Katherine Johnson"],
  ["fix(registry): retry a failed chunk load once before falling back", "Barbara Liskov"],
  ["chore(deps): drop the unused diff-view shim", "Margaret Hamilton"],
  ["feat(git): add the rebase-range preview", "Ada Lovelace"],
];

/**
 * A repo whose branches each sit in one of the states the dialog has to render.
 *
 * The shapes that matter here are about the UPSTREAM, not the push target:
 *
 *   - `main` tracks origin/main and has run well past the 12-row preview limit, so
 *     the tail is exercised.
 *   - `chore/bump-electron` tracks origin and is level with it: nothing of the
 *     user's would be replayed. Today's dialog still lists twelve commits there,
 *     which is the defect the capture has to make visible.
 *   - the long branch tracks the long-named SECOND remote, which is also the
 *     triangular case: it pulls from the mirror and pushes to origin, so a preview
 *     reading the push destination would name the wrong ref.
 *   - `spike/unconfigured-remote` has no upstream at all.
 */
function createFixtureRepo(): { dir: string; cleanup: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), "daintree-gitrebase-shots-"));
  const dir = path.join(root, "helios-dashboard");
  const originDir = path.join(root, "origin.git");
  const mirrorDir = path.join(root, "mirror.git");
  const wtRoot = path.join(path.dirname(dir), path.basename(dir) + "-worktrees");
  mkdirSync(dir, { recursive: true });
  mkdirSync(wtRoot, { recursive: true });

  git(["init", "--bare", "-b", "main", originDir], root);
  git(["init", "--bare", "-b", "main", mirrorDir], root);

  git(["init", "-b", "main", dir], root);
  git(["config", "user.email", "dev@daintree.dev"], dir);
  git(["config", "user.name", "Daintree Test"], dir);
  git(["config", "commit.gpgsign", "false"], dir);

  writeFileSync(path.join(dir, "README.md"), "# Helios Dashboard\n");
  git(["add", "-A"], dir);
  git(["commit", "-m", "initial commit"], dir);

  git(["remote", "add", "origin", originDir], dir);
  git(["remote", "add", "upstream-mirror-eu-west-1", mirrorDir], dir);

  // main: tracks origin/main, then runs 14 commits past it. More than the 12-row
  // preview limit, so the "and N more" tail is exercised.
  git(["push", "-u", "origin", "main"], dir);
  SUBJECTS.forEach(([message, author], i) => {
    commit(dir, `src/module-${i}.ts`, `export const m${i} = ${i};\n`, message, author);
  });

  // one-ahead: the single-commit preview, where the row treatment has nothing to
  // compare itself against.
  git(["checkout", "-b", "fix/retry-backoff-jitter", "main~14"], dir);
  git(["push", "-u", "origin", "fix/retry-backoff-jitter"], dir);
  commit(
    dir,
    "src/backoff.ts",
    "export const jitter = 0.3;\n",
    "fix(net): jitter the retry backoff so a fleet doesn't resynchronise",
    "Grace Hopper"
  );

  // level with upstream: tracked, nothing ahead. The state that shows whether the
  // preview describes the replay range or merely the branch's recent history.
  git(["checkout", "-b", "chore/bump-electron", "main~14"], dir);
  git(["push", "-u", "origin", "chore/bump-electron"], dir);

  // long values, AND the triangular case: pulls from the long-named mirror, pushes
  // to origin. A preview that read `pushDestination` would name `origin/...` here.
  const longBranch =
    "feature/11980-refine-git-pull-rebase-confirm-dialog-preview-states-and-upstream-summary";
  git(["checkout", "-b", longBranch, "main~14"], dir);
  git(["push", "-u", "upstream-mirror-eu-west-1", longBranch], dir);
  git(["config", `branch.${longBranch}.pushRemote`, "origin"], dir);
  commit(
    dir,
    "src/preview.ts",
    "export const preview = true;\n",
    "feat(git): render the resolved upstream, the branch being rewritten, and the exact commits the rebase would replay in one preview region instead of four",
    "Wilhelmina Fitzgerald-Mackintosh"
  );
  commit(dir, "src/preview2.ts", "export const two = 2;\n", "fix: short one", "Jean Bartik");

  // behind only: tracks a remote branch that already has all fourteen commits, while
  // sitting on none of them. Nothing of the user's is replayed and no hash changes —
  // an empty replay range that must NOT be reported as "already matches", because
  // the rebase does move the branch.
  git(["push", "origin", "main:refs/heads/release/next"], dir);
  git(["checkout", "-b", "docs/behind-upstream", "main~14"], dir);
  git(["branch", "--set-upstream-to=origin/release/next", "docs/behind-upstream"], dir);

  // unfetched upstream: the config names one and `%(upstream)` resolves it, but its
  // remote-tracking ref has never existed here, so there is nothing local to subtract
  // from and the replay set cannot be measured. What a branch looks like after its
  // upstream is renamed or deleted on the remote, or under a narrow fetch refspec.
  //
  // Configured directly rather than by deleting a ref that `push -u` created: the app
  // fetches in the background, and a deleted tracking ref for a branch that DOES exist
  // on the remote comes straight back, which silently turns this into the in-sync
  // state. An upstream that names a branch the remote has never had cannot be
  // resurrected by any fetch.
  git(["checkout", "-b", "spike/unfetched-upstream", "main~14"], dir);
  git(["config", "branch.spike/unfetched-upstream.remote", "origin"], dir);
  git(["config", "branch.spike/unfetched-upstream.merge", "refs/heads/never-fetched-here"], dir);

  // no upstream: never pushed, no branch.<n>.merge, so `resolveGitUpstream` refuses.
  git(["checkout", "-b", "spike/unconfigured-remote", "main~14"], dir);
  commit(
    dir,
    "src/spike.ts",
    "export const spike = 1;\n",
    "spike: try the new layout",
    "Ada Lovelace"
  );

  git(["checkout", "main"], dir);

  return {
    dir,
    cleanup: () => {
      if (existsSync(wtRoot)) rmSync(wtRoot, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    },
  };
}

async function settle(page: Page, ms = 400): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
  );
  await page.waitForTimeout(ms);
}

/**
 * Screenshot, but only after the state it claims to be has been proven on screen.
 *
 * This is the hard rule of the whole harness: a capture run that quietly writes a
 * plausible-looking wrong artifact is worse than one that fails, because the review
 * then reasons about a screen that never existed.
 */
async function snap(
  page: Page,
  slug: string,
  opts: { marker: string; locator?: string; markerTimeout?: number }
): Promise<void> {
  await page
    .locator(opts.marker)
    .first()
    .waitFor({ state: "visible", timeout: opts.markerTimeout ?? 8000 });
  await settle(page);
  // Re-checked AFTER the settle, not only before it: the app's own later render can
  // replace the state between the assertion and the shutter.
  if (!(await page.locator(opts.marker).first().isVisible())) {
    throw new Error(`[git-rebase-shots] "${slug}": marker ${opts.marker} vanished before the shot`);
  }
  const file = path.join(OUTPUT_DIR, `${slug}${TAG}.png`);
  if (opts.locator) {
    await page.locator(opts.locator).last().screenshot({ path: file, type: "png" });
  } else {
    await page.screenshot({ path: file, type: "png", animations: "disabled", caret: "hide" });
  }
}

/**
 * Open the pull-rebase confirm by dispatching the real action, fire-and-forget.
 *
 * NOT awaited: `git.pullRebase`'s `run()` blocks on the deferred confirm promise, so
 * awaiting it here would hang until the dialog resolves. Every caller closes with
 * Escape, which resolves it `false` — this harness never confirms a rebase, and must
 * not: a real rebase would rewrite the fixture out from under the remaining steps.
 */
async function openRebaseConfirm(page: Page, cwd: string): Promise<void> {
  await page.evaluate((worktreePath) => {
    const dispatch = (
      window as unknown as {
        __daintreeDispatchAction?: (id: string, args: unknown, opts: unknown) => Promise<unknown>;
      }
    ).__daintreeDispatchAction;
    if (typeof dispatch !== "function") throw new Error("Action dispatch hook not available");
    void dispatch("git.pullRebase", { cwd: worktreePath }, { source: "test" });
  }, cwd);
}

async function closeDialog(page: Page): Promise<void> {
  for (let i = 0; i < 3; i++) {
    if (
      !(await page
        .locator(DIALOG)
        .first()
        .isVisible()
        .catch(() => false))
    )
      return;
    await page.keyboard.press("Escape").catch(() => {});
    await settle(page, 200);
  }
}

/**
 * Every built-in theme. Switching themes in place crashes the project view under this
 * harness (the same constraint git-push-confirm-review and confirm-dialog-review hit),
 * so a cross-theme sweep boots once per theme:
 *
 *   for t in <these ids>; do
 *     DAINTREE_SHOT_GITREBASE=1 DAINTREE_SHOT_THEME=$t DAINTREE_SHOT_TAG=$t \
 *     DAINTREE_SHOT_ONLY=many npx playwright test --project=screenshots git-pull-rebase-confirm-review
 *   done
 */
export const ALL_THEMES = [
  "arashiyama",
  "atacama",
  "bali",
  "bondi",
  "daintree",
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

const ONLY = (process.env.DAINTREE_SHOT_ONLY ?? "").split(",").filter(Boolean);

// A failed step must not abort the run — the remaining shots are still worth having,
// and a per-theme sweep should not lose fourteen themes to one bad selector. But the
// run must still FAIL: a silent exit 0 over an empty output directory reads as success.
const failures: string[] = [];

test("git pull-rebase confirm review — preview states", async () => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_GITREBASE is required for the pull-rebase-confirm capture",
  });
  test.skip(!ENABLED, "Set DAINTREE_SHOT_GITREBASE to run the pull-rebase-confirm capture");

  failures.length = 0;
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const repo = createFixtureRepo();
  const userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-gitrebaseshot-"));
  let ctx: AppContext | undefined;

  try {
    ctx = await launchApp({
      userDataDir,
      screenshotScale: SCALE,
      windowSize: { width: 1680, height: 1050 },
      env: { DAINTREE_E2E_FAULT_MODE: "1" },
      extraArgs: ["--disable-gpu", "--in-process-gpu", "--disable-breakpad", "--noerrdialogs"],
    });
    const app = ctx.app;
    const page = await openAndOnboardProject(ctx.app, ctx.window, repo.dir, "Helios Dashboard");
    if (THEME) await setAppTheme(page, THEME);
    await page.addStyleTag({ content: POLISH_CSS }).catch(() => {});
    await dismissBlockingPalette(page);
    await page
      .locator(SEL.worktree.mainCard)
      .waitFor({ state: "visible", timeout: T_LONG })
      .catch(() => {});
    await settle(page, 2000);
    await dismissBlockingPalette(page);

    /**
     * Runs one state, then unconditionally returns to rest. Unconditionally, not on
     * the success path only: a step that dies holding the dialog open would otherwise
     * wedge every step after it behind a modal.
     */
    const step = async (
      name: string,
      branch: string | null,
      fn: () => Promise<void>
    ): Promise<void> => {
      if (ONLY.length > 0 && !ONLY.includes(name)) return;
      try {
        if (branch) git(["checkout", branch], repo.dir);
        await fn();
      } catch (error) {
        const detail = String(error).slice(0, 300);
        console.warn(`[git-rebase-shots] step "${name}" failed:`, detail);
        failures.push(`${name}: ${detail}`);
      } finally {
        await clearAllFaults(app).catch(() => {});
        await closeDialog(page).catch((error) => {
          failures.push(`${name} (reset): ${String(error).slice(0, 200)}`);
        });
        await page.emulateMedia({ forcedColors: null, contrast: null }).catch(() => {});
      }
    };

    // 1. The headline state: a real upstream and more local commits than the preview shows.
    await step("many", "main", async () => {
      await openRebaseConfirm(page, repo.dir);
      await snap(page, "10-loaded-many", { marker: TID.commitRow, locator: DIALOG });
      await snap(page, "11-loaded-many-in-window", { marker: TID.commitRow });
    });

    // 2. One commit — the row treatment with nothing to compare itself against.
    await step("one", "fix/retry-backoff-jitter", async () => {
      await openRebaseConfirm(page, repo.dir);
      await snap(page, "15-loaded-one", { marker: TID.commitRow, locator: DIALOG });
    });

    // 3. Level with the upstream: nothing of the user's would be replayed. The state
    //    that shows whether the preview describes the replay range or merely the
    //    branch's recent history.
    await step("level", "chore/bump-electron", async () => {
      await openRebaseConfirm(page, repo.dir);
      await snap(page, "20-nothing-to-replay", {
        marker: SEL.confirmDialog.confirm,
        locator: DIALOG,
      });
    });

    // 4. Long everything, plus the triangular case: this branch pulls from the
    //    long-named mirror and pushes to origin, so a preview that named the push
    //    destination would be pointing at the wrong repository entirely.
    await step(
      "long",
      "feature/11980-refine-git-pull-rebase-confirm-dialog-preview-states-and-upstream-summary",
      async () => {
        await openRebaseConfirm(page, repo.dir);
        await snap(page, "25-long-values", { marker: TID.commitRow, locator: DIALOG });
      }
    );

    // 5a. Behind only: an empty replay range that is NOT a level branch. Shares its
    //     shape with step 3 and must not share its wording.
    await step("behind", "docs/behind-upstream", async () => {
      await openRebaseConfirm(page, repo.dir);
      await snap(page, "21-behind-only", { marker: SEL.confirmDialog.confirm, locator: DIALOG });
    });

    // 5b. Upstream configured but never fetched here — the one state where the
    //     replay set cannot be measured at all, and so the one where approval has
    //     to be refused rather than granted over an unknown.
    await step("unfetched", "spike/unfetched-upstream", async () => {
      await openRebaseConfirm(page, repo.dir);
      await snap(page, "22-unfetched-upstream", {
        marker: TID.unfetched,
        locator: DIALOG,
      });
    });

    // 6. No upstream — the block that must never degrade into a guess at `origin`.
    await step("no-upstream", "spike/unconfigured-remote", async () => {
      await openRebaseConfirm(page, repo.dir);
      await snap(page, "30-no-upstream", { marker: TID.noUpstream, locator: DIALOG });
    });

    // 6. Preview load failure and its retry, through the real error path.
    await step("error", "main", async () => {
      const message = "fatal: not a git repository (or any parent up to mount point /)";
      await injectFault(app, CH.stagingStatus, message);
      await injectFault(app, CH.listCommits, message);
      await injectFault(app, CH.listRebaseCommits, message);
      await openRebaseConfirm(page, repo.dir);
      await snap(page, "40-load-error", { marker: TID.retry, locator: DIALOG });
    });

    // 7. Loading held open by a main-process delay, so the shot is the real in-flight
    //    render rather than a paused animation frame.
    await step("loading", "main", async () => {
      await injectDelay(app, CH.listCommits, 9000);
      await injectDelay(app, CH.listRebaseCommits, 9000);
      await injectDelay(app, CH.stagingStatus, 9000);
      await openRebaseConfirm(page, repo.dir);
      // Past the 400ms Doherty gate, so a gated skeleton has committed to rendering.
      await page.waitForTimeout(1200);
      await snap(page, "50-loading", { marker: TID.loading, locator: DIALOG });
    });

    // 8. Keyboard focus on the primary control — an affordance, not a detail, on a
    //    surface reached from the palette and a keybinding.
    await step("focus", "main", async () => {
      await openRebaseConfirm(page, repo.dir);
      await page.locator(TID.commitRow).first().waitFor({ state: "visible", timeout: 8000 });
      await page.locator(SEL.confirmDialog.confirm).focus();
      await snap(page, "60-focus-primary", { marker: SEL.confirmDialog.confirm, locator: DIALOG });
    });

    // 9. prefers-contrast: more — macOS "Increase contrast".
    await step("contrast", "main", async () => {
      await page.emulateMedia({ contrast: "more" });
      await openRebaseConfirm(page, repo.dir);
      await snap(page, "70-contrast-more", { marker: TID.commitRow, locator: DIALOG });
    });

    // 10. forced-colors: active — Windows high contrast swaps in system colours, and
    //     anything carrying meaning in a tint alone collapses here.
    await step("forced", "main", async () => {
      await page.emulateMedia({ forcedColors: "active" });
      await openRebaseConfirm(page, repo.dir);
      await snap(page, "75-forced-colors", { marker: TID.commitRow, locator: DIALOG });
    });

    // 11. BOTH at once, which is the combination the real platform reports and
    //     neither single-query shot can catch: on a high-contrast Windows palette
    //     Chromium matches `prefers-contrast: more` as well as `forced-colors:
    //     active`, and the two blocks in `src/index.css` are written independently.
    //     The destructive button is distinguished from Cancel by border weight
    //     alone here, so a rule from one block that lands on the other's buttons
    //     erases the only marker on the action that rewrites history.
    await step("forced-contrast", "main", async () => {
      await page.emulateMedia({ forcedColors: "active", contrast: "more" });
      await openRebaseConfirm(page, repo.dir);
      await snap(page, "80-forced-colors-contrast", { marker: TID.commitRow, locator: DIALOG });
    });
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

  // Counted here rather than trusted from the exit code: swallowed per-step errors are
  // exactly how a harness reports PASS over an empty directory.
  const written = existsSync(OUTPUT_DIR)
    ? readdirSync(OUTPUT_DIR).filter((f) => f.endsWith(`${TAG}.png`)).length
    : 0;
  console.log(`[git-rebase-shots] wrote ${written} png(s) to ${OUTPUT_DIR}`);

  if (failures.length > 0) {
    throw new Error(
      `[git-rebase-shots] ${failures.length} step(s) failed:\n${failures.join("\n")}`
    );
  }
  if (written === 0) {
    throw new Error(`[git-rebase-shots] no PNGs written to ${OUTPUT_DIR}`);
  }
});
