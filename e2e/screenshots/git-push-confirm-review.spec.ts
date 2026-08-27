/**
 * `GitPushConfirmDialog` visual-review harness (#11979).
 *
 * The D2 push confirm is judged on rendered pixels: half of what is wrong with a
 * preview surface — a truncating message column, a hash rail that reads as noise, a
 * spinner in an empty box — is invisible in the JSX and obvious in a PNG.
 *
 * Every state here is driven through the REAL seams, never a renderer mock:
 *
 *   - the loaded states come from a real fixture repo with a real bare remote, so
 *     `resolveGitPushDestination` resolves a real destination and `git log` returns
 *     real commits. Switching state means `git checkout` in the fixture, exactly as a
 *     user would arrive at it.
 *   - loading and load-failure come from the main-process fault registry
 *     (`DAINTREE_E2E_FAULT_MODE=1` + `e2e/helpers/ipcFaults`), so the app takes its
 *     genuine error path rather than a stubbed one.
 *   - the dialog is opened by dispatching `git.push` itself. It is NEVER confirmed —
 *     every step leaves by Escape, which resolves the deferred promise `false`.
 *
 *   DAINTREE_SHOT_GITPUSH=1 npx playwright test --project=screenshots git-push-confirm-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_GITPUSH  required — any truthy value runs the capture
 *   DAINTREE_SHOT_THEME    optional theme id (default: the app default)
 *   DAINTREE_SHOT_TAG      optional suffix so rounds sit side by side
 *   DAINTREE_SHOT_ONLY     comma-separated step filter (see step names below)
 *   DAINTREE_SHOT_OUT      optional absolute output dir (default artifacts/git-push-confirm-shots)
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

const ENABLED = !!process.env.DAINTREE_SHOT_GITPUSH;
const THEME = process.env.DAINTREE_SHOT_THEME ?? "";
const TAG = process.env.DAINTREE_SHOT_TAG ? `-${process.env.DAINTREE_SHOT_TAG}` : "";
const SCALE = process.env.DAINTREE_SCREENSHOT_SCALE ?? "2";
const OUTPUT_DIR =
  process.env.DAINTREE_SHOT_OUT ??
  path.resolve(process.cwd(), "artifacts", "git-push-confirm-shots");

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
  noDestination: '[data-testid="git-push-no-destination"]',
  loading: '[data-testid="git-push-commits-loading"]',
  retry: '[data-testid="git-push-commits-retry"]',
  commitRow: '[data-testid="git-push-commit-row"]',
} as const;

const CH = {
  listCommits: "git:list-commits",
  stagingStatus: "git:get-staging-status",
  listPushCommits: "git:list-push-commits",
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
  git(["-c", `user.name=${author}`, "-c", "user.email=dev@daintree.dev", "commit", "-m", message], dir);
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
  ["feat(git): add the push-range preview", "Ada Lovelace"],
];

/**
 * A repo whose branches each sit in one of the states the dialog has to render, plus
 * a real bare remote so the destination resolves the way it does in production.
 *
 * A SECOND remote exists on purpose: with one remote, an unconfigured branch resolves
 * to it (`resolveUnconfigured`), so the "no unambiguous destination" state is only
 * reachable when there is a genuine ambiguity to be had.
 */
