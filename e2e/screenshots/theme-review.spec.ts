/**
 * Theme visual-review harness.
 *
 * Boots a rich multi-worktree fixture, switches to the requested theme, and
 * writes PNGs of the workbench plus secondary chrome (tooltips, menus,
 * dialogs, hover states, diff view, settings, terminal) so theme work can be
 * judged against real rendered pixels instead of token values. Built for the
 * light-theme redesign series (#9711); any theme pass should start here.
 *
 * Opt-in only: the spec skips itself unless DAINTREE_SHOT_THEME is set, so
 * the marketing screenshots workflow (which runs the whole `screenshots`
 * project) never executes it.
 *
 *   DAINTREE_SHOT_THEME=bondi npx playwright test --project=screenshots theme-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_THEME  required — theme id to render (e.g. bondi, daintree)
 *   DAINTREE_SHOT_DIR    optional absolute output dir (default artifacts/theme-shots/<theme>)
 *   DAINTREE_SHOT_TAG    optional suffix to keep multiple rounds side by side
 *   DAINTREE_SHOT_ONLY   comma-separated step filter (valid names: STEP_SLUGS keys)
 *   DAINTREE_SHOT_ALLOW_MISSING  comma-separated states permitted to be absent
 *   DAINTREE_SCREENSHOT_SCALE  device scale factor (default 2)
 *
 * Output: <dir>/<NN-slug>[-tag].png plus a manifest recording every state's
 * outcome. The run FAILS if any expected state is missing from disk — a capture
 * harness that reports success without having written the files it promised is
 * worse than one that fails, because the review downstream then scores a stale
 * or partial set without anyone noticing.
 *
 * A full run writes manifest.json; a DAINTREE_SHOT_ONLY run writes
 * manifest.partial.json, so re-shooting one step never destroys the record of
 * the last complete sweep.
 */

import { test, type Page } from "@playwright/test";
import { execSync } from "child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, statSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { openAndOnboardProject } from "../helpers/project";
import { dismissBlockingPalette } from "../helpers/overlays";
import { setAppTheme } from "../helpers/theme";
import { SEL } from "../helpers/selectors";
import { T_LONG } from "../helpers/timeouts";

const THEME = process.env.DAINTREE_SHOT_THEME ?? "";
const TAG = process.env.DAINTREE_SHOT_TAG ? `-${process.env.DAINTREE_SHOT_TAG}` : "";
const SCALE = process.env.DAINTREE_SCREENSHOT_SCALE ?? "2";
const OUTPUT_DIR = process.env.DAINTREE_SHOT_DIR
  ? path.resolve(process.env.DAINTREE_SHOT_DIR)
  : path.resolve(process.cwd(), "artifacts", "theme-shots", THEME || "unset");

/**
 * Every state this harness promises to produce, in capture order. The run is
 * verified against this list, so adding a `snap()` means adding its slug here.
 */
const EXPECTED_STATES = [
  "10-workbench",
  "11-tooltip-toolbar",
  "12-sidebar-card-hover",
  "13-context-menu",
  "14-sidebar-search",
  "24-filter-popover",
  "25-project-switcher",
  "17-action-palette",
  "18-notifications",
  "19-review-hub",
  "20-diff-view",
  "21-settings",
  "26-settings-appearance",
  "27-settings-search",
  "22-terminal",
  "28-terminal-search",
  "23-dock",
  "29-confirm-dialog",
  "15-quick-create-palette",
  "16-new-worktree-dialog",
] as const;

/**
 * Which slugs each step owns. Derived from the `snap()` calls inside each
 * `step("name", …)` below, and the only thing DAINTREE_SHOT_ONLY is verified
 * against — slug-vs-step-name string matching guessed wrong (a filter on
 * `terminal-and-dock,new-worktree-dialog` resolved to one slug instead of five).
 * Adding a snap() means adding its slug here AND to EXPECTED_STATES; the two
 * lists are cross-checked at verification time.
 */
