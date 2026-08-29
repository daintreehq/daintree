/**
 * File browser panel visual-review harness.
 *
 * Boots a fixture repo with a realistic project tree — nested source folders,
 * dotfiles at the root, an always-hidden junk folder, and a folder whose only
 * contents are dotfiles — then opens the browser as a GRID PANEL (the
 * first-class surface, #11666) and writes PNGs of every state the tree column's
 * chrome can take. Design work on the header, the view controls, and the
 * hidden-file affordances is judged against these rather than against the JSX.
 *
 * The states are chosen so each one stresses a different chrome decision:
 * the header at rest, the header carrying its maximum control count (rooted),
 * the header at the sidebar's minimum width (the clipping case), the tree as
 * the sole column (the layout the complaint came from), and both empty states
 * the dotfile filter can produce.
 *
 * Opt-in only — skips itself unless DAINTREE_SHOT_FILEBROWSER is set, so the
 * marketing screenshots workflow never runs it.
 *
 *   npm run build
 *   DAINTREE_SHOT_FILEBROWSER=1 npx playwright test --project=screenshots file-browser-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_FILEBROWSER  required — any truthy value
 *   DAINTREE_SHOT_DIR          output directory (default: artifacts/file-browser-shots)
 *   DAINTREE_SHOT_TAG          filename suffix, to keep review rounds side by side
 *   DAINTREE_SHOT_THEME        theme id, or "all" to sweep every built-in
 *   DAINTREE_SHOT_ONLY         comma-separated step filter
 *
 * Cross-theme sweeps boot one cold app per theme (in-place switching crashes
 * the project view after a few reloads), so "all" is slow by construction.
 */

import { test, type Page, type Locator } from "@playwright/test";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { createFixtureRepo } from "../helpers/fixtures";
import { openAndOnboardProject } from "../helpers/project";
import { dismissBlockingPalette } from "../helpers/overlays";
import { setAppTheme } from "../helpers/theme";
import { BUILT_IN_THEME_SOURCES } from "../../shared/theme/builtInThemeSources";
import { T_MEDIUM } from "../helpers/timeouts";

const ENABLED = Boolean(process.env.DAINTREE_SHOT_FILEBROWSER);
const TAG = process.env.DAINTREE_SHOT_TAG ? `-${process.env.DAINTREE_SHOT_TAG}` : "";
const THEME_INPUT = process.env.DAINTREE_SHOT_THEME ?? "";
const THEMES =
  THEME_INPUT === "all" ? BUILT_IN_THEME_SOURCES.map((t) => t.id) : [THEME_INPUT || "daintree"];
const SCALE = process.env.DAINTREE_SCREENSHOT_SCALE ?? "2";
const OUTPUT_DIR = process.env.DAINTREE_SHOT_DIR
  ? path.resolve(process.env.DAINTREE_SHOT_DIR)
  : path.resolve(process.cwd(), "artifacts", "file-browser-shots");

const POLISH_CSS = `
  *, *::before, *::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
    caret-color: transparent !important;
  }
`;

/**
 * A project tree with enough shape to make the chrome decisions visible:
 * several nested folders so the tree has depth worth scrolling, root dotfiles
 * so the dotfile toggle has something to act on, a junk folder that the
 * always-hidden list suppresses regardless of the toggle, and `config/` whose
 * entire contents are dotfiles — the only way to reach the filtered-empty
 * state, where the tree has rows to show but the filter removed all of them.
 */
const FIXTURE_FILES: Record<string, string> = {
  "src/components/Panel/ContentPanel.tsx": "export const ContentPanel = () => null;\n",
  "src/components/Panel/PanelHeader.tsx": "export const PanelHeader = () => null;\n",
  "src/components/Layout/Toolbar.tsx": "export const Toolbar = () => null;\n",
  "src/panels/file-browser/FileBrowserPane.tsx": "export const Pane = () => null;\n",
  "src/panels/file-browser/FileTreeView.tsx": "export const TreeView = () => null;\n",
  "src/store/panelStore.ts": "export const usePanelStore = () => null;\n",
  "src/lib/utils.ts": "export const cn = (...a: string[]) => a.join(' ');\n",
  "src/index.css": ":root { color-scheme: dark; }\n",
  "docs/architecture/state-management.md": "# State management\n\nStores and their shape.\n",
  "docs/architecture/notification-system.md": "# Notifications\n\nRouting matrix.\n",
  "docs/e2e-testing.md": "# E2E testing\n\nTiers and buckets.\n",
  "scripts/build.ts": "export {};\n",
  "scripts/release.ts": "export {};\n",
  "shared/config/agentRegistry.ts": "export const agents = [];\n",
  "electron/services/PtyManager.ts": "export class PtyManager {}\n",
  ".github/workflows/ci.yml": "name: CI\n",
  ".claude/settings.json": "{}\n",
  "config/.eslintrc.json": "{}\n",
  "config/.prettierrc": "{}\n",
  "config/.editorconfig": "root = true\n",
  "node_modules/react/index.js": "module.exports = {};\n",
  "dist/bundle.js": "console.log(1);\n",
  ".gitignore": "node_modules\ndist\n",
  ".gitattributes": "* text=auto\n",
  ".mcp.json": "{}\n",
  ".copytreeignore": "dist\n",
  "README.md": "# Fixture project\n\nA project tree for the file browser review harness.\n",
  "CLAUDE.md": "# Project instructions\n",
  "package.json": '{\n  "name": "fixture-project",\n  "version": "1.0.0"\n}\n',
  "tsconfig.json": '{\n  "compilerOptions": {}\n}\n',
};

