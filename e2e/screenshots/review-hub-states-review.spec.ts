/**
 * Review Hub non-content states visual-review harness (#11985).
 *
 * `ReviewHubContent` switches among eight states around its populated review flow:
 * loading, initial-load failure, base-branch loading, base-branch failure, base-branch
 * empty, working-tree clean (finished vs unpublished), general action failure, push
 * failure, and conflict. Each accumulated separately, so the question the issue asks —
 * "do these read as one visual language?" — can only be answered by seeing them side
 * by side at a real panel width. That is what this harness produces.
 *
 * How each state is reached, and why:
 *
 *   Real git wherever git is deterministic. The fixture is a repo whose MAIN worktree
 *   sits on `main` and whose feature worktree sits on `feature/agent-refactor` — the
 *   split matters, because `fetchBaseBranch` returns early when the current branch IS
 *   the main worktree's branch, so a single-worktree fixture can never reach
 *   base-branch mode at all. A bare remote gives `hasRemote`, a pushed branch plus one
 *   local commit gives `aheadCount > 0` with `behindCount === 0`, which is the only
 *   combination that makes `pushReady` true and renders the clean-state Push button.
 *
 *   IPC fault injection for the failures. `DAINTREE_E2E_FAULT_MODE=1` plus
 *   `e2e/helpers/ipcFaults` makes a real `git:*` invoke reject in the main process, so
 *   the renderer's `window.electron.git.*` promise rejects exactly as it would in
 *   production. This is the app's real data seam, not a UI-level mock — the component
 *   is unaware it is under test, and the error text it renders is the error text the
 *   handler actually threw. Delay faults drive the Doherty gate the same honest way.
 *
 * Steps, and what each is evidence for:
 *
 *   populated       the populated working tree — the geometry every other state is judged against.
 *   loading         initial load below and above the 400ms Doherty gate.
 *   loadfail        initial-load failure and its Retry, at rest and focused.
 *   actionfail      a staging action rejecting — the full-width strip above the scroll area.
 *   basebranch      base-branch mode: populated, loading skeleton, failure.
 *   conflictop      a real merge conflict — `ConflictPanel` owns the frame.
 *   conflictstrip   a stash-pop conflict — unmerged index with no MERGE_HEAD, which is
 *                   the only way to see the local conflict strip above the file list.
 *   cleanunpushed   clean tree with unpushed commits and a live Push.
 *   pushfail        that Push rejecting — the specialised banner stacked over a quiet state.
 *   cleandone       clean tree with nothing left to publish — the genuinely finished state.
 *   basebranchempty no commits ahead of base — the other finished state, for direct comparison.
 *   narrow          the two finished states and the failures at a squeezed panel width.
 *   keyboard        focus rings on every recovery control these states own.
 *   contrast        forced-colors and prefers-contrast: more.
 *   grid            the same states hosted in the panel grid rather than the dialog.
 *
 * Opt-in only, like review-hub-filesection-review: skips itself unless
 * DAINTREE_SHOT_REVIEWSTATES is set, so the marketing screenshots workflow never runs it.
 *
 *   DAINTREE_SHOT_REVIEWSTATES=1 npx playwright test --project=screenshots review-hub-states
 *
 * Env knobs:
 *   DAINTREE_SHOT_REVIEWSTATES  required — any truthy value runs the capture
 *   DAINTREE_SHOT_THEME         optional theme id (default: the app default)
 *   DAINTREE_SHOT_TAG           optional suffix so rounds sit side by side
 *   DAINTREE_SHOT_ONLY          comma-separated step filter (see step names above)
 *   DAINTREE_SHOT_OUT           optional absolute output dir (default: artifacts/reviewstates-shots)
 *
 * Output: <out>/<NN-slug>[-tag].png (gitignored).
 */

import { test, type Page, type ElectronApplication } from "@playwright/test";
import { execSync } from "child_process";
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  existsSync,
  readdirSync,
  readFileSync,
} from "fs";
import { createHash } from "crypto";
import { tmpdir } from "os";
import path from "path";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { openAndOnboardProject } from "../helpers/project";
import { dismissBlockingPalette } from "../helpers/overlays";
import { setAppTheme } from "../helpers/theme";
import { injectFault, injectDelay, clearAllFaults } from "../helpers/ipcFaults";
import { SEL } from "../helpers/selectors";
import { T_LONG, T_MEDIUM } from "../helpers/timeouts";

const ENABLED = !!process.env.DAINTREE_SHOT_REVIEWSTATES;
const THEME = process.env.DAINTREE_SHOT_THEME ?? "";
const TAG = process.env.DAINTREE_SHOT_TAG ? `-${process.env.DAINTREE_SHOT_TAG}` : "";
const SCALE = process.env.DAINTREE_SCREENSHOT_SCALE ?? "2";
const OUTPUT_DIR =
  process.env.DAINTREE_SHOT_OUT ?? path.resolve(process.cwd(), "artifacts", "reviewstates-shots");

const WIDE = { width: 1680, height: 1050 };
const NARROW = { width: 900, height: 1050 };

const FEATURE_BRANCH = "feature/agent-refactor";

