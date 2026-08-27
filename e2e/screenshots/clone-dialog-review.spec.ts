/**
 * Clone-repository dialog visual-review harness.
 *
 * Drives `CloneRepoDialog` through every state that carries design weight —
 * empty and valid configuration, validation error, the pre-Doherty busy phase,
 * "Connecting…", a multi-stage clone, cancellation, generic failure,
 * authentication failure with provider recovery, failure plus partial-cleanup
 * failure, and success — and writes a PNG of each so the redesign can be judged
 * against real rendered pixels.
 *
 * States are produced by replacing the `project:clone-repo` /
 * `project:clone-cancel` / `forge:get-providers` handlers in the MAIN process,
 * so everything downstream of `ipcMain` is the real path: the real envelope,
 * the real `GitOperationError` reconstruction in the preload, the real
 * contextBridge property stripping, the real `onCloneProgress` subscription.
 * Nothing in the renderer is stubbed. A real network clone can't produce
 * auth-failure or cleanup-failure on demand, and can't hold the busy phase
 * still long enough to photograph it.
 *
 * Opt-in only, like the other review harnesses: skips itself unless
 * DAINTREE_SHOT_CLONE is set, so the marketing screenshots workflow never runs it.
 *
 *   DAINTREE_SHOT_CLONE=1 npx playwright test --project=screenshots clone-dialog-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_CLONE   required — any truthy value runs the capture
 *   DAINTREE_SHOT_THEME   optional theme id (default: the app default)
 *   DAINTREE_SHOT_TAG     optional suffix so rounds sit side by side
 *   DAINTREE_SHOT_ONLY    comma-separated step filter (see step names below)
 *
 * Output: artifacts/clone-shots/<NN-slug>[-tag].png (gitignored).
 */

import { test, expect, type Page, type ElectronApplication } from "@playwright/test";
import { execSync } from "child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, statSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { launchApp, closeApp, mockOpenDialog, type AppContext } from "../helpers/launch";
import { openAndOnboardProject } from "../helpers/project";
import { dismissBlockingPalette } from "../helpers/overlays";
import { setAppTheme } from "../helpers/theme";
import { SEL } from "../helpers/selectors";
import { T_MEDIUM } from "../helpers/timeouts";

const ENABLED = !!process.env.DAINTREE_SHOT_CLONE;
const THEME = process.env.DAINTREE_SHOT_THEME ?? "";
const TAG = process.env.DAINTREE_SHOT_TAG ? `-${process.env.DAINTREE_SHOT_TAG}` : "";
const SCALE = process.env.DAINTREE_SCREENSHOT_SCALE ?? "2";
const OUTPUT_DIR = path.resolve(process.cwd(), "artifacts", "clone-shots");

/** The dialog backdrop carries `aria-modal`; the panel is its first child. */
const BACKDROP = 'div[aria-modal="true"]';

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

const CLONE_URL = "https://github.com/helios-labs/helios-dashboard.git";

/** Git's own stage labels, sentence-cased by the handler before they're sent. */
const LONG_STAGES = [
  { stage: "counting objects", progress: 100, message: "Counting objects: 100%" },
  { stage: "compressing objects", progress: 100, message: "Compressing objects: 100%" },
  { stage: "receiving objects", progress: 64, message: "Receiving objects: 64%" },
];

interface ScriptStage {
  stage: string;
  progress: number;
  message: string;
}

interface CloneScript {
  mode: "success" | "error" | "auth" | "cleanup" | "hang";
  stages: ScriptStage[];
  stageDelayMs: number;
  clonedPath: string;
  errorMessage: string;
  cleanupMessage: string;
}

function git(cmd: string, cwd: string): void {
  execSync(`git ${cmd}`, { cwd, stdio: "ignore" });
}

