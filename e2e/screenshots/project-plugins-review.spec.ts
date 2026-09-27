/**
 * Project settings → Plugins visual-review harness.
 *
 * The page answers every plugin question that is about one project: whether the
 * repository's own `.daintree/plugins` may run, each project plugin's own switch
 * and settings, and whether each installed plugin is surfaced here at all. Its
 * states live behind a picker and behind lifecycle transitions (folder off,
 * staged, muted, unreadable, running), so a tab-level sweep sees almost none of
 * them. This harness drives each one through the product's own seams:
 *
 *   - project plugins are real directories in the fixture repo's
 *     `.daintree/plugins`, discovered, trusted, staged and muted by main;
 *   - installed plugins are real manifests in a fake `HOME` plus the
 *     `plugins.installed` records `PluginInstalledRecordsStore` reads, and the
 *     sideloaded samples through `DAINTREE_E2E_SIDELOAD_PLUGIN_DIR`;
 *   - stored setting values are written with `plugin.setSettingValue`, the same
 *     bridge the form writes through;
 *   - failures come from the E2E fault registry on the real IPC channel, so the
 *     renderer's own catch paths render them.
 *
 *   DAINTREE_SHOT_PROJECT_PLUGINS=1 DAINTREE_SHOT_DIR=/abs/out \
 *     npx playwright test --project=screenshots project-plugins-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_PROJECT_PLUGINS  required — any truthy value runs the capture
 *   DAINTREE_SHOT_DIR              required — output directory (never the repo)
 *   DAINTREE_SHOT_THEME            optional theme id (default: the app default)
 *   DAINTREE_SHOT_ONLY             comma-separated step filter
 *
 * Needs `npm run build:e2e` for the sideloaded samples. A manifest.json beside the
 * PNGs lists every file written, and the run fails unless every planned step
 * produced its files and they are all on disk.
 */

