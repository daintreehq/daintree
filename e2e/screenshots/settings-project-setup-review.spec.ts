/**
 * Project setup settings visual-review harness — empty, populated and validation states.
 *
 * `settings-pages-review.spec.ts` walks every tab of a fresh profile, which only ever
 * shows these pages empty. The project setup pages (Project Settings → General,
 * Context, Variables, Worktree setup, Recipes; global Environment; the CLI agents env
 * editor and its Import .env dialog) carry most of their design weight in lists that
 * are empty on a fresh profile and in errors that only appear after the user types
 * something wrong. This harness seeds them through the real persistence seams
 * (`project.saveSettings`, `project.saveRecipes`, `globalEnv.set`, `agentSettings.set`),
 * reloads so the renderer rebuilds from disk, and drives the validation states through
 * the UI the way a user would. Page slicing and navigation follow the pages harness.
 *
 *   DAINTREE_SHOT_PROJECT_SETUP=1 DAINTREE_SHOT_DIR=/abs/out \
 *     npx playwright test --project=screenshots settings-project-setup-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_PROJECT_SETUP  required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR            required — absolute output directory outside the repo
 *   DAINTREE_SHOT_THEME          optional theme id (default: the app default)
 *   DAINTREE_SHOT_STATES         comma-separated subset of empty,populated,validation
 *   DAINTREE_SHOT_MAX_SLICES     slice cap per page (default 6)
 *
 * Every capture asserts text that only exists once its state is reached, and the run
 * fails unless the PNGs on disk match manifest.json.
 */

import { test, expect, type Page, type ElectronApplication, type Locator } from "@playwright/test";
import { execSync } from "child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { openAndOnboardProject } from "../helpers/project";
import { dismissBlockingPalette } from "../helpers/overlays";
import { setAppTheme } from "../helpers/theme";
import { navigateToAgentSettings } from "../helpers/presets";
import { saveCurrentProjectSettings } from "../helpers/projectSettings";

const ENABLED = !!process.env.DAINTREE_SHOT_PROJECT_SETUP;
const THEME = process.env.DAINTREE_SHOT_THEME ?? "";
const THEME_SLUG = THEME || "default";
const MAX_SLICES = Number(process.env.DAINTREE_SHOT_MAX_SLICES ?? "6");
const OUTPUT_DIR = process.env.DAINTREE_SHOT_DIR ? path.resolve(process.env.DAINTREE_SHOT_DIR) : "";
const STATES = (process.env.DAINTREE_SHOT_STATES ?? "empty,populated,validation")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const DIALOG = '[role="dialog"]:has(.settings-sidebar)';
const CARD = '[role="dialog"]:has(.settings-sidebar) > div';
const CLOSE = '[aria-label="Close settings"]';
const IMPORT_ENV_DIALOG = '[data-testid="import-env-dialog"]';
const ENV_EDITOR = '[data-testid="global-env-editor"]';
const navItem = (tab: string) => `.settings-sidebar [role="tab"][data-tab="${tab}"]`;

const PROJECT_NAME = "Helios Dashboard";
const WIDE = { width: 1680, height: 1050 };

const PAGES = [
  "project:general",
  "project:context",
  "project:variables",
  "project:automation",
  "project:recipes",
  "environment",
] as const;

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

const GLOBAL_ENV: Record<string, string> = {
  EDITOR: "code --wait",
  GITHUB_TOKEN: "ghp_9f2kQv7LmXw3RbT8yN1cZpHs4dJ6uA0eK5gI",
  NODE_OPTIONS: "--max-old-space-size=8192",
  PATH_EXTRA: "/opt/homebrew/bin:/usr/local/go/bin",
};

const AGENT_ENV: Record<string, string> = {
  ANTHROPIC_BASE_URL: "https://api.anthropic.com",
  MAX_THINKING_TOKENS: "16384",
  ANTHROPIC_API_KEY: "sk-ant-api03-Hk7v2QpLm9xR4tYbN1cZ",
};

