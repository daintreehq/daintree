/**
 * Move or rename project dialog visual-review harness.
 *
 * Drives `MoveOrRenameProjectDialog` through every state that carries design
 * weight, in both of its modes, and writes a PNG of each so a redesign can be
 * judged against real rendered pixels:
 *
 *   move      — at rest, a display-name-only change, an invalid folder name,
 *               the preview past its Doherty gate, a clear preview, a busy
 *               preview (terminals, every continuity tier, worktrees, panels),
 *               blockers, a preview failure, the apply in flight, an apply
 *               failure, and long paths.
 *   reattach  — at rest, a picked folder with its preview, an apply failure,
 *               and long paths.
 *
 * Both modes are reached the way a user reaches them: move from the current
 * project's row in the project switcher, reattach by selecting a project whose
 * folder has really been deleted — the harness adds a second project through
 * the real `project:add` channel, removes its folder, and lets the app's own
 * missing-project check flag it.
 *
 * States come from replacing the `project-relocation:preview` and
 * `project-relocation:apply` handlers in the MAIN process, so the renderer runs
 * its real path — the real envelope, the real debounce and stale-request guard,
 * the real Doherty gate. A real relocation can't produce a blocker or a failure
 * on demand, and can't hold the apply still long enough to photograph it.
 *
 * Opt-in only, like the other review harnesses: skips itself unless
 * DAINTREE_SHOT_RELOCATE is set, so the marketing screenshots workflow never runs it.
 *
 *   DAINTREE_SHOT_RELOCATE=1 npx playwright test --project=screenshots move-rename-dialog-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_RELOCATE  required — any truthy value runs the capture
 *   DAINTREE_SHOT_THEME     optional theme id (default: the app default)
 *   DAINTREE_SHOT_TAG       optional suffix so rounds and themes sit side by side
 *   DAINTREE_SHOT_ONLY      comma-separated step filter (see step names below)
 *   DESIGN_CAPTURE_DIR      optional output directory
 *
 * Output: artifacts/move-rename-shots/<NN-slug>[-tag].png (gitignored), or
 * DESIGN_CAPTURE_DIR when set.
 */

import { test, expect, type Page, type ElectronApplication } from "@playwright/test";
import { execSync } from "child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, statSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { launchApp, closeApp, mockOpenDialog, type AppContext } from "../helpers/launch";
import { openAndOnboardProject } from "../helpers/project";
import { dismissBlockingPalette } from "../helpers/overlays";
import { setAppTheme, ensureQuickRunInputVisible } from "../helpers/theme";
import { SEL } from "../helpers/selectors";
import { T_LONG, T_MEDIUM } from "../helpers/timeouts";

const ENABLED = !!process.env.DAINTREE_SHOT_RELOCATE;
const THEME = process.env.DAINTREE_SHOT_THEME ?? "";
const TAG = process.env.DAINTREE_SHOT_TAG ? `-${process.env.DAINTREE_SHOT_TAG}` : "";
const SCALE = process.env.DAINTREE_SCREENSHOT_SCALE ?? "2";
const OUTPUT_DIR = process.env.DESIGN_CAPTURE_DIR
  ? path.resolve(process.env.DESIGN_CAPTURE_DIR)
  : path.resolve(process.cwd(), "artifacts", "move-rename-shots");

const DIALOG_TESTID = '[data-testid="move-or-rename-project-dialog"]';
/** The dialog backdrop carries `aria-modal`; the panel is its first child. */
const PANEL = `div[aria-modal="true"]:has(${DIALOG_TESTID}) > div`;

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

interface ScriptBlocker {
  reason: string;
  message: string;
}

interface ScriptContinuity {
  agentId: string;
  agentName: string;
  count: number;
  tier: string;
  detail?: string;
}

/** What the stubbed handlers answer with. `newPath` is echoed from the request. */
interface RelocationScript {
  previewMode: "ok" | "error" | "hang";
  previewError: string;
  runningTerminalCount: number;
  agentContinuity: ScriptContinuity[];
  linkedWorktrees: string[];
  affectedPanelCount: number;
  blockers: ScriptBlocker[];
  applyMode: "hang" | "error";
  applyError: string;
}

