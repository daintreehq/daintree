/**
 * Review Hub commit composer visual-review harness.
 *
 * `CommitPanel` is the bottom of the Review Hub: the commit message box, the status
 * line that names what blocks a commit, the Commit / Commit & push pair, and the push
 * progress rows. Most of its states are transient (a push is over in a second against a
 * local remote) or gated on git shapes nobody sets up by hand (detached HEAD, no
 * remote), so they are rarely looked at. This harness puts every one of them on screen.
 *
 * How each state is reached:
 *
 *   Real git for staging, detached HEAD and the no-remote variant. The fixture is a
 *   main worktree on `main` plus a feature worktree with a bare remote, the same
 *   shape as review-hub-states-review, so `hasRemote` and the push destination are
 *   genuine.
 *
 *   Push progress through the real channel. `DAINTREE_E2E_FAULT_MODE=1` delays the
 *   `git:push` invoke in the main process, which holds `isPushing` true, and the
 *   harness then sends `git:push-progress` events from main exactly as the push
 *   handler does. The stage names are the ones simple-git emits (`counting`,
 *   `compressing`, `writing`), and one event carries `progress: null`, which the real
 *   handler sends for stages git reports without a percentage.
 *
 * Steps:
 *
 *   blocked      nothing staged, empty message, and the checklist tooltip.
 *   partial      files staged but no message — the tooltip with resolved rows.
 *   ready        staged plus a message; short, overflowing, and multi-line.
 *   keyboard     focus on the message box and on the primary button.
 *   confirm      the push confirm dialog.
 *   pushing      the push in flight: target only, then per-stage progress.
 *   pushall      the push after a commit that leaves the tree clean.
 *   detached     detached HEAD, at rest and after the blocked click focuses the note.
 *   narrow       pushing and blocked at a squeezed window.
 *   contrast     forced-colors and prefers-contrast: more.
 *   noremote     no remote: the single Commit button. Runs last, it removes origin.
 *
 * Opt-in only:
 *
 *   DAINTREE_SHOT_COMMITPANEL=1 DESIGN_CAPTURE_DIR=/abs/dir \
 *     npx playwright test --project=screenshots review-hub-commit-panel
 *
 * Env knobs:
 *   DAINTREE_SHOT_COMMITPANEL  required — any truthy value runs the capture
 *   DAINTREE_SHOT_THEME        optional theme id (default: the app default)
 *   DAINTREE_SHOT_TAG          optional suffix so themes sit side by side
 *   DAINTREE_SHOT_ONLY         comma-separated step filter
 *   DESIGN_CAPTURE_DIR         optional absolute output dir (default: artifacts/commitpanel-shots)
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
  realpathSync,
} from "fs";
import { createHash } from "crypto";
import { tmpdir } from "os";
import path from "path";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { openAndOnboardProject } from "../helpers/project";
import { dismissBlockingPalette } from "../helpers/overlays";
import { setAppTheme } from "../helpers/theme";
import { injectDelay, clearAllFaults } from "../helpers/ipcFaults";
import { SEL } from "../helpers/selectors";
import { T_LONG, T_MEDIUM } from "../helpers/timeouts";

const ENABLED = !!process.env.DAINTREE_SHOT_COMMITPANEL;
const THEME = process.env.DAINTREE_SHOT_THEME ?? "";
const TAG = process.env.DAINTREE_SHOT_TAG ? `-${process.env.DAINTREE_SHOT_TAG}` : "";
const SCALE = process.env.DAINTREE_SCREENSHOT_SCALE ?? "2";
const OUTPUT_DIR =
  process.env.DESIGN_CAPTURE_DIR ?? path.resolve(process.cwd(), "artifacts", "commitpanel-shots");

const WIDE = { width: 1680, height: 1050 };
const NARROW = { width: 900, height: 1050 };

const FEATURE_BRANCH = "feature/agent-refactor";

const CONTENT = '[data-testid="review-hub-content"]';
const TEXTAREA = `${CONTENT} textarea`;
const PRIMARY = `${CONTENT} [data-testid="review-hub-commit-primary"]`;
const staged = (n: number): string => `${PRIMARY}[data-staged-count="${n}"]`;
const PANEL_TESTID = '[data-testid="review-hub-commit-panel"]';
const TOOLTIP = "[data-radix-popper-content-wrapper]";
/** An OPEN tooltip — a closing one keeps its wrapper mounted for its exit frames. */
const TOOLTIP_OPEN = `${TOOLTIP}:has([data-state="delayed-open"], [data-state="instant-open"])`;
const REFRESH = '[aria-label="Refresh"]';