/** A minimal repo just so the app has a project to sit behind the dialog. */
function createFixtureRepo(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "daintree-clone-shots-"));
  const wtRoot = path.join(path.dirname(dir), path.basename(dir) + "-worktrees");
  mkdirSync(wtRoot, { recursive: true });

  git("init -b main", dir);
  git('config user.email "test@daintree.dev"', dir);
  git('config user.name "Daintree Test"', dir);
  writeFileSync(path.join(dir, "README.md"), "# Helios Dashboard\n");
  git("add -A", dir);
  git('commit -m "initial commit"', dir);

  return {
    dir,
    cleanup: () => {
      if (existsSync(wtRoot)) rmSync(wtRoot, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * Swap the three main-process handlers the dialog talks to for scripted ones.
 * `forge:get-providers` is pinned to a single GitHub provider so both the
 * `owner/repo` shorthand host and the auth-failure sign-in route are
 * deterministic — with the real registry the recovery banner silently
 * degrades to the generic block and the capture would be of the wrong state.
 */
async function installCloneStub(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ ipcMain, webContents }) => {
    const scope = globalThis as unknown as {
      __cloneShotScript?: CloneScript;
      __cloneShotCancelled?: boolean;
    };
    scope.__cloneShotScript ??= {
      mode: "success",
      stages: [],
      stageDelayMs: 150,
      clonedPath: "/Users/you/Code/helios-dashboard",
      errorMessage: "Clone failed",
      cleanupMessage: "Cleanup failed",
    };

    // `electron/setup/security.ts` monkey-patches `ipcMain.handle` to wrap every
    // return in the success envelope and every throw in the error envelope. A
    // handler that builds its own envelope gets double-wrapped and the renderer
    // reads the failure as a success — so return raw payloads and throw real
    // Errors, exactly as the production handlers do. `serializeError` promotes
    // own `name` / `code` / `gitReason` onto the wire.
    const gitError = (message: string, gitReason: string) => {
      const error = new Error(message);
      error.name = "GitOperationError";
      (error as Error & { gitReason: string }).gitReason = gitReason;
      return error;
    };
    const cancelledError = () => {
      const error = new Error("Clone cancelled");
      error.name = "AppError";
      (error as Error & { code: string }).code = "CANCELLED";
      return error;
    };

    const emit = (payload: unknown) => {
      for (const contents of webContents.getAllWebContents()) {
        if (contents.isDestroyed()) continue;
        try {
          contents.send("project:clone-progress", payload);
        } catch {
          // A view torn down mid-send is not this harness's problem.
        }
      }
    };

    // Fixed timestamps — a wall-clock value would make otherwise-identical
    // rounds differ and defeat side-by-side comparison.
    let tick = 1_700_000_000_000;
    const progress = (stage: string, value: number, message: string) =>
      emit({ stage, progress: value, message, timestamp: (tick += 1000) });

    ipcMain.removeHandler("project:clone-repo");
    ipcMain.handle("project:clone-repo", async () => {
      const script = scope.__cloneShotScript!;
      scope.__cloneShotCancelled = false;

      for (const stage of script.stages) {
        await new Promise((resolve) => setTimeout(resolve, script.stageDelayMs));
        if (scope.__cloneShotCancelled) break;
        progress(stage.stage, stage.progress, stage.message);
      }

      if (script.mode === "hang") {
        // Held open so the busy phases can be photographed; "Stop clone"
        // releases it through the cancel handler below.
        await new Promise<void>((resolve) => {
          const poll = setInterval(() => {
            if (scope.__cloneShotCancelled) {
              clearInterval(poll);
              resolve();
            }
          }, 50);
        });
      }

      if (scope.__cloneShotCancelled) {
        progress("cancelled", 0, "Clone cancelled");
        throw cancelledError();
      }

      if (script.mode === "success") {
        progress("complete", 100, "Clone complete");
        return { clonedPath: script.clonedPath };
      }

      if (script.mode === "cleanup") {
        progress("cleanup-failed", 0, script.cleanupMessage);
      }

      progress("error", 0, `Clone failed: ${script.errorMessage}`);
      throw gitError(script.errorMessage, script.mode === "auth" ? "auth-failed" : "unknown");
    });

    ipcMain.removeHandler("project:clone-cancel");
    ipcMain.handle("project:clone-cancel", () => {
      scope.__cloneShotCancelled = true;
    });

    ipcMain.removeHandler("forge:get-providers");
    ipcMain.handle("forge:get-providers", () => [
      {
        pluginId: "daintree.github",
        contribution: { id: "github", name: "GitHub", matches: ["github.com"] },
      },
    ]);
  });
}

async function setScript(app: ElectronApplication, script: Partial<CloneScript>): Promise<void> {
  await app.evaluate((_electron, patch) => {
    const scope = globalThis as unknown as { __cloneShotScript?: CloneScript };
    scope.__cloneShotScript = { ...scope.__cloneShotScript!, ...patch };
  }, script);
}

async function settle(page: Page, ms = 400): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
  );
  await page.waitForTimeout(ms);
}

const written: string[] = [];

/**
 * Screenshot, then confirm a non-empty file actually landed. A harness that
 * trusts its own exit code reports success while writing nothing.
 */
async function snap(page: Page, slug: string, locator?: string): Promise<void> {
  const file = path.join(OUTPUT_DIR, `${slug}${TAG}.png`);
  if (locator) {
    await page.locator(locator).first().screenshot({ path: file, type: "png" });
  } else {
    await page.screenshot({ path: file, type: "png", animations: "disabled", caret: "hide" });
  }
  if (!existsSync(file) || statSync(file).size === 0) {
    throw new Error(`[clone-shots] snap "${slug}" produced no file at ${file}`);
  }
  written.push(path.basename(file));
}

