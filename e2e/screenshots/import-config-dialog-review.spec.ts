/**
 * Import configuration dialog visual-review harness.
 *
 * Drives `ImportConfigDialog` through every state that carries design weight
 * and writes a PNG of each, in every theme named, so a redesign can be judged
 * against real rendered pixels:
 *
 *   dialog — a busy bundle touching every section, a single-section bundle,
 *            an adds-only bundle, the backup exported, unsupported sections, a long file name, the apply in flight, a
 *            rolled-back apply, and a thrown apply.
 *   toasts — the file was rejected, the bundle already matches, the import
 *            landed, and the import landed with skipped leaves.
 *
 * The flow is entered the way the action enters it — the `daintree:import-config`
 * window event — and states come from replacing the `config-bundle:preview-import`
 * and `config-bundle:apply-import` handlers in the MAIN process, so the renderer
 * runs its real path: the real IPC envelope, the real single-flight gate, the
 * real notify routing. A real bundle can't be made to roll back on demand, and
 * a real apply can't be held still long enough to photograph.
 *
 * Opt-in only, like the other review harnesses: skips itself unless
 * DAINTREE_SHOT_IMPORT_CONFIG is set, so the marketing screenshots workflow
 * never runs it.
 *
 *   DAINTREE_SHOT_IMPORT_CONFIG=1 npx playwright test --project=screenshots import-config-dialog-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_IMPORT_CONFIG  required — any truthy value runs the capture
 *   DAINTREE_SHOT_THEMES         comma-separated theme ids (default: daintree,bondi)
 *   DAINTREE_SHOT_ONLY           comma-separated step filter (see step names below)
 *   DESIGN_CAPTURE_DIR           optional output directory
 *
 * Output: artifacts/import-config-shots/<NN-slug>--<theme>.png (gitignored), or
 * DESIGN_CAPTURE_DIR when set.
 */

import { test, expect, type Page, type ElectronApplication } from "@playwright/test";
import { execSync } from "child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, statSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { openAndOnboardProject } from "../helpers/project";
import { dismissBlockingPalette } from "../helpers/overlays";
import { setAppTheme } from "../helpers/theme";
import { SEL } from "../helpers/selectors";
import { T_MEDIUM } from "../helpers/timeouts";

const ENABLED = !!process.env.DAINTREE_SHOT_IMPORT_CONFIG;
const THEMES = (process.env.DAINTREE_SHOT_THEMES ?? "daintree,bondi")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);
const SCALE = process.env.DAINTREE_SCREENSHOT_SCALE ?? "2";
const OUTPUT_DIR = process.env.DESIGN_CAPTURE_DIR
  ? path.resolve(process.env.DESIGN_CAPTURE_DIR)
  : path.resolve(process.cwd(), "artifacts", "import-config-shots");

const IMPORT_EVENT = "daintree:import-config";
const MODAL = 'div[aria-modal="true"]:has-text("Import configuration")';
/** The dialog backdrop carries `aria-modal`; the panel is its first child. */
const PANEL = `${MODAL} > div`;

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

interface PreviewChange {
  key: string;
  label: string;
  kind: "add" | "update";
  from?: string;
  to?: string;
}

interface PreviewSection {
  section: string;
  add: number;
  update: number;
  unchanged: number;
  changes: PreviewChange[];
}

interface ImportScript {
  previewMode: "ready" | "rejected" | "matches";
  fileName?: string;
  sections: PreviewSection[];
  unknownSections: string[];
  rejectReason: string;
  applyMode: "hang" | "rolled-back" | "throw" | "applied" | "applied-skipped";
  applyError: string;
}

const upd = (key: string, label: string, from?: string, to?: string): PreviewChange => ({
  key,
  label,
  kind: "update",
  ...(from !== undefined ? { from, to } : {}),
});
const add = (key: string, label: string, to?: string): PreviewChange => ({
  key,
  label,
  kind: "add",
  ...(to !== undefined ? { to } : {}),
});