/** The review body — the element every state shot is scoped to. */
const CONTENT = '[data-testid="review-hub-content"]';
/** The clean-state Push, and the push banner's own detail disclosure. */
const CLEAN_PUSH = '[data-testid="review-hub-clean-push"]';
/** Proof the divergence data reached the UI — the marker `cleandone` waits to LOSE. */
const CLEAN_UNPUSHED = '[data-testid="review-hub-clean-unpushed"]';
const PUSH_TOGGLE = '[data-testid="review-hub-push-error-toggle"]';
const REFRESH = '[aria-label="Refresh"]';

/** Channels this harness injects on. Names come from `electron/ipc/channels.ts`. */
const CH = {
  stagingStatus: "git:get-staging-status",
  compare: "git:compare-worktrees",
  unstageAll: "git:unstage-all",
  push: "git:push",
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
 * The skeleton steps are the one exception to POLISH_CSS: zeroing animation
 * duration makes `animate-pulse-delayed` paint at whatever keyframe offset 0
 * happens to be, so the Doherty-gated skeleton would be captured at an
 * arbitrary opacity. These steps re-enable animation on the skeleton only.
 */
const SKELETON_ANIMATION_CSS = `
  [data-testid="review-hub-content"] [class*="animate-pulse"] {
    animation-duration: 2s !important;
    animation-delay: 0s !important;
  }
`;

function git(cmd: string, cwd: string): void {
  execSync(`git ${cmd}`, { cwd, stdio: "ignore" });
}

/** Same command, but the caller expects it to fail (conflicts return non-zero). */
function gitAllowFail(cmd: string, cwd: string): void {
  try {
    execSync(`git ${cmd}`, { cwd, stdio: "ignore" });
  } catch {
    /* expected — conflict paths exit non-zero by design */
  }
}

/** Deterministic filler so churn numbers are large and stable across runs. */
function lines(prefix: string, n: number): string {
  return Array.from({ length: n }, (_, i) => `${prefix} line ${i + 1};`).join("\n") + "\n";
}

interface Fixture {
  dir: string;
  worktreeDir: string;
  cleanup: () => void;
}

/**
 * A repo whose MAIN worktree stays on `main`, plus a feature worktree that is the
 * subject of every shot.
 *
 * The two-worktree shape is load-bearing rather than decorative. `mainBranch` is read
 * off whichever worktree reports `isMainWorktree`, and `fetchBaseBranch` bails when the
 * current branch equals it — so a fixture that reviews the main worktree can never
 * reach base-branch mode, and half this issue's capture matrix would silently produce
 * working-tree shots instead.
 *
 * The bare remote is equally load-bearing: without `hasRemote` the clean state renders
 * its "No changes to commit" branch unconditionally, and the unpushed-commits branch —
 * the one the issue is actually asking about — is unreachable.
 */
function createFixtureRepo(): Fixture {
  const dir = mkdtempSync(path.join(tmpdir(), "daintree-reviewstates-shots-"));
  const wtRoot = path.join(path.dirname(dir), path.basename(dir) + "-worktrees");
  const remoteDir = path.join(path.dirname(dir), path.basename(dir) + "-remote.git");
  mkdirSync(wtRoot, { recursive: true });

  git("init -b main", dir);
  git('config user.email "test@daintree.dev"', dir);
  git('config user.name "Daintree Test"', dir);

  const write = (rel: string, body: string, root = dir): void => {
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  };

  // ---- committed baseline on main ----------------------------------------
  write("README.md", "# Helios Dashboard\n");
  write("package.json", JSON.stringify({ name: "helios", version: "1.0.0" }, null, 2) + "\n");
  write("src/renderer/orchestration/OrchestrationPreferencesPanel.tsx", lines("panel", 220));
  write("src/renderer/orchestration/useOrchestrationScheduler.ts", lines("sched", 140));
  write("src/main/services/workspace/WorkspaceReconciliationService.ts", lines("recon", 260));
  write("src/shared/config/agents/anthropic/claudeCodeAgentDefinition.ts", lines("agent", 180));
  write("src/renderer/components/CommandPalette/CommandPaletteResultRow.tsx", lines("row", 160));
  write("src/renderer/store/worktreeTopologyStore.ts", lines("topo", 200));
  write("docs/architecture/notification-system.md", lines("- doc", 120));
  write("conflict-target.ts", lines("shared", 40));
  git("add -A", dir);
  git('commit -m "initial commit"', dir);

  // ---- a bare remote, so hasRemote is true and ahead/behind are real ------
  execSync(`git init --bare ${JSON.stringify(remoteDir)}`, { stdio: "ignore" });
  git(`remote add origin ${JSON.stringify(remoteDir)}`, dir);
  git("push -u origin main", dir);

  // ---- a branch that will conflict with the feature branch later ----------
  git("checkout -b conflict-source", dir);
  write("conflict-target.ts", lines("SOURCE-SIDE", 40));
  git("add -A", dir);
  git('commit -m "rewrite the shared module from the source side"', dir);
  git("checkout main", dir);

  // ---- the feature worktree: three commits ahead of main, pushed ---------
  git(`worktree add -b ${FEATURE_BRANCH} ${JSON.stringify(wtRoot)}/agent-refactor main`, dir);
  const worktreeDir = path.join(wtRoot, "agent-refactor");

  write("src/renderer/orchestration/OrchestrationPreferencesPanel.tsx", lines("panel-v2", 420), worktreeDir); // prettier-ignore
  write("src/renderer/orchestration/preferences/AdvancedConcurrencySection.tsx", lines("adv", 180), worktreeDir); // prettier-ignore
  git("add -A", worktreeDir);
  git('commit -m "rework the orchestration preferences panel"', worktreeDir);

  write("src/main/services/workspace/WorkspaceReconciliationService.ts", lines("recon-v2", 380), worktreeDir); // prettier-ignore
  git("add -A", worktreeDir);
  git('commit -m "reconcile workspace state on worktree add"', worktreeDir);

  write("conflict-target.ts", lines("FEATURE-SIDE", 40), worktreeDir);
  git("add -A", worktreeDir);
  git('commit -m "rewrite the shared module from the feature side"', worktreeDir);

  git(`push -u origin ${FEATURE_BRANCH}`, worktreeDir);

  // One more commit AFTER the push — this is what makes aheadCount 1 with
  // behindCount 0, the only combination that renders the clean-state Push.
  write("docs/architecture/notification-system.md", lines("- doc v2", 200), worktreeDir);
  git("add -A", worktreeDir);
  git('commit -m "document the reconciliation notifications"', worktreeDir);

  // ---- the dirty working tree the populated shots need -------------------
  write("src/shared/config/agents/anthropic/claudeCodeAgentDefinition.ts", lines("agent-v2", 340), worktreeDir); // prettier-ignore
  write("src/renderer/components/CommandPalette/CommandPaletteResultRow.tsx", lines("row-v2", 300), worktreeDir); // prettier-ignore
  write("src/renderer/store/worktreeTopologyStore.ts", lines("topo-v2", 430), worktreeDir);
  write("src/renderer/orchestration/useOrchestrationScheduler.ts", lines("sched-v2", 310), worktreeDir); // prettier-ignore

  return {
    dir,
    worktreeDir,
    cleanup: () => {
      for (const target of [wtRoot, remoteDir, dir]) {
        try {
          if (existsSync(target)) rmSync(target, { recursive: true, force: true });
        } catch {
          /* best effort */
        }
      }
    },
  };
}

async function settle(page: Page, ms = 350): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
  );
  await page.waitForTimeout(ms);
}