const ONLY = (process.env.DAINTREE_SHOT_ONLY ?? "").split(",").filter(Boolean);
const failures: string[] = [];

/**
 * Steps are isolated so one broken state doesn't cost the whole sweep, but
 * every failure is collected and rethrown at the end — a swallowed step is how
 * a harness reports PASS over a missing capture.
 */
async function step(name: string, fn: () => Promise<void>): Promise<void> {
  if (ONLY.length > 0 && !ONLY.includes(name)) return;
  try {
    await fn();
  } catch (error) {
    const detail = `${name}: ${String(error).slice(0, 400)}`;
    console.warn(`[clone-shots] step failed — ${detail}`);
    failures.push(detail);
  }
}

/**
 * Sibling project dialogs stay mounted, so `Browse` and `Cancel` are ambiguous
 * page-wide. Every interaction scopes through this.
 */
const dialog = (page: Page) => page.locator(BACKDROP).filter({ hasText: "Clone repository" });
const panel = () => `${BACKDROP}:has-text("Clone repository") > div`;

async function openDialog(page: Page): Promise<void> {
  const mod = process.platform === "darwin" ? "Meta" : "Control";
  await page.keyboard.press(`${mod}+Shift+P`);
  await page.locator(SEL.actionPalette.dialog).waitFor({ state: "visible", timeout: T_MEDIUM });
  await page.locator(SEL.actionPalette.searchInput).fill("Clone Repository");
  await settle(page, 400);
  await page.locator(SEL.actionPalette.options).first().click();
  await dialog(page).waitFor({ state: "visible", timeout: T_MEDIUM });
  await settle(page, 500);
}

/**
 * Throws rather than giving up quietly. A dialog stuck open turns every later
 * step into a 30s timeout on a disabled input, which reads as ten unrelated
 * failures instead of the one that actually happened.
 */
async function closeDialog(page: Page): Promise<void> {
  for (let i = 0; i < 4; i++) {
    if (
      !(await dialog(page)
        .isVisible()
        .catch(() => false))
    )
      return;
    await page.keyboard.press("Escape").catch(() => {});
    await settle(page, 200);
  }
  throw new Error("dialog did not close — later steps would cascade");
}

/** Fill the form to a clonable state. `parentPath` is picker-only by design. */
async function fillForm(page: Page, url = CLONE_URL): Promise<void> {
  await dialog(page).locator("#clone-repo-url").fill(url);
  await dialog(page).getByRole("button", { name: "Browse" }).click();
  await settle(page, 400);
}

async function startClone(page: Page): Promise<void> {
  await dialog(page).getByRole("button", { name: "Clone", exact: true }).click();
}

async function stopClone(page: Page): Promise<void> {
  await dialog(page).getByRole("button", { name: "Stop clone" }).click();
}

/** Every built-in theme — see the worktree harness for the per-theme sweep. */
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