/** Built from its changes, so the counts can never disagree with the names. */
function section(id: string, unchanged: number, changes: PreviewChange[]): PreviewSection {
  return {
    section: id,
    add: changes.filter((c) => c.kind === "add").length,
    update: changes.filter((c) => c.kind === "update").length,
    unchanged,
    changes,
  };
}

/** Every section, a realistic spread of adds and replaces. */
const BUSY: PreviewSection[] = [
  section("userAgentRegistry", 1, [
    add("claude-reviewer", "Claude Reviewer"),
    add("local-llama", "Local Llama"),
  ]),
  section("agentSettings", 4, [
    upd("claude", "Claude Code"),
    upd("codex", "Codex"),
    upd("gemini", "Gemini CLI"),
  ]),
  section("keybindingOverrides", 9, [
    upd("terminal.close", "Close focused terminal"),
    upd("terminal.new", "New terminal"),
    add("terminal.split", "Split terminal"),
    add("worktree.next", "Next worktree"),
    add("worktree.previous", "Previous worktree"),
    add("palette.recipes", "Open recipes"),
  ]),
  section("appTheme", 0, [upd("colorSchemeId", "Color scheme", "Daintree", "Bondi")]),
  section("notificationSettings", 5, [
    upd("soundEnabled", "Sounds", "On", "Off"),
    upd("quietHoursEnabled", "Quiet hours", "Off", "On"),
  ]),
  section("worktreeConfig", 0, [
    upd(
      "pathPattern",
      "Path pattern",
      "{parent-dir}/{base-folder}-worktrees/{branch-slug}",
      "~/trees/{branch-slug}"
    ),
  ]),
  section("globalRecipes", 2, [
    upd("r-bug-bash", "Bug bash"),
    add("r-fleet", "Full review fleet"),
    add("r-triage", "Nightly triage"),
    add("r-release", "Release checklist"),
  ]),
];

const THEME_ONLY: PreviewSection[] = [
  section("appTheme", 0, [upd("colorSchemeId", "Color scheme", "Daintree", "Bondi")]),
  section("keybindingOverrides", 12, []),
];

/** Nothing replaced — every change is new, so nothing on this machine is lost. */
const ADDS_ONLY: PreviewSection[] = [
  section("userAgentRegistry", 0, [add("claude-reviewer", "Claude Reviewer")]),
  section("globalRecipes", 0, [
    add("r-fleet", "Full review fleet"),
    add("r-triage", "Nightly triage"),
  ]),
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

async function installImportStub(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ ipcMain }) => {
    const scope = globalThis as unknown as { __importShotScript?: ImportScript };
    scope.__importShotScript ??= {
      previewMode: "ready",
      fileName: "daintree-config.json",
      sections: [],
      unknownSections: [],
      rejectReason: "",
      applyMode: "hang",
      applyError: "",
    };

    // Held in a global so the pending promise stays reachable: a promise
    // nothing references is collected, and Electron then fails the invoke with
    // "reply was never sent" — which photographs as an error, not a wait.
    const held = ((globalThis as unknown as { __importShotHeld?: unknown[] }).__importShotHeld ??=
      []);
    const hang = () => new Promise<never>((resolve) => held.push(resolve));

    ipcMain.removeHandler("config-bundle:preview-import");
    ipcMain.handle("config-bundle:preview-import", async () => {
      const s = scope.__importShotScript!;
      if (s.previewMode === "rejected") {
        return { outcome: "rejected", sections: [], unknownSections: [], errors: [s.rejectReason] };
      }
      const sections =
        s.previewMode === "matches"
          ? s.sections.map((x) => ({
              ...x,
              add: 0,
              update: 0,
              unchanged: x.unchanged + x.add + x.update,
              changes: [],
            }))
          : s.sections;
      return {
        outcome: "ready",
        fileName: s.fileName,
        bundleJson: "{}",
        exportedAt: "2026-09-20T09:14:00.000Z",
        schemaVersion: 1,
        sections,
        unknownSections: s.unknownSections,
        errors: [],
      };
    });

    // Export is the dialog's backup route; answer as if the save dialog wrote a file.
    ipcMain.removeHandler("config-bundle:export");
    ipcMain.handle("config-bundle:export", async () => ({
      outcome: "written",
      filePath: "/Users/you/Desktop/daintree-config-backup.json",
      sections: [],
      omittedSecretPaths: [],
    }));

    ipcMain.removeHandler("config-bundle:apply-import");
    ipcMain.handle("config-bundle:apply-import", async () => {
      const s = scope.__importShotScript!;
      if (s.applyMode === "hang") return hang();
      if (s.applyMode === "throw") throw new Error(s.applyError);
      const report = (skipped: boolean) => ({
        outcome: "applied",
        rolledBack: false,
        errors: [],
        sections: s.sections.map((x) => ({
          section: x.section,
          present: true,
          applied: x.add + x.update - (skipped && x.section === "userAgentRegistry" ? 1 : 0),
          unchanged: x.unchanged,
          skipped: skipped && x.section === "userAgentRegistry" ? 1 : 0,
          failed: 0,
          errors: [],
          leaves:
            skipped && x.section === "userAgentRegistry"
              ? [
                  {
                    key: "local-llama",
                    status: "skipped",
                    reason: "its command isn't installed on this machine",
                  },
                ]
              : [],
        })),
      });
      if (s.applyMode === "applied") return report(false);
      if (s.applyMode === "applied-skipped") return report(true);
      return {
        outcome: "rolled-back",
        rolledBack: true,
        errors: [s.applyError],
        sections: [],
      };
    });
  });
}

