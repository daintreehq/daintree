/**
 * Rendered Markdown find visual-review harness.
 *
 * Covers Cmd+F on a rendered Markdown document in each place one is read: the
 * file browser's viewer, a file panel, and the file viewer dialog. The states
 * are the find bar's whole life: just opened, matching, stepped to a match far
 * down the document, no matches, Match case pressed, and closed again; plus
 * Source mode's own find for comparison, a narrow viewer, forced colours, and
 * the matching state across a spread of themes.
 *
 * Opt-in only — skips itself unless DAINTREE_SHOT_MDFIND is set.
 *
 *   npm run build:e2e
 *   DAINTREE_SHOT_MDFIND=1 DAINTREE_SHOT_DIR=/tmp/mdfind \
 *     npx playwright test --project=screenshots rendered-markdown-find-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_MDFIND           required — any truthy value
 *   DAINTREE_SHOT_DIR              output directory (default: artifacts/rendered-markdown-find-shots)
 *   DAINTREE_SHOT_THEMES           comma-separated theme ids for the sweep
 *   DAINTREE_SHOT_ONLY             comma-separated state filter
 *   DAINTREE_SHOT_MDFIND_BASELINE  capture without asserting a find field exists,
 *                                  for a build that predates rendered find
 */

import { test, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import { execFileSync } from "child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { createFixtureRepo } from "../helpers/fixtures";
import { openAndOnboardProject } from "../helpers/project";
import { dismissBlockingPalette } from "../helpers/overlays";
import { setAppTheme } from "../helpers/theme";
import { T_MEDIUM } from "../helpers/timeouts";

const ENABLED = Boolean(process.env.DAINTREE_SHOT_MDFIND);
const BASELINE = Boolean(process.env.DAINTREE_SHOT_MDFIND_BASELINE);
const THEMES = (
  process.env.DAINTREE_SHOT_THEMES ??
  "daintree,svalbard,namib,bali,redwoods,atacama,highlands,hokkaido,fiordland"
)
  .split(",")
  .filter(Boolean);
const ONLY = (process.env.DAINTREE_SHOT_ONLY ?? "").split(",").filter(Boolean);
const SCALE = process.env.DAINTREE_SCREENSHOT_SCALE ?? "2";
const OUTPUT_DIR = process.env.DAINTREE_SHOT_DIR
  ? path.resolve(process.env.DAINTREE_SHOT_DIR)
  : path.resolve(process.cwd(), "artifacts", "rendered-markdown-find-shots");

const WIDE = { width: 1560, height: 940 };
const NARROW = { width: 900, height: 820 };

const POLISH_CSS = `
  *, *::before, *::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
    caret-color: transparent !important;
  }
  .animate-pulse-delayed { animation: none !important; opacity: 1 !important; }
`;

const MARKDOWN_SOURCE = `# State management

Every store in the renderer is a Zustand store created once per project view.
Cross-store reads go through \`storeAccessors.ts\` so no store imports a partner
at module evaluation time.

## Store families

| Family | Scope | Persisted |
| --- | --- | --- |
| Panels | per project view | yes |
| Worktrees | per project view | no |
| Preferences | app-global store | yes |

## Rules

1. Never import a partner store at module scope.
2. Derive, don't duplicate — selectors over copies.
3. Persist only what a restart needs.

> The worktree store is the one per-view factory; everything else is a
> module-level \`create()\`.

\`\`\`ts
export const usePanelStore = create<PanelState>()((set) => ({
  panels: [],
  addPanel: (panel) => set((state) => ({ panels: [...state.panels, panel] })),
}));
\`\`\`

## Hydration

A project view boots with empty stores. Hydration reads the persisted snapshot
for that view, validates it against the current schema, and only then lets the
panels mount. A snapshot that fails validation is dropped rather than repaired:
a half-restored layout is harder to recover from than an empty one.

Restores are ordered. Preferences land first because the panel layout reads the
density preference while it measures. Worktrees land last because they arrive
over IPC and may never arrive at all for a project that has moved.

## Persistence

Writes are debounced per store. A store that writes on every keystroke would
fsync the user data directory dozens of times a second while a terminal
streams, so each persisted slice names the fields that matter and the rest stay
in memory.

- Panels persist their order, kind, and per-kind view state.
- Preferences persist everything; they are small and rarely change.
- Worktrees persist nothing; the main process owns that truth.

## Migrations

Every persisted shape carries a version. A migration is a pure function from
version N to N+1, and the chain runs in order on load. A migration never reads
another store: by the time it runs, nothing else has hydrated.

### Writing one

Bump the version, add the step, and add a fixture for the old shape. The
fixture is the part reviewers check first, because a migration without one has
never been run against real data.

## Testing

Stores are tested through their public actions, never by poking state. A test
that sets fields directly passes against a store that can no longer reach that
state on its own.

### See also

- [Notification system](./notification-system.md)
- [Store init order](./store-init-order.md)
`;

function seedFiles(dir: string): void {
  const write = (relative: string, contents: string) => {
    const target = path.join(dir, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, contents);
  };
  write("docs/architecture/state-management.md", MARKDOWN_SOURCE);
  write("docs/architecture/notification-system.md", "# Notifications\n\nRouting matrix.\n");
  write("README.md", "# Fixture project\n\nA project tree for the find review harness.\n");
  write("package.json", '{\n  "name": "fixture-project",\n  "version": "1.0.0"\n}\n');
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("add", "-A");
  git("-c", "user.email=fixture@example.com", "-c", "user.name=Fixture", "commit", "-qm", "seed");
}

async function settle(page: Page, ms = 500): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
  );
  await page.waitForTimeout(ms);
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

