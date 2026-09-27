/**
 * Review Hub conflict panel visual-review harness.
 *
 * `ConflictPanel` takes over the Review Hub body whenever a merge, rebase, or
 * cherry-pick stops on conflicts. It is reached only through a real git
 * operation, so every state here is produced by real git in a throwaway repo and
 * read by the app through its normal staging-status IPC — nothing is mocked.
 *
 * Steps, and what each is evidence for:
 *
 *   merge        a merge stopped on four conflicts of three kinds (both modified,
 *                deleted by them, added by both) plus auto-merged files, which land
 *                in the Resolved group. Rest, row hover, Resolved expanded, one file
 *                marked resolved.
 *   keyboard     focus rings on a row action and on Abort.
 *   confirm      the Abort and Take-ours confirmations.
 *   allresolved  every conflict staged: the empty state and an enabled Continue.
 *   rebase       a rebase stopped mid-sequence, so the sequence rail shows done,
 *                current, pending, fixup-nested and dropped commits.
 *   narrow       merge and rebase at a squeezed window width.
 *   themes       merge across four palettes, dark and light.
 *   contrast     forced-colors and prefers-contrast: more.
 *
 * Opt-in only: skips itself unless DAINTREE_SHOT_CONFLICTPANEL is set.
 *
 *   DAINTREE_SHOT_CONFLICTPANEL=1 DESIGN_CAPTURE_DIR=/abs/dir \
 *     npx playwright test --project=screenshots conflict-panel-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_CONFLICTPANEL  required — any truthy value runs the capture
 *   DESIGN_CAPTURE_DIR           optional absolute output dir (default: artifacts/conflictpanel-shots)
 *   DAINTREE_SHOT_ONLY           comma-separated step filter (see step names above)
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
import { SEL } from "../helpers/selectors";
import { T_LONG, T_MEDIUM } from "../helpers/timeouts";

const ENABLED = !!process.env.DAINTREE_SHOT_CONFLICTPANEL;
const SCALE = process.env.DAINTREE_SCREENSHOT_SCALE ?? "2";
const OUTPUT_DIR =
  process.env.DESIGN_CAPTURE_DIR ?? path.resolve(process.cwd(), "artifacts", "conflictpanel-shots");
const ONLY = (process.env.DAINTREE_SHOT_ONLY ?? "").split(",").filter(Boolean);

const WIDE = { width: 1680, height: 1050 };
const NARROW = { width: 900, height: 1050 };
const FEATURE_BRANCH = "feature/agent-refactor";
const SPOT_THEMES = ["daintree", "namib", "bali", "atacama"];

const PANEL = '[data-testid="conflict-panel"]';
const CONTENT = '[data-testid="review-hub-content"]';

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

function git(cmd: string, cwd: string, env?: Record<string, string>): void {
  execSync(`git ${cmd}`, { cwd, stdio: "ignore", env: { ...process.env, ...env } });
}

function gitAllowFail(cmd: string, cwd: string, env?: Record<string, string>): void {
  try {
    git(cmd, cwd, env);
  } catch {
    /* expected — conflict paths exit non-zero by design */
  }
}

function lines(prefix: string, n: number): string {
  return Array.from({ length: n }, (_, i) => `${prefix} line ${i + 1};`).join("\n") + "\n";
}

/** Several separated edits, so one file carries more than one conflict region. */
function regions(prefix: string, n: number, every: number): string {
  return (
    Array.from({ length: n }, (_, i) =>
      i % every === 0 ? `${prefix} edit ${i + 1};` : `shared line ${i + 1};`
    ).join("\n") + "\n"
  );
}

const MERGE_FILES = {
  deep: "src/renderer/components/Orchestration/Preferences/AdvancedConcurrencySchedulingSection.tsx",
  store: "src/renderer/store/worktreeTopologyStore.ts",
  deleted: "src/main/services/legacy/LegacyWorkspaceBridge.ts",
  added: "docs/architecture/reconciliation.md",
  auto1: "src/shared/config/agents/anthropic/claudeCodeAgentDefinition.ts",
  auto2: "package.json",
};

interface Fixture {
  dir: string;
  worktreeDir: string;
  cleanup: () => void;
}