const QUIET_PREVIEW: Partial<RelocationScript> = {
  previewMode: "ok",
  runningTerminalCount: 0,
  agentContinuity: [],
  linkedWorktrees: [],
  affectedPanelCount: 0,
  blockers: [],
};

/** Riskiest first, the order the coordinator sorts them in. */
const EVERY_TIER: ScriptContinuity[] = [
  { agentId: "aider", agentName: "Aider", count: 1, tier: "unavailable" },
  {
    agentId: "gemini",
    agentName: "Gemini CLI",
    count: 1,
    tier: "provider-migration",
    detail: "Gemini keys conversations by folder path, so this one stays at the old path",
  },
  { agentId: "opencode", agentName: "OpenCode", count: 1, tier: "unverified" },
  { agentId: "codex", agentName: "Codex", count: 1, tier: "project-local" },
  { agentId: "claude", agentName: "Claude Code", count: 2, tier: "preserved" },
];

function git(cmd: string, cwd: string): void {
  execSync(`git ${cmd}`, { cwd, stdio: "ignore" });
}

function createFixtureRepo(root: string, name: string): string {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  git("init -b main", dir);
  git('config user.email "test@daintree.dev"', dir);
  git('config user.name "Daintree Test"', dir);
  writeFileSync(path.join(dir, "README.md"), `# ${name}\n`);
  git("add -A", dir);
  git('commit -m "initial commit"', dir);
  return dir;
}

async function installRelocationStub(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ ipcMain }) => {
    const scope = globalThis as unknown as { __relocateShotScript?: RelocationScript };
    scope.__relocateShotScript ??= {
      previewMode: "ok",
      previewError: "Couldn't preview the changes",
      runningTerminalCount: 0,
      agentContinuity: [],
      linkedWorktrees: [],
      affectedPanelCount: 0,
      blockers: [],
      applyMode: "hang",
      applyError: "Couldn't move the project",
    };

    // `electron/setup/security.ts` wraps every handler's return in the success
    // envelope and every throw in the error one, so return raw payloads and
    // throw real Errors, exactly as the production handler does.
    // Held in a global so the pending promise stays reachable: a promise
    // nothing references is collected, and Electron then fails the invoke with
    // "reply was never sent" — which photographs as an error, not a wait.
    const held = ((
      globalThis as unknown as { __relocateShotHeld?: unknown[] }
    ).__relocateShotHeld ??= []);
    const hang = () => new Promise<never>((resolve) => held.push(resolve));

    ipcMain.removeHandler("project-relocation:preview");
    ipcMain.handle(
      "project-relocation:preview",
      async (_event, request: { mode: string; newPath: string }) => {
        const script = scope.__relocateShotScript!;
        if (script.previewMode === "hang") return hang();
        if (script.previewMode === "error") throw new Error(script.previewError);
        return {
          mode: request.mode,
          oldPath: "",
          newPath: request.newPath,
          runningTerminalCount: script.runningTerminalCount,
          agentContinuity: script.agentContinuity,
          linkedWorktrees: script.linkedWorktrees,
          affectedPanelCount: script.affectedPanelCount,
          blockers: script.blockers,
        };
      }
    );

    ipcMain.removeHandler("project-relocation:apply");
    ipcMain.handle("project-relocation:apply", async () => {
      const script = scope.__relocateShotScript!;
      if (script.applyMode === "hang") return hang();
      throw new Error(script.applyError);
    });
  });
}

async function setScript(
  app: ElectronApplication,
  patch: Partial<RelocationScript>
): Promise<void> {
  await app.evaluate((_electron, p) => {
    const scope = globalThis as unknown as { __relocateShotScript?: RelocationScript };
    scope.__relocateShotScript = { ...scope.__relocateShotScript!, ...p };
  }, patch);
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
    throw new Error(`[relocate-shots] snap "${slug}" produced no file at ${file}`);
  }
  written.push(path.basename(file));
}

/**
 * The rich and long-path states overflow the dialog body, and an element
 * screenshot only shows what is scrolled into view — so those states also get
 * a capture scrolled to the end, or the bottom of the preview is never seen.
 */