const written: string[] = [];

/**
 * Wait until a marker proves the app actually reached the state, and THROW if it
 * does not.
 *
 * This exists because the first run of this harness wrote twelve PNGs that
 * collapsed into four distinct images: base-branch populated/skeleton/failure
 * were one identical file, and clean-with-unpushed/nothing-to-publish were
 * another. Every one of them was a timer-based `settle()` firing before the
 * state changed, so the step "passed" and produced confident, wrong evidence —
 * which is worse than failing, because a review then gets scored against it.
 * Snapping on an assertion rather than a delay is the only thing that prevents
 * it.
 */
async function expectState(
  page: Page,
  selector: string,
  opts: { hidden?: boolean; label: string; timeout?: number }
): Promise<void> {
  try {
    await page
      .locator(selector)
      .first()
      .waitFor({ state: opts.hidden ? "hidden" : "visible", timeout: opts.timeout ?? 15_000 });
  } catch {
    throw new Error(
      `[reviewstates-shots] state "${opts.label}" never materialised — ` +
        `${selector} was not ${opts.hidden ? "hidden" : "visible"}. Refusing to shoot a wrong-state PNG.`
    );
  }
}

async function snap(page: Page, slug: string, locator?: string): Promise<void> {
  await settle(page);
  const file = path.join(OUTPUT_DIR, `${slug}${TAG}.png`);
  if (locator) {
    await page.locator(locator).last().screenshot({ path: file, type: "png" });
  } else {
    await page.screenshot({ path: file, type: "png", animations: "disabled", caret: "hide" });
  }
  written.push(path.basename(file));
}

/** The review body in one frame — the comparison the issue is actually about. */
async function snapBody(page: Page, slug: string): Promise<void> {
  await snap(page, slug, CONTENT);
}

/**
 * Shoot without waiting out a settle — the pre-Doherty window is 400ms wide, and
 * `snap`'s default 350ms wait plus two rAFs would land on the far side of it.
 */
async function snapNow(page: Page, slug: string, locator?: string): Promise<void> {
  const file = path.join(OUTPUT_DIR, `${slug}${TAG}.png`);
  if (locator) {
    await page.locator(locator).last().screenshot({ path: file, type: "png", timeout: 4000 });
  } else {
    await page.screenshot({ path: file, type: "png", caret: "hide" });
  }
  written.push(path.basename(file));
}

async function setWindowSize(
  app: ElectronApplication,
  size: { width: number; height: number }
): Promise<void> {
  await app.evaluate(({ BrowserWindow }, target) => {
    const win = BrowserWindow.getAllWindows()[0];
    win?.setSize(target.width, target.height);
  }, size);
}

