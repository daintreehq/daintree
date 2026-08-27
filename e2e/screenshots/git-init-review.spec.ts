/**
 * `GitInitDialog` visual-review harness (#11975).
 *
 * The dialog gathers configuration, then runs a multi-step git routine and reports it
 * in place. Most of what is wrong with a surface like that is invisible in the JSX and
 * obvious in a PNG: a dependent field that reads as a peer of the checkbox controlling
 * it, a monospace transcript that reads as a terminal dropped into a form, two error
 * treatments for one failure, a success state that is still mostly a disabled form.
 *
 * Every state here is driven through the REAL seams, never a renderer mock:
 *
 *   - the dialog is opened the way a user opens it: pick a folder that is not a
 *     repository, which fails `NOT_A_GIT_REPO` in `addProjectByPath` and re-emerges as
 *     `NonGitFolderDialog`; "Initialize repository" then hands over to `GitInitDialog`.
 *     The carried-identity state comes from the create-project-folder flow, which is
 *     the only path that supplies one.
 *   - initialization is real. `project:init-git-guided` runs against a real folder and
 *     the progress rows come from the main process's own events.
 *   - the git-identity failure is real: the app is launched with `GIT_CONFIG_GLOBAL`
 *     pointed at a file this harness owns, so emptying it makes `git commit` fail the
 *     way it does for a user who has never configured git.
 *   - the mid-flight progress state is real too — a fixture with 60k files makes
 *     `git add .` take seconds, so the shot is a genuine in-flight render rather than
 *     a paused animation frame.
 *   - "connecting" and the thrown-failure state come from the main-process fault
 *     registry (`DAINTREE_E2E_FAULT_MODE=1` + `e2e/helpers/ipcFaults`).
 *
 *   DAINTREE_SHOT_GITINIT=1 npx playwright test --project=screenshots git-init-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_GITINIT  required — any truthy value runs the capture
 *   DAINTREE_SHOT_THEME    optional theme id (default: the app default)
 *   DAINTREE_SHOT_TAG      optional suffix so rounds sit side by side
 *   DAINTREE_SHOT_ONLY     comma-separated step filter (see step names below)
 *   DAINTREE_SHOT_OUT      optional absolute output dir (default artifacts/git-init-shots)
 *
 * Output: <out>/<NN-slug>[-tag].png (artifacts/ is gitignored).
 */

import { test, type Page } from "@playwright/test";
import { execFileSync } from "child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { launchApp, closeApp, mockOpenDialog, type AppContext } from "../helpers/launch";
import { dismissTelemetryConsent } from "../helpers/project";
import { dismissBlockingPalette } from "../helpers/overlays";
import { injectDelay, injectFault, clearAllFaults } from "../helpers/ipcFaults";
import { SEL } from "../helpers/selectors";
import { T_LONG } from "../helpers/timeouts";

const ENABLED = !!process.env.DAINTREE_SHOT_GITINIT;
const THEME = process.env.DAINTREE_SHOT_THEME ?? "";
const TAG = process.env.DAINTREE_SHOT_TAG ? `-${process.env.DAINTREE_SHOT_TAG}` : "";
const SCALE = process.env.DAINTREE_SCREENSHOT_SCALE ?? "2";
const OUTPUT_DIR =
  process.env.DAINTREE_SHOT_OUT ?? path.resolve(process.cwd(), "artifacts", "git-init-shots");

/**
 * The dialog CARD, not the surface element.
 *
 * `AppDialog` puts `role="dialog"` on the `fixed inset-0` scrim, so screenshotting the
 * role selector silently returns the whole window — a full-window PNG that looks like a
 * successful crop until you compare its dimensions.
 */
const DIALOG = "[data-app-dialog-surface] > div";

/**
 * The stable testid contract this harness asserts against. The redesign may move,
 * restyle, or re-shape any of these — it must not delete them, or the harness stops
 * being able to prove the state it captured is the state it meant to capture.
 */
const TID = {
  dialog: '[data-testid="git-init-dialog"]',
  nameError: '[data-testid="git-init-name-error"]',
  progress: '[data-testid="git-init-progress"]',
  connecting: '[data-testid="git-init-connecting"]',
  step: '[data-testid="git-init-step"]',
  commandBlock: '[data-testid="git-init-command-block"]',
  error: '[data-testid="git-init-error"]',
  success: '[data-testid="git-init-success"]',
  openProject: '[data-testid="git-init-open"]',
} as const;