async function scrollBodyToEnd(page: Page): Promise<void> {
  await page
    .locator(`${PANEL} .dialog-body-inset`)
    .first()
    .evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
  await settle(page, 200);
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
    console.warn(`[relocate-shots] step failed — ${detail}`);
    failures.push(detail);
  }
}

const dialog = (page: Page) => page.locator(`div[aria-modal="true"]:has(${DIALOG_TESTID})`);

async function openSwitcher(page: Page): Promise<void> {
  await page.locator(SEL.toolbar.projectSwitcherTrigger).click();
  await page.locator(SEL.projectSwitcher.palette).waitFor({ state: "visible", timeout: T_MEDIUM });
  await settle(page, 500);
}

/** The switcher row whose visible text names the project. */
function switcherRow(page: Page, name: string) {
  return page
    .locator(SEL.projectSwitcher.palette)
    .locator('[role="option"]')
    .filter({ hasText: name })
    .first();
}

async function openMove(page: Page, projectName: string): Promise<void> {
  await openSwitcher(page);
  await switcherRow(page, projectName).click({ button: "right" });
  await page.getByRole("menuitem", { name: /Move or rename project/ }).click();
  await dialog(page).waitFor({ state: "visible", timeout: T_MEDIUM });
  await settle(page, 500);
}

async function openReattach(page: Page, projectName: string): Promise<void> {
  await openSwitcher(page);
  await switcherRow(page, projectName).click();
  await dialog(page).waitFor({ state: "visible", timeout: T_MEDIUM });
  await settle(page, 500);
}

/**
 * Throws rather than giving up quietly. A dialog stuck open turns every later
 * step into a timeout, which reads as ten unrelated failures instead of the
 * one that actually happened. An apply held open makes the dialog
 * non-dismissible, so those steps end by reloading the view instead.
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

async function reloadView(page: Page): Promise<void> {
  await page.reload({ waitUntil: "domcontentloaded" });
  await page
    .locator(SEL.toolbar.projectSwitcherTrigger)
    .waitFor({ state: "visible", timeout: T_LONG });
  await ensureQuickRunInputVisible(page);
  await page.addStyleTag({ content: POLISH_CSS }).catch(() => {});
  await dismissBlockingPalette(page);
  await settle(page, 1200);
}

/** The folder-name field — located by its label so a layout change doesn't break it. */
const folderField = (page: Page) => dialog(page).getByLabel("Folder name", { exact: true });
const nameField = (page: Page) => dialog(page).getByLabel(/^(Display name|Name)$/);

async function browse(page: Page): Promise<void> {
  await dialog(page)
    .getByRole("button", { name: /Browse/ })
    .first()
    .click();
  await settle(page, 300);
}

async function confirm(page: Page, label: RegExp): Promise<void> {
  await dialog(page).getByRole("button", { name: label }).click();
}