function createFixtureRepo(): { dir: string; cleanup: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), "daintree-gitpush-shots-"));
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

  // main: pushed, then run well past the 12-row preview limit so the tail is exercised.
  git(["push", "-u", "origin", "main"], dir);
  SUBJECTS.forEach(([message, author], i) => {
    commit(dir, `src/module-${i}.ts`, `export const m${i} = ${i};\n`, message, author);
  });

  // one-ahead: the single-commit preview.
  git(["checkout", "-b", "fix/retry-backoff-jitter", "main~14"], dir);
  git(["push", "-u", "origin", "fix/retry-backoff-jitter"], dir);
  commit(
    dir,
    "src/backoff.ts",
    "export const jitter = 0.3;\n",
    "fix(net): jitter the retry backoff so a fleet doesn't resynchronise",
    "Grace Hopper"
  );

  // in-sync: pushed with nothing ahead. The dialog must not imply this pushes anything.
  git(["checkout", "-b", "chore/bump-electron", "main~14"], dir);
  git(["push", "-u", "origin", "chore/bump-electron"], dir);

  // long values: a long branch name pushing to the long-named remote, with a long author.
  const longBranch =
    "feature/11979-refine-git-push-confirm-dialog-preview-states-and-destination-summary";
  git(["checkout", "-b", longBranch, "main~14"], dir);
  git(["push", "-u", "upstream-mirror-eu-west-1", longBranch], dir);
  commit(
    dir,
    "src/preview.ts",
    "export const preview = true;\n",
    "feat(git): render the resolved destination, the branch it comes from, and the exact commits the push would publish in one preview region instead of four",
    "Wilhelmina Fitzgerald-Mackintosh"
  );
  commit(
    dir,
    "src/preview2.ts",
    "export const two = 2;\n",
    "fix: short one",
    "Jean Bartik"
  );

  // no destination: never pushed, no push config, two remotes -> genuinely ambiguous.
  git(["checkout", "-b", "spike/unconfigured-remote", "main~14"], dir);
  commit(dir, "src/spike.ts", "export const spike = 1;\n", "spike: try the new layout", "Ada Lovelace");

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
    throw new Error(`[git-push-shots] "${slug}": marker ${opts.marker} vanished before the shot`);
  }
  const file = path.join(OUTPUT_DIR, `${slug}${TAG}.png`);
  if (opts.locator) {
    await page.locator(opts.locator).last().screenshot({ path: file, type: "png" });
  } else {
    await page.screenshot({ path: file, type: "png", animations: "disabled", caret: "hide" });
  }
}

/**
 * Open the push confirm by dispatching the real action, fire-and-forget.
 *
 * NOT awaited: `git.push`'s `run()` blocks on the deferred confirm promise, so
 * awaiting it here would hang until the dialog resolves. Every caller closes with
 * Escape, which resolves it `false` — this harness never confirms a push.
 */
async function openPushConfirm(page: Page, cwd: string): Promise<void> {
  await page.evaluate((worktreePath) => {
    const dispatch = (
      window as unknown as {
        __daintreeDispatchAction?: (
          id: string,
          args: unknown,
          opts: unknown
        ) => Promise<unknown>;
      }
    ).__daintreeDispatchAction;
    if (typeof dispatch !== "function") throw new Error("Action dispatch hook not available");
    void dispatch("git.push", { worktreePath }, { source: "test" });
  }, cwd);
}

async function closeDialog(page: Page): Promise<void> {
  for (let i = 0; i < 3; i++) {
    if (!(await page.locator(DIALOG).first().isVisible().catch(() => false))) return;
    await page.keyboard.press("Escape").catch(() => {});
    await settle(page, 200);
  }
}