const CH = {
  initGitGuided: "project:init-git-guided",
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
   * Skeleton bones start at opacity 0 and are faded in by the pulse keyframes after
   * the 400ms Doherty delay, so the animation freeze above leaves them INVISIBLE — a
   * loading shot that looks like an empty panel and sends the whole review off
   * reviewing a screen that does not exist. Pin them visible.
   */
  [class*="animate-pulse-"] { opacity: 1 !important; }
`;

/**
 * A folder that is deliberately NOT a repository, populated enough that `git add`
 * has something to do and the .gitignore template has something to exclude.
 */
function makePlainFolder(root: string, name: string): string {
  const dir = path.join(root, name);
  mkdirSync(path.join(dir, "src"), { recursive: true });
  mkdirSync(path.join(dir, "node_modules", "left-pad"), { recursive: true });
  writeFileSync(path.join(dir, "README.md"), `# ${name}\n\nNotes.\n`);
  writeFileSync(path.join(dir, "package.json"), `{ "name": "${name}", "version": "0.1.0" }\n`);
  writeFileSync(path.join(dir, ".env"), "API_TOKEN=not-a-real-token\n");
  writeFileSync(path.join(dir, "src", "index.ts"), "export const start = () => {};\n");
  writeFileSync(path.join(dir, "node_modules", "left-pad", "index.js"), "module.exports = 1;\n");
  return dir;
}

/**
 * Same, but big enough that `git add .` genuinely takes seconds.
 *
 * The mid-flight progress state is the one this dialog exists to render, and it is
 * also the one a fast fixture makes impossible to photograph. 60k small files put
 * `git add` at roughly three seconds on a warm SSD — long enough to assert the live
 * step is on screen and then take the shot, without stubbing anything.
 */
function makeSlowFolder(root: string, name: string): string {
  const dir = path.join(root, name);
  const body = "export const value = 1;\n".repeat(20);
  for (let d = 0; d < 120; d++) {
    const sub = path.join(dir, "src", `mod${String(d).padStart(3, "0")}`);
    mkdirSync(sub, { recursive: true });
    for (let i = 0; i < 500; i++) {
      writeFileSync(path.join(sub, `f${String(i).padStart(3, "0")}.ts`), body);
    }
  }
  writeFileSync(path.join(dir, "README.md"), `# ${name}\n`);
  return dir;
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
  opts: { marker: string; locator?: string; markerTimeout?: number; settleMs?: number }
): Promise<void> {
  await page
    .locator(opts.marker)
    .first()
    .waitFor({ state: "visible", timeout: opts.markerTimeout ?? 8000 });
  await settle(page, opts.settleMs);
  // Re-checked AFTER the settle, not only before it: the app's own later render can
  // replace the state between the assertion and the shutter.
  if (!(await page.locator(opts.marker).first().isVisible())) {
    throw new Error(`[git-init-shots] "${slug}": marker ${opts.marker} vanished before the shot`);
  }
  const file = path.join(OUTPUT_DIR, `${slug}${TAG}.png`);
  if (opts.locator) {
    await page.locator(opts.locator).last().screenshot({ path: file, type: "png" });
  } else {
    await page.screenshot({ path: file, type: "png", animations: "disabled", caret: "hide" });
  }
}

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

/**
 * The shared `setAppTheme` waits on project-view chrome (sidebar toggle, project
 * switcher, command input). This harness never opens a project — every state is
 * reached from the welcome screen — so it waits on the welcome screen instead.
 */
async function setWelcomeTheme(page: Page, schemeId: string): Promise<void> {
  await page.evaluate(async (id) => {
    await window.electron.appTheme.setColorScheme(id);
  }, schemeId);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(SEL.welcome.openFolder).waitFor({ state: "visible", timeout: T_LONG });
  const applied = await page
    .locator("html")
    .evaluate((element) => element.getAttribute("data-theme"));
  if (applied !== schemeId) {
    throw new Error(`[git-init-shots] theme ${schemeId} did not apply (got ${applied})`);
  }
}

const ONLY = (process.env.DAINTREE_SHOT_ONLY ?? "").split(",").filter(Boolean);

// A failed step must not abort the run — the remaining shots are still worth having,
// and a per-theme sweep should not lose fourteen themes to one bad selector. But the
// run must still FAIL: a silent exit 0 over an empty output directory reads as success.
const failures: string[] = [];