import { test, expect, type Page, type ElectronApplication } from "@playwright/test";
import { execSync } from "child_process";
import { cpSync, mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { openAndOnboardProject } from "../helpers/project";
import { dismissBlockingPalette } from "../helpers/overlays";
import { setAppTheme } from "../helpers/theme";
import { SAMPLE_PLUGINS_DIR } from "../helpers/plugins";
import { injectFault, clearAllFaults } from "../helpers/ipcFaults";

const ENABLED = !!process.env.DAINTREE_SHOT_PROJECT_PLUGINS;
const THEME = process.env.DAINTREE_SHOT_THEME ?? "";
const THEME_SLUG = THEME || "default";
const OUTPUT_DIR = process.env.DAINTREE_SHOT_DIR ? path.resolve(process.env.DAINTREE_SHOT_DIR) : "";
const ONLY = (process.env.DAINTREE_SHOT_ONLY ?? "").split(",").filter(Boolean);

const PROJECT_PLUGIN_FIXTURE = path.resolve(
  import.meta.dirname,
  "../../plugins/fixtures/project-local/.daintree"
);

const DIALOG = '[role="dialog"]:has(.settings-sidebar)';
const CARD = '[role="dialog"]:has(.settings-sidebar) > div';
const CLOSE = '[aria-label="Close settings"]';
const PANEL = `${DIALOG} #settings-panel-project\\:plugins`;
const TRIGGER = `${PANEL} [data-testid="project-plugin-selector-trigger"]`;
const LIST = "#project-plugin-selector-list";
const FILTER = '[aria-label="Filter plugins"]';

const WIDE = { width: 1680, height: 1050 };
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();

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

const STUB_MAIN = "export async function activate() {}\nexport async function deactivate() {}\n";

/**
 * The settings-rich project plugin: one field of every kind the form renders
 * differently, at the two project-bound scopes, plus a required field with a
 * default and a long description that clamps behind "Show more".
 */
const DEPLOY_PREVIEW = {
  name: "acme.deploy-preview",
  version: "1.8.0",
  scope: "project",
  displayName: "Deploy Preview",
  description:
    "Builds a preview deployment for every pushed branch, posts the URL back to the pull request, and tears the environment down when the branch is merged or deleted. Preview environments share the staging database unless an isolated snapshot is configured below, and each one is billed to the project's cloud account for as long as it stays up.",
  main: "dist/index.js",
  engines: { daintree: ">=0.11.0" },
  capabilities: ["git:read", "network:fetch", "fs:project-read"],
  contributes: {
    settings: [
      {
        id: "environment",
        type: "string",
        label: "Environment name",
        description: "Prefix for preview hostnames",
        default: "preview",
        scope: "project",
        required: true,
      },
      {
        id: "region",
        type: "enum",
        label: "Region",
        options: ["us-east", "eu-west", "ap-south"],
        default: "us-east",
        scope: "project",
      },
      {
        id: "instanceSize",
        type: "enum",
        label: "Instance size",
        description: "Larger instances build faster and cost more per hour",
        options: [
          "Shared (0.5 vCPU, 512 MB)",
          "Standard (2 vCPU, 4 GB)",
          "Performance (8 vCPU, 16 GB)",
        ],
        default: "Standard (2 vCPU, 4 GB)",
        scope: "project",
      },
      {
        id: "ttlHours",
        type: "number",
        label: "Keep previews for",
        description: "Hours an idle preview stays up before it is torn down",
        default: 48,
        min: 1,
        max: 720,
        scope: "project",
      },
      {
        id: "autoDeploy",
        type: "boolean",
        label: "Deploy on every push",
        description: "Off means previews are only built when you ask for one",
        default: true,
        scope: "local",
      },
      {
        id: "snapshotDir",
        type: "directory",
        label: "Database snapshot folder",
        description: "Seeds an isolated database for each preview",
        mustExist: true,
        scope: "local",
      },
      {
        id: "apiToken",
        type: "secret",
        label: "Cloud API token",
        scope: "local",
      },
      {
        id: "headers",
        type: "json",
        label: "Extra response headers",
        default: { "x-robots-tag": "noindex" },
        scope: "project",
      },
    ],
  },
};

/** Present at trust time so it runs, then muted: the stopped-settings case. */
const MUTED_LINTER = {
  name: "acme.commit-linter",
  version: "0.4.2",
  scope: "project",
  displayName: "Commit Linter",
  description: "Checks commit messages against the project's conventional-commit rules.",
  main: "dist/index.js",
  engines: { daintree: ">=0.11.0" },
  capabilities: ["git:read"],
  contributes: {
    settings: [
      {
        id: "types",
        type: "string",
        label: "Allowed types",
        description: "Comma-separated commit types",
        default: "feat,fix,chore,docs",
        scope: "project",
      },
      {
        id: "maxSubject",
        type: "number",
        label: "Subject length limit",
        default: 72,
        scope: "project",
      },
    ],
  },
};

/** Added after trust, so it lands staged: read but never run. */
const STAGED = {
  name: "acme.release-notes",
  version: "0.3.0",
  scope: "project",
  displayName: "Release Notes",
  description: "Drafts release notes from merged pull requests since the last tag.",
  main: "dist/index.js",
  engines: { daintree: ">=0.11.0" },
  capabilities: ["git:read", "fs:project-write", "network:fetch"],
  contributes: {
    settings: [
      {
        id: "changelogPath",
        type: "file",
        label: "Changelog file",
        description: "Where drafted notes are appended",
        scope: "project",
      },
    ],
  },
};

/** Shares its id with an installed plugin — the `collidesWithGlobal` case. */
const COLLIDING = {
  name: "acme.quick-notes",
  version: "0.1.0",
  scope: "project",
  displayName: "Quick Notes (team fork)",
  description: "The team's fork of Quick Notes, with notes stored in the repository.",
  main: "dist/index.js",
  engines: { daintree: ">=0.11.0" },
  capabilities: [],
};

interface InstalledFixture {
  id: string;
  displayName: string;
  version: string;
  description: string;
  disabled?: boolean;
  settings?: unknown[];
}

const INSTALLED: InstalledFixture[] = [
  {
    id: "acme.markdown-studio",
    displayName: "Markdown Studio",
    version: "1.4.2",
    description:
      "Adds a live Markdown preview panel with a synced outline, footnote support, and one-click export to HTML or PDF.",
    settings: [
      {
        id: "previewTheme",
        type: "enum",
        label: "Preview theme",
        options: ["github", "minimal", "academic"],
        default: "github",
      },
      {
        id: "exportDir",
        type: "directory",
        label: "Export folder",
        description: "Where exported HTML and PDF files are written",
        scope: "project",
      },
      {
        id: "mathSupport",
        type: "boolean",
        label: "Render math",
        description: "KaTeX for inline and block math",
        default: false,
        scope: "project",
      },
    ],
  },
  {
    id: "acme.quick-notes",
    displayName: "Quick Notes",
    version: "0.3.1",
    description: "A scratch note per worktree, stored alongside the branch.",
  },
  {
    id: "acme.tokyo-night-extras",
    displayName: "Tokyo Night Extras",
    version: "0.2.0",
    description: "Extends the Tokyo Night colour scheme with additional token accents.",
    disabled: true,
  },
];

function writePlugin(dir: string, manifest: Record<string, unknown>, mainPath: string): void {
  mkdirSync(path.join(dir, path.dirname(mainPath)), { recursive: true });
  writeFileSync(path.join(dir, mainPath), STUB_MAIN);
  writeFileSync(path.join(dir, "plugin.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

function writeInstalled(fakeHome: string): {
  records: Record<string, unknown>;
  disabled: string[];
} {
  const root = path.join(fakeHome, ".daintree", "plugins");
  mkdirSync(root, { recursive: true });
  const records: Record<string, unknown> = {};
  const disabled: string[] = [];
  for (const fx of INSTALLED) {
    const manifest: Record<string, unknown> = {
      name: fx.id,
      version: fx.version,
      displayName: fx.displayName,
      description: fx.description,
      main: "main/index.js",
      engines: { daintree: ">=0.11.0" },
      capabilities: [],
    };
    if (fx.settings) manifest.contributes = { settings: fx.settings };
    writePlugin(path.join(root, fx.id), manifest, "main/index.js");
    records[fx.id] = {
      source: "catalog",
      installedAt: NOW - 10 * DAY,
      archiveHash: `sha256-${fx.id.length}`,
      originalUrl: null,
      disabled: !!fx.disabled,
      updateAvailable: null,
      devMode: false,
      loadError: null,
    };
    if (fx.disabled) disabled.push(fx.id);
  }
  return { records, disabled };
}

function git(cmd: string, cwd: string): void {
  execSync(`git ${cmd}`, { cwd, stdio: "ignore" });
}

function createRepo(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "daintree-projectplugins-shots-"));
  git("init -b main", dir);
  git('config user.email "test@daintree.dev"', dir);
  git('config user.name "Daintree Test"', dir);
  writeFileSync(path.join(dir, "README.md"), "# Helios Dashboard\n");
  git("remote add origin https://github.com/daintree-shot-fixture/helios-dashboard.git", dir);
  cpSync(PROJECT_PLUGIN_FIXTURE, path.join(dir, ".daintree"), { recursive: true });
  const plugins = path.join(dir, ".daintree", "plugins");
  writePlugin(path.join(plugins, DEPLOY_PREVIEW.name), DEPLOY_PREVIEW, "dist/index.js");
  writePlugin(path.join(plugins, MUTED_LINTER.name), MUTED_LINTER, "dist/index.js");
  writePlugin(path.join(plugins, COLLIDING.name), COLLIDING, "dist/index.js");
  // Unreadable: a manifest that fails the project schema.
  mkdirSync(path.join(plugins, "acme.broken-widget"), { recursive: true });
  writeFileSync(
    path.join(plugins, "acme.broken-widget", "plugin.json"),
    JSON.stringify({ name: "acme.broken-widget", version: "one", displayName: "Broken Widget" })
  );
  git("add -A", dir);
  git('commit -m "initial commit"', dir);
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

async function settle(page: Page, ms = 350): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
  );
  await page.waitForTimeout(ms);
}

async function setWindowSize(app: ElectronApplication, s: { width: number; height: number }) {
  await app.evaluate(({ BrowserWindow }, size) => {
    BrowserWindow.getAllWindows()[0]?.setSize(size.width, size.height);
  }, s);
}

async function openPluginsTab(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.dispatchEvent(
      new CustomEvent("daintree:open-settings-tab", { detail: { tab: "project:plugins" } })
    );
  });
  await page.locator(DIALOG).waitFor({ state: "visible", timeout: 20_000 });
  await page.locator(TRIGGER).waitFor({ state: "visible", timeout: 15_000 });
  await settle(page, 600);
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