test("move or rename dialog review — both modes, every state", async () => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_RELOCATE is required for the move/rename dialog capture",
  });
  test.skip(!ENABLED, "Set DAINTREE_SHOT_RELOCATE to run the move/rename dialog capture");

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const root = mkdtempSync(path.join(tmpdir(), "daintree-relocate-shots-"));
  const primary = createFixtureRepo(root, "helios-dashboard");
  const ghost = createFixtureRepo(root, "atlas-api");
  const userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-relocateshot-"));
  let ctx: AppContext | undefined;

  const newParent = "/Users/you/Code/clients";
  const longParent =
    "/Users/you/Library/Mobile Documents/com~apple~CloudDocs/Engineering/Clients/Helios Labs/2026 platform rebuild/services";
  const longFolder = "helios-dashboard-realtime-telemetry-and-billing-console";

  try {
    ctx = await launchApp({
      userDataDir,
      screenshotScale: SCALE,
      windowSize: { width: 1680, height: 1050 },
      extraArgs: ["--disable-gpu", "--in-process-gpu", "--disable-breakpad", "--noerrdialogs"],
    });

    const page = await openAndOnboardProject(ctx.app, ctx.window, primary, "helios-dashboard");

    // A second project, added through the real channel and then deleted from
    // disk, so the app's own missing-project check marks it unavailable.
    await page.evaluate(async (p) => {
      await window.electron.project.add(p);
    }, ghost);
    rmSync(ghost, { recursive: true, force: true });
    await page.evaluate(async () => {
      await window.electron.project.checkMissing();
    });

    if (THEME) await setAppTheme(page, THEME);
    await reloadView(page);

    await installRelocationStub(ctx.app);
    await mockOpenDialog(ctx.app, newParent);

    // ── Move mode ────────────────────────────────────────────────────────────

    // 1. At rest — nothing changed yet.
    await step("move-rest", async () => {
      await openMove(page, "helios-dashboard");
      await snap(page, "10-move-rest", PANEL);
      await snap(page, "11-move-rest-in-window");
      await closeDialog(page);
    });

    // 2. Display name only — the metadata fast path, no preview.
    await step("move-name-only", async () => {
      await openMove(page, "helios-dashboard");
      await nameField(page).fill("Helios Dashboard");
      await settle(page, 400);
      await snap(page, "12-move-name-only", PANEL);
      await closeDialog(page);
    });

    // 3. Folder-name validation error.
    await step("move-invalid", async () => {
      await openMove(page, "helios-dashboard");
      await folderField(page).fill("helios:dashboard");
      await settle(page, 400);
      await snap(page, "15-move-folder-invalid", PANEL);
      await closeDialog(page);
    });

    // 4. Preview past the Doherty gate — still checking.
    await step("move-loading", async () => {
      await setScript(ctx!.app, { previewMode: "hang" });
      await openMove(page, "helios-dashboard");
      await folderField(page).fill("helios-web");
      await settle(page, 1100);
      await snap(page, "20-move-preview-loading", PANEL);
      await closeDialog(page);
    });

    // 5. A clear preview — a plain rename in place, nothing affected.
    await step("move-clear", async () => {
      await setScript(ctx!.app, QUIET_PREVIEW);
      await openMove(page, "helios-dashboard");
      await folderField(page).fill("helios-web");
      await settle(page, 900);
      await snap(page, "25-move-preview-clear", PANEL);
      await closeDialog(page);
    });

    // 6. A busy preview — new parent, terminals, every continuity tier,
    // worktrees and panels. The status lines.
    await step("move-rich", async () => {
      await setScript(ctx!.app, {
        ...QUIET_PREVIEW,
        runningTerminalCount: 6,
        agentContinuity: EVERY_TIER,
        linkedWorktrees: [
          "/Users/you/Code/helios-dashboard-worktrees/feature-billing",
          "/Users/you/Code/helios-dashboard-worktrees/fix-auth-refresh",
        ],
        affectedPanelCount: 4,
      });
      await openMove(page, "helios-dashboard");
      await nameField(page).fill("Helios Dashboard");
      await browse(page);
      await settle(page, 900);
      await snap(page, "30-move-preview-rich", PANEL);
      await snap(page, "31-move-preview-rich-in-window");
      await scrollBodyToEnd(page);
      await snap(page, "32-move-preview-rich-scrolled", PANEL);
      await closeDialog(page);
    });

    // 7. Blockers — the move can't proceed.
    await step("move-blocked", async () => {
      await setScript(ctx!.app, {
        ...QUIET_PREVIEW,
        blockers: [
          {
            reason: "destination-exists",
            message: "A folder named helios-web already exists in /Users/you/Code/clients",
          },
          {
            reason: "cross-volume",
            message:
              "Moving to another drive isn't supported yet. Choose a folder on the same drive",
          },
        ],
      });
      await openMove(page, "helios-dashboard");
      await folderField(page).fill("helios-web");
      await browse(page);
      await settle(page, 900);
      await snap(page, "35-move-preview-blocked", PANEL);
      await closeDialog(page);
    });

    // 8. The preview itself failed.
    await step("move-preview-error", async () => {
      await setScript(ctx!.app, {
        previewMode: "error",
        previewError: `EACCES: permission denied, access '${path.dirname(primary)}'`,
      });
      await openMove(page, "helios-dashboard");
      await folderField(page).fill("helios-web");
      await settle(page, 900);
      await snap(page, "40-move-preview-error", PANEL);
      await closeDialog(page);
    });

    // 9. Apply in flight — non-dismissible, confirm loading.
    await step("move-applying", async () => {
      await setScript(ctx!.app, { ...QUIET_PREVIEW, runningTerminalCount: 2, applyMode: "hang" });
      await openMove(page, "helios-dashboard");
      await folderField(page).fill("helios-web");
      await settle(page, 900);
      await confirm(page, /^Move project$/);
      await settle(page, 600);
      await snap(page, "45-move-applying", PANEL);
      await reloadView(page);
    });

    // 10. Apply failed.
    await step("move-apply-error", async () => {
      await setScript(ctx!.app, {
        ...QUIET_PREVIEW,
        runningTerminalCount: 2,
        applyMode: "error",
        applyError: "Couldn't stop 1 terminal in time. Nothing was moved — close it and try again",
      });
      await openMove(page, "helios-dashboard");
      await folderField(page).fill("helios-web");
      await settle(page, 900);
      await confirm(page, /^Move project$/);
      await settle(page, 700);
      await snap(page, "50-move-apply-error", PANEL);
      await closeDialog(page);
    });

    // 11. Long paths everywhere they can appear.
    await step("move-long", async () => {
      await mockOpenDialog(ctx!.app, longParent);
      await setScript(ctx!.app, {
        ...QUIET_PREVIEW,
        runningTerminalCount: 1,
        agentContinuity: [EVERY_TIER[4]],
        linkedWorktrees: [
          `${longParent}/${longFolder}-worktrees/feature-realtime-usage-metering-backfill`,
        ],
      });
      await openMove(page, "helios-dashboard");
      await folderField(page).fill(longFolder);
      await browse(page);
      await settle(page, 900);
      await snap(page, "55-move-long-paths", PANEL);
      await scrollBodyToEnd(page);
      await snap(page, "56-move-long-paths-scrolled", PANEL);
      await closeDialog(page);
      await mockOpenDialog(ctx!.app, newParent);
    });

    // ── Reattach mode ────────────────────────────────────────────────────────

    // 12. At rest — the folder is gone and nothing is picked yet.
    await step("reattach-rest", async () => {
      await openReattach(page, "atlas-api");
      await snap(page, "60-reattach-rest", PANEL);
      await snap(page, "61-reattach-rest-in-window");
      await closeDialog(page);
    });

    // 13. A folder picked, preview loaded.
    await step("reattach-picked", async () => {
      await mockOpenDialog(ctx!.app, "/Volumes/Archive/Code/atlas-api");
      await setScript(ctx!.app, { ...QUIET_PREVIEW, affectedPanelCount: 3 });
      await openReattach(page, "atlas-api");
      await browse(page);
      await settle(page, 900);
      await snap(page, "65-reattach-picked", PANEL);
      await closeDialog(page);
    });

    // 14. Reattach failed.
    await step("reattach-apply-error", async () => {
      await setScript(ctx!.app, {
        ...QUIET_PREVIEW,
        applyMode: "error",
        applyError: "That folder isn't a Git repository. Choose the folder that holds the project",
      });
      await openReattach(page, "atlas-api");
      await browse(page);
      await settle(page, 900);
      await confirm(page, /^Reattach project$/);
      await settle(page, 700);
      await snap(page, "70-reattach-apply-error", PANEL);
      await closeDialog(page);
    });

    // 15. Reattach with a long picked path.
    await step("reattach-long", async () => {
      await mockOpenDialog(ctx!.app, `${longParent}/atlas-api-ingest-gateway-and-schema-registry`);
      await setScript(ctx!.app, QUIET_PREVIEW);
      await openReattach(page, "atlas-api");
      await browse(page);
      await settle(page, 900);
      await snap(page, "75-reattach-long-paths", PANEL);
      await closeDialog(page);
    });
  } finally {
    if (ctx?.app) await closeApp(ctx.app);
    rmSync(root, { recursive: true, force: true });
    rmSync(userDataDir, { recursive: true, force: true });
  }

  console.log(`[relocate-shots] wrote ${written.length} file(s): ${written.join(", ")}`);
  expect(failures, `capture steps failed:\n${failures.join("\n")}`).toEqual([]);
  expect(written.length, "no screenshots were written").toBeGreaterThan(0);
});