async function setScript(app: ElectronApplication, patch: Partial<ImportScript>): Promise<void> {
  await app.evaluate((_electron, p) => {
    const scope = globalThis as unknown as { __importShotScript?: ImportScript };
    scope.__importShotScript = { ...scope.__importShotScript!, ...p };
  }, patch);
}

async function settle(page: Page, ms = 400): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
  );
  await page.waitForTimeout(ms);
}

const written: string[] = [];
let themeTag = "";

/**
 * Screenshot, then confirm a non-empty file actually landed. A harness that
 * trusts its own exit code reports success while writing nothing.
 */
async function snap(page: Page, slug: string, locator?: string): Promise<void> {
  const file = path.join(OUTPUT_DIR, `${slug}--${themeTag}.png`);
  if (locator) {
    await page.locator(locator).first().screenshot({ path: file, type: "png" });
  } else {
    await page.screenshot({ path: file, type: "png", animations: "disabled", caret: "hide" });
  }
  if (!existsSync(file) || statSync(file).size === 0) {
    throw new Error(`[import-config-shots] snap "${slug}" produced no file at ${file}`);
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
    const detail = `${themeTag}/${name}: ${String(error).slice(0, 400)}`;
    console.warn(`[import-config-shots] step failed — ${detail}`);
    failures.push(detail);
  }
}

const modal = (page: Page) => page.locator(MODAL);

async function openImport(page: Page): Promise<void> {
  await page.evaluate((name) => window.dispatchEvent(new CustomEvent(name)), IMPORT_EVENT);
}

async function openDialog(page: Page): Promise<void> {
  await openImport(page);
  await modal(page).waitFor({ state: "visible", timeout: T_MEDIUM });
  await settle(page, 500);
}

async function confirm(page: Page): Promise<void> {
  await modal(page)
    .getByRole("button", { name: /^Import configuration$|^Try again$/ })
    .click();
}

async function dismissToasts(page: Page): Promise<void> {
  const buttons = page.locator(SEL.notifications.toastDismissButton);
  for (let i = 0; i < 6 && (await buttons.count()) > 0; i++) {
    await buttons
      .first()
      .click()
      .catch(() => {});
    await settle(page, 200);
  }
}

/**
 * Throws rather than giving up quietly. A dialog stuck open turns every later
 * step into a timeout, which reads as ten unrelated failures instead of the
 * one that actually happened.
 */