const STEP_SLUGS: Record<string, readonly string[]> = {
  workbench: ["10-workbench"],
  tooltip: ["11-tooltip-toolbar"],
  "card-hover": ["12-sidebar-card-hover"],
  "context-menu": ["13-context-menu"],
  "search-active": ["14-sidebar-search"],
  "filter-popover": ["24-filter-popover"],
  "project-switcher": ["25-project-switcher"],
  "action-palette": ["17-action-palette"],
  notifications: ["18-notifications"],
  "review-hub": ["19-review-hub", "20-diff-view"],
  settings: ["21-settings", "26-settings-appearance", "27-settings-search"],
  "terminal-and-dock": ["22-terminal", "28-terminal-search", "23-dock"],
  "confirm-dialog": ["29-confirm-dialog"],
  "new-worktree-dialog": ["15-quick-create-palette", "16-new-worktree-dialog"],
};

/**
 * Timeout for the waits that must not fail silently. The capture machine runs
 * loaded and the app launches with --disable-gpu, so first paint of an overlay
 * is routinely seconds slow; anything under ~15s here reports "flow changed"
 * when the real answer is "not yet".
 */
const T_REQUIRED = Math.max(T_LONG, 15_000);

const ALLOW_MISSING = new Set(
  (process.env.DAINTREE_SHOT_ALLOW_MISSING ?? "").split(",").filter(Boolean)
);

/** Per-step outcomes, written to manifest.json and used for the final gate. */
const stepFailures = new Map<string, string>();

// Freeze animations and hide carets so captures are deterministic.
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

function git(cmd: string, cwd: string): void {
  execSync(`git ${cmd}`, { cwd, stdio: "ignore" });
}