function git(cmd: string, cwd: string): void {
  execSync(`git ${cmd}`, { cwd, stdio: "ignore" });
}

function createFixtureRepo(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "daintree-project-setup-shots-"));
  const wtRoot = path.join(path.dirname(dir), path.basename(dir) + "-worktrees");
  mkdirSync(wtRoot, { recursive: true });
  git("init -b main", dir);
  git('config user.email "test@daintree.dev"', dir);
  git('config user.name "Daintree Test"', dir);
  mkdirSync(path.join(dir, "src"), { recursive: true });
  writeFileSync(path.join(dir, "README.md"), "# Helios Dashboard\n");
  writeFileSync(
    path.join(dir, "package.json"),
    '{"name":"helios","scripts":{"dev":"vite","build":"vite build","test":"vitest"}}\n'
  );
  writeFileSync(path.join(dir, "src", "index.ts"), "export const version = 1;\n");
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

async function settle(page: Page, ms = 350): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
  );
  await page.waitForTimeout(ms);
}

async function setWindowSize(
  app: ElectronApplication,
  size: { width: number; height: number }
): Promise<void> {
  await app.evaluate(({ BrowserWindow }, s) => {
    BrowserWindow.getAllWindows()[0]?.setSize(s.width, s.height);
  }, size);
}

async function openSettingsAt(page: Page, tab: string): Promise<void> {
  await page.evaluate(
    (detail) => {
      window.dispatchEvent(new CustomEvent("daintree:open-settings-tab", { detail }));
    },
    { tab }
  );
  await page.locator(DIALOG).waitFor({ state: "visible", timeout: 20_000 });
  await expect(page.locator(navItem(tab))).toHaveAttribute("aria-selected", "true", {
    timeout: 15_000,
  });
  await settle(page, 900);
}

async function closeSettings(page: Page): Promise<void> {
  await page
    .locator(CLOSE)
    .click()
    .catch(() => {});
  await page
    .locator(DIALOG)
    .waitFor({ state: "hidden", timeout: 8000 })
    .catch(() => {});
}

function panel(page: Page, tab: string): Locator {
  return page.locator(`${DIALOG} #settings-panel-${tab.replace(/:/g, "\\:")}`);
}