/** Tag the element that scrolls the Plugins panel, and reset it to the top. */
async function tagScroller(page: Page): Promise<{ scrollHeight: number; clientHeight: number }> {
  return page.evaluate(() => {
    document
      .querySelectorAll("[data-shot-scroller]")
      .forEach((el) => el.removeAttribute("data-shot-scroller"));
    const panel = document.getElementById("settings-panel-project:plugins");
    if (!panel) throw new Error("no plugins panel");
    let el: HTMLElement | null = panel.parentElement;
    while (el) {
      const oy = getComputedStyle(el).overflowY;
      if ((oy === "auto" || oy === "scroll") && el.clientHeight > 0) break;
      el = el.parentElement;
    }
    if (!el) throw new Error("no scroll container above the plugins panel");
    el.setAttribute("data-shot-scroller", "");
    el.scrollTop = 0;
    return { scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
  });
}

interface ManifestEntry {
  file: string;
  step: string;
}
const manifest: ManifestEntry[] = [];
const failures: string[] = [];

async function shotCard(page: Page, step: string, name: string): Promise<void> {
  const file = `${name}--${THEME_SLUG}.png`;
  await page
    .locator(CARD)
    .first()
    .screenshot({ path: path.join(OUTPUT_DIR, file), type: "png", animations: "disabled" });
  manifest.push({ file, step });
}

/** The whole page, in viewport slices down the real scrollport. */
async function capturePage(page: Page, step: string, name: string, maxSlices = 4): Promise<void> {
  const { scrollHeight, clientHeight } = await tagScroller(page);
  await settle(page, 250);
  const stride = Math.max(200, Math.floor(clientHeight * 0.85));
  const total = Math.min(
    maxSlices,
    Math.max(1, Math.ceil((scrollHeight - clientHeight) / stride) + 1)
  );
  for (let i = 0; i < total; i++) {
    await page.evaluate((top) => {
      const el = document.querySelector<HTMLElement>("[data-shot-scroller]");
      if (el) el.scrollTop = top;
    }, i * stride);
    await settle(page, 200);
    await shotCard(page, step, total === 1 ? name : `${name}-p${i + 1}`);
  }
}

async function openPicker(page: Page): Promise<void> {
  if ((await page.locator(LIST).count()) === 0) {
    await page.locator(TRIGGER).click();
    await page.locator(LIST).waitFor({ state: "visible", timeout: 10_000 });
  }
  await settle(page, 300);
}

/** Pick a plugin by its visible name, and assert the pane that should follow. */
async function pick(page: Page, name: string | RegExp, paneTestId: string): Promise<void> {
  await openPicker(page);
  await page
    .locator(`${LIST} [role="option"]:not([aria-disabled="true"])`, { hasText: name })
    .first()
    .click();
  await page
    .locator(`${PANEL} [data-testid="${paneTestId}"]`)
    .waitFor({ state: "visible", timeout: 10_000 });
  await expect(page.locator(TRIGGER)).toContainText(name);
  await settle(page, 700);
}

async function pickOverview(page: Page): Promise<void> {
  await openPicker(page);
  await page.locator(`${LIST} [role="option"]`, { hasText: "This project" }).first().click();
  await page
    .locator(`${PANEL} [data-testid="project-plugins-overview"]`)
    .waitFor({ state: "visible", timeout: 10_000 });
  await settle(page, 500);
}

async function step(name: string, fn: () => Promise<void>): Promise<void> {
  if (ONLY.length > 0 && !ONLY.includes(name)) return;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const before = manifest.length;
    try {
      await fn();
      if (manifest.length === before) throw new Error("step produced no capture");
      return;
    } catch (error) {
      manifest.splice(before);
      await page_?.keyboard.press("Escape").catch(() => {});
      if (attempt === 2) failures.push(`${name}: ${String(error).slice(0, 400)}`);
    }
  }
}