/**
 * Main worktree on `main`, the reviewed worktree on a feature branch. Two
 * incoming branches: `incoming-merge` conflicts with the feature branch in four
 * ways, and `rebase-onto` rewrites a file the feature's second commit touches, so
 * rebasing the feature onto it stops on step 2 of 5.
 */
function createFixtureRepo(): Fixture {
  const dir = mkdtempSync(path.join(tmpdir(), "daintree-conflictpanel-shots-"));
  const wtRoot = path.join(path.dirname(dir), path.basename(dir) + "-worktrees");
  mkdirSync(wtRoot, { recursive: true });

  git("init -b main", dir);
  git('config user.email "test@daintree.dev"', dir);
  git('config user.name "Daintree Test"', dir);

  const write = (rel: string, body: string, root = dir): void => {
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  };

  write("README.md", "# Helios Dashboard\n");
  write(MERGE_FILES.auto2, lines('"k"', 30));
  write(MERGE_FILES.deep, regions("base", 60, 12));
  write(MERGE_FILES.store, lines("topo", 40));
  write(MERGE_FILES.deleted, lines("bridge", 40));
  write(MERGE_FILES.auto1, lines("agent", 60));
  write("src/renderer/orchestration/scheduler.ts", lines("sched", 40));
  git("add -A", dir);
  git('commit -m "initial commit"', dir);

  git("checkout -b incoming-merge", dir);
  write(MERGE_FILES.deep, regions("INCOMING", 60, 12));
  write(MERGE_FILES.store, lines("INCOMING-topo", 40));
  write(MERGE_FILES.deleted, lines("INCOMING-bridge", 40));
  write(MERGE_FILES.added, lines("- incoming doc", 30));
  write(MERGE_FILES.auto1, lines("agent", 55) + lines("INCOMING-agent-tail", 5));
  git("add -A", dir);
  git('commit -m "rework orchestration on the incoming side"', dir);
  git("checkout main", dir);

  git("checkout -b rebase-onto", dir);
  write("src/renderer/orchestration/scheduler.ts", lines("ONTO-sched", 40));
  git("add -A", dir);
  git('commit -m "rewrite the scheduler upstream"', dir);
  git("checkout main", dir);

  git(`worktree add -b ${FEATURE_BRANCH} ${JSON.stringify(wtRoot)}/agent-refactor main`, dir);
  const wt = path.join(wtRoot, "agent-refactor");

  write(MERGE_FILES.deep, regions("FEATURE", 60, 12), wt);
  write(MERGE_FILES.store, lines("FEATURE-topo", 40), wt);
  git("add -A", wt);
  git('commit -m "rework the orchestration preferences panel"', wt);

  write("src/renderer/orchestration/scheduler.ts", lines("FEATURE-sched", 40), wt);
  git("add -A", wt);
  git('commit -m "debounce scheduler ticks while a worktree is being reconciled"', wt);

  write("src/renderer/orchestration/scheduler.ts", lines("FEATURE-sched", 40) + "// fix\n", wt);
  git("add -A", wt);
  git('commit -m "fixup! debounce scheduler ticks while a worktree is being reconciled"', wt);

  write("src/renderer/scratch.ts", lines("scratch", 5), wt);
  git("add -A", wt);
  git('commit -m "chore: drop scratch experiment"', wt);

  git(`rm -q ${MERGE_FILES.deleted}`, wt);
  write(MERGE_FILES.added, lines("- feature doc", 30), wt);
  write(MERGE_FILES.auto2, lines('"k"', 30) + '"feature": true\n', wt);
  git("add -A", wt);
  git('commit -m "retire the legacy workspace bridge and document reconciliation"', wt);

  return {
    dir,
    worktreeDir: wt,
    cleanup: () => {
      for (const target of [wtRoot, dir]) {
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
const failures: string[] = [];

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
      `[conflictpanel-shots] state "${opts.label}" never materialised — ${selector} was not ` +
        `${opts.hidden ? "hidden" : "visible"}. Refusing to shoot a wrong-state PNG.`
    );
  }
}

async function snap(page: Page, slug: string, locator?: string): Promise<void> {
  await settle(page);
  const file = path.join(OUTPUT_DIR, `${slug}.png`);
  if (locator) {
    await page.locator(locator).last().screenshot({ path: file, type: "png" });
  } else {
    await page.screenshot({ path: file, type: "png", animations: "disabled", caret: "hide" });
  }
  written.push(path.basename(file));
}

async function setWindowSize(
  app: ElectronApplication,
  size: { width: number; height: number }
): Promise<void> {
  await app.evaluate(({ BrowserWindow }, target) => {
    BrowserWindow.getAllWindows()[0]?.setSize(target.width, target.height);
  }, size);
}

async function tabTo(page: Page, target: string, maxPresses = 30): Promise<boolean> {
  for (let i = 0; i < maxPresses; i++) {
    await page.keyboard.press("Tab");
    if (await page.locator(`${target}:focus`).count()) return true;
  }
  return false;
}

async function step(name: string, fn: () => Promise<void>, reset: () => Promise<void>) {
  if (ONLY.length > 0 && !ONLY.includes(name)) return;
  try {
    await fn();
  } catch (error) {
    const detail = String(error).slice(0, 400);
    console.warn(`[conflictpanel-shots] step "${name}" failed:`, detail);
    failures.push(`${name}: ${detail}`);
  } finally {
    await reset().catch((error) => {
      failures.push(`${name} (reset): ${String(error).slice(0, 200)}`);
    });
  }
}

test("conflict panel review — merge, rebase, resolved, confirm, themes", async () => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_CONFLICTPANEL is required for the conflict-panel capture",
  });
  test.skip(!ENABLED, "Set DAINTREE_SHOT_CONFLICTPANEL to run the conflict-panel capture");
  test.setTimeout(15 * 60_000);

  failures.length = 0;
  written.length = 0;
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const repo = createFixtureRepo();
  const wt = repo.worktreeDir;
  const userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-conflictpanelshot-"));
  let ctx: AppContext | undefined;

  try {
    ctx = await launchApp({
      userDataDir,
      screenshotScale: SCALE,
      windowSize: WIDE,
      extraArgs: ["--disable-gpu", "--in-process-gpu", "--disable-breakpad", "--noerrdialogs"],
    });
    const page = await openAndOnboardProject(ctx.app, ctx.window, repo.dir, "Helios Dashboard");
    const app = ctx.app;
    await page.addStyleTag({ content: POLISH_CSS }).catch(() => {});
    await dismissBlockingPalette(page);
    await page
      .locator(SEL.worktree.mainCard)
      .waitFor({ state: "visible", timeout: T_LONG })
      .catch(() => {});
    await settle(page, 1500);
    await dismissBlockingPalette(page);

    const hub = page.locator(SEL.reviewHub.container);
    // Not by branch name: mid-rebase HEAD is detached and the card relabels, so
    // the only stable handle is "the worktree card that is not the main one".
    const featureCard = page
      .locator(`[data-worktree-branch]:not(${SEL.worktree.mainCard})`)
      .first();

    const openHub = async (): Promise<void> => {
      await dismissBlockingPalette(page);
      await featureCard.waitFor({ state: "visible", timeout: T_LONG });
      const opener = featureCard.locator(SEL.worktree.reviewHubButton).first();
      if (await opener.isVisible().catch(() => false)) {
        await opener.click();
      } else {
        await featureCard.click({ button: "right" });
        await page.locator('[role="menu"]').waitFor({ state: "visible", timeout: T_MEDIUM });
        const reviewTrigger = page.getByRole("menuitem", { name: /^Review$/ }).first();
        const reviewItem = page.getByRole("menuitem", { name: /^Review worktree$/ }).first();
        await reviewTrigger.hover();
        if (!(await reviewItem.isVisible().catch(() => false))) await reviewTrigger.click();
        await reviewItem.click();
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

    const resetGit = (): void => {
      gitAllowFail("merge --abort", wt);
      gitAllowFail("rebase --abort", wt);
      git("reset --hard HEAD", wt);
      git("clean -fd", wt);
    };

    type GitState = "merge" | "merge-all-resolved" | "rebase";
    const setGitState = (kind: GitState): void => {
      resetGit();
      if (kind === "rebase") {
        // --autosquash nests the fixup under its target; the perl edit drops the
        // scratch commit so the rail also has a dropped entry to draw.
        gitAllowFail("rebase -i --autosquash rebase-onto", wt, {
          GIT_SEQUENCE_EDITOR: `perl -pi -e 's/^pick (\\S+) (chore: drop)/drop $1 $2/'`,
        });
        return;
      }
      gitAllowFail("merge incoming-merge", wt);
      if (kind === "merge-all-resolved") {
        git(`checkout --ours -- ${MERGE_FILES.deep} ${MERGE_FILES.store} ${MERGE_FILES.added}`, wt);
        git(`add ${MERGE_FILES.deep} ${MERGE_FILES.store} ${MERGE_FILES.added}`, wt);
        git(`rm -q ${MERGE_FILES.deleted}`, wt);
      }
    };

    const useGitState = async (kind: GitState): Promise<void> => {
      await closeHub();
      setGitState(kind);
      await settle(page, 500);
      await openHub();
      await expectState(page, PANEL, { label: `${kind} panel` });
      if (kind === "rebase") {
        await expectState(page, '[data-testid="conflict-rebase-sequence"]', {
          label: "rebase sequence rail",
        });
      }
      if (kind !== "merge-all-resolved") {
        // The hunk-count scan resolves after the first paint; wait for it so the
        // row geometry is final.
        await expectState(page, `${PANEL} [data-testid^="conflict-hunk-count-"]`, {
          label: `${kind} hunk counts`,
        });
      }
      await settle(page, 600);
    };

    const rest = async (): Promise<void> => {
      await closeHub();
      await setWindowSize(app, WIDE);
      await page.emulateMedia({ forcedColors: "none", contrast: "no-preference" }).catch(() => {});
      await page.mouse.move(2, 2);
      await settle(page, 300);
    };

    await step(
      "merge",
      async () => {
        await useGitState("merge");
        await snap(page, "10-merge-rest", PANEL);
        await snap(page, "11-merge-window");
        const row = page.locator(`${PANEL} li:has([data-testid^="conflict-hunk-count-"])`).first();
        await row.hover();
        await snap(page, "12-merge-row-hover", PANEL);
        await page.mouse.move(2, 2);
        const toggle = page.locator('[data-testid="conflict-resolved-toggle"]');
        await toggle.click();
        await expectState(page, '[data-testid="conflict-resolved-list"]', {
          label: "resolved expanded",
        });
        await snap(page, "13-merge-resolved-expanded", PANEL);
        await page
          .locator(`${PANEL} [aria-label="Mark ${MERGE_FILES.store} as resolved"]`)
          .first()
          .click();
        // The file still carries its markers, so the panel asks first — that
        // confirmation is a state worth seeing in its own right.
        const markerDialog = page.locator('[role="dialog"]:has-text("still has")');
        await expectState(page, '[role="dialog"]:has-text("still has")', {
          label: "marker confirm",
        });
        await snap(page, "15-confirm-markers-remain");
        await markerDialog.getByRole("button", { name: "Mark resolved" }).click();
        await expectState(page, `${PANEL} [aria-label="Mark ${MERGE_FILES.store} as resolved"]`, {
          hidden: true,
          label: "one file resolved",
        });
        await settle(page, 800);
        await snap(page, "14-merge-one-resolved", PANEL);
      },
      rest
    );

    await step(
      "keyboard",
      async () => {
        await useGitState("merge");
        await page.locator(PANEL).click({ position: { x: 4, y: 4 } });
        if (await tabTo(page, '[data-testid="conflict-abort"]')) {
          await snap(page, "20-keyboard-abort-focused", PANEL);
        } else {
          failures.push("keyboard: Abort never took focus");
        }
        if (await tabTo(page, `${PANEL} li button`)) {
          await snap(page, "21-keyboard-row-action-focused", PANEL);
        } else {
          failures.push("keyboard: no row action took focus");
        }
      },
      rest
    );

    await step(
      "confirm",
      async () => {
        await useGitState("merge");
        await page.locator('[data-testid="conflict-abort"]').click();
        await expectState(page, '[role="alertdialog"], [role="dialog"]:has-text("Abort merge?")', {
          label: "abort confirm",
        });
        await snap(page, "30-confirm-abort");
        await page.keyboard.press("Escape");
        await settle(page, 400);
        await page
          .locator(`${PANEL} [aria-label="More actions for ${MERGE_FILES.store}"]`)
          .first()
          .click();
        await expectState(page, '[role="menu"]', { label: "row menu" });
        await snap(page, "32-row-menu-open");
        await page
          .getByRole("menuitem", { name: /^Take ours/ })
          .first()
          .click();
        await expectState(page, ':text("current branch version of")', {
          label: "take-ours confirm",
        });
        await snap(page, "31-confirm-take-ours");
        await page.keyboard.press("Escape");
      },
      rest
    );

    await step(
      "allresolved",
      async () => {
        await useGitState("merge-all-resolved");
        await expectState(page, '[data-testid="conflict-continue"]:not([disabled])', {
          label: "continue enabled",
        });
        await snap(page, "40-all-resolved", PANEL);
      },
      rest
    );

    await step(
      "rebase",
      async () => {
        await useGitState("rebase");
        await snap(page, "50-rebase-rest", PANEL);
        await snap(page, "51-rebase-window");
      },
      rest
    );

    await step(
      "narrow",
      async () => {
        await setWindowSize(app, NARROW);
        await useGitState("merge");
        await snap(page, "60-narrow-merge", PANEL);
        await useGitState("rebase");
        await snap(page, "61-narrow-rebase", PANEL);
      },
      rest
    );

    await step(
      "contrast",
      async () => {
        await useGitState("merge");
        await page.emulateMedia({ contrast: "no-preference", forcedColors: "active" });
        await snap(page, "70-forced-colors", PANEL);
        await page.emulateMedia({ contrast: "more", forcedColors: "none" });
        await snap(page, "71-prefers-contrast-more", PANEL);
      },
      rest
    );

    await step(
      "themes",
      async () => {
        setGitState("merge");
        for (const [i, theme] of SPOT_THEMES.entries()) {
          await closeHub();
          await setAppTheme(page, theme);
          await page.addStyleTag({ content: POLISH_CSS }).catch(() => {});
          await dismissBlockingPalette(page);
          await openHub();
          await expectState(page, `${PANEL} [data-testid^="conflict-hunk-count-"]`, {
            label: `theme ${theme}`,
          });
          await settle(page, 600);
          await snap(page, `8${i}-theme-${theme}`, PANEL);
        }
      },
      async () => {
        await closeHub();
        await setAppTheme(page, SPOT_THEMES[0]).catch(() => {});
      }
    );
  } finally {
    if (ctx?.app) await closeApp(ctx.app).catch(() => {});
    repo.cleanup();
    try {
      rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }

  const onDisk = existsSync(OUTPUT_DIR)
    ? readdirSync(OUTPUT_DIR).filter((f) => written.includes(f))
    : [];
  console.log(`[conflictpanel-shots] wrote ${written.length} shot(s), ${onDisk.length} on disk`);

  const byHash = new Map<string, string[]>();
  for (const file of onDisk) {
    const hash = createHash("md5")
      .update(readFileSync(path.join(OUTPUT_DIR, file)))
      .digest("hex");
    byHash.set(hash, [...(byHash.get(hash) ?? []), file]);
  }
  const dupes = [...byHash.values()].filter((group) => group.length > 1);
  const problems: string[] = [];
  if (dupes.length > 0) {
    problems.push(
      `${dupes.length} group(s) of different states rendered byte-identical:\n` +
        dupes.map((g) => `  ${g.join(" == ")}`).join("\n")
    );
  }
  if (failures.length > 0) {
    problems.push(`${failures.length} step(s) failed:\n  ${failures.join("\n  ")}`);
  }
  if (problems.length > 0) throw new Error(`[conflictpanel-shots]\n${problems.join("\n")}`);
  if (written.length === 0) throw new Error("[conflictpanel-shots] no screenshots were written");
  if (onDisk.length < written.length) {
    throw new Error(
      `[conflictpanel-shots] wrote ${written.length} shot(s) but only ${onDisk.length} landed on disk`
    );
  }
});