async function setWindowSize(app: ElectronApplication, size: { width: number; height: number }) {
  await app.evaluate(({ BrowserWindow }, s) => {
    const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.isVisible());
    win?.setSize(s.width, s.height);
  }, size);
}

const stepFailures: string[] = [];

test("rendered markdown find review", async () => {
  test.setTimeout(25 * 60_000);
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_MDFIND is required for the rendered Markdown find capture",
  });
  test.skip(!ENABLED, "Set DAINTREE_SHOT_MDFIND to run the rendered Markdown find capture");

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const themeDir = path.join(OUTPUT_DIR, "themes");
  mkdirSync(themeDir, { recursive: true });

  const repo = createFixtureRepo({ name: "rendered-markdown-find-shots" });
  seedFiles(repo.dir);
  const docPath = path.join(repo.dir, "docs/architecture/state-management.md");
  const userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-mdfind-"));
  let ctx: AppContext | undefined;

  try {
    ctx = await launchApp({
      userDataDir,
      screenshotScale: SCALE,
      windowSize: WIDE,
      extraArgs: ["--disable-gpu", "--in-process-gpu", "--disable-breakpad", "--noerrdialogs"],
    });
    const app = ctx.app;
    const page = await openAndOnboardProject(ctx.app, ctx.window, repo.dir, "Fixture Project");
    await page.addStyleTag({ content: POLISH_CSS }).catch(() => {});
    await dismissBlockingPalette(page);
    await setWindowSize(app, WIDE);
    await settle(page, 800);

    const state = async (name: string, fn: () => Promise<void>): Promise<void> => {
      if (ONLY.length > 0 && !ONLY.includes(name)) return;
      try {
        await fn();
      } catch (error) {
        stepFailures.push(`${name}: ${String(error).slice(0, 400)}`);
        console.warn(`[mdfind-shots] ${name} failed:`, String(error).slice(0, 400));
      }
    };

    /** The find field the open bar shows, scoped to one surface. */
    const findInput = (scope: Locator): Locator =>
      scope.getByRole("textbox", { name: "Find in document" });

    /** Cmd+F, then prove a focused find field is on screen (unless baseline). */
    const openFind = async (scope: Locator): Promise<void> => {
      await page.keyboard.press("Meta+f");
      await settle(page, 400);
      if (BASELINE) return;
      const input = findInput(scope);
      await input.waitFor({ state: "visible", timeout: T_MEDIUM });
      const focused = await input.evaluate((el) => el === document.activeElement);
      if (!focused) throw new Error("find field opened without focus");
    };

    const typeQuery = async (scope: Locator, query: string): Promise<void> => {
      if (BASELINE) return;
      const input = findInput(scope);
      await input.fill(query);
      await settle(page, 450);
      const value = await input.inputValue();
      if (value !== query) throw new Error(`find field holds "${value}", expected "${query}"`);
    };

    /** Capture `target` as-is: focus stays where the state put it. */
    const shoot = async (target: Locator, slug: string, waitMs = 500): Promise<void> => {
      await page.mouse.move(2, 2);
      await settle(page, waitMs);
      await target.screenshot({ path: path.join(OUTPUT_DIR, `${slug}.png`), type: "png" });
    };

    // --- File browser viewer ------------------------------------------------
    const worktreeId = await mainWorktreeId(page);
    const opened = await dispatchAction(page, "worktree.openFileBrowserPanel", { worktreeId });
    const browserPanelId = opened.result?.panelId;
    if (!browserPanelId) throw new Error("openFileBrowserPanel returned no panelId");
    let panel = page.locator(`[data-panel-id="${browserPanelId}"]`);
    await panel.waitFor({ state: "visible", timeout: T_MEDIUM });
    await settle(page, 1200);

    const row = (name: string): Locator =>
      panel.locator('[role="tree"]').getByRole("treeitem", { name, exact: true }).first();
    const openPath = async (relative: string): Promise<void> => {
      const parts = relative.split("/");
      for (const part of parts.slice(0, -1)) {
        const item = row(part);
        await item.waitFor({ state: "visible", timeout: T_MEDIUM });
        if ((await item.getAttribute("aria-expanded")) !== "true") {
          await item.click();
          await settle(page, 350);
        }
      }
      await row(parts[parts.length - 1]!).click({ timeout: T_MEDIUM });
      await settle(page, 1200);
    };
    const setMode = async (label: "Source" | "Rendered"): Promise<void> => {
      const segment = panel.getByRole("radio", { name: label, exact: true });
      if ((await segment.count()) > 0) {
        await segment.click();
      } else {
        await panel.getByRole("button", { name: /^View mode:/ }).click();
        await settle(page, 300);
        await page.getByRole("menuitemradio", { name: label }).click();
      }
      await settle(page, 600);
    };

    await state("fb-find", async () => {
      await openPath("docs/architecture/state-management.md");
      await panel.locator(".markdown-document").waitFor({ state: "visible", timeout: T_MEDIUM });
      await shoot(panel, "fb-00-rendered-rest");
      await openFind(panel);
      await shoot(panel, "fb-01-find-open");
      await typeQuery(panel, "store");
      await shoot(panel, "fb-02-matches");
      if (!BASELINE) {
        // Shift+Enter from the first match wraps to the last, far down the
        // document: the scroll that brings it into view, under the bar.
        await findInput(panel).press("Shift+Enter");
        await settle(page, 500);
      }
      await shoot(panel, "fb-03-step-wrap-last");
      await typeQuery(panel, "persisted snapshot");
      await shoot(panel, "fb-04-phrase");
      await typeQuery(panel, "zebra crossing");
      await shoot(panel, "fb-05-no-matches");
      if (!BASELINE) {
        await typeQuery(panel, "Store");
        await panel.getByRole("button", { name: "Match case" }).click();
        await settle(page, 450);
      }
      await shoot(panel, "fb-06-match-case");
      if (!BASELINE) {
        await findInput(panel).press("Escape");
        await settle(page, 500);
        if ((await findInput(panel).count()) > 0) throw new Error("Escape left the find bar open");
      }
      await shoot(panel, "fb-07-closed");
    });

    await state("fb-source", async () => {
      await setMode("Source");
      await panel.locator(".cm-content").first().click();
      await page.keyboard.press("Meta+f");
      await settle(page, 500);
      await page.keyboard.type("store");
      await settle(page, 450);
      await shoot(panel, "fb-08-source-find");
      await page.keyboard.press("Escape");
      await settle(page, 300);
      await setMode("Rendered");
    });

    const scroller = (): Locator => panel.locator('[data-testid="file-browser-markdown-scroll"]');

    // Opening and closing mid-document must leave the text where it was.
    await state("fb-anchor", async () => {
      await panel
        .getByRole("heading", { name: "Hydration" })
        .evaluate((el) => el.scrollIntoView({ block: "start" }));
      await settle(page, 400);
      await shoot(panel, "fb-10-scrolled-rest");
      await openFind(panel);
      await shoot(panel, "fb-11-scrolled-open");
      if (!BASELINE) await findInput(panel).press("Escape");
      await settle(page, 400);
      await shoot(panel, "fb-12-scrolled-closed");
    });

    await state("fb-narrow", async () => {
      await setWindowSize(app, NARROW);
      await settle(page, 800);
      const grip = panel.locator('[data-testid="file-browser-sidebar-resize"]');
      if ((await grip.count()) > 0) {
        await grip.focus();
        for (let i = 0; i < 4; i++) await page.keyboard.press("Shift+ArrowLeft");
      }
      await row("state-management.md").click({ timeout: T_MEDIUM });
      await settle(page, 1000);
      await scroller().evaluate((el) => (el.scrollTop = 0));
      await settle(page, 300);
      await openFind(panel);
      await typeQuery(panel, "store");
      await shoot(panel, "fb-09-narrow-matches");
      // The bar spans a narrow pane: a match in the title must still show.
      await typeQuery(panel, "state management");
      await shoot(panel, "fb-13-narrow-title-match");
      if (!BASELINE) await findInput(panel).press("Escape");
      await setWindowSize(app, WIDE);
      await settle(page, 800);
    });

    await dispatchAction(page, "terminal.close", { terminalId: browserPanelId });
    await settle(page, 800);

    // --- File panel -----------------------------------------------------------
    const openFilePanel = async (): Promise<{ id: string; locator: Locator }> => {
      const result = await dispatchAction(page, "file.openPanel", {
        path: docPath,
        viewMode: "rendered",
      });
      const id = result.result?.panelId;
      if (!id) throw new Error(`file.openPanel gave no panel: ${result.error?.message ?? ""}`);
      const locator = page.locator(`[data-panel-id="${id}"]`);
      await locator.waitFor({ state: "visible", timeout: T_MEDIUM });
      await locator.locator(".markdown-document").waitFor({ state: "visible", timeout: T_MEDIUM });
      await settle(page, 900);
      // A click in the document focuses the panel, the way a reader lands there.
      await locator.locator(".markdown-document h1").first().click();
      await settle(page, 300);
      return { id, locator };
    };

    await state("file-panel", async () => {
      const { id, locator } = await openFilePanel();
      await openFind(locator);
      await typeQuery(locator, "store");
      await shoot(locator, "fp-01-matches");
      await page.emulateMedia({ forcedColors: "active" });
      await settle(page, 500);
      await shoot(locator, "fp-02-forced-colors");
      await page.emulateMedia({ forcedColors: "none" });
      await settle(page, 300);
      if (!BASELINE) await findInput(locator).press("Escape");
      await dispatchAction(page, "terminal.close", { terminalId: id });
      await settle(page, 600);
    });

    // --- File viewer dialog -----------------------------------------------------
    await state("dialog", async () => {
      const result = await dispatchAction(page, "file.view", {
        path: docPath,
        viewMode: "rendered",
      });
      if (result.ok === false) throw new Error(`file.view failed: ${result.error?.message ?? ""}`);
      const dialog = page.locator('[data-testid="panel-dialog"]');
      await dialog.waitFor({ state: "visible", timeout: T_MEDIUM });
      await dialog.locator(".markdown-document").waitFor({ state: "visible", timeout: T_MEDIUM });
      await settle(page, 900);
      await openFind(dialog);
      await typeQuery(dialog, "store");
      await shoot(dialog, "dlg-01-matches");
      if (!BASELINE) {
        await findInput(dialog).press("Escape");
        await settle(page, 500);
        if (!(await dialog.isVisible()))
          throw new Error("Escape in the find bar closed the dialog");
      }
      await shoot(dialog, "dlg-02-after-escape");
      await page.keyboard.press("Escape");
      await settle(page, 600);
    });

    // --- Theme sweep: the matching state in a file panel ------------------------
    await state("themes", async () => {
      for (const themeId of THEMES) {
        await setAppTheme(page, themeId);
        await page.addStyleTag({ content: POLISH_CSS }).catch(() => {});
        await dismissBlockingPalette(page);
        await settle(page, 800);
        const { id, locator } = await openFilePanel();
        await openFind(locator);
        await typeQuery(locator, "store");
        await page.mouse.move(2, 2);
        await settle(page, 500);
        await locator.screenshot({ path: path.join(themeDir, `${themeId}.png`), type: "png" });
        if (!BASELINE) await findInput(locator).press("Escape");
        await dispatchAction(page, "terminal.close", { terminalId: id });
        await settle(page, 500);
      }
    });
  } finally {
    if (ctx) await closeApp(ctx.app);
    repo.cleanup();
  }

  const written = readdirSync(OUTPUT_DIR).filter((f) => f.endsWith(".png"));
  const themed = readdirSync(themeDir).filter((f) => f.endsWith(".png"));
  if (stepFailures.length > 0) {
    throw new Error(
      `[mdfind-shots] ${stepFailures.length} state(s) failed:\n${stepFailures.join("\n")}\n` +
        `(${written.length} + ${themed.length} themed PNGs written)`
    );
  }
  if (written.length === 0) throw new Error("[mdfind-shots] no PNGs were written");
  console.log(
    `[mdfind-shots] wrote ${written.length} + ${themed.length} themed PNGs to ${OUTPUT_DIR}`
  );
});