/**
 * Every built-in theme. Switching themes in place crashes the project view under this
 * harness (the same constraint worktree-dialog-review and confirm-dialog-review hit),
 * so a cross-theme sweep boots once per theme:
 *
 *   for t in <these ids>; do
 *     DAINTREE_SHOT_GITPUSH=1 DAINTREE_SHOT_THEME=$t DAINTREE_SHOT_TAG=$t \
 *     DAINTREE_SHOT_ONLY=many npx playwright test --project=screenshots git-push-confirm-review
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

test("git push confirm review — preview states", async () => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_GITPUSH is required for the push-confirm capture",
  });
  test.skip(!ENABLED, "Set DAINTREE_SHOT_GITPUSH to run the push-confirm capture");

  failures.length = 0;
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const repo = createFixtureRepo();
  const userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-gitpushshot-"));
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
        console.warn(`[git-push-shots] step "${name}" failed:`, detail);
        failures.push(`${name}: ${detail}`);
      } finally {
        await clearAllFaults(app).catch(() => {});
        await closeDialog(page).catch((error) => {
          failures.push(`${name} (reset): ${String(error).slice(0, 200)}`);
        });
        await page.emulateMedia({ forcedColors: null, contrast: null }).catch(() => {});
      }
    };

    // 1. The headline state: a real destination and more commits than the preview shows.
    await step("many", "main", async () => {
      await openPushConfirm(page, repo.dir);
      await snap(page, "10-loaded-many", { marker: TID.commitRow, locator: DIALOG });
      await snap(page, "11-loaded-many-in-window", { marker: TID.commitRow });
    });

    // 2. One commit — the row treatment with nothing to compare itself against.
    await step("one", "fix/retry-backoff-jitter", async () => {
      await openPushConfirm(page, repo.dir);
      await snap(page, "15-loaded-one", { marker: TID.commitRow, locator: DIALOG });
    });

    // 3. Nothing ahead of the remote. The state that shows whether the preview
    //    describes the push range or merely the branch's recent history.
    await step("in-sync", "chore/bump-electron", async () => {
      await openPushConfirm(page, repo.dir);
      await snap(page, "20-in-sync", { marker: SEL.confirmDialog.confirm, locator: DIALOG });
    });

    // 4. Long everything: branch, remote, subject, author. Where truncation shows up.
    await step(
      "long",
      "feature/11979-refine-git-push-confirm-dialog-preview-states-and-destination-summary",
      async () => {
        await openPushConfirm(page, repo.dir);
        await snap(page, "25-long-values", { marker: TID.commitRow, locator: DIALOG });
      }
    );

    // 5. No unambiguous destination — the block that must never degrade into "origin".
    await step("no-destination", "spike/unconfigured-remote", async () => {
      await openPushConfirm(page, repo.dir);
      await snap(page, "30-no-destination", { marker: TID.noDestination, locator: DIALOG });
    });

    // 6. Preview load failure and its retry, through the real error path.
    await step("error", "main", async () => {
      await injectFault(app, CH.stagingStatus, "fatal: not a git repository (or any parent up to mount point /)");
      await injectFault(app, CH.listPushCommits, "fatal: not a git repository (or any parent up to mount point /)");
      await openPushConfirm(page, repo.dir);
      await snap(page, "40-load-error", { marker: TID.retry, locator: DIALOG });
    });

    // 7. Loading held open by a main-process delay, so the shot is the real in-flight
    //    render rather than a paused animation frame.
    await step("loading", "main", async () => {
      await injectDelay(app, CH.listCommits, 9000);
      await injectDelay(app, CH.listPushCommits, 9000);
      await injectDelay(app, CH.stagingStatus, 9000);
      await openPushConfirm(page, repo.dir);
      // Past the 400ms Doherty gate, so a gated skeleton has committed to rendering.
      await page.waitForTimeout(1200);
      await snap(page, "50-loading", { marker: TID.loading, locator: DIALOG });
    });

    // 8. Keyboard focus on the primary control — an affordance, not a detail, on a
    //    surface reached from the palette and a keybinding.
    await step("focus", "main", async () => {
      await openPushConfirm(page, repo.dir);
      await page.locator(TID.commitRow).first().waitFor({ state: "visible", timeout: 8000 });
      await page.locator(SEL.confirmDialog.confirm).focus();
      await snap(page, "60-focus-primary", { marker: SEL.confirmDialog.confirm, locator: DIALOG });
    });

    // 9. prefers-contrast: more — macOS "Increase contrast".
    await step("contrast", "main", async () => {
      await page.emulateMedia({ contrast: "more" });
      await openPushConfirm(page, repo.dir);
      await snap(page, "70-contrast-more", { marker: TID.commitRow, locator: DIALOG });
    });

    // 10. forced-colors: active — Windows high contrast swaps in system colours, and
    //     anything carrying meaning in a tint alone collapses here.
    await step("forced", "main", async () => {
      await page.emulateMedia({ forcedColors: "active" });
      await openPushConfirm(page, repo.dir);
      await snap(page, "75-forced-colors", { marker: TID.commitRow, locator: DIALOG });
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
  console.log(`[git-push-shots] wrote ${written} png(s) to ${OUTPUT_DIR}`);

  if (failures.length > 0) {
    throw new Error(`[git-push-shots] ${failures.length} step(s) failed:\n${failures.join("\n")}`);
  }
  if (written === 0) {
    throw new Error(`[git-push-shots] no PNGs written to ${OUTPUT_DIR}`);
  }
});