async function closeDialog(page: Page): Promise<void> {
  for (let i = 0; i < 4; i++) {
    if (
      !(await modal(page)
        .isVisible()
        .catch(() => false))
    )
      return;
    await page.keyboard.press("Escape").catch(() => {});
    await settle(page, 200);
  }
  throw new Error("dialog did not close — later steps would cascade");
}

async function polish(page: Page): Promise<void> {
  await page.addStyleTag({ content: POLISH_CSS }).catch(() => {});
  await dismissBlockingPalette(page);
  await settle(page, 1200);
}

/** A toast, photographed with the region around it so its placement reads. */
async function snapToast(page: Page, slug: string): Promise<void> {
  const region = page.locator(SEL.notifications.toastRegion);
  await region.locator("li, [role='status'], [role='alert']").first().waitFor({
    state: "visible",
    timeout: T_MEDIUM,
  });
  await settle(page, 500);
  await snap(page, slug, SEL.notifications.toastRegion);
}

async function captureTheme(page: Page, app: ElectronApplication): Promise<void> {
  // 1. A busy bundle touching every section — the canonical state.
  await step("busy", async () => {
    await setScript(app, {
      previewMode: "ready",
      fileName: "daintree-config-2026-09-20.json",
      sections: BUSY,
      unknownSections: [],
      applyMode: "hang",
    });
    await openDialog(page);
    await snap(page, "10-busy", PANEL);
    await snap(page, "11-busy-in-window");
    await closeDialog(page);
  });

  // 2. A small bundle — one change, and a section present but identical.
  await step("single", async () => {
    await setScript(app, {
      previewMode: "ready",
      fileName: "theme-only.json",
      sections: THEME_ONLY,
      unknownSections: [],
    });
    await openDialog(page);
    await snap(page, "15-single-section", PANEL);
    await closeDialog(page);
  });

  // 2b. Only additions — nothing on this machine is replaced.
  await step("adds-only", async () => {
    await setScript(app, {
      previewMode: "ready",
      fileName: "team-recipes.json",
      sections: ADDS_ONLY,
      unknownSections: [],
    });
    await openDialog(page);
    await snap(page, "17-adds-only", PANEL);
    await closeDialog(page);
  });

  // 2c. The backup route taken — current values exported before importing.
  await step("exported", async () => {
    await setScript(app, {
      previewMode: "ready",
      fileName: "daintree-config-2026-09-20.json",
      sections: BUSY,
      unknownSections: [],
    });
    await openDialog(page);
    await modal(page)
      .getByRole("button", { name: /Export a backup/ })
      .click();
    await settle(page, 600);
    await snap(page, "18-backup-exported", PANEL);
    await closeDialog(page);
  });

  // 3. A bundle from a newer build carrying sections this one doesn't know.
  await step("unknown", async () => {
    await setScript(app, {
      previewMode: "ready",
      fileName: "daintree-config-from-0.40.json",
      sections: BUSY.slice(2, 5),
      unknownSections: ["mcpServers", "voiceSettings"],
    });
    await openDialog(page);
    await snap(page, "20-unknown-sections", PANEL);
    await closeDialog(page);
  });

  // 4. A long file name and no fileName at all.
  await step("long-name", async () => {
    await setScript(app, {
      previewMode: "ready",
      fileName: "greg-macbook-pro-daintree-configuration-backup-before-reinstall-2026-09-20.json",
      sections: BUSY,
      unknownSections: ["mcpServers"],
    });
    await openDialog(page);
    await snap(page, "25-long-file-name", PANEL);
    await closeDialog(page);
  });

  // 5. Apply in flight.
  await step("applying", async () => {
    await setScript(app, {
      previewMode: "ready",
      fileName: "daintree-config-2026-09-20.json",
      sections: BUSY,
      unknownSections: [],
      applyMode: "hang",
    });
    await openDialog(page);
    await confirm(page);
    await settle(page, 700);
    await snap(page, "30-applying", PANEL);
    // A held apply makes the dialog non-dismissible, so reload out of it.
    await page.reload({ waitUntil: "domcontentloaded" });
    await polish(page);
  });

  // 6. Apply rolled back — the dialog stays open with the reason.
  await step("rolled-back", async () => {
    await setScript(app, {
      previewMode: "ready",
      fileName: "daintree-config-2026-09-20.json",
      sections: BUSY,
      unknownSections: [],
      applyMode: "rolled-back",
      applyError:
        "Couldn't import keyboard shortcuts: the settings file is read-only. Nothing was changed.",
    });
    await openDialog(page);
    await confirm(page);
    await settle(page, 700);
    await snap(page, "35-rolled-back", PANEL);
    await closeDialog(page);
  });

  // 7. Apply threw outright.
  await step("apply-threw", async () => {
    await setScript(app, {
      applyMode: "throw",
      applyError:
        "EACCES: permission denied, open '/Users/you/Library/Application Support/Daintree/config.json'",
    });
    await openDialog(page);
    await confirm(page);
    await settle(page, 700);
    await snap(page, "40-apply-threw", PANEL);
    await closeDialog(page);
  });

  // 8. Toasts — the rest of the flow's surface.
  await step("toast-rejected", async () => {
    await dismissToasts(page);
    await setScript(app, {
      previewMode: "rejected",
      rejectReason: "that file isn't a Daintree configuration bundle",
    });
    await openImport(page);
    await snapToast(page, "50-toast-rejected");
    await dismissToasts(page);
  });

  await step("toast-matches", async () => {
    await setScript(app, { previewMode: "matches", sections: BUSY, unknownSections: [] });
    await openImport(page);
    await snapToast(page, "55-toast-already-matches");
    await dismissToasts(page);
  });

  await step("toast-applied", async () => {
    await setScript(app, {
      previewMode: "ready",
      sections: BUSY,
      unknownSections: [],
      applyMode: "applied",
    });
    await openDialog(page);
    await confirm(page);
    await snapToast(page, "60-toast-applied");
    await dismissToasts(page);
  });

  await step("toast-skipped", async () => {
    await setScript(app, {
      previewMode: "ready",
      sections: BUSY,
      unknownSections: [],
      applyMode: "applied-skipped",
    });
    await openDialog(page);
    await confirm(page);
    await snapToast(page, "65-toast-applied-with-skips");
    await dismissToasts(page);
  });
}