const CH = { push: "git:push", commit: "git:commit" } as const;

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

const SHORT_MESSAGE = "Reconcile workspace state on worktree add";
const LONG_SUBJECT =
  "Reconcile workspace state on worktree add so the sidebar never shows a stale branch name";
const MULTILINE_MESSAGE = [
  "Reconcile workspace state on worktree add",
  "",
  "The reconciliation service used to run only on project open, so a",
  "worktree created mid-session showed its parent's branch until the next",
  "refresh. Run it on add as well, and debounce the burst that follows.",
].join("\n");

function git(cmd: string, cwd: string): void {
  execSync(`git ${cmd}`, { cwd, stdio: "ignore" });
}

function gitAllowFail(cmd: string, cwd: string): void {
  try {
    execSync(`git ${cmd}`, { cwd, stdio: "ignore" });
  } catch {
    /* expected in some states */
  }
}

function lines(prefix: string, n: number): string {
  return Array.from({ length: n }, (_, i) => `${prefix} line ${i + 1};`).join("\n") + "\n";
}

const DIRTY_FILES: Array<[string, string, number]> = [
  ["src/shared/config/agents/anthropic/claudeCodeAgentDefinition.ts", "agent-v2", 340],
  ["src/renderer/components/CommandPalette/CommandPaletteResultRow.tsx", "row-v2", 300],
  ["src/renderer/store/worktreeTopologyStore.ts", "topo-v2", 430],
  ["src/renderer/orchestration/useOrchestrationScheduler.ts", "sched-v2", 310],
];

interface Fixture {
  dir: string;
  worktreeDir: string;
  remoteDir: string;
  cleanup: () => void;
}

function createFixtureRepo(): Fixture {
  const dir = mkdtempSync(path.join(tmpdir(), "daintree-commitpanel-shots-"));
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

  write("README.md", "# Helios Dashboard\n");
  for (const [rel, , n] of DIRTY_FILES) write(rel, lines("base", Math.floor(n / 2)));
  write("src/main/services/workspace/WorkspaceReconciliationService.ts", lines("recon", 260));
  git("add -A", dir);
  git('commit -m "initial commit"', dir);

  execSync(`git init --bare ${JSON.stringify(remoteDir)}`, { stdio: "ignore" });
  git(`remote add origin ${JSON.stringify(remoteDir)}`, dir);
  git("push -u origin main", dir);

  git(`worktree add -b ${FEATURE_BRANCH} ${JSON.stringify(wtRoot)}/agent-refactor main`, dir);
  const worktreeDir = path.join(wtRoot, "agent-refactor");
  write("src/main/services/workspace/WorkspaceReconciliationService.ts", lines("recon-v2", 380), worktreeDir); // prettier-ignore
  git("add -A", worktreeDir);
  git('commit -m "reconcile workspace state on worktree add"', worktreeDir);
  git(`push -u origin ${FEATURE_BRANCH}`, worktreeDir);

  for (const [rel, prefix, n] of DIRTY_FILES) write(rel, lines(prefix, n), worktreeDir);

  return {
    dir,
    worktreeDir,
    remoteDir,
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
      `[commitpanel-shots] state "${opts.label}" never materialised — ` +
        `${selector} was not ${opts.hidden ? "hidden" : "visible"}. Refusing to shoot a wrong-state PNG.`
    );
  }
}