async function tagScroller(
  page: Page,
  tab: string
): Promise<{ scrollHeight: number; clientHeight: number }> {
  return page.evaluate((panelId) => {
    document
      .querySelectorAll("[data-shot-scroller]")
      .forEach((el) => el.removeAttribute("data-shot-scroller"));
    const p = document.getElementById(panelId);
    if (!p) throw new Error(`no panel #${panelId}`);
    let el: HTMLElement | null = p.parentElement;
    while (el) {
      const oy = getComputedStyle(el).overflowY;
      if ((oy === "auto" || oy === "scroll") && el.clientHeight > 0) break;
      el = el.parentElement;
    }
    if (!el) throw new Error("no scroll container above the tab panel");
    el.setAttribute("data-shot-scroller", "");
    el.scrollTop = 0;
    return { scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
  }, `settings-panel-${tab}`);
}

interface ManifestEntry {
  file: string;
  state: string;
  page: string;
}

const manifest: ManifestEntry[] = [];
const failures: string[] = [];

function fileName(state: string, name: string): string {
  return `${state}--${name.replace(/:/g, "_")}--${THEME_SLUG}.png`;
}

/** Slices the page top to bottom, after asserting the text that proves the state. */
async function capturePage(
  page: Page,
  state: string,
  tab: string,
  requiredText: string[]
): Promise<void> {
  const p = panel(page, tab);
  for (const text of requiredText) {
    await expect(p.getByText(text, { exact: false }).first()).toBeVisible({ timeout: 10_000 });
  }
  const { scrollHeight, clientHeight } = await tagScroller(page, tab);
  await settle(page, 250);
  const step = Math.max(200, Math.floor(clientHeight * 0.85));
  const total = Math.min(
    MAX_SLICES,
    Math.max(1, Math.ceil((scrollHeight - clientHeight) / step) + 1)
  );
  for (let i = 0; i < total; i++) {
    await page.evaluate((top) => {
      const el = document.querySelector<HTMLElement>("[data-shot-scroller]");
      if (el) el.scrollTop = top;
    }, i * step);
    await settle(page, 200);
    const file = fileName(state, `${tab}--p${i + 1}`);
    await page
      .locator(CARD)
      .first()
      .screenshot({ path: path.join(OUTPUT_DIR, file), type: "png", animations: "disabled" });
    manifest.push({ file, state, page: tab });
  }
}

/** One frame of the dialog with `target` scrolled to the centre of the page scroller. */
async function captureAt(
  page: Page,
  state: string,
  name: string,
  target: Locator,
  requiredText: string[]
): Promise<void> {
  await expect(target).toBeVisible({ timeout: 10_000 });
  for (const text of requiredText) {
    await expect(target.getByText(text, { exact: false }).first()).toBeVisible({
      timeout: 10_000,
    });
  }
  await target.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await settle(page, 300);
  const file = fileName(state, name);
  await page
    .locator(CARD)
    .first()
    .screenshot({ path: path.join(OUTPUT_DIR, file), type: "png", animations: "disabled" });
  manifest.push({ file, state, page: name });
}

async function captureOverlay(
  page: Page,
  state: string,
  name: string,
  overlay: Locator,
  requiredText: string[]
): Promise<void> {
  await expect(overlay).toBeVisible({ timeout: 10_000 });
  for (const text of requiredText) {
    await expect(overlay.getByText(text, { exact: false }).first()).toBeVisible({
      timeout: 10_000,
    });
  }
  await settle(page, 300);
  const file = fileName(state, name);
  await overlay.screenshot({
    path: path.join(OUTPUT_DIR, file),
    type: "png",
    animations: "disabled",
  });
  manifest.push({ file, state, page: name });
}

async function attempt(label: string, fn: () => Promise<void>): Promise<void> {
  const before = manifest.length;
  try {
    await fn();
  } catch (error) {
    manifest.splice(before);
    failures.push(`${label}: ${String(error).slice(0, 500)}`);
  }
}

async function agentEnvEditor(page: Page): Promise<Locator> {
  await navigateToAgentSettings(page, "claude");
  const editor = page.locator(`#settings-panel-agents ${ENV_EDITOR}`);
  await expect(editor).toBeVisible({ timeout: 15_000 });
  await tagScroller(page, "agents");
  return editor;
}

async function captureAll(page: Page, state: "empty" | "populated"): Promise<void> {
  const populated = state === "populated";
  const required: Record<(typeof PAGES)[number], string[]> = {
    "project:general": ["Dev server", "Agent integrations"],
    "project:context": populated ? ["dist/**", "Always include"] : ["Excluded paths"],
    "project:variables": populated ? ["Inherited from global"] : ["Add variable"],
    "project:automation": populated
      ? ["Run commands", "Provision commands"]
      : ["Run commands", "Resource environments"],
    "project:recipes": populated ? ["Full stack"] : ["Add recipe"],
    environment: populated ? ["Global variables"] : ["Add a variable"],
  };
  for (const tab of PAGES) {
    await attempt(`${state}/${tab}`, async () => {
      await openSettingsAt(page, tab);
      const seededKey = { "project:variables": "DATABASE_URL", environment: "NODE_OPTIONS" }[
        tab as string
      ];
      if (populated && seededKey) {
        await expect(panel(page, tab).locator(`input[value="${seededKey}"]`)).toBeVisible({
          timeout: 10_000,
        });
      }
      if (populated && tab === "project:general") {
        // The tier is a project setting the saveSettings seam does not carry, so
        // choose it the way a user does to get the System warning on screen.
        await panel(page, tab).getByRole("radio", { name: "System" }).check({ force: true });
        await settle(page, 300);
      }
      await capturePage(page, state, tab, required[tab]);
    });
  }
  await attempt(`${state}/agents-env`, async () => {
    const editor = await agentEnvEditor(page);
    if (populated) {
      await expect(editor.locator('input[value="ANTHROPIC_BASE_URL"]')).toBeVisible();
    }
    await captureAt(page, state, "agents-env", page.locator("#agents-global-env"), [
      populated ? "Import .env" : "Add your first variable",
    ]);
  });
  await closeSettings(page);
}

async function seedPopulated(page: Page): Promise<void> {
  await saveCurrentProjectSettings(page, {
    devServerCommand: "npm run dev -- --port 5173",
    devServerLoadTimeout: 45,
    turbopackEnabled: true,
    daintreeMcpTier: "system",
    excludedPaths: ["node_modules/**", "dist/**", "coverage/**"],
    copyTreeSettings: {
      maxContextSize: 52428800,
      charLimit: 400000,
      strategy: "modified",
      alwaysInclude: ["**/*.md", "docs/architecture/**"],
      alwaysExclude: ["**/*.lock"],
    },
    environmentVariables: {
      DATABASE_URL: "postgres://helios:dev@localhost:5432/helios",
      NODE_OPTIONS: "--max-old-space-size=4096",
      STRIPE_SECRET_KEY: "sk_test_51Hk7v2QpLm9xR4tYbN1cZ",
      VITE_API_BASE: "http://localhost:8787",
    },
    runCommands: [
      { id: "cmd-dev", name: "Dev server", command: "npm run dev", preferredLocation: "dock" },
      {
        id: "cmd-test",
        name: "Unit tests (watch)",
        command: "npx vitest --watch --reporter=dot",
        preferredAutoRestart: true,
      },
      { id: "cmd-build", name: "Production build", command: "npm run build" },
    ],
    branchPrefixMode: "custom",
    branchPrefixCustom: "helios/",
    worktreePathPattern: "{parent-dir}/{base-folder}-worktrees/{branch-slug}",
    terminalSettings: {
      shell: "/opt/homebrew/bin/fish",
      shellArgs: ["-l"],
      scrollbackLines: 5000,
    },
    resourceEnvironments: {
      "docker-local": {
        icon: "Container",
        provision: ["docker compose up -d", "docker compose exec app npm ci"],
        teardown: ["docker compose down -v"],
        status: "docker compose ps --format json",
        connect: "docker compose exec app /bin/bash",
      },
      "staging-vm": { icon: "Cloud", provision: ["ssh staging ./provision.sh"] },
    },
    activeResourceEnvironment: "docker-local",
    defaultWorktreeMode: "docker-local",
    defaultWorktreeRecipeId: "recipe-fullstack",
  });

  await page.evaluate(
    async ({ globalEnv, agentEnv }) => {
      const current = await window.electron.project.getCurrent();
      if (!current?.id) throw new Error("no current project to seed recipes into");
      const now = Date.now();
      await window.electron.project.saveRecipes(current.id, [
        {
          id: "recipe-fullstack",
          name: "Full stack",
          projectId: current.id,
          createdAt: now - 86_400_000 * 9,
          lastUsedAt: now - 3_600_000 * 3,
          showInEmptyState: true,
          terminals: [
            { type: "claude" },
            { type: "terminal", title: "Dev", command: "npm run dev" },
            { type: "terminal", title: "Tests", command: "npx vitest" },
          ],
        },
        {
          id: "recipe-review",
          name: "Review a pull request with two agents side by side",
          projectId: current.id,
          createdAt: now - 86_400_000 * 2,
          terminals: [{ type: "claude" }, { type: "codex" }],
        },
      ] as never);
      await window.electron.globalEnv.set(globalEnv);
      type AgentSettings = { agents?: Record<string, Record<string, unknown> | undefined> };
      const settings = (await window.electron.agentSettings.get()) as AgentSettings;
      const entry = settings.agents?.claude ?? {};
      await window.electron.agentSettings.set("claude", {
        ...entry,
        globalEnv: agentEnv,
        presetId: undefined,
      } as never);
    },
    { globalEnv: GLOBAL_ENV, agentEnv: AGENT_ENV }
  );
}

async function reloadClean(page: Page): Promise<void> {
  if (THEME) {
    await setAppTheme(page, THEME);
  } else {
    await page.reload({ waitUntil: "domcontentloaded" });
  }
  await page.addStyleTag({ content: POLISH_CSS });
  await dismissBlockingPalette(page).catch(() => undefined);
  await settle(page, 1200);
}

async function captureValidation(page: Page): Promise<void> {
  await attempt("validation/project:variables", async () => {
    await openSettingsAt(page, "project:variables");
    const p = panel(page, "project:variables");
    const add = p.getByRole("button", { name: "Add variable" });
    await add.click();
    await p.getByLabel("Environment variable name").last().fill("2FAST_MODE");
    await add.click();
    await p.getByLabel("Environment variable name").last().fill("DATABASE_URL");
    await p.getByRole("button", { name: "Save", exact: true }).click();
    await capturePage(page, "validation", "project:variables", [
      "Start with a letter or underscore",
      "Another variable already uses this name",
    ]);
    await p.getByRole("button", { name: "Discard" }).click();
  });

  await attempt("validation/environment", async () => {
    await openSettingsAt(page, "environment");
    const p = panel(page, "environment");
    await p.getByRole("button", { name: "Add variable" }).first().click();
    await p.getByLabel("Environment variable name").last().fill("MY-KEY");
    await p.getByLabel("Environment variable value").last().fill("on");
    await p.getByRole("button", { name: "Save", exact: true }).click();
    await capturePage(page, "validation", "environment", ["Start with a letter or underscore"]);
    await p.getByRole("button", { name: "Discard" }).click();
  });

  await attempt("validation/project:general", async () => {
    await openSettingsAt(page, "project:general");
    const p = panel(page, "project:general");
    await p.getByLabel("Hex color value").fill("#12zz");
    await captureAt(
      page,
      "validation",
      "project:general--color",
      p.getByLabel("Hex color value"),
      []
    );
  });

  await attempt("validation/project:automation", async () => {
    await openSettingsAt(page, "project:automation");
    const p = panel(page, "project:automation");
    await p.getByRole("textbox", { name: "Path pattern" }).fill("{parent-dir}/worktrees/{branch}");
    await p.getByRole("spinbutton", { name: "Scrollback" }).fill("12");
    await p.getByRole("button", { name: "Add environment" }).click();
    const nameInput = p.locator("#new-environment-name");
    await nameInput.fill("docker-local");
    await nameInput.press("Enter");
    await capturePage(page, "validation", "project:automation", [
      "already exists",
      "Must be between",
    ]);
  });

  await attempt("validation/project:recipes", async () => {
    await saveCurrentProjectSettings(page, { defaultWorktreeRecipeId: "recipe-deleted" });
    await closeSettings(page);
    await openSettingsAt(page, "project:recipes");
    const p = panel(page, "project:recipes");
    await capturePage(page, "validation", "project:recipes", ["Default recipe unavailable"]);
    await p.getByRole("button", { name: "Import recipe" }).click();
    const importDialog = page.locator('[role="dialog"]:has-text("Paste the JSON")').last();
    await importDialog.locator("textarea").fill('{"name": "Broken", "terminals": [');
    await importDialog.getByRole("button", { name: "Import", exact: true }).click();
    await captureOverlay(
      page,
      "validation",
      "recipes-import",
      importDialog.locator("> div").first(),
      ["Paste the JSON"]
    );
    await page.keyboard.press("Escape");
    await settle(page, 300);
  });

  await attempt("validation/agents-env", async () => {
    await closeSettings(page);
    const editor = await agentEnvEditor(page);
    await editor.locator('[data-testid="env-editor-add"]').click();
    const key = editor.locator('[data-testid="env-editor-key"]').last();
    await key.fill("ANTHROPIC_BASE_URL");
    await key.blur();
    await editor.locator('[data-testid="env-editor-add"]').click();
    const blank = editor.locator('[data-testid="env-editor-key"]').last();
    await blank.fill("");
    await blank.blur();
    await captureAt(page, "validation", "agents-env", page.locator("#agents-global-env"), [
      "Enter a name",
      "Another variable already uses this name",
    ]);
  });

  await attempt("validation/import-env", async () => {
    const editor = page.locator(`#settings-panel-agents ${ENV_EDITOR}`);
    await editor.locator('[data-testid="env-editor-import"]').click({ force: true });
    const dialog = page.locator(IMPORT_ENV_DIALOG);
    const card = dialog.locator("> div").first();
    await dialog
      .locator('[data-testid="import-env-textarea"]')
      .fill(["GOOD_KEY=fine", "this line has no equals sign", "2BAD_KEY=digit first"].join("\n"));
    await captureOverlay(page, "validation", "import-env--errors", card, ["parse error"]);
    await dialog
      .locator('[data-testid="import-env-textarea"]')
      .fill(
        [
          "MAX_THINKING_TOKENS=32000",
          "ANTHROPIC_BASE_URL=https://proxy.internal",
          "NEW_FLAG=1",
        ].join("\n")
      );
    await dialog.locator('[data-confirm-role="confirm"]').click();
    await captureOverlay(page, "validation", "import-env--conflicts", card, ["Resolve conflicts"]);
    await page.keyboard.press("Escape");
  });
  await closeSettings(page);
}

test("project setup settings review — empty, populated and validation states", async () => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_PROJECT_SETUP is required for the project setup capture",
  });
  test.skip(!ENABLED, "Set DAINTREE_SHOT_PROJECT_SETUP to run the project setup capture");
  if (!OUTPUT_DIR || !path.isAbsolute(OUTPUT_DIR)) {
    throw new Error("DAINTREE_SHOT_DIR must be an absolute directory outside the repo");
  }
  if (OUTPUT_DIR.startsWith(process.cwd() + path.sep)) {
    throw new Error("DAINTREE_SHOT_DIR must be outside the repo");
  }
  test.setTimeout(900_000);

  mkdirSync(OUTPUT_DIR, { recursive: true });
  for (const f of readdirSync(OUTPUT_DIR)) {
    if (f.endsWith(".png")) rmSync(path.join(OUTPUT_DIR, f));
  }
  const repo = createFixtureRepo();
  const userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-projectsetupshot-"));
  let ctx: AppContext | undefined;

  try {
    ctx = await launchApp({
      userDataDir,
      windowSize: WIDE,
      extraArgs: ["--disable-gpu", "--in-process-gpu", "--disable-breakpad", "--noerrdialogs"],
    });
    await setWindowSize(ctx.app, WIDE);
    const page = await openAndOnboardProject(ctx.app, ctx.window, repo.dir, PROJECT_NAME);
    await reloadClean(page);

    if (STATES.includes("empty")) await captureAll(page, "empty");

    if (STATES.includes("populated") || STATES.includes("validation")) {
      await seedPopulated(page);
      await reloadClean(page);
    }
    if (STATES.includes("populated")) await captureAll(page, "populated");
    if (STATES.includes("validation")) await captureValidation(page);
  } finally {
    if (ctx) await closeApp(ctx.app).catch(() => {});
    repo.cleanup();
    rmSync(userDataDir, { recursive: true, force: true });
  }

  writeFileSync(path.join(OUTPUT_DIR, "manifest.json"), JSON.stringify(manifest, null, 2));
  const onDisk = new Set(readdirSync(OUTPUT_DIR).filter((f) => f.endsWith(".png")));
  const missing = manifest.filter((m) => !onDisk.has(m.file)).map((m) => m.file);
  console.log(
    `[project-setup-shots] ${manifest.length - missing.length}/${manifest.length} PNGs → ${OUTPUT_DIR}`
  );
  if (missing.length > 0) failures.push(`missing on disk: ${missing.join(", ")}`);
  if (failures.length > 0)
    throw new Error(`project setup capture failed:\n  ${failures.join("\n  ")}`);
  expect(manifest.length).toBeGreaterThan(0);
});