test("import config dialog review — every state, every theme", async () => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_IMPORT_CONFIG is required for the import config capture",
  });
  test.skip(!ENABLED, "Set DAINTREE_SHOT_IMPORT_CONFIG to run the import config capture");

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const root = mkdtempSync(path.join(tmpdir(), "daintree-import-shots-"));
  const repo = createFixtureRepo(root, "helios-dashboard");
  const userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-importshot-"));
  let ctx: AppContext | undefined;

  try {
    ctx = await launchApp({
      userDataDir,
      screenshotScale: SCALE,
      windowSize: { width: 1440, height: 960 },
      extraArgs: ["--disable-gpu", "--in-process-gpu", "--disable-breakpad", "--noerrdialogs"],
    });

    const page = await openAndOnboardProject(ctx.app, ctx.window, repo, "helios-dashboard");
    await installImportStub(ctx.app);

    for (const theme of THEMES) {
      themeTag = theme;
      await setAppTheme(page, theme);
      await polish(page);
      await captureTheme(page, ctx.app);
    }
  } finally {
    if (ctx?.app) await closeApp(ctx.app);
    rmSync(root, { recursive: true, force: true });
    rmSync(userDataDir, { recursive: true, force: true });
  }

  console.log(`[import-config-shots] wrote ${written.length} file(s): ${written.join(", ")}`);
  expect(failures, `capture steps failed:\n${failures.join("\n")}`).toEqual([]);
  expect(written.length, "no screenshots were written").toBeGreaterThan(0);
});