type Box = { x: number; y: number; width: number; height: number };

/** The panel root: the test id when the build has one, else the textarea's parent. */
async function panelBox(page: Page): Promise<Box> {
  const byId = page.locator(`${CONTENT} ${PANEL_TESTID}`).first();
  const target = (await byId.count()) ? byId : page.locator(TEXTAREA).first().locator("xpath=..");
  const box = await target.boundingBox();
  if (!box) throw new Error("[commitpanel-shots] commit panel has no bounding box");
  return box;
}

/**
 * Shoot the union of the panel and anything floating over it (the tooltip), padded,
 * so a crop always carries the surface's own edges for context.
 */
async function snapPanel(page: Page, slug: string, extra: string[] = [], pad = 16): Promise<void> {
  await settle(page);
  const boxes: Box[] = [await panelBox(page)];
  for (const sel of extra) {
    const b = await page.locator(sel).last().boundingBox();
    if (!b) throw new Error(`[commitpanel-shots] ${sel} is not on screen for ${slug}`);
    boxes.push(b);
  }
  const x0 = Math.max(0, Math.min(...boxes.map((b) => b.x)) - pad);
  const y0 = Math.max(0, Math.min(...boxes.map((b) => b.y)) - pad);
  const x1 = Math.max(...boxes.map((b) => b.x + b.width)) + pad;
  const y1 = Math.max(...boxes.map((b) => b.y + b.height)) + pad;
  const file = path.join(OUTPUT_DIR, `${slug}${TAG}.png`);
  await page.screenshot({
    path: file,
    type: "png",
    caret: "hide",
    clip: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 },
  });
  written.push(path.basename(file));
}