let page_: Page | undefined;

async function projectPluginState(page: Page, id: string): Promise<string> {
  return page.evaluate(async (pluginId) => {
    const plugins = await window.electron.plugin.getProjectPlugins();
    return plugins.find((p) => p.id === pluginId)?.state ?? "missing";
  }, id);
}

test("project plugins review — every pane, lifecycle state and failure", async () => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_PROJECT_PLUGINS is required for the project-plugins capture",
  });
  test.skip(!ENABLED, "Set DAINTREE_SHOT_PROJECT_PLUGINS to run the project-plugins capture");
  if (!OUTPUT_DIR) throw new Error("DAINTREE_SHOT_DIR is required — captures never go in the repo");
  if (!existsSync(SAMPLE_PLUGINS_DIR)) {
    throw new Error(`Sample plugins missing at ${SAMPLE_PLUGINS_DIR} — run npm run build:e2e`);
  }
  mkdirSync(OUTPUT_DIR, { recursive: true });

  const repo = createRepo();
  // No "daintree-e2e" in the prefix: launchApp's hygiene pkill would match it.
  const userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-projectpluginsshot-"));
  const fakeHome = path.join(userDataDir, "home");
  mkdirSync(path.join(fakeHome, ".config"), { recursive: true });
  const { records, disabled } = writeInstalled(fakeHome);
  writeFileSync(
    path.join(userDataDir, "config.json"),
    `${JSON.stringify({ plugins: { installed: records, disabled } }, null, 2)}\n`
  );

  let ctx: AppContext | undefined;
  try {
    ctx = await launchApp({
      userDataDir,
      windowSize: WIDE,
      extraArgs: ["--disable-gpu", "--in-process-gpu", "--disable-breakpad", "--noerrdialogs"],
      env: {
        DAINTREE_E2E_SIDELOAD_PLUGIN_DIR: SAMPLE_PLUGINS_DIR,
        DAINTREE_E2E_FAULT_MODE: "1",
        HOME: fakeHome,
        XDG_CONFIG_HOME: path.join(fakeHome, ".config"),
      },
    });
    const app = ctx.app;
    await setWindowSize(app, WIDE);
    const page = await openAndOnboardProject(app, ctx.window, repo.dir, "Helios Dashboard");
    page_ = page;
    if (THEME) await setAppTheme(page, THEME);
    await page.addStyleTag({ content: POLISH_CSS });
    await dismissBlockingPalette(page);
    await settle(page, 800);

    // ── Folder not yet allowed ────────────────────────────────────────────
    await openPluginsTab(page);
    await step("untrusted", async () => {
      await expect(page.locator(PANEL)).toContainText("Not running");
      await capturePage(page, "untrusted", "10-overview-untrusted", 2);
    });
    await step("folderoff", async () => {
      await pick(page, "Deploy Preview", "project-plugin-detail");
      await expect(page.locator(PANEL)).toContainText("This project's plugins are turned off");
      await capturePage(page, "folderoff", "11-plugin-folder-off", 3);
      await pickOverview(page);
    });
    await closeSettings(page);

    // ── Allow the folder, then stage one and mute one ─────────────────────
    await expect
      .poll(
        async () => {
          await page.evaluate(() =>
            window.electron.plugin.setProjectPluginTrust("enabled").catch(() => {})
          );
          return projectPluginState(page, DEPLOY_PREVIEW.name);
        },
        { timeout: 30_000, intervals: [500, 1000, 2000] }
      )
      .toBe("active");
    writePlugin(path.join(repo.dir, ".daintree", "plugins", STAGED.name), STAGED, "dist/index.js");
    await expect
      .poll(
        async () => {
          await page.evaluate(() => window.electron.plugin.reloadProjectPlugins());
          return projectPluginState(page, STAGED.name);
        },
        { timeout: 30_000, intervals: [1000, 2000] }
      )
      .toBe("staged");
    await page.evaluate(
      (id) => window.electron.plugin.setProjectPluginMuted(id, true),
      MUTED_LINTER.name
    );
    // A stored snapshot path that no longer exists: the mustExist standing error.
    const instanceId = await page.evaluate(async (id) => {
      const plugins = await window.electron.plugin.getProjectPlugins();
      return plugins.find((p) => p.id === id)?.instanceId ?? null;
    }, DEPLOY_PREVIEW.name);
    const projectId = await page.evaluate(
      async () => (await window.electron.project.getCurrent())?.id ?? null
    );
    if (instanceId && projectId) {
      await page.evaluate(
        async ({ pid, proj }) => {
          await window.electron.plugin.setSettingValue(
            pid,
            "snapshotDir",
            "/Volumes/archive/helios/db-snapshots",
            "local",
            proj
          );
          await window.electron.plugin.setSettingValue(pid, "region", "eu-west", "project", proj);
          await window.electron.plugin.setSettingValue(
            pid,
            "apiToken",
            "tok_live_4f9a",
            "local",
            proj
          );
        },
        { pid: instanceId, proj: projectId }
      );
    } else {
      failures.push(`seed: no instance id (${instanceId}) or project id (${projectId})`);
    }
    await settle(page, 1200);

    await openPluginsTab(page);

    await step("overview", async () => {
      await expect(page.locator(PANEL)).toContainText("Allowed to run");
      await capturePage(page, "overview", "20-overview", 3);
    });

    await step("picker", async () => {
      await openPicker(page);
      await expect(page.locator(LIST)).toContainText("Installed");
      await shotCard(page, "picker", "21-picker-open");
      await page.locator(FILTER).fill("deploy");
      await settle(page, 300);
      await shotCard(page, "picker", "22-picker-filtered");
      await page.locator(FILTER).fill("zzzz");
      await settle(page, 300);
      await expect(page.locator(LIST)).toContainText("No plugins match");
      await shotCard(page, "picker", "23-picker-no-match");
      await page.keyboard.press("Escape");
      await settle(page, 300);
    });

    await step("running", async () => {
      await pick(page, "Deploy Preview", "project-plugin-detail");
      await expect(page.locator(PANEL)).toContainText("Environment name");
      await capturePage(page, "running", "30-running-settings", 5);
    });

    await step("fielderror", async () => {
      await pick(page, "Deploy Preview", "project-plugin-detail");
      const row = page.locator(`${PANEL} [id$="-ttlHours"]`).first();
      await row.scrollIntoViewIfNeeded();
      const input = row.locator("input").first();
      await input.fill("forty");
      await input.blur();
      await settle(page, 400);
      await expect(row).toContainText("Enter a valid number");
      await row.evaluate((el) => el.scrollIntoView({ block: "center" }));
      await settle(page, 200);
      await shotCard(page, "fielderror", "31-field-error");
      await input.fill("48");
      await input.blur();
      await settle(page, 300);
    });

    await step("staged", async () => {
      await pick(page, "Release Notes", "project-plugin-detail");
      await expect(page.locator(PANEL)).toContainText("Activate plugin");
      await capturePage(page, "staged", "40-staged", 3);
    });

    await step("muted", async () => {
      await pick(page, "Commit Linter", "project-plugin-detail");
      await capturePage(page, "muted", "41-muted", 3);
    });

    await step("invalid", async () => {
      await pick(page, /Broken Widget|acme\.broken-widget/, "project-plugin-detail");
      await capturePage(page, "invalid", "42-invalid", 2);
    });

    await step("collision", async () => {
      await pick(page, "Quick Notes (team fork)", "project-plugin-detail");
      await capturePage(page, "collision", "43-collision", 2);
    });

    await step("installed", async () => {
      await pick(page, "Markdown Studio", "installed-plugin-detail");
      await capturePage(page, "installed", "50-installed", 3);
    });

    await step("installedoff", async () => {
      await pick(page, "Tokyo Night Extras", "installed-plugin-detail");
      await capturePage(page, "installedoff", "51-installed-disabled", 2);
    });

    await step("forge", async () => {
      await pick(page, "GitHub", "installed-plugin-detail");
      await capturePage(page, "forge", "52-installed-forge", 2);
    });

    await step("rich", async () => {
      await pick(page, "Rich Daintree", "installed-plugin-detail");
      await capturePage(page, "rich", "53-installed-rich", 2);
    });

    // An action that fails: main refuses the mute, the store reports it.
    await step("actionerror", async () => {
      await pick(page, "Deploy Preview", "project-plugin-detail");
      await injectFault(
        app,
        "plugin:project-set-muted",
        "EACCES: permission denied, open '.daintree/plugin-state.json'"
      );
      await page.locator(`${PANEL} [data-testid="project-plugin-mute-switch"]`).click();
      await settle(page, 800);
      await expect(page.locator(`${PANEL} [role="alert"]`).first()).toBeVisible();
      await capturePage(page, "actionerror", "60-action-error", 1);
      await clearAllFaults(app);
    });

    // The installed list can't be read: the picker keeps what it had.
    await step("listerror", async () => {
      await injectFault(app, "plugin:list", "Plugin host is restarting");
      await page.evaluate(() => window.electron.plugin.reloadProjectPlugins());
      await expect(page.locator(PANEL)).toContainText(
        /Couldn't (read|refresh) your installed plugins/,
        {
          timeout: 10_000,
        }
      );
      await settle(page, 400);
      await capturePage(page, "listerror", "61-list-error", 1);
      await clearAllFaults(app);
    });

    await step("focus", async () => {
      await closeSettings(page);
      await openPluginsTab(page);
      await page.locator(TRIGGER).focus();
      await page.keyboard.press("Shift+Tab");
      await page.keyboard.press("Tab");
      await settle(page, 200);
      await shotCard(page, "focus", "70-focus-trigger");
    });

    await closeSettings(page);
  } finally {
    if (ctx) await closeApp(ctx.app).catch(() => {});
    repo.cleanup();
    rmSync(userDataDir, { recursive: true, force: true });
  }

  writeFileSync(
    path.join(OUTPUT_DIR, `manifest-${THEME_SLUG}.json`),
    JSON.stringify(manifest, null, 2)
  );
  const onDisk = new Set(readdirSync(OUTPUT_DIR).filter((f) => f.endsWith(".png")));
  const missing = manifest.filter((m) => !onDisk.has(m.file)).map((m) => m.file);
  console.log(
    `[project-plugins-shots] ${manifest.length - missing.length}/${manifest.length} PNGs → ${OUTPUT_DIR}`
  );
  if (missing.length > 0) failures.push(`missing on disk: ${missing.join(", ")}`);
  if (failures.length > 0)
    throw new Error(`project-plugins capture failed:\n  ${failures.join("\n  ")}`);
});