/** Repo with a main worktree + several feature worktrees in varied states. */
function createRichRepo(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "daintree-theme-shots-"));
  const wtRoot = path.join(path.dirname(dir), path.basename(dir) + "-worktrees");
  mkdirSync(wtRoot, { recursive: true });

  git("init -b main", dir);
  git('config user.email "test@daintree.dev"', dir);
  git('config user.name "Daintree Test"', dir);
  mkdirSync(path.join(dir, "src"), { recursive: true });
  writeFileSync(path.join(dir, "README.md"), "# Helios Dashboard\n");
  writeFileSync(
    path.join(dir, "src", "index.ts"),
    'export function main(): number {\n  // entry point\n  const greeting = "hello";\n  console.log(greeting);\n  return 0;\n}\n'
  );
  // In-repo recipes. The quick-create palette lists recipes plus a trailing
  // "Customize…" row, and `useQuickCreatePalette` builds NO items at all when
  // the project has zero recipes — an empty-state palette is both a worse
  // capture and missing the row the dialog hangs off.
  const recipesDir = path.join(dir, ".daintree", "recipes");
  mkdirSync(recipesDir, { recursive: true });
  const recipes = [
    { name: "Ship a feature", type: "claude", title: "Implement" },
    { name: "Review & polish", type: "codex", title: "Review" },
    { name: "Chase a flake", type: "terminal", title: "Repro" },
  ];
  for (const r of recipes) {
    const slug = r.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
    writeFileSync(
      path.join(recipesDir, `${slug}.json`),
      JSON.stringify(
        {
          id: `inrepo-${slug}`,
          name: r.name,
          terminals: [{ type: r.type, title: r.title, command: "", env: {} }],
          createdAt: 1_700_000_000_000,
          showInEmptyState: false,
          autoAssign: "always",
        },
        null,
        2
      ) + "\n"
    );
  }
  git("add -A", dir);
  git('commit -m "initial commit"', dir);
  // Dirty main worktree: a modified file + a new file → diff view content.
  writeFileSync(
    path.join(dir, "src", "index.ts"),
    'export function main(): number {\n  // entry point with retries\n  const greeting = "hello again";\n  const retries = 3;\n  console.log(greeting, retries);\n  return retries;\n}\n'
  );
  writeFileSync(path.join(dir, "notes.md"), "# Notes\n\n- redesign pass\n");

  const features = [
    { branch: "feature/oauth-device-flow", dirty: true, commits: 2 },
    { branch: "feature/streaming-tokens", dirty: false, commits: 1 },
    { branch: "fix/retry-backoff-jitter", dirty: true, commits: 3 },
    { branch: "chore/bump-electron-41", dirty: false, commits: 1 },
  ];
  for (const f of features) {
    const slug = f.branch.replace(/[/]/g, "-");
    const wtDir = path.join(wtRoot, slug);
    git(`branch ${f.branch}`, dir);
    git(`worktree add ${JSON.stringify(wtDir)} ${f.branch}`, dir);
    for (let i = 0; i < f.commits; i++) {
      writeFileSync(path.join(wtDir, `change-${i}.md`), `change ${i} on ${f.branch}\n`);
      git("add -A", wtDir);
      git(`commit -m "work ${i} on ${slug}"`, wtDir);
    }
    if (f.dirty) {
      writeFileSync(path.join(wtDir, "wip.txt"), "in progress\n");
      writeFileSync(path.join(wtDir, "src", "index.ts"), `// ${slug}\nexport const x = 1;\n`);
    }
  }

  return {
    dir,
    cleanup: () => {
      if (existsSync(wtRoot)) rmSync(wtRoot, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function settle(page: Page, ms = 600): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
  );
  await page.waitForTimeout(ms);
}

async function snap(page: Page, slug: string, locator?: string): Promise<void> {
  await settle(page);
  const file = path.join(OUTPUT_DIR, `${slug}${TAG}.png`);
  if (locator) {
    await page.locator(locator).first().screenshot({ path: file, type: "png" });
  } else {
    await page.screenshot({ path: file, type: "png", animations: "disabled", caret: "hide" });
  }
}

/**
 * Dispatch an action through the E2E bridge ActionService installs when the app
 * was launched with DAINTREE_E2E_MODE. Used where a surface has no stable
 * pointer path to it — the sidebar "+" opens the full dialog, so the quick
 * create palette is only reachable via its own action.
 */
async function dispatchAction(page: Page, actionId: string): Promise<void> {
  const result = (await page.evaluate(async (id) => {
    const fn = (window as unknown as { __daintreeDispatchAction?: unknown })
      .__daintreeDispatchAction as
      | ((
          actionId: string,
          args?: unknown,
          options?: { source?: string }
        ) => Promise<{ ok?: boolean; error?: { message?: string } }>)
      | undefined;
    if (typeof fn !== "function") return { ok: false, error: { message: "no dispatch bridge" } };
    return await fn(id, undefined, { source: "test" });
  }, actionId)) as { ok?: boolean; error?: { message?: string } } | undefined;
  if (result?.ok === false) {
    throw new Error(`dispatch ${actionId} failed: ${result.error?.message ?? "unknown"}`);
  }
}

/** Run a capture step; failures are logged, not fatal — later shots still run. */
const ONLY = (process.env.DAINTREE_SHOT_ONLY ?? "").split(",").filter(Boolean);
async function step(name: string, fn: () => Promise<void>): Promise<void> {
  if (ONLY.length > 0 && !ONLY.includes(name)) return;
  try {
    await fn();
  } catch (error) {
    // Deliberately non-fatal: one bad step must not cost the other nineteen
    // captures. The run is still failed at the end by verifyCaptures(), which
    // checks the files on disk rather than trusting that we got this far.
    const reason = String(error).slice(0, 200);
    stepFailures.set(name, reason);
    console.warn(`[theme-shots] step "${name}" failed:`, reason);
  }
}

/**
 * The gate. Counts what actually landed on disk against EXPECTED_STATES, writes
 * a manifest, and throws when anything promised is missing. Never infer success
 * from the fact that the spec reached its end.
 */
function verifyCaptures(): void {
  // Ownership is declared, not inferred: every expected slug must belong to
  // exactly one step, or a filtered run silently verifies the wrong set.
  const owned = new Set<string>(Object.values(STEP_SLUGS).flat());
  const expectedSet = new Set<string>(EXPECTED_STATES);
  const unowned = EXPECTED_STATES.filter((slug) => !owned.has(slug));
  const orphaned = [...owned].filter((slug) => !expectedSet.has(slug));
  if (unowned.length > 0 || orphaned.length > 0) {
    throw new Error(
      `[theme-shots] STEP_SLUGS is out of sync with EXPECTED_STATES: ` +
        `unowned=${unowned.join(", ") || "none"} unknown=${orphaned.join(", ") || "none"}`
    );
  }

  let wanted: string[];
  if (ONLY.length === 0) {
    wanted = [...EXPECTED_STATES];
  } else {
    const unknownSteps = ONLY.filter((name) => !STEP_SLUGS[name]);
    if (unknownSteps.length > 0) {
      throw new Error(
        `[theme-shots] DAINTREE_SHOT_ONLY names unknown step(s): ${unknownSteps.join(", ")}. ` +
          `Valid steps: ${Object.keys(STEP_SLUGS).join(", ")}`
      );
    }
    const selected = new Set(ONLY.flatMap((name) => STEP_SLUGS[name] ?? []));
    wanted = EXPECTED_STATES.filter((slug) => selected.has(slug));
  }

  const present: string[] = [];
  const missing: string[] = [];
  for (const slug of wanted) {
    const file = path.join(OUTPUT_DIR, `${slug}${TAG}.png`);
    const ok = existsSync(file) && statSync(file).size > 1024;
    (ok ? present : missing).push(slug);
  }

  // A filtered run describes a fraction of the set, so it must never overwrite
  // the record of the last complete sweep.
  writeFileSync(
    path.join(OUTPUT_DIR, ONLY.length > 0 ? "manifest.partial.json" : "manifest.json"),
    JSON.stringify(
      {
        theme: THEME,
        tag: TAG,
        scale: SCALE,
        only: ONLY.length > 0 ? ONLY : null,
        capturedAt: new Date().toISOString(),
        expected: wanted.length,
        present,
        missing,
        stepFailures: Object.fromEntries(stepFailures),
      },
      null,
      2
    )
  );

  const fatal = missing.filter((slug) => !ALLOW_MISSING.has(slug));
  if (fatal.length > 0) {
    throw new Error(
      `[theme-shots] ${fatal.length} of ${wanted.length} states missing for theme "${THEME}": ` +
        `${fatal.join(", ")}. Step failures: ` +
        `${[...stepFailures].map(([k, v]) => `${k}: ${v}`).join(" | ") || "none recorded"}`
    );
  }
  console.log(
    `[theme-shots] verified ${present.length}/${wanted.length} states for "${THEME}" → ${OUTPUT_DIR}`
  );
}

test("theme review — chrome, overlays, states", async () => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_THEME is required for the theme-review capture",
  });
  test.skip(!THEME, "Set DAINTREE_SHOT_THEME to run the theme-review capture");

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const repo = createRichRepo();
  // Own userData dir with a prefix that does NOT contain "daintree-e2e":
  // launchApp's pre-launch hygiene pkills `node_modules/electron.*daintree-e2e`,
  // so concurrent capture sessions (parallel theme worktrees on one machine)
  // would SIGKILL each other's freshly-launching app mid-poll. A distinct
  // prefix keeps this spec out of that blast radius. launchApp skips
  // auto-cleanup for caller-provided dirs, so remove it in the finally.
  const userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-themeshot-"));
  let ctx: AppContext | undefined;
  try {
    ctx = await launchApp({
      userDataDir,
      screenshotScale: SCALE,
      windowSize: { width: 1680, height: 1050 },
      // GPU + crashpad mitigations: local macOS Electron screenshot runs hit
      // recurring crashpad/GPU-process FATALs without these.
      extraArgs: ["--disable-gpu", "--in-process-gpu", "--disable-breakpad", "--noerrdialogs"],
    });
    const page = await openAndOnboardProject(ctx.app, ctx.window, repo.dir, "Helios Dashboard");
    await page.evaluate(async () => {
      const cur = await window.electron.project.getCurrent();
      if (cur?.id)
        await window.electron.project.update(cur.id, { emoji: "☀️", name: "Helios Dashboard" });
    });
    await setAppTheme(page, THEME);
    await page.addStyleTag({ content: POLISH_CSS }).catch(() => {});
    await dismissBlockingPalette(page);
    await page
      .locator(SEL.worktree.mainCard)
      .waitFor({ state: "visible", timeout: T_LONG })
      .catch(() => {});
    await settle(page, 3000);
    await dismissBlockingPalette(page);

    // 1. Baseline workbench.
    await step("workbench", () => snap(page, "10-workbench"));

    // 2. Tooltip on a toolbar control.
    await step("tooltip", async () => {
      await page.locator(SEL.toolbar.toggleSidebar).hover();
      await page.waitForTimeout(1200);
      await snap(page, "11-tooltip-toolbar");
      await page.mouse.move(800, 600);
    });

    // 3. Hover state on an idle worktree card.
    await step("card-hover", async () => {
      await page.locator('[data-worktree-branch="fix/retry-backoff-jitter"]').first().hover();
      await page.waitForTimeout(400);
      await snap(page, "12-sidebar-card-hover", SEL.sidebar.aside);
      await page.mouse.move(800, 600);
    });

    // 4. Worktree card context menu.
    await step("context-menu", async () => {
      await page.locator(SEL.worktree.mainCard).click({ button: "right" });
      await page.locator('[role="menu"]').waitFor({ state: "visible", timeout: 4000 });
      await settle(page, 400);
      await snap(page, "13-context-menu");
      await page.keyboard.press("Escape");
      await settle(page, 300);
    });

    // 5. Sidebar search active (typed query).
    await step("search-active", async () => {
      const search = page.locator(SEL.worktree.searchInput);
      await search.click();
      await search.fill("retry");
      await settle(page, 600);
      await snap(page, "14-sidebar-search", SEL.sidebar.aside);
      await page
        .locator(SEL.worktree.searchClear)
        .click()
        .catch(() => {});
      await page.keyboard.press("Escape").catch(() => {});
      await settle(page, 300);
    });

    // 5b. Worktree filter/sort popover.
    await step("filter-popover", async () => {
      await page.locator(SEL.worktree.filterButton).click();
      await page.locator(SEL.worktree.filterPopover).waitFor({ state: "visible", timeout: 4000 });
      await settle(page, 400);
      await snap(page, "24-filter-popover");
      await page.keyboard.press("Escape");
      await settle(page, 300);
    });

    // 5c. Project switcher palette.
    await step("project-switcher", async () => {
      await page.locator(SEL.toolbar.projectSwitcherTrigger).click();
      await settle(page, 600);
      await snap(page, "25-project-switcher");
      await page.keyboard.press("Escape");
      await settle(page, 300);
    });

    // 6. Action palette.
    await step("action-palette", async () => {
      // Open it by action, not by the double-Shift accelerator with a Cmd+K
      // fallback. Under load the accelerator's palette took longer than the
      // 2.5s guard to paint, so the fallback fired too — and Cmd+K is a chord
      // prefix, which raised the command HUD on top of the palette that was
      // already opening. The capture came out with two overlapping palettes.
      await dispatchAction(page, "action.palette.open");
      const dialog = page.locator(SEL.actionPalette.dialog);
      await dialog.waitFor({ state: "visible", timeout: T_REQUIRED });
      await page.locator(SEL.actionPalette.searchInput).fill("theme");
      await settle(page, 600);
      await snap(page, "17-action-palette");
      await page.keyboard.press("Escape");
      await settle(page, 300);
    });

    // 7. Notifications popover.
    await step("notifications", async () => {
      await page.locator(SEL.notifications.bellButton).click();
      await settle(page, 600);
      await snap(page, "18-notifications");
      await page.keyboard.press("Escape");
      await settle(page, 300);
    });

    // 8. Review hub / diff view for the dirty main worktree.
    await step("review-hub", async () => {
      await page.locator(SEL.worktree.mainCard).hover();
      await settle(page, 300);
      const btn = page.locator(SEL.worktree.reviewHubButton).first();
      await btn.waitFor({ state: "visible", timeout: 4000 });
      await btn.click();
      await page.locator(SEL.reviewHub.container).waitFor({ state: "visible", timeout: 15_000 });
      await settle(page, 1500);
      await snap(page, "19-review-hub");
      const diffBtn = page.locator(SEL.reviewHub.fileDiffButton("src/index.ts"));
      if (await diffBtn.isVisible({ timeout: 2500 }).catch(() => false)) {
        await diffBtn.click();
        await settle(page, 1200);
        await snap(page, "20-diff-view");
      }
      // The diff layers above the review rather than replacing it (#11243),
      // so unwind the stack top-down before moving on to the next step.
      await page
        .locator(SEL.reviewHub.diffDialogClose)
        .click()
        .catch(() => {});
      await settle(page, 300);
      await page
        .locator(SEL.reviewHub.close)
        .click()
        .catch(() => {});
      await settle(page, 300);
    });

    // 9. Settings dialog (toolbar button first, shortcut fallback).
    await step("settings", async () => {
      const openSettings = page.locator(SEL.toolbar.openSettings);
      if (await openSettings.isVisible({ timeout: 2500 }).catch(() => false)) {
        await openSettings.click();
      } else {
        await page.keyboard.press(process.platform === "darwin" ? "Meta+," : "Control+,");
      }
      await page.locator(SEL.settings.heading).waitFor({ state: "visible", timeout: 8000 });
      await settle(page, 1200);
      await snap(page, "21-settings");
      // Appearance tab — theme preview cards are a major theme surface.
      const appearanceNav = page.getByRole("tab", { name: "Appearance" }).first();
      if (await appearanceNav.isVisible({ timeout: 2500 }).catch(() => false)) {
        await appearanceNav.click();
        await settle(page, 1200);
        await snap(page, "26-settings-appearance");
      }
      // Typed settings search — input field + result highlighting.
      const settingsSearch = page.locator(SEL.settings.searchInput);
      if (await settingsSearch.isVisible({ timeout: 2000 }).catch(() => false)) {
        await settingsSearch.click();
        await settingsSearch.fill("theme");
        await settle(page, 800);
        await snap(page, "27-settings-search");
        await settingsSearch.clear().catch(() => {});
      }
      await page
        .locator(SEL.settings.closeButton)
        .click()
        .catch(() => {});
      await settle(page, 300);
    });

    // 10. Terminal panel + dock chip.
    await step("terminal-and-dock", async () => {
      const openTerminal = page.locator(SEL.toolbar.openTerminal);
      await openTerminal.waitFor({ state: "visible", timeout: 5000 });
      await openTerminal.click();
      await page
        .locator(SEL.panel.gridPanel)
        .first()
        .waitFor({ state: "visible", timeout: T_LONG });
      await settle(page, 2000);
      // Seed ANSI-colored output so the terminal palette is reviewable —
      // failures here must not sink the rest of the step.
      try {
        await page.locator(SEL.panel.gridPanel).first().click();
        await page.keyboard.type(
          "printf '\\e[31mred \\e[32mgreen \\e[33myellow \\e[34mblue \\e[35mmagenta \\e[36mcyan \\e[90mbright-black\\e[0m\\n'; git log --oneline --color=always | head -3; ls"
        );
        await page.keyboard.press("Enter");
        await settle(page, 1500);
      } catch {
        // plain prompt is still a usable capture
      }
      await snap(page, "22-terminal");

      // Both of the remaining shots are required, and the dock one is reached
      // through the search one — so collect failures instead of returning on
      // the first, or a slow search bar silently costs the dock capture too.
      const failures: string[] = [];

      // Terminal search bar (find-in-terminal chrome). `find.inFocusedPanel`
      // (Cmd+F) only dispatches a `daintree:find-in-panel` event, and
      // TerminalPane ignores it unless that pane is the focused one
      // (TerminalPane.tsx:782) — so focus the xterm screen itself, then fire
      // the event directly rather than trusting the accelerator to survive
      // xterm's key handling.
      try {
        await page.locator(SEL.terminal.xtermRows).first().click();
        await settle(page, 500);
        await page.evaluate(() => window.dispatchEvent(new CustomEvent("daintree:find-in-panel")));
        const termSearch = page.locator(SEL.terminal.searchInput);
        await termSearch.waitFor({ state: "visible", timeout: T_REQUIRED });
        // "green" is in the ANSI line seeded above, so the bar renders its
        // match state rather than the "no results" one — the colours that
        // carry theme weight are on the match chrome.
        await termSearch.fill("green");
        await settle(page, 500);
        await snap(page, "28-terminal-search");
        await page.keyboard.press("Escape");
        await settle(page, 300);
      } catch (error) {
        failures.push(`terminal-search: ${String(error).slice(0, 160)}`);
      }

      try {
        const minimize = page.locator(SEL.panel.minimize).first();
        await minimize.waitFor({ state: "visible", timeout: T_REQUIRED });
        await minimize.click();
        await settle(page, 1000);
        await snap(page, "23-dock");
      } catch (error) {
        failures.push(`dock: ${String(error).slice(0, 160)}`);
      }

      if (failures.length > 0) throw new Error(failures.join(" | "));
    });

    // 10b. Confirm dialog (destructive-tier chrome) — open via the worktree
    // context menu, capture, and ESCAPE without confirming.
    await step("confirm-dialog", async () => {
      await page
        .locator('[data-worktree-branch="chore/bump-electron-41"]')
        .first()
        .click({ button: "right" });
      await page.locator('[role="menu"]').waitFor({ state: "visible", timeout: 4000 });
      const deleteItem = page.getByRole("menuitem", { name: /delete/i }).first();
      await deleteItem.waitFor({ state: "visible", timeout: 3000 });
      await deleteItem.click();
      await page
        .locator('[role="alertdialog"], [role="dialog"]')
        .filter({ hasText: /delete/i })
        .last()
        .waitFor({ state: "visible", timeout: 5000 });
      await settle(page, 500);
      await snap(page, "29-confirm-dialog");
      await page.keyboard.press("Escape");
      await settle(page, 400);
    });

    // 11. New worktree dialog + quick create palette — LAST: this flow has
    // crashed the renderer in local capture runs, so nothing important may run
    // after it. The sidebar "+" dispatches `worktree.createDialog.open`
    // (SidebarContent.tsx:1851), which opens the FULL dialog — it does not go
    // through the quick create palette, which has its own action. Two
    // independent openers, so two independently-recorded failures.
    await step("new-worktree-dialog", async () => {
      const failures: string[] = [];

      try {
        await page.locator(SEL.worktree.newWorktreeButton).click();
        const dialog = page.locator(SEL.worktree.newDialog);
        await dialog.waitFor({ state: "visible", timeout: T_REQUIRED });
        await settle(page, 800);
        await snap(page, "16-new-worktree-dialog");
        await page.keyboard.press("Escape");
        await dialog.waitFor({ state: "hidden", timeout: T_REQUIRED }).catch(() => {});
        await settle(page, 400);
      } catch (error) {
        failures.push(`new-worktree-dialog: ${String(error).slice(0, 160)}`);
        await page.keyboard.press("Escape").catch(() => {});
        await settle(page, 300);
      }

      // Order is load-bearing: hydration only calls `loadRecipes` when a
      // project is already current at boot, which it is not here (the project
      // is opened after launch). Mounting the dialog above runs
      // `useNewWorktreeProjectSettings`, which loads the in-repo recipes — so
      // the palette below has rows and a "Customize…" option to show.
      try {
        await dispatchAction(page, "worktree.quickCreate");
        const palette = page.locator(SEL.worktree.quickCreatePalette);
        await palette.waitFor({ state: "visible", timeout: T_REQUIRED });
        // The "Customize…" row only exists once the project has recipes — the
        // fixture seeds three, so its absence means the list never loaded.
        await page
          .locator(SEL.worktree.quickCreateCustomize)
          .waitFor({ state: "visible", timeout: T_REQUIRED });
        await settle(page, 500);
        await snap(page, "15-quick-create-palette");
      } catch (error) {
        failures.push(`quick-create-palette: ${String(error).slice(0, 160)}`);
      }

      await page.keyboard.press("Escape").catch(() => {});
      await settle(page, 300);
      await page.keyboard.press("Escape").catch(() => {});
      await settle(page, 200);

      if (failures.length > 0) throw new Error(failures.join(" | "));
    });
  } finally {
    if (ctx?.app) await closeApp(ctx.app);
    repo.cleanup();
    rmSync(userDataDir, { recursive: true, force: true });
  }

  verifyCaptures();
});