async function snapWindow(page: Page, slug: string): Promise<void> {
  await settle(page);
  const file = path.join(OUTPUT_DIR, `${slug}${TAG}.png`);
  await page.screenshot({ path: file, type: "png", caret: "hide" });
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

async function tabTo(page: Page, target: string, maxPresses = 30): Promise<boolean> {
  for (let i = 0; i < maxPresses; i++) {
    await page.keyboard.press("Tab");
    if (await page.locator(`${target}:focus`).count()) return true;
  }
  return false;
}

/** Send push progress from main, the way the push handler does. */
async function sendProgress(
  app: ElectronApplication,
  cwds: string[],
  events: Array<{
    stage: string;
    progress: number | null;
    processed?: number | null;
    total?: number | null;
    targetBranch?: string;
  }>
): Promise<void> {
  await app.evaluate(
    ({ webContents }, payload) => {
      for (const wc of webContents.getAllWebContents()) {
        if (wc.isDestroyed()) continue;
        for (const cwd of payload.cwds) {
          for (const e of payload.events) {
            wc.send("git:push-progress", {
              cwd,
              stage: e.stage,
              progress: e.progress,
              processed: e.processed ?? null,
              total: e.total ?? null,
              ...(e.targetBranch ? { targetBranch: e.targetBranch } : {}),
            });
          }
        }
      }
    },
    { cwds, events }
  );
}

const ONLY = (process.env.DAINTREE_SHOT_ONLY ?? "").split(",").filter(Boolean);

const failures: string[] = [];
async function step(name: string, fn: () => Promise<void>, reset: () => Promise<void>) {
  if (ONLY.length > 0 && !ONLY.includes(name)) return;
  try {
    await fn();
  } catch (error) {
    const detail = String(error).slice(0, 400);
    console.warn(`[commitpanel-shots] step "${name}" failed:`, detail);
    failures.push(`${name}: ${detail}`);
  } finally {
    await reset().catch((error) => {
      failures.push(`${name} (reset): ${String(error).slice(0, 200)}`);
    });
  }
}

test("review hub commit panel review — every state of the commit composer", async () => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_COMMITPANEL is required for the commit panel capture",
  });
  test.skip(!ENABLED, "Set DAINTREE_SHOT_COMMITPANEL to run the commit panel capture");
  test.setTimeout(600_000);

  failures.length = 0;
  written.length = 0;

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const repo = createFixtureRepo();
  const cwds = [...new Set([repo.worktreeDir, realpathSync(repo.worktreeDir)])];
  const userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-commitpanelshot-"));
  let ctx: AppContext | undefined;

  try {
    ctx = await launchApp({
      userDataDir,
      screenshotScale: SCALE,
      windowSize: WIDE,
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
    const wt = repo.worktreeDir;

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
      await expectState(page, TEXTAREA, { label: "hub open with commit panel" });
    };

    const closeHub = async (): Promise<void> => {
      for (let i = 0; i < 4; i++) {
        if (!(await hub.isVisible().catch(() => false))) return;
        await page.keyboard.press("Escape").catch(() => {});
        await settle(page, 250);
      }
    };

    const refreshHub = async (): Promise<void> => {
      await hub.locator(REFRESH).first().click();
      await settle(page, 900);
    };

    // The push steps really push once their injected delay expires, so every reset
    // puts both the branch and the remote back on the original tip.
    const baseTip = execSync("git rev-parse HEAD", { cwd: wt }).toString().trim();

    /** Dirty tree on the feature branch at the original pushed tip. */
    const resetGit = (): void => {
      gitAllowFail(`checkout ${FEATURE_BRANCH}`, wt);
      git(`reset --hard ${baseTip}`, wt);
      gitAllowFail(`push -f origin ${baseTip}:refs/heads/${FEATURE_BRANCH}`, wt);
      git("clean -fd", wt);
      for (const [rel, prefix, n] of DIRTY_FILES) {
        writeFileSync(path.join(wt, rel), lines(prefix, n));
      }
    };

    /**
     * The hub auto-stages everything on open, so staging states are reached by
     * unstaging through the UI. Two of four staged keeps the panel mounted after a
     * commit, which a push needs: the panel unmounts once the tree is clean.
     */
    const unstage = async (rel: string): Promise<void> => {
      await hub.locator(`[aria-label="Unstage ${rel}"]`).first().click();
      await settle(page, 500);
    };
    const stageSome = async (): Promise<void> => {
      await unstage(DIRTY_FILES[2]![0]);
      await unstage(DIRTY_FILES[3]![0]);
      await expectState(page, staged(2), { label: "two staged" });
    };
    const unstageAll = async (): Promise<void> => {
      await hub
        .getByRole("button", { name: /^Unstage all/ })
        .first()
        .click();
      await expectState(page, staged(0), { label: "none staged" });
    };

    const typeMessage = async (message: string): Promise<void> => {
      const box = page.locator(TEXTAREA);
      await box.fill(message);
      await settle(page, 200);
    };

    const blurAll = async (): Promise<void> => {
      await page.mouse.move(2, 2);
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await settle(page, 250);
    };

    const primary = () => page.locator(PRIMARY).first();

    /** Snap with whatever overlay the hover or focus opened, if any. */
    const openOverlay = async (): Promise<string[]> => {
      await settle(page, 500);
      return (await page.locator(TOOLTIP_OPEN).count()) ? [TOOLTIP_OPEN] : [];
    };

    const rest = async (): Promise<void> => {
      await clearAllFaults(app).catch(() => {});
      await setWindowSize(app, WIDE);
      await page.emulateMedia({ forcedColors: "none", contrast: "no-preference" }).catch(() => {});
      await closeHub();
      resetGit();
      await settle(page, 400);
      await openHub();
      await settle(page, 700);
      await page.addStyleTag({ content: POLISH_CSS }).catch(() => {});
    };

    resetGit();
    await openHub();
    await settle(page, 800);

    await step(
      "blocked",
      async () => {
        await unstageAll();
        await blurAll();
        await snapPanel(page, "01-blocked-rest");
        await snapWindow(page, "02-hub-context");
        await primary().hover();
        await snapPanel(page, "03-blocked-tooltip", await openOverlay());
      },
      rest
    );

    await step(
      "partial",
      async () => {
        await stageSome();
        await blurAll();
        await snapPanel(page, "04-staged-no-message");
        await primary().hover();
        await snapPanel(page, "05-staged-no-message-tooltip", await openOverlay());
      },
      rest
    );

    await step(
      "ready",
      async () => {
        await stageSome();
        await typeMessage(SHORT_MESSAGE);
        await blurAll();
        await snapPanel(page, "06-ready");
        await primary().hover();
        await settle(page, 600);
        await snapPanel(page, "07-ready-hover");
        await typeMessage(LONG_SUBJECT);
        await blurAll();
        await snapPanel(page, "08-subject-over-72");
        await typeMessage(MULTILINE_MESSAGE);
        await blurAll();
        await snapPanel(page, "09-multiline");
      },
      rest
    );

    await step(
      "keyboard",
      async () => {
        await stageSome();
        await typeMessage(SHORT_MESSAGE);
        await blurAll();
        await page.locator(TEXTAREA).focus();
        await page.keyboard.press("Shift+Tab");
        await page.keyboard.press("Tab");
        if (!(await page.locator(`${TEXTAREA}:focus`).count())) {
          throw new Error("message box never took focus");
        }
        await snapPanel(page, "10-focus-message");
        await page.keyboard.press("Tab");
        await settle(page, 200);
        await snapPanel(page, "11-focus-commit");
        const reached = await tabTo(page, PRIMARY, 4);
        if (!reached) throw new Error("primary never took focus");
        await snapPanel(page, "12-focus-primary");
        await typeMessage("");
        await page.locator(TEXTAREA).focus();
        await page.keyboard.press("Tab");
        await tabTo(page, PRIMARY, 4);
        await settle(page, 600);
        await snapPanel(page, "13-focus-primary-blocked", await openOverlay());
      },
      rest
    );

    await step(
      "confirm",
      async () => {
        await stageSome();
        await typeMessage(MULTILINE_MESSAGE);
        await primary().click();
        await expectState(page, '[role="alertdialog"], [role="dialog"]:has-text("Push commits?")', {
          label: "push confirm",
        });
        await snapWindow(page, "14-push-confirm");
        await page.keyboard.press("Escape");
      },
      rest
    );

    /** `all` commits every file, the auto-staged default that leaves the tree clean. */
    const startPush = async (opts: { all?: boolean } = {}): Promise<void> => {
      if (!opts.all) await stageSome();
      await typeMessage(SHORT_MESSAGE);
      await injectDelay(app, CH.push, 25_000);
      await primary().click();
      const confirm = page.getByRole("button", { name: /^Push to / }).first();
      await confirm.waitFor({ state: "visible", timeout: T_MEDIUM });
      await confirm.click();
      await expectState(page, `${PRIMARY}[aria-disabled="true"]`, {
        label: "push in flight",
      });
      await settle(page, 600);
    };

    const waitPushDone = async (): Promise<void> => {
      await page
        .locator(`${CONTENT} :text("Pushing to")`)
        .waitFor({ state: "hidden", timeout: 40_000 })
        .catch(() => {});
    };

    await step(
      "pushing",
      async () => {
        await startPush();
        await blurAll();
        await sendProgress(app, cwds, [
          { stage: "target", progress: null, targetBranch: `origin/${FEATURE_BRANCH}` },
        ]);
        await expectState(page, `${CONTENT} :text("Pushing to")`, { label: "push target" });
        await snapPanel(page, "15-pushing-target");
        await sendProgress(app, cwds, [
          { stage: "counting", progress: 100, processed: 14, total: 14 },
          { stage: "compressing", progress: 62, processed: 5, total: 8 },
        ]);
        await settle(page, 400);
        await snapPanel(page, "16-pushing-progress");
        await sendProgress(app, cwds, [
          { stage: "compressing", progress: 100, processed: 8, total: 8 },
          { stage: "writing", progress: 37, processed: 3, total: 8 },
          { stage: "remote:", progress: null },
        ]);
        await settle(page, 400);
        await snapPanel(page, "17-pushing-progress-late");
        await snapWindow(page, "18-pushing-window");
        await waitPushDone();
      },
      rest
    );

    await step(
      "pushall",
      async () => {
        await startPush({ all: true });
        await blurAll();
        await sendProgress(app, cwds, [
          { stage: "target", progress: null, targetBranch: `origin/${FEATURE_BRANCH}` },
          { stage: "counting", progress: 100 },
          { stage: "writing", progress: 58 },
        ]);
        await expectState(page, `${CONTENT} :text("Pushing to")`, { label: "push after clean" });
        await snapWindow(page, "28-pushing-after-clean-window");
        await waitPushDone();
      },
      rest
    );

    await step(
      "detached",
      async () => {
        git("checkout --detach", wt);
        await refreshHub();
        await expectState(page, `${CONTENT} :text("Detached HEAD")`, { label: "detached" });
        await blurAll();
        await snapPanel(page, "19-detached");
        await primary().click({ force: true, timeout: 5000 });
        await settle(page, 300);
        await page.mouse.move(2, 2);
        await snapPanel(page, "20-detached-blocker-focused");
        git(`checkout ${FEATURE_BRANCH}`, wt);
      },
      rest
    );

    await step(
      "narrow",
      async () => {
        await setWindowSize(app, NARROW);
        await settle(page, 800);
        await blurAll();
        await snapPanel(page, "21-narrow-staged");
        await startPush();
        await blurAll();
        await sendProgress(app, cwds, [
          { stage: "target", progress: null, targetBranch: `origin/${FEATURE_BRANCH}` },
          { stage: "counting", progress: 100 },
          { stage: "compressing", progress: 100 },
          { stage: "writing", progress: 37 },
        ]);
        await expectState(page, `${CONTENT} :text("Pushing to")`, { label: "narrow push" });
        await snapPanel(page, "22-narrow-pushing");
        await waitPushDone();
      },
      rest
    );

    await step(
      "contrast",
      async () => {
        await stageSome();
        await page.emulateMedia({ forcedColors: "active" });
        await blurAll();
        await snapPanel(page, "23-forced-colors-staged");
        await primary().hover();
        await snapPanel(page, "24-forced-colors-tooltip", await openOverlay());
        await page.emulateMedia({ forcedColors: "none", contrast: "more" });
        await blurAll();
        await primary().hover();
        await snapPanel(page, "25-more-contrast-tooltip", await openOverlay());
      },
      rest
    );

    await step(
      "noremote",
      async () => {
        await closeHub();
        git("remote remove origin", repo.dir);
        await settle(page, 600);
        await openHub();
        await expectState(page, `${PRIMARY}:not(:has-text("push"))`, { label: "no remote" });
        await blurAll();
        await snapPanel(page, "26-no-remote-staged");
        await stageSome();
        await typeMessage(SHORT_MESSAGE);
        await blurAll();
        await snapPanel(page, "27-no-remote-ready");
      },
      async () => {
        gitAllowFail(`remote add origin ${JSON.stringify(repo.remoteDir)}`, repo.dir);
        gitAllowFail("fetch origin", repo.dir);
        gitAllowFail(`branch -u origin/${FEATURE_BRANCH} ${FEATURE_BRANCH}`, repo.dir);
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

  const onDisk = existsSync(OUTPUT_DIR)
    ? readdirSync(OUTPUT_DIR).filter((f) => f.endsWith(`${TAG}.png`))
    : [];
  console.log(`[commitpanel-shots] wrote ${written.length} shot(s), ${onDisk.length} on disk`);

  const byHash = new Map<string, string[]>();
  for (const file of written) {
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
  if (problems.length > 0) throw new Error(`[commitpanel-shots]\n${problems.join("\n")}`);
  if (written.length === 0) throw new Error("[commitpanel-shots] no screenshots were written");
});