function seedFiles(dir: string): void {
  for (const [relative, contents] of Object.entries(FIXTURE_FILES)) {
    const target = path.join(dir, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, contents);
  }
}

async function settle(page: Page, ms = 500): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
  );
  await page.waitForTimeout(ms);
}

const ONLY = (process.env.DAINTREE_SHOT_ONLY ?? "").split(",").filter(Boolean);

/* A step failure must not abort the remaining captures, but it must not pass
   silently either — a run where every step blew up would otherwise report PASS
   and write no PNGs. Failures are collected and rethrown at the end, and the
   file count is verified independently of the exit code. */
const stepFailures: string[] = [];
async function step(name: string, fn: () => Promise<void>): Promise<void> {
  if (ONLY.length > 0 && !ONLY.includes(name)) return;
  try {
    await fn();
  } catch (error) {
    stepFailures.push(`${name}: ${String(error).slice(0, 300)}`);
    console.warn(`[fb-shots] step "${name}" skipped:`, String(error).slice(0, 300));
  }
}

interface DispatchResult {
  ok?: boolean;
  error?: { message?: string };
  result?: { worktrees?: Array<{ id: string; isMain?: boolean }>; panelId?: string };
}

async function dispatchAction(
  page: Page,
  actionId: string,
  args?: unknown
): Promise<DispatchResult> {
  return page.evaluate(
    ([id, a]) =>
      (
        window as unknown as {
          __daintreeDispatchAction: (id: string, a?: unknown) => Promise<DispatchResult>;
        }
      ).__daintreeDispatchAction(id, a),
    [actionId, args] as const
  );
}

async function mainWorktreeId(page: Page): Promise<string> {
  for (let attempt = 0; attempt < 40; attempt++) {
    const listed = await dispatchAction(page, "worktree.list");
    const id = (listed.result?.worktrees ?? []).find((w) => w.isMain)?.id;
    if (id !== undefined) return id;
    await page.waitForTimeout(250);
  }
  throw new Error("main worktree never resolved");
}