test("git init dialog review — configuration, progress, recovery and success", async () => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_GITINIT is required for the git-init capture",
  });
  test.skip(!ENABLED, "Set DAINTREE_SHOT_GITINIT to run the git-init capture");

  failures.length = 0;
  mkdirSync(OUTPUT_DIR, { recursive: true });

  const fixtureRoot = mkdtempSync(path.join(tmpdir(), "daintree-gitinit-shots-"));
  const userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-gitinitshot-"));

  /**
   * The app's git identity, owned by this harness rather than by whoever is running it.
   *
   * Via HOME, deliberately, and NOT via `GIT_CONFIG_GLOBAL`: the app's git hardening
   * strips `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM` out of every spawn env on purpose
   * (`BLOCKED_INHERITED_GIT_ENV_KEYS` in `electron/utils/hardenedGit.ts`), so setting
   * them here changes nothing and the app quietly keeps reading the developer's own
   * `~/.gitconfig`. `HOME` is what is left, and it is what git resolves the global
   * config from. `XDG_CONFIG_HOME` rides along because git prefers it when set.
   *
   * Rewriting the file between steps flips the real behaviour: with a `[user]` block the
   * initial commit succeeds, without one it fails exactly the way it does for someone
   * who has never configured git — which is the whole point of the recovery state.
   */
  const fakeHome = path.join(fixtureRoot, "home");
  mkdirSync(path.join(fakeHome, ".config"), { recursive: true });
  const gitConfigPath = path.join(fakeHome, ".gitconfig");
  const writeGitIdentity = (present: boolean): void => {
    writeFileSync(
      gitConfigPath,
      present
        ? "[init]\n\tdefaultBranch = main\n[user]\n\tname = Daintree Test\n\temail = dev@daintree.dev\n"
        : // `useConfigOnly` is what makes the absence deterministic. Left off, git guesses
          // an identity from the login name and hostname, the commit SUCCEEDS, the dialog
          // reaches its success state, the project is added and the app leaves the welcome
          // screen — taking the page every later step is holding with it.
          "[init]\n\tdefaultBranch = main\n[user]\n\tuseConfigOnly = true\n"
    );
  };

  /**
   * Prove the identity switch actually works before relying on it.
   *
   * Whether a bare `git commit` fails depends on the host's git version, hostname and
   * environment. If it quietly succeeds here, every recovery state in this harness
   * silently becomes a success state — the exact class of wrong-but-plausible artifact
   * this file must never produce. Better to fail now, loudly.
   */
  const assertIdentitySwitchWorks = (): void => {
    const probe = path.join(fixtureRoot, "identity-probe");
    mkdirSync(probe, { recursive: true });
    writeFileSync(path.join(probe, "a.txt"), "probe\n");
    const env = {
      ...process.env,
      HOME: fakeHome,
      XDG_CONFIG_HOME: path.join(fakeHome, ".config"),
      GIT_CONFIG_NOSYSTEM: "1",
    };
    execFileSync("git", ["init", "-q", "."], { cwd: probe, env, stdio: "ignore" });
    execFileSync("git", ["add", "-A"], { cwd: probe, env, stdio: "ignore" });
    writeGitIdentity(false);
    let failed = false;
    try {
      execFileSync("git", ["commit", "-m", "probe"], { cwd: probe, env, stdio: "pipe" });
    } catch {
      failed = true;
    }
    if (!failed) {
      throw new Error(
        "[git-init-shots] git committed without a configured identity — the recovery states " +
          "in this harness would silently capture success instead. Check the HOME override " +
          "and user.useConfigOnly support in this git version."
      );
    }
    rmSync(probe, { recursive: true, force: true });
  };
  // Absent for the whole run, and switched on only by the final `success` step.
  //
  // This is not a detail: every state that starts initialization eventually resolves,
  // and one that resolves SUCCESSFULLY adds the project and switches the app out of the
  // welcome screen — destroying the page every later step is holding. Leaving the
  // identity absent makes those runs land in the recovery state instead, which is
  // dismissible, so the harness keeps its footing.
  writeGitIdentity(false);
  assertIdentitySwitchWorks();

  // One folder per step. A step that starts initialization leaves a repository behind,
  // and a second visit to it would open the project instead of the dialog.
  const folder = (name: string) => makePlainFolder(fixtureRoot, name);
  const parentForCreateFlow = path.join(fixtureRoot, "workspace");
  mkdirSync(parentForCreateFlow, { recursive: true });

  let ctx: AppContext | undefined;

  try {
    ctx = await launchApp({
      userDataDir,
      screenshotScale: SCALE,
      windowSize: { width: 1680, height: 1050 },
      env: {
        DAINTREE_E2E_FAULT_MODE: "1",
        HOME: fakeHome,
        XDG_CONFIG_HOME: path.join(fakeHome, ".config"),
        // The host's /etc/gitconfig must not decide whether the recovery state is
        // reachable. Unlike GIT_CONFIG_GLOBAL, this one survives the hardening filter.
        GIT_CONFIG_NOSYSTEM: "1",
      },
      extraArgs: ["--disable-gpu", "--in-process-gpu", "--disable-breakpad", "--noerrdialogs"],
    });
    const app = ctx.app;
    const page = ctx.window;

    await dismissTelemetryConsent(page);
    await dismissBlockingPalette(page);
    await page.locator(SEL.welcome.openFolder).waitFor({ state: "visible", timeout: T_LONG });
    if (THEME) await setWelcomeTheme(page, THEME);
    await page.addStyleTag({ content: POLISH_CSS }).catch(() => {});
    await settle(page, 600);

    /**
     * Controls inside whichever dialog is up.
     *
     * Scoped and exact on purpose: the app toolbar carries a permanently disabled
     * "Browse files" button, and `getByRole`'s name match is a substring by default, so a
     * bare `{ name: "Browse" }` resolves to the toolbar and waits out its timeout on a
     * control that can never be clicked.
     */
    const dialogButton = (name: string) =>
      page.locator("[data-app-dialog-surface]").getByRole("button", { name, exact: true });

    /** Open a non-repo folder the way a user does, and land on the git setup step. */
    const openGitSetup = async (dir: string): Promise<void> => {
      await mockOpenDialog(app, dir);
      await page.locator(SEL.welcome.openFolder).click();
      // The folder is not a repository, so `addProjectByPath` fails NOT_A_GIT_REPO and
      // re-emerges as the choice screen. Its "Initialize repository" button is what
      // hands over to the dialog under review.
      await dialogButton("Initialize repository").waitFor({
        state: "visible",
        timeout: 15000,
      });
      await dialogButton("Initialize repository").click();
      await page.locator(TID.dialog).waitFor({ state: "visible", timeout: 8000 });
    };

    const startInit = async (): Promise<void> => {
      await dialogButton("Initialize repository").click();
    };

    /**
     * Escape, patiently.
     *
     * `dismissible={!isInitializing}` means Escape is inert while an operation is in
     * flight, and some of these operations are deliberately slow. A four-try teardown
     * gives up while the modal is still up, and every step after it then spends its own
     * timeout clicking at a scrim. Keep pressing until the dialog is actually gone or the
     * budget is spent — the budget is longer than the slowest state this harness drives.
     */
    const closeDialog = async (): Promise<void> => {
      for (let i = 0; i < 30; i++) {
        if (
          !(await page
            .locator(DIALOG)
            .first()
            .isVisible()
            .catch(() => false))
        )
          return;
        await page.keyboard.press("Escape").catch(() => {});
        await settle(page, i < 4 ? 250 : 2000);
      }
      throw new Error("[git-init-shots] dialog would not close");
    };

    /**
     * Runs one state, then unconditionally returns to rest. Unconditionally, not on the
     * success path only: a step that dies holding the dialog open would otherwise wedge
     * every step after it behind a modal.
     */
    const step = async (name: string, fn: () => Promise<void>): Promise<void> => {
      if (ONLY.length > 0 && !ONLY.includes(name)) return;
      try {
        await fn();
      } catch (error) {
        const detail = String(error).slice(0, 600);
        console.warn(`[git-init-shots] step "${name}" failed:`, detail);
        failures.push(`${name}: ${detail}`);
      } finally {
        await clearAllFaults(app).catch(() => {});
        await closeDialog().catch((error) => {
          failures.push(`${name} (reset): ${String(error).slice(0, 200)}`);
        });
        await page.emulateMedia({ forcedColors: null, contrast: null }).catch(() => {});
      }
    };

    // 1. The headline configuration state: reached directly by opening a non-repo
    //    folder, initial commit on, defaults everywhere.
    await step("direct", async () => {
      await openGitSetup(folder("aurora-notes"));
      await snap(page, "10-configure-default", { marker: TID.dialog, locator: DIALOG });
      await snap(page, "11-configure-default-in-window", { marker: TID.dialog });
    });

    // 2. Arrival with an identity already chosen. The create-project-folder flow is the
    //    only path that carries one, so it is the only honest way to reach this state.
    await step("identity-carried", async () => {
      await page.getByRole("button", { name: "Create project", exact: true }).click();
      await dialogButton("Browse").waitFor({ state: "visible", timeout: 8000 });
      await mockOpenDialog(app, parentForCreateFlow);
      await dialogButton("Browse").click();
      await page.locator("#create-folder-name").fill("telemetry-pipeline");
      await dialogButton("Create folder").click();
      await dialogButton("Initialize repository").waitFor({
        state: "visible",
        timeout: 15000,
      });
      await dialogButton("Initialize repository").click();
      await page.locator(TID.dialog).waitFor({ state: "visible", timeout: 8000 });
      await snap(page, "15-configure-carried-identity", { marker: TID.dialog, locator: DIALOG });
    });

    // 3. Initial commit off — the dependent field disappears, which is the state that
    //    shows whether it ever read as dependent in the first place.
    await step("commit-off", async () => {
      await openGitSetup(folder("harbour-lights"));
      await page.locator(TID.dialog).locator('input[type="checkbox"]').first().uncheck();
      await snap(page, "20-configure-commit-off", { marker: TID.dialog, locator: DIALOG });
    });

    // 4. Both validation states. The name one paints the field AND says why the button
    //    went dead; the commit-message one is the state where the button goes dead with
    //    nothing said at all.
    await step("empty-name", async () => {
      await openGitSetup(folder("cinder-block"));
      await page.locator("#git-init-project-name").fill("");
      await snap(page, "25-configure-empty-name", { marker: TID.nameError, locator: DIALOG });
    });

    await step("empty-message", async () => {
      await openGitSetup(folder("quiet-harbor"));
      await page.locator("#git-init-commit-message").fill("");
      await snap(page, "26-configure-empty-commit-message", {
        marker: TID.dialog,
        locator: DIALOG,
      });
    });

    // 5. A long project name and the longest gitignore template label — where the
    //    configuration mode truncates, if it does.
    await step("long-values", async () => {
      await openGitSetup(folder("meridian-observability-platform-services"));
      await page
        .locator("#git-init-project-name")
        .fill("Meridian Observability Platform — ingestion, rollup and alerting services");
      await snap(page, "27-configure-long-values", { marker: TID.dialog, locator: DIALOG });
    });

    // 6. Started, but the main process has not spoken yet: past the 400ms Doherty gate
    //    with zero progress events. Held open by a real IPC delay.
    await step("connecting", async () => {
      await openGitSetup(folder("still-water"));
      await injectDelay(app, CH.initGitGuided, 6000);
      await startInit();
      await snap(page, "30-running-connecting", { marker: TID.connecting, locator: DIALOG });
      // The delayed invoke is still in flight, and `dismissible={!isInitializing}` means
      // Escape does nothing until it lands. Wait it out here rather than leaving a modal
      // no later step can get past.
      await page.locator(TID.commandBlock).first().waitFor({ state: "visible", timeout: 25000 });
    });

    // 7. Mid-flight, with real steps behind it. The 60k-file fixture makes `git add`
    //    take seconds, and the identity is cleared first so the run lands in the
    //    recovery state rather than adding a project and leaving the welcome screen.
    await step("running", async () => {
      const slow = makeSlowFolder(fixtureRoot, "atlas-monorepo");
      await openGitSetup(slow);
      await startInit();
      await page
        .locator(TID.step)
        .filter({ hasText: "Staging files" })
        .first()
        .waitFor({ state: "visible", timeout: 20000 });
      await snap(page, "35-running-mid-flight", {
        marker: TID.step,
        locator: DIALOG,
        settleMs: 150,
      });
      // `git add` is still chewing through 60k files and the dialog is not dismissible
      // until it lands. Wait for the run to terminate rather than leaving a modal the
      // next step has to fight.
      await page.locator(TID.commandBlock).first().waitFor({ state: "visible", timeout: 60000 });
    });

    // 8. The identity failure and its multi-line command block — the one place this
    //    dialog puts shell commands in front of a user.
    await step("identity-error", async () => {
      await openGitSetup(folder("lantern-works"));
      await startInit();
      await snap(page, "40-failed-git-identity", {
        marker: TID.commandBlock,
        locator: DIALOG,
        markerTimeout: 20000,
      });
      await snap(page, "41-failed-git-identity-in-window", { marker: TID.commandBlock });
    });

    // 9. A thrown failure, which takes the OTHER error path: no progress events at all,
    //    so the separately styled block is the only thing on screen.
    await step("generic-error", async () => {
      await openGitSetup(folder("copper-forge"));
      await injectFault(
        app,
        CH.initGitGuided,
        "EACCES: permission denied, mkdir '/Users/dev/copper-forge/.git'"
      );
      await startInit();
      await snap(page, "45-failed-generic", {
        marker: TID.error,
        locator: DIALOG,
        markerTimeout: 15000,
      });
    });

    // 10. Keyboard focus on the primary control. This dialog is reached from Cmd+O and
    //     a Dock drop, so its keyboard affordances are design, not detail.
    await step("focus", async () => {
      await openGitSetup(folder("north-quay"));
      // Tabbed to, not `.focus()`-ed. A programmatic focus call does not satisfy
      // `:focus-visible` in Chromium, so the shot came back pixel-identical to the
      // unfocused default and read as "this button has no focus ring" — a defect that
      // was the harness's, not the dialog's. Walk the real tab order instead.
      let focused = false;
      for (let i = 0; i < 12 && !focused; i++) {
        await page.keyboard.press("Tab");
        focused = await dialogButton("Initialize repository").evaluate(
          (el) => el === document.activeElement
        );
      }
      if (!focused) {
        throw new Error("[git-init-shots] tab order never reached the primary action");
      }
      await snap(page, "60-focus-primary", { marker: TID.dialog, locator: DIALOG });
    });

    // 11. prefers-contrast: more — macOS "Increase contrast".
    await step("contrast", async () => {
      await page.emulateMedia({ contrast: "more" });
      await openGitSetup(folder("slate-run"));
      await snap(page, "70-contrast-more", { marker: TID.dialog, locator: DIALOG });
    });

    // 12. forced-colors: active — Windows high contrast swaps in system colours, and
    //     anything carrying meaning in a tint alone collapses here. Captured on the
    //     identity failure because that is where this surface leans hardest on tint.
    await step("forced", async () => {
      await page.emulateMedia({ forcedColors: "active" });
      await openGitSetup(folder("ironbark"));
      await startInit();
      await snap(page, "75-forced-colors", {
        marker: TID.commandBlock,
        locator: DIALOG,
        markerTimeout: 20000,
      });
    });

    // 13. Success. LAST, because finishing adds the project and switches the app out of
    //     the welcome screen, and the dialog auto-continues two seconds later — so this
    //     shot has a two-second window and takes a short settle to fit inside it.
    await step("success", async () => {
      writeGitIdentity(true);
      await openGitSetup(folder("beacon-hill"));
      await startInit();
      await snap(page, "50-success", {
        marker: TID.success,
        locator: DIALOG,
        markerTimeout: 20000,
        settleMs: 120,
      });
      // Success auto-continues, adds the project and switches the app out of the welcome
      // screen. Let that finish here rather than racing the teardown against it.
      await page.locator(DIALOG).first().waitFor({ state: "hidden", timeout: 15000 });
    });
  } finally {
    if (ctx?.app) await closeApp(ctx.app).catch(() => {});
    for (const dir of [fixtureRoot, userDataDir]) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  }

  // Counted here rather than trusted from the exit code: swallowed per-step errors are
  // exactly how a harness reports PASS over an empty directory.
  const written = existsSync(OUTPUT_DIR)
    ? readdirSync(OUTPUT_DIR).filter((f) => f.endsWith(`${TAG}.png`)).length
    : 0;
  console.log(`[git-init-shots] wrote ${written} png(s) to ${OUTPUT_DIR}`);

  if (failures.length > 0) {
    throw new Error(`[git-init-shots] ${failures.length} step(s) failed:\n${failures.join("\n")}`);
  }
  if (written === 0) {
    throw new Error(`[git-init-shots] no PNGs written to ${OUTPUT_DIR}`);
  }
});