test("clone dialog review — configuration, progress, failure and success states", async () => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_CLONE is required for the clone-dialog capture",
  });
  test.skip(!ENABLED, "Set DAINTREE_SHOT_CLONE to run the clone-dialog capture");

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const repo = createFixtureRepo();
  const destination = mkdtempSync(path.join(tmpdir(), "daintree-clone-dest-"));
  const userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-cloneshot-"));
  let ctx: AppContext | undefined;

  try {
    ctx = await launchApp({
      userDataDir,
      screenshotScale: SCALE,
      windowSize: { width: 1680, height: 1050 },
      extraArgs: ["--disable-gpu", "--in-process-gpu", "--disable-breakpad", "--noerrdialogs"],
    });

    const page = await openAndOnboardProject(ctx.app, ctx.window, repo.dir, "Helios Dashboard");
    if (THEME) await setAppTheme(page, THEME);
    await page.addStyleTag({ content: POLISH_CSS }).catch(() => {});
    await dismissBlockingPalette(page);
    await settle(page, 2000);
    await dismissBlockingPalette(page);

    await installCloneStub(ctx.app);
    // The Browse button resolves through the real open-dialog channel.
    await mockOpenDialog(ctx.app, destination);
    await setScript(ctx.app, { clonedPath: path.join(destination, "helios-dashboard") });

    // 1. Empty configuration — the dialog as it first appears.
    await step("empty", async () => {
      await openDialog(page);
      await snap(page, "10-config-empty", panel());
      await snap(page, "11-config-empty-in-window");
      await closeDialog(page);
    });

    // 2. Valid configuration — every field satisfied, Clone enabled.
    await step("valid", async () => {
      await openDialog(page);
      await fillForm(page);
      await snap(page, "15-config-valid", panel());
      await closeDialog(page);
    });

    // 3. Folder-name validation error.
    await step("validation", async () => {
      await openDialog(page);
      await fillForm(page);
      await dialog(page).locator("#clone-folder-name").fill("helios:dashboard");
      await settle(page, 300);
      await snap(page, "20-config-validation-error", panel());
      await closeDialog(page);
    });

    // 4. Shorthand `owner/repo` — the single-provider expansion path.
    await step("shorthand", async () => {
      await openDialog(page);
      await fillForm(page, "helios-labs/helios-dashboard");
      await snap(page, "25-config-shorthand", panel());
      await closeDialog(page);
    });

    // 5. Busy before the Doherty gate elapses — a clone fast enough that the
    // progress box never appears. Only ~400ms wide, so this is snapped
    // immediately after the click with no settle.
    await step("busy", async () => {
      await openDialog(page);
      await fillForm(page);
      await setScript(ctx!.app, { mode: "hang", stages: [] });
      await startClone(page);
      await snap(page, "30-busy-pre-gate", panel());
      await stopClone(page);
      await settle(page, 500);
      await closeDialog(page);
    });

    // 6. Past the gate with no git progress yet — the "Connecting…" row.
    await step("connecting", async () => {
      await openDialog(page);
      await fillForm(page);
      await setScript(ctx!.app, { mode: "hang", stages: [] });
      await startClone(page);
      await settle(page, 900);
      await snap(page, "35-connecting", panel());
      await stopClone(page);
      await settle(page, 500);
      await closeDialog(page);
    });

    // 7. Long clone, several stages live at once — the crowded state the
    // redesign exists to fix.
    await step("progress", async () => {
      await openDialog(page);
      await fillForm(page);
      await setScript(ctx!.app, { mode: "hang", stages: LONG_STAGES, stageDelayMs: 250 });
      await startClone(page);
      await settle(page, 1600);
      await snap(page, "40-progress-multi-stage", panel());
      await snap(page, "41-progress-multi-stage-in-window");
      await stopClone(page);
      await settle(page, 600);

      // 8. Cancellation — the same clone after the user stops it.
      await snap(page, "45-cancelled", panel());
      await closeDialog(page);
    });

    // 9. Generic failure — no matching provider, so the locally-styled block.
    await step("error", async () => {
      await openDialog(page);
      await fillForm(page);
      await setScript(ctx!.app, {
        mode: "error",
        stages: LONG_STAGES.slice(0, 2),
        stageDelayMs: 120,
        errorMessage: "repository 'https://github.com/helios-labs/helios-dashboard.git/' not found",
      });
      await startClone(page);
      await settle(page, 1200);
      await snap(page, "50-failure-generic", panel());
      await closeDialog(page);
    });

    // 10. Authentication failure — the provider sign-in recovery banner.
    await step("auth", async () => {
      await openDialog(page);
      await fillForm(page);
      await setScript(ctx!.app, {
        mode: "auth",
        stages: LONG_STAGES.slice(0, 1),
        stageDelayMs: 120,
        errorMessage:
          "Authentication failed for 'https://github.com/helios-labs/helios-dashboard.git/'",
      });
      await startClone(page);
      await settle(page, 1200);
      await snap(page, "55-failure-auth", panel());
      await closeDialog(page);
    });

    // 11. Failure plus partial-cleanup failure — two error surfaces at once.
    await step("cleanup", async () => {
      await openDialog(page);
      await fillForm(page);
      await setScript(ctx!.app, {
        mode: "cleanup",
        stages: LONG_STAGES.slice(0, 2),
        stageDelayMs: 120,
        errorMessage: "early EOF",
        cleanupMessage: `Couldn't remove the partial clone at ${path.join(destination, "helios-dashboard")}. Close any Git processes using it and delete the folder manually.`,
      });
      await startClone(page);
      await settle(page, 1200);
      await snap(page, "60-failure-with-cleanup", panel());
      await closeDialog(page);
    });

    // 12. Success — the two-second window before the dialog hands off.
    await step("success", async () => {
      await openDialog(page);
      await fillForm(page);
      await setScript(ctx!.app, { mode: "success", stages: LONG_STAGES, stageDelayMs: 120 });
      await startClone(page);
      await settle(page, 700);
      await snap(page, "70-success", panel());
      await snap(page, "71-success-in-window");
      await closeDialog(page);
    });
  } finally {
    if (ctx?.app) await closeApp(ctx.app);
    repo.cleanup();
    rmSync(destination, { recursive: true, force: true });
    rmSync(userDataDir, { recursive: true, force: true });
  }

  console.log(`[clone-shots] wrote ${written.length} file(s): ${written.join(", ")}`);
  expect(failures, `capture steps failed:\n${failures.join("\n")}`).toEqual([]);
  expect(written.length, "no screenshots were written").toBeGreaterThan(0);
});