const ONLY = (process.env.DAINTREE_SHOT_ONLY ?? "").split(",").filter(Boolean);

// A failed step must not abort the run — the other shots are still worth having. But
// the run must still FAIL, or a silent exit 0 with an empty output directory reads as
// success.
const failures: string[] = [];
async function step(name: string, fn: () => Promise<void>, reset: () => Promise<void>) {
  if (ONLY.length > 0 && !ONLY.includes(name)) return;
  try {
    await fn();
  } catch (error) {
    const detail = String(error).slice(0, 300);
    console.warn(`[reviewstates-shots] step "${name}" failed:`, detail);
    failures.push(`${name}: ${detail}`);
  } finally {
    await reset().catch((error) => {
      failures.push(`${name} (reset): ${String(error).slice(0, 200)}`);
    });
  }
}

test("review hub states review — the states around the populated review flow", async () => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_REVIEWSTATES is required for the review-states capture",
  });
  test.skip(!ENABLED, "Set DAINTREE_SHOT_REVIEWSTATES to run the review-states capture");

  failures.length = 0;
  written.length = 0;

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const repo = createFixtureRepo();
  const userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-reviewstatesshot-"));
  let ctx: AppContext | undefined;

  try {
    ctx = await launchApp({
      userDataDir,
      screenshotScale: SCALE,
      windowSize: WIDE,
      // Fault mode is what lets a real `git:*` invoke reject in the main process,
      // so the renderer sees a genuine IPC rejection rather than a stubbed one.
      env: { DAINTREE_E2E_FAULT_MODE: "1" },
      extraArgs: ["--disable-gpu", "--in-process-gpu", "--disable-breakpad", "--noerrdialogs"],
    });
    const page = await openAndOnboardProject(ctx.app, ctx.window, repo.dir, "Helios Dashboard");
    if (THEME) await setAppTheme(page, THEME);
    await page.addStyleTag({ content: POLISH_CSS }).catch(() => {});
    await dismissBlockingPalette(page);
    await page
      .locator(SEL.worktree.mainCard)
      .waitFor({ state: "visible", timeout: T_LONG })
      .catch(() => {});
    await settle(page, 1500);
    await dismissBlockingPalette(page);

    const app = ctx.app;
    const hub = page.locator(SEL.reviewHub.container);
    const featureCard = page.locator(SEL.worktree.card(FEATURE_BRANCH));

    /**
     * Open Review & Commit on the FEATURE worktree — never the main one.
     *
     * The card's opener is not always there: `WorktreeDetailsSection` renders it
     * only while `hasChanges || isUnpushedClean`, so it VANISHES for exactly the
     * two finished states this issue is most about. The context menu carries the
     * same command unconditionally, so it is the fallback rather than the
     * primary — clicking the button when it exists is the path a user takes.
     */
    const openHub = async (): Promise<void> => {
      await dismissBlockingPalette(page);
      await featureCard.waitFor({ state: "visible", timeout: T_LONG });
      const opener = featureCard.locator(SEL.worktree.reviewHubButton).first();
      if (await opener.isVisible().catch(() => false)) {
        await opener.click();
      } else {
        await featureCard.click({ button: "right" });
        await page.locator('[role="menu"]').waitFor({ state: "visible", timeout: T_MEDIUM });
        await page
          .getByRole("menuitem", { name: /Review & Commit/i })
          .first()
          .click();
      }
      await hub.waitFor({ state: "visible", timeout: T_MEDIUM });
      await page.locator(CONTENT).waitFor({ state: "visible", timeout: T_MEDIUM });
    };

    const closeHub = async (): Promise<void> => {
      for (let i = 0; i < 4; i++) {
        if (!(await hub.isVisible().catch(() => false))) return;
        await page.keyboard.press("Escape").catch(() => {});
        await settle(page, 250);
      }
    };

    /** Close, reopen — the only way to replay the initial-load path. */
    const reopenHub = async (): Promise<void> => {
      await closeHub();
      await settle(page, 300);
      await openHub();
    };

    const expandFileList = async (): Promise<void> => {
      const toggle = hub.locator(SEL.reviewHub.fileListToggle);
      if (!(await toggle.isVisible().catch(() => false))) return;
      if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
      await settle(page, 400);
    };

    /**
     * Flip the working-tree / base-branch segmented control.
     *
     * By index, not by label: the second button reads "vs {mainBranch}", so a
     * text selector would have to know the fixture's branch name, and it is
     * `disabled` whenever the current branch IS the main branch — which is
     * exactly the misconfiguration this harness's two-worktree fixture exists
     * to avoid, so it is worth failing loudly on rather than silently skipping.
     */
    const setDiffMode = async (mode: "working-tree" | "base-branch"): Promise<void> => {
      const button = page
        .locator(`${SEL.reviewHub.diffMode} button`)
        .nth(mode === "base-branch" ? 1 : 0);
      await button.click();
      await settle(page, 600);
    };

    /**
     * Put the fixture into a NAMED git state, from whatever state it is in.
     *
     * Steps used to mutate git in sequence and rely on the previous step having
     * run. `DAINTREE_SHOT_ONLY` then silently produced shots of the WRONG state
     * — the narrow and prefers-contrast steps captured a populated working tree
     * while claiming to show a clean one, because the steps that clean the tree
     * had been filtered out. A capture harness whose steps are order-dependent
     * cannot be re-run piecemeal, which is exactly what you need when one step
     * fails. Every state-dependent step now declares what it needs.
     */
    const setGitState = async (
      kind: "dirty" | "clean-unpushed" | "clean-done" | "base-empty" | "conflicted"
    ): Promise<void> => {
      const wt = repo.worktreeDir;
      gitAllowFail("merge --abort", wt);
      gitAllowFail("rebase --abort", wt);
      git("reset --hard HEAD", wt);
      git("clean -fd", wt);
      // Back to the pushed tip, so every branch below starts from one baseline.
      git(`reset --hard origin/${FEATURE_BRANCH}`, wt);

      if (kind === "clean-done") return; // ahead 0, behind 0, nothing to publish

      if (kind === "base-empty") {
        git("reset --hard main", wt);
        return;
      }

      if (kind === "conflicted") {
        // A genuinely unmerged index with NO operation in progress — the only
        // way to reach the local conflict strip, because MERGING/REBASING hand
        // the frame to ConflictPanel instead. Stash a change to a file, commit
        // an incompatible change to that same file, then pop: git leaves UU
        // entries and no MERGE_HEAD. The earlier attempt used `merge -X ours`,
        // which auto-resolved and produced no conflict at all.
        writeFileSync(path.join(wt, "conflict-target.ts"), lines("STASHED-SIDE", 40));
        git("stash push -u -m reviewstates-conflict", wt);
        writeFileSync(path.join(wt, "conflict-target.ts"), lines("COMMITTED-SIDE", 40));
        git("add -A", wt);
        git('commit -m "rewrite the shared module incompatibly"', wt);
        gitAllowFail("stash pop", wt);
        return;
      }

      // Both remaining states need one unpushed commit (ahead 1, behind 0) —
      // the only combination that makes `pushReady` true.
      writeFileSync(
        path.join(wt, "docs/architecture/notification-system.md"),
        lines("- doc v2", 200)
      );
      git("add -A", wt);
      git('commit -m "document the reconciliation notifications"', wt);
      if (kind === "clean-unpushed") return;

      // dirty: put the working-tree changes back on top.
      writeFileSync(path.join(wt, "src/shared/config/agents/anthropic/claudeCodeAgentDefinition.ts"), lines("agent-v2", 340)); // prettier-ignore
      writeFileSync(path.join(wt, "src/renderer/components/CommandPalette/CommandPaletteResultRow.tsx"), lines("row-v2", 300)); // prettier-ignore
      writeFileSync(
        path.join(wt, "src/renderer/store/worktreeTopologyStore.ts"),
        lines("topo-v2", 430)
      );
      writeFileSync(path.join(wt, "src/renderer/orchestration/useOrchestrationScheduler.ts"), lines("sched-v2", 310)); // prettier-ignore
    };

    /** Apply a git state and remount so the hub actually reads it. */
    const useGitState = async (
      kind: "dirty" | "clean-unpushed" | "clean-done" | "base-empty" | "conflicted"
    ): Promise<void> => {
      await closeHub();
      await setGitState(kind);
      await settle(page, 400);
      await openHub();
      await settle(page, 900);
    };

    await openHub();
    await expandFileList();
    await settle(page, 800);

    /**
     * A reset that returns to the documented rest state rather than assuming it.
     *
     * The close/reopen is NOT optional, and leaving it out cost a whole capture
     * run. Clearing an injected fault does not re-fetch: after a `loadfail` step
     * the component still holds `loadError` with `status === null`, which leaves
     * the "vs {main}" toggle `disabled` and the file list unmounted for every
     * step that follows. Five later steps timed out on controls that were never
     * coming back. Only a fresh mount re-runs the initial fetch, so `rest`
     * remounts and then waits for status to actually resolve.
     */
    const rest = async (): Promise<void> => {
      await clearAllFaults(app).catch(() => {});
      await setWindowSize(app, WIDE);
      await page.emulateMedia({ forcedColors: "none", contrast: "no-preference" }).catch(() => {});
      await page.addStyleTag({ content: POLISH_CSS }).catch(() => {});
      await settle(page, 300);
      await closeHub();
      await settle(page, 300);
      await openHub();
      // Status resolved == either the file list toggle or a resolved empty
      // state is on screen. Without this the next step races the fetch.
      await page
        .locator(
          `${SEL.reviewHub.fileListToggle}, ${CONTENT} [data-testid="review-hub-clean-unpushed"], ${CONTENT} p`
        )
        .first()
        .waitFor({ state: "visible", timeout: T_MEDIUM })
        .catch(() => {});
      await settle(page, 400);
      await setDiffMode("working-tree").catch(() => {});
    };

    // ── the populated baseline every other state is judged against ─────────

    await step(
      "populated",
      async () => {
        await snapBody(page, "10-populated-working-tree");
        await snap(page, "11-populated-window");
      },
      rest
    );

    // ── loading: below and above the 400ms Doherty gate ───────────────────

    await step(
      "loading",
      async () => {
        await page.addStyleTag({ content: SKELETON_ANIMATION_CSS }).catch(() => {});
        await injectDelay(app, CH.stagingStatus, 4000);
        await closeHub();
        await settle(page, 300);
        await openHub();
        // Inside the gate: the surface must show NOTHING, not a spinner.
        await page.waitForTimeout(180);
        await snapNow(page, "20-loading-inside-doherty-gate", CONTENT);
        // Past the gate: the skeleton, whose geometry must match what resolves.
        await page.waitForTimeout(700);
        await snapNow(page, "21-loading-skeleton", CONTENT);
        await snapNow(page, "22-loading-skeleton-window");
        await clearAllFaults(app);
        await page.waitForTimeout(4200);
        await settle(page, 600);
        await snapBody(page, "23-loading-resolved-for-comparison");
      },
      rest
    );

    // ── initial-load failure ──────────────────────────────────────────────

    await step(
      "loadfail",
      async () => {
        await injectFault(
          app,
          CH.stagingStatus,
          "fatal: not a git repository (or any of the parent directories): .git"
        );
        await reopenHub();
        await settle(page, 900);
        await snapBody(page, "30-initial-load-failure");
        await snap(page, "31-initial-load-failure-window");
        // The Retry control focused — this is the only recovery the state offers.
        await page
          .locator(`${CONTENT} button:has-text("Retry")`)
          .first()
          .focus()
          .catch(() => {});
        await settle(page, 250);
        await snapBody(page, "32-initial-load-failure-retry-focused");
      },
      rest
    );

    // ── a staging action rejecting ────────────────────────────────────────

    await step(
      "actionfail",
      async () => {
        await expandFileList();
        await injectFault(
          app,
          CH.unstageAll,
          "error: unable to write new index file\nfatal: Unable to write new index file"
        );
        await page.locator(SEL.reviewHub.unstageAllButton).first().click();
        await settle(page, 1200);
        await snapBody(page, "40-action-failure");
        await snap(page, "41-action-failure-window");
      },
      rest
    );

    // ── base-branch mode: populated, loading, failure ─────────────────────

    await step(
      "basebranch",
      async () => {
        await useGitState("dirty");
        await setDiffMode("base-branch");
        await expectState(
          page,
          `${CONTENT} [data-testid="base-branch-file-row"], ${CONTENT} span:has-text("Changed vs")`,
          { label: "base-branch populated" }
        );
        await snapBody(page, "50-base-branch-populated");

        // Remount rather than round-tripping the toggle. `fetchBaseBranch` runs
        // on entering base-branch mode; toggling out and back inside one React
        // batch did NOT re-fire it, so the delay and error faults landed on a
        // view that never re-fetched and five shots came out byte-identical.
        await page.addStyleTag({ content: SKELETON_ANIMATION_CSS }).catch(() => {});
        await injectDelay(app, CH.compare, 4000);
        await closeHub();
        await openHub();
        await setDiffMode("base-branch");
        await page.waitForTimeout(700);
        await snapNow(page, "52-base-branch-skeleton", CONTENT);
        await clearAllFaults(app);
        await page.waitForTimeout(4200);

        await injectFault(
          app,
          CH.compare,
          "fatal: ambiguous argument 'main...feature/agent-refactor': unknown revision or path not in the working tree"
        );
        await closeHub();
        await openHub();
        await setDiffMode("base-branch");
        await expectState(page, `${CONTENT} button:has-text("Retry")`, {
          label: "base-branch failure",
        });
        await snapBody(page, "53-base-branch-failure");
        await snap(page, "54-base-branch-failure-window");
        // Tab, never .focus() — programmatic focus does not match
        // :focus-visible in Chromium, which is why the earlier focus shot came
        // out byte-identical to its unfocused sibling.
        await page.keyboard.press("Tab");
        await page.keyboard.press("Tab");
        await settle(page, 250);
        await snapBody(page, "55-base-branch-failure-tabbed");
      },
      rest
    );

    // ── a real merge conflict: ConflictPanel owns the frame ───────────────

    await step(
      "conflictop",
      async () => {
        await closeHub();
        await setGitState("dirty");
        git("stash push -u -m reviewstates-preconflict", repo.worktreeDir);
        gitAllowFail("merge conflict-source", repo.worktreeDir);
        await openHub();
        await expectState(page, `${CONTENT} :text("conflict")`, {
          label: "conflict operation",
        });
        await snapBody(page, "60-conflict-operation");
        await snap(page, "61-conflict-operation-window");
      },
      async () => {
        await closeHub();
        gitAllowFail("merge --abort", repo.worktreeDir);
        gitAllowFail("stash drop", repo.worktreeDir);
        await rest();
      }
    );

    // ── an unmerged index with NO operation: the local conflict strip ─────

    await step(
      "conflictstrip",
      async () => {
        await useGitState("conflicted");
        await expandFileList();
        await expectState(page, `${CONTENT} :text("conflicted file")`, {
          label: "conflict strip",
        });
        await snapBody(page, "65-conflict-strip");
        await snap(page, "66-conflict-strip-window");
      },
      async () => {
        await closeHub();
        gitAllowFail("stash drop", repo.worktreeDir);
        await rest();
      }
    );

    // ── clean tree with unpushed commits ──────────────────────────────────

    await step(
      "cleanunpushed",
      async () => {
        await useGitState("clean-unpushed");
        await expectState(page, `${CONTENT} ${CLEAN_UNPUSHED}`, { label: "clean with unpushed" });
        await snapBody(page, "70-clean-with-unpushed-commits");
        await snap(page, "71-clean-with-unpushed-commits-window");
        // Tab into Push rather than focusing it — see the base-branch note.
        await page.locator(CONTENT).click({ position: { x: 5, y: 5 } });
        for (let i = 0; i < 12; i++) {
          await page.keyboard.press("Tab");
          if (await page.locator(`${CLEAN_PUSH}:focus`).count()) break;
        }
        await settle(page, 250);
        await snapBody(page, "72-clean-unpushed-push-tabbed");
      },
      rest
    );

    // ── that Push rejecting — the specialised banner over a quiet state ───

    await step(
      "pushfail",
      async () => {
        await useGitState("clean-unpushed");
        await expectState(page, `${CONTENT} ${CLEAN_PUSH}`, { label: "push available" });
        await injectFault(
          app,
          CH.push,
          "! [rejected]        feature/agent-refactor -> feature/agent-refactor (non-fast-forward)\nerror: failed to push some refs\nhint: Updates were rejected because the remote contains work that you do not have locally."
        );
        await page.locator(CLEAN_PUSH).click();
        // The clean-state Push is a D2 destructive action: it only REQUESTS a
        // push, and the globally-mounted preview dialog is what dispatches it
        // (#7880 safeguards). Without confirming here the step would capture
        // the confirm dialog and never reach the push-error banner at all.
        await page
          .locator(SEL.reviewHub.pushConfirmMessage)
          .waitFor({ state: "visible", timeout: T_MEDIUM })
          .catch(() => {});
        await page
          .locator(SEL.confirmDialog.confirm)
          .click()
          .catch(() => {});
        await expectState(page, SEL.reviewHub.pushError, { label: "push failure banner" });
        await snapBody(page, "75-push-failure-over-clean-state");
        await snap(page, "76-push-failure-window");
        // The detail disclosure exists only when the classified reason opts
        // into `detailPolicy: "collapse"`. Shooting unconditionally produced a
        // byte-identical duplicate of the shot above, so only shoot it when the
        // control is genuinely there.
        if (await page.locator(PUSH_TOGGLE).count()) {
          await page.locator(PUSH_TOGGLE).click();
          await expectState(page, '[data-testid="review-hub-push-error-details"]', {
            label: "push details expanded",
          });
          await snapBody(page, "77-push-failure-details-expanded");
        } else {
          console.log("[reviewstates-shots] no push-detail toggle for this reason — shot skipped");
        }
      },
      rest
    );

    // ── clean tree with nothing left to publish — genuinely finished ──────

    await step(
      "cleandone",
      async () => {
        await useGitState("clean-done");
        // Assert the divergence actually reached the UI. The worktree store
        // polls independently of the hub's own fetch, so a fixed settle here
        // captured a stale "1 commit not pushed" and produced a shot identical
        // to the unpushed state — the opposite of what this step documents.
        await expectState(page, `${CONTENT} ${CLEAN_UNPUSHED}`, {
          hidden: true,
          label: "nothing left to publish",
          timeout: 30_000,
        });
        await snapBody(page, "80-clean-nothing-to-publish");
        await snap(page, "81-clean-nothing-to-publish-window");
      },
      rest
    );

    // ── no commits ahead of base — the OTHER finished state ───────────────

    await step(
      "basebranchempty",
      async () => {
        await useGitState("base-empty");
        await setDiffMode("base-branch");
        await expectState(page, `${CONTENT} :text("No changes vs")`, {
          label: "no changes vs base",
        });
        await snapBody(page, "85-base-branch-empty");
        await snap(page, "86-base-branch-empty-window");
        await setDiffMode("working-tree");
        await settle(page, 900);
        await snapBody(page, "87-clean-state-for-direct-comparison");
      },
      rest
    );

    // ── narrow ────────────────────────────────────────────────────────────

    await step(
      "narrow",
      async () => {
        await useGitState("clean-unpushed");
        await setWindowSize(app, NARROW);
        await settle(page, 900);
        await expectState(page, `${CONTENT} ${CLEAN_UNPUSHED}`, { label: "narrow clean state" });
        await snapBody(page, "90-narrow-clean-state");
        await snap(page, "91-narrow-window");
        await injectFault(app, CH.stagingStatus, "fatal: unable to read the index file");
        await reopenHub();
        await expectState(page, `${CONTENT} button:has-text("Retry")`, {
          label: "narrow load failure",
        });
        await snapBody(page, "92-narrow-load-failure");
        await clearAllFaults(app);
        await reopenHub();
        await setDiffMode("base-branch");
        await settle(page, 1200);
        await snapBody(page, "93-narrow-base-branch");
      },
      rest
    );

    // ── keyboard ──────────────────────────────────────────────────────────

    await step(
      "keyboard",
      async () => {
        await useGitState("dirty");
        await injectFault(app, CH.compare, "fatal: bad revision 'main'");
        await setDiffMode("base-branch");
        await expectState(page, `${CONTENT} button:has-text("Retry")`, {
          label: "base-branch failure for keyboard",
        });
        await page.keyboard.press("Tab");
        await page.keyboard.press("Tab");
        await settle(page, 250);
        await snapBody(page, "94-keyboard-into-base-branch-failure");
        await clearAllFaults(app);
        await useGitState("clean-unpushed");
        await expectState(page, `${CONTENT} ${CLEAN_UNPUSHED}`, { label: "clean for keyboard" });
        await page.keyboard.press("Tab");
        await settle(page, 250);
        await snapBody(page, "95-keyboard-into-clean-state");
      },
      rest
    );

    // ── contrast ──────────────────────────────────────────────────────────

    await step(
      "contrast",
      async () => {
        await useGitState("clean-unpushed");
        await page.emulateMedia({ contrast: "more" });
        await settle(page, 600);
        await expectState(page, `${CONTENT} ${CLEAN_UNPUSHED}`, { label: "contrast clean" });
        await snapBody(page, "96-prefers-contrast-more-clean");
        await injectFault(app, CH.stagingStatus, "fatal: unable to read the index file");
        await reopenHub();
        await expectState(page, `${CONTENT} button:has-text("Retry")`, {
          label: "contrast failure",
        });
        await snapBody(page, "97-prefers-contrast-more-failure");
        await page.emulateMedia({ contrast: "no-preference", forcedColors: "active" });
        await settle(page, 600);
        await snapBody(page, "98-forced-colors-failure");
        await clearAllFaults(app);
        await reopenHub();
        await expectState(page, `${CONTENT} ${CLEAN_UNPUSHED}`, { label: "forced-colors clean" });
        await snapBody(page, "99-forced-colors-clean");
      },
      rest
    );

    // ── the same states, hosted in the grid rather than the dialog ────────

    await step(
      "grid",
      async () => {
        await closeHub();
        await dismissBlockingPalette(page);
        await featureCard.click();
        await settle(page, 500);
        await page.keyboard.press("ControlOrMeta+KeyK");
        await settle(page, 500);
        await page.keyboard.type("Review");
        await settle(page, 600);
        await page.keyboard.press("Enter");
        await settle(page, 2500);
        await page.locator(CONTENT).waitFor({ state: "visible", timeout: T_LONG });
        await snapBody(page, "A0-grid-hosted-clean-state");
        await snap(page, "A1-grid-hosted-window");
        await injectFault(app, CH.stagingStatus, "fatal: unable to read the index file");
        await page
          .locator(`${CONTENT} ${REFRESH}`)
          .first()
          .click()
          .catch(() => {});
        await settle(page, 1200);
        await snapBody(page, "A2-grid-hosted-load-failure");
      },
      async () => {
        await clearAllFaults(app).catch(() => {});
        await settle(page, 300);
      }
    );
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

  // Count the artifacts rather than trusting the step loop: a harness that exits 0 with
  // an empty output directory is worse than one that fails.
  const onDisk = existsSync(OUTPUT_DIR)
    ? readdirSync(OUTPUT_DIR).filter((f) => f.endsWith(`${TAG}.png`))
    : [];
  console.log(`[reviewstates-shots] wrote ${written.length} shot(s), ${onDisk.length} on disk`);

  if (failures.length > 0) {
    throw new Error(
      `[reviewstates-shots] ${failures.length} step(s) failed:\n${failures.join("\n")}`
    );
  }
  if (written.length === 0) {
    throw new Error("[reviewstates-shots] no screenshots were written");
  }
  if (onDisk.length < written.length) {
    throw new Error(
      `[reviewstates-shots] wrote ${written.length} shot(s) but only ${onDisk.length} landed on disk`
    );
  }

  // Two shots of DIFFERENT states must never be the same image. When they are,
  // the harness captured before the state changed and the whole set silently
  // stops being evidence. Distinct states are the entire point of this capture,
  // so an identical pair is a hard failure rather than a warning.
  const byHash = new Map<string, string[]>();
  for (const file of onDisk) {
    const hash = createHash("md5")
      .update(readFileSync(path.join(OUTPUT_DIR, file)))
      .digest("hex");
    byHash.set(hash, [...(byHash.get(hash) ?? []), file]);
  }
  const dupes = [...byHash.values()].filter((group) => group.length > 1);
  if (dupes.length > 0) {
    throw new Error(
      `[reviewstates-shots] ${dupes.length} group(s) of DIFFERENT states rendered byte-identical — ` +
        `the capture raced the state change:\n${dupes.map((g) => g.join(" == ")).join("\n")}`
    );
  }
});