test("file browser review — tree sidebar chrome", async () => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_FILEBROWSER is required for the file browser capture",
  });
  test.skip(!ENABLED, "Set DAINTREE_SHOT_FILEBROWSER to run the file browser capture");

  mkdirSync(OUTPUT_DIR, { recursive: true });

  for (const themeId of THEMES) {
    const repo = createFixtureRepo({ name: "file-browser-shots" });
    seedFiles(repo.dir);
    const userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-fbshot-"));
    let ctx: AppContext | undefined;
    // Only the default theme writes the un-prefixed state names; a sweep run
    // tags every file with its theme so one directory holds the whole matrix.
    const prefix = THEMES.length > 1 ? `theme-${themeId}-` : "";

    try {
      ctx = await launchApp({
        userDataDir,
        screenshotScale: SCALE,
        windowSize: { width: 1680, height: 1050 },
        extraArgs: ["--disable-gpu", "--in-process-gpu", "--disable-breakpad", "--noerrdialogs"],
      });
      const page = await openAndOnboardProject(ctx.app, ctx.window, repo.dir, "Fixture Project");
      if (themeId) await setAppTheme(page, themeId);
      await page.addStyleTag({ content: POLISH_CSS }).catch(() => {});
      await dismissBlockingPalette(page);

      const worktreeId = await mainWorktreeId(page);
      const opened = await dispatchAction(page, "worktree.openFileBrowserPanel", { worktreeId });
      if (opened.ok === false) {
        throw new Error(`openFileBrowserPanel failed: ${opened.error?.message ?? "unknown"}`);
      }
      const panelId = opened.result?.panelId;
      if (!panelId) throw new Error("openFileBrowserPanel returned no panelId");

      const panel = page.locator(`[data-panel-id="${panelId}"]`);
      await panel.waitFor({ state: "visible", timeout: T_MEDIUM });
      await settle(page, 1200);

      // The tree column is the sidebar-coloured half; its header is the row the
      // review is about. Anchored on the viewer toggle, which lives in that
      // header and unmounts only when the tree column itself is gone.
      // The column itself, by its own marker. An ancestor-of-the-toggle
      // selector matched the whole panel instead, so every "tree column" shot
      // was silently a full-panel shot.
      const treeColumn = panel.locator('[data-testid="file-browser-tree-column"]');
      const treeHeader = panel
        .locator('[data-testid="file-browser-viewer-toggle"]')
        .locator("xpath=ancestor::div[1]");

      const snap = async (slug: string, target?: Locator): Promise<void> => {
        await settle(page);
        const file = path.join(OUTPUT_DIR, `${prefix}${slug}${TAG}.png`);
        if (target) await target.first().screenshot({ path: file, type: "png" });
        else
          await page.screenshot({ path: file, type: "png", animations: "disabled", caret: "hide" });
      };

      /**
       * Drop focus before a capture. The resize separator paints an accent
       * focus ring, so a shot taken while it still holds focus shows stray
       * accent rules that are an artifact of how the harness drove it, not
       * something a user would ever see.
       */
      const blurActive = async (): Promise<void> => {
        await page.evaluate(() => {
          (document.activeElement as HTMLElement | null)?.blur();
        });
      };

      /** Back to the worktree root if the tree is scoped, else a no-op. */
      const resetRoot = async (): Promise<void> => {
        const back = panel.getByLabel("Back to worktree root");
        if ((await back.count()) > 0) {
          await back.click();
          await settle(page, 800);
        }
      };

      // Expand a couple of folders so the tree shows real depth rather than a
      // flat root listing — indentation and the chevron gutter are part of what
      // the chrome has to sit above.
      await step("expand", async () => {
        for (const name of ["src", "docs"]) {
          const row = panel.locator(`[role="treeitem"]`, { hasText: name }).first();
          await row.click({ timeout: T_MEDIUM });
          await settle(page, 400);
        }
      });

      await step("rest", async () => {
        await snap("10-rest-panel", panel);
        await snap("11-rest-tree", treeColumn);
        await snap("12-rest-header", treeHeader);
      });

      const viewOptions = panel.locator('[data-testid="file-browser-view-options"]');

      /**
       * The dotfile filter now lives inside the view-options menu, so driving it
       * means opening the menu and toggling the checkbox. Radix closes the menu
       * on select, which is also what keeps this off the Escape path that
       * black-screens the GPU-flag build.
       */
      const setShowDotfiles = async (show: boolean): Promise<void> => {
        await viewOptions.click({ timeout: T_MEDIUM });
        await settle(page, 400);
        const item = page.locator('[data-testid="file-browser-show-dotfiles"]');
        const checked = (await item.getAttribute("data-state")) === "checked";
        if (checked === show) {
          // Already where we want it — close without changing anything.
          await page.keyboard.press("Escape");
        } else {
          await item.click();
        }
        await settle(page, 700);
      };

      await step("dotfiles-hidden", async () => {
        await setShowDotfiles(false);
        await snap("20-dotfiles-hidden-tree", treeColumn);
        // The header carrying the hidden-row badge: the whole point of the
        // consolidation is that this now says HOW MANY rows are missing, where
        // the old lit icon only said the filter was on.
        await snap("21-dotfiles-hidden-header", treeHeader);
        await snap("22-dotfiles-hidden-full");
        await setShowDotfiles(true);
      });

      await step("viewer-collapsed", async () => {
        await panel.locator('[data-testid="file-browser-viewer-toggle"]').click();
        await settle(page, 700);
        await snap("30-viewer-collapsed-panel", panel);
        await snap("31-viewer-collapsed-header", treeHeader);
        // The same control re-opens it: the tree header keeps the viewer's
        // disclosure in both states and only swaps its icon. The viewer's own
        // `file-browser-sidebar-toggle` is the mirror control for the TREE and
        // exists only while the tree is the collapsed half.
        await panel.locator('[data-testid="file-browser-viewer-toggle"]').click();
        await settle(page, 700);
      });

      await step("narrow", async () => {
        // Keyboard resize rather than a drag: the separator's own contract, and
        // it lands on an exact width instead of wherever a synthetic mouse
        // gesture stops. Shift takes the coarse 50px step.
        const grip = panel.locator('[data-testid="file-browser-sidebar-resize"]');
        await grip.focus();
        for (let i = 0; i < 10; i++) await page.keyboard.press("Shift+ArrowLeft");
        await blurActive();
        await settle(page, 600);
        await snap("40-narrow-tree", treeColumn);
        await snap("41-narrow-header", treeHeader);
        for (let i = 0; i < 10; i++) await page.keyboard.press("Shift+ArrowRight");
        await blurActive();
        await settle(page, 600);
      });

      await step("rooted", async () => {
        await resetRoot();
        // "Set as root" lives only in the row menu (double-click re-rooting was
        // removed as non-standard). Rooted is the header's maximum control
        // count: the root anchor becomes a button and "Up one level" appears.
        const row = panel.locator('[role="treeitem"]', { hasText: "src" }).first();
        await row.click({ button: "right" });
        await settle(page, 400);
        // Closed by clicking the item, never Escape: Escape-dismissing a Radix
        // context menu black-screens the renderer in the GPU-flag build.
        await page.getByRole("menuitem", { name: /set as root/i }).click({ timeout: T_MEDIUM });
        await settle(page, 900);
        await snap("50-rooted-tree", treeColumn);
        await snap("51-rooted-header", treeHeader);
      });

      await step("rooted-narrow", async () => {
        // The worst case for the header: every control present, minimum width.
        const grip = panel.locator('[data-testid="file-browser-sidebar-resize"]');
        await grip.focus();
        for (let i = 0; i < 10; i++) await page.keyboard.press("Shift+ArrowLeft");
        await blurActive();
        await settle(page, 600);
        await snap("60-rooted-narrow-header", treeHeader);
        for (let i = 0; i < 10; i++) await page.keyboard.press("Shift+ArrowRight");
        await settle(page, 600);
        await resetRoot();
      });

      await step("filtered-empty", async () => {
        // Self-resetting rather than relying on the previous step's cleanup: a
        // step that fails mid-way leaves the tree rooted somewhere else, and
        // every later step keyed on a root-level row would then fail too —
        // one broken state cascading into a run that captures nothing.
        await resetRoot();
        // `config/` holds nothing but dotfiles, so hiding them empties a folder
        // that is not actually empty — the state the filtered-empty copy and
        // its "Show dotfiles" action exist for.
        const row = panel.locator('[role="treeitem"]', { hasText: "config" }).first();
        await row.click({ button: "right" });
        await settle(page, 400);
        await page.getByRole("menuitem", { name: /set as root/i }).click({ timeout: T_MEDIUM });
        await settle(page, 900);
        await setShowDotfiles(false);
        await snap("70-filtered-empty-tree", treeColumn);
        await setShowDotfiles(true);
        await resetRoot();
      });

      await step("view-options", async () => {
        await resetRoot();
        // The consolidated menu, open, in the tree header where the settings it
        // holds actually apply — both of them govern the tree.
        await viewOptions.click({ timeout: T_MEDIUM });
        await settle(page, 600);
        // Full page, not the panel: Radix portals the menu to document.body, so
        // a panel-scoped shot crops whatever part of it falls outside the
        // panel's own box and makes a correctly-placed menu look clipped.
        await snap("80-view-options-open");
        await page.keyboard.press("Escape");
        await settle(page, 400);
      });

      await step("view-options-collapsed", async () => {
        // The other half of the ownership rule: with the tree column collapsed
        // the viewer's toolbar renders the same menu, so no layout is ever
        // without a control for a setting that is still reordering the rows.
        await panel.locator('[data-testid="file-browser-sidebar-toggle"]').count();
        await panel.locator('[data-testid="file-browser-viewer-toggle"]').click();
        await settle(page, 700);
        await snap("90-viewer-collapsed-header-after", treeHeader);
        await panel.locator('[data-testid="file-browser-viewer-toggle"]').click();
        await settle(page, 700);
      });
    } finally {
      if (ctx) await closeApp(ctx.app);
      repo.cleanup();
    }
  }

  // Never trust the exit code: count what actually landed. A harness that
  // reports PASS having written nothing is worse than one that fails.
  const written = readdirSync(OUTPUT_DIR).filter((f) => f.endsWith(".png"));
  if (stepFailures.length > 0) {
    throw new Error(
      `[fb-shots] ${stepFailures.length} step(s) failed:\n${stepFailures.join("\n")}\n` +
        `(${written.length} PNGs written)`
    );
  }
  if (written.length === 0) {
    throw new Error("[fb-shots] no PNGs were written");
  }
  console.log(`[fb-shots] wrote ${written.length} PNGs to ${OUTPUT_DIR}`);
});
