/**
 * Plugin manager visual-review harness.
 *
 * `PluginManagerView` is the app's whole plugin surface: a master-detail
 * catalogue reached from the Daintree menu (macOS) / File menu (Windows,
 * Linux). It has to answer several questions at once — what is installed, where
 * each plugin came from, whether it is on, what it is allowed to do, and which
 * of them need something from me — across four provenance kinds that look
 * similar in the JSX and very different on screen:
 *
 *   built-in   ships in `dist-electron/plugins/builtin`; cannot be uninstalled.
 *   installed  a `.dntr` unpacked into `~/.daintree/plugins`, with an
 *              `InstalledPluginRecord` carrying its source, timestamps and
 *              update state.
 *   dev mode   a directory loaded through the `daintree-plugin dev` CLI.
 *   project    shipped in the repo under `.daintree/plugins`, gated behind a
 *              per-folder trust decision rather than a per-plugin switch.
 *
 * The fixtures are real, and they arrive through the seams the product itself
 * writes through:
 *
 *   - installed plugins are real directories with real manifests, written into
 *     a fake `HOME` this harness owns. `PluginService` resolves its plugins root
 *     as `os.homedir() + "/.daintree/plugins"` with NO E2E override, so `HOME`
 *     is the only seam that redirects it — and redirecting it is mandatory, not
 *     cosmetic: without it this spec would read, and an install step would
 *     write, the running developer's own plugin directory. Precedent for the
 *     `HOME` redirect is `git-init-review.spec.ts`.
 *   - provenance, install/update timestamps, dev-mode, update-available and
 *     load-error state come from `plugins.installed` in the app's own
 *     electron-store `config.json`, seeded in the userData dir before launch.
 *     That is exactly the record `PluginInstalledRecordsStore` reads, so the
 *     rows render what they render in the app rather than what a mock says.
 *   - built-ins are the real `github` and `gitlab` forge plugins, and the
 *     capability/settings-rich samples arrive through the existing
 *     `DAINTREE_E2E_SIDELOAD_PLUGIN_DIR` backdoor.
 *   - the project-plugin section comes from a real `.daintree/plugins` tree
 *     copied into the fixture repo, so the trust gate is the real one.
 *
 * The fixture list is deliberately hostile in the places this screen is known
 * to break: a plugin with no `tagline` (only the two forge built-ins set one,
 * so the bare-row case is the COMMON case, not an edge case), a long display
 * name, a prerelease-and-build semver, a long tagline, a disabled plugin, one
 * that failed to load, and one carrying an available update.
 *
 * Steps:
 *   landing        the surface as it opens — no selection, catalogue in detail.
 *   list           tight crop of the master column: row rhythm, badges,
 *                  provenance, and the ragged second line.
 *   builtin        a built-in selected (has a tagline) — the good case.
 *   notagline      an installed plugin with no tagline — the common case.
 *   permissions    the Permissions tab, capability severities and scopes.
 *   settings       the generated settings form.
 *   disabled       a disabled row and its detail header.
 *   dev            a dev-mode plugin, generation badge and hot-reload state.
 *   failed         a plugin whose load errored while still reading "enabled".
 *   hostile        long name + long version + long tagline, list and detail.
 *   update         a plugin with an update available.
 *   search         an active free-text query (list flattens, headers drop).
 *   chip           a category chip filter active.
 *   empty          a query that matches nothing.
 *   project        the project-plugin section and its trust gate.
 *   urldialog      the Install from URL dialog.
 *   uninstall      the uninstall confirm, with its delete-settings checkbox.
 *   focus          keyboard focus ring on the first row.
 *   contrast       prefers-contrast: more.
 *   forced         forced-colors: active.
 *
 * Opt-in only: skips itself unless DAINTREE_SHOT_PLUGINMGR is set, so the
 * marketing screenshots workflow never runs it.
 *
 *   DAINTREE_SHOT_PLUGINMGR=1 npx playwright test --project=screenshots plugin-manager-review
 *
 * Env knobs:
 *   DAINTREE_SHOT_PLUGINMGR  required — any truthy value runs the capture
 *   DAINTREE_SHOT_THEME      optional theme id (default: the app default)
 *   DAINTREE_SHOT_TAG        optional suffix so rounds sit side by side
 *   DAINTREE_SHOT_ONLY       comma-separated step filter (see step names above)
 *   DAINTREE_SHOT_OUT        optional absolute output dir (default: artifacts/…)
 *
 * Output: artifacts/plugin-manager-shots/<NN-slug>[-tag].png (gitignored).
 */

import { test, expect, type Page } from "@playwright/test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync, cpSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { openAndOnboardProject } from "../helpers/project";
import { dismissBlockingPalette } from "../helpers/overlays";
import { createFixtureRepo } from "../helpers/fixtures";
import { setAppTheme } from "../helpers/theme";
import { T_LONG, T_MEDIUM } from "../helpers/timeouts";

const ROOT = path.resolve(import.meta.dirname, "../..");
const SAMPLE_PLUGINS_DIR = path.join(ROOT, "dist-electron/plugins/sample");
const PROJECT_PLUGIN_FIXTURE = path.join(ROOT, "plugins/fixtures/project-local/.daintree");

const RUN = process.env.DAINTREE_SHOT_PLUGINMGR ?? "";
const THEME = process.env.DAINTREE_SHOT_THEME ?? "";
const TAG = process.env.DAINTREE_SHOT_TAG ? `-${process.env.DAINTREE_SHOT_TAG}` : "";
const OUTPUT_DIR =
  process.env.DAINTREE_SHOT_OUT ?? path.join(ROOT, "artifacts/plugin-manager-shots");

const MANAGER = '[data-testid="plugin-manager-view"]';
const LIST = '[data-testid="plugin-list"]';
const SEARCH = '[aria-label="Search plugins"]';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();

/**
 * One installed-plugin fixture: the on-disk manifest plus the provenance record
 * the app persists for it. Kept together so a row's rendered state is readable
 * from a single object rather than assembled from two places.
 */
interface InstalledFixture {
  /** Directory name AND manifest name — `loadFromDir` treats the dir as the id. */
  id: string;
  displayName: string;
  version: string;
  description: string;
  tagline?: string;
  capabilities?: string[];
  scopes?: Record<string, unknown>;
  settings?: boolean;
  /**
   * Write a `.dev-marker` into the plugin dir. That file — not the record's
   * `devMode` flag — is what arms dev mode: `PluginService` reads the marker at
   * load and actively CLEARS a record `devMode` that has no marker behind it,
   * so seeding the record alone renders an ordinary row.
   */
  devMarker?: boolean;
  record: {
    source: "sideload" | "url" | "catalog";
    installedAt: number;
    updatedAt?: number;
    archiveHash: string | null;
    originalUrl: string | null;
    disabled: boolean;
    updateAvailable: { version: string; url?: string } | null;
    devMode: boolean;
    loadError: { message: string; stack?: string; at: number } | null;
  };
}

/**
 * The catalogue this harness renders. Ordering here is irrelevant — the view
 * groups by category — but the SPREAD matters: every row property that changes
 * the rendering is exercised by at least one entry, and the no-tagline case is
 * over-represented on purpose because that is its real-world frequency.
 */
const INSTALLED: InstalledFixture[] = [
  {
    id: "acme.markdown-studio",
    displayName: "Markdown Studio",
    version: "1.4.2",
    tagline: "Live preview, outline, and export for Markdown files",
    description:
      "Adds a live Markdown preview panel with a synced outline, footnote support, and one-click export to HTML or PDF.",
    capabilities: ["fs:project-read", "fs:project-write"],
    settings: true,
    record: {
      source: "sideload",
      installedAt: NOW - 3 * DAY,
      archiveHash: "sha256-11ab",
      originalUrl: null,
      disabled: false,
      updateAvailable: null,
      devMode: false,
      loadError: null,
    },
  },
  {
    id: "justinpriday.docker-control",
    displayName: "Docker Control",
    version: "1.0.7",
    // No tagline — the common case, and the one that leaves the row's second
    // line empty even though `description` is right there.
    description:
      "Start, stop, and inspect Docker containers from inside Daintree, with log tailing and a compose-aware project view.",
    capabilities: ["socket:connect", "network:fetch"],
    scopes: {
      socket: { allowedPaths: ["/var/run/docker.sock"] },
      network: { allowedUrls: ["https://registry.hub.docker.com"] },
    },
    record: {
      source: "url",
      installedAt: NOW - 41 * DAY,
      updatedAt: NOW - 6 * DAY,
      archiveHash: "sha256-22cd",
      originalUrl: "https://plugins.example.com/docker-control-1.0.7.dntr",
      disabled: false,
      updateAvailable: { version: "2.1.0" },
      devMode: false,
      loadError: null,
    },
  },
  {
    id: "acme.quick-notes",
    displayName: "Quick Notes",
    version: "0.3.1",
    description: "A scratch note per worktree, stored alongside the branch.",
    record: {
      source: "catalog",
      installedAt: NOW - 12 * DAY,
      archiveHash: "sha256-33ef",
      originalUrl: null,
      disabled: false,
      updateAvailable: null,
      devMode: false,
      loadError: null,
    },
  },
  {
    id: "acme.tokyo-night-extras",
    displayName: "Tokyo Night Extras",
    version: "0.2.0",
    tagline: "Extra syntax accents for the Tokyo Night palette",
    description: "Extends the Tokyo Night colour scheme with additional token accents.",
    record: {
      source: "catalog",
      installedAt: NOW - 60 * DAY,
      archiveHash: "sha256-44aa",
      originalUrl: null,
      // Disabled by the user — must be tellable apart from "failed" and
      // "blocked" at a glance.
      disabled: true,
      updateAvailable: null,
      devMode: false,
      loadError: null,
    },
  },
  {
    id: "acme.scratchpad-widget",
    displayName: "Scratchpad Widget",
    version: "0.0.9",
    tagline: "Work in progress — loaded from disk",
    description: "A scratchpad panel, under active development.",
    capabilities: ["fs:project-read"],
    devMarker: true,
    record: {
      source: "sideload",
      installedAt: NOW - 2 * 60 * 60 * 1000,
      archiveHash: null,
      originalUrl: null,
      disabled: false,
      updateAvailable: null,
      devMode: true,
      loadError: null,
    },
  },
  {
    id: "acme.telemetry-probe",
    displayName: "Telemetry Probe",
    version: "1.2.0",
    tagline: "Collects build and test timings",
    description: "Records build and test durations and charts them per branch.",
    capabilities: ["network:fetch"],
    record: {
      source: "url",
      installedAt: NOW - 20 * DAY,
      archiveHash: "sha256-55bb",
      originalUrl: "https://plugins.example.com/telemetry-probe.dntr",
      disabled: false,
      updateAvailable: null,
      devMode: false,
      // Failed to load, but the user's `disabled` flag is false — the state the
      // switch is most likely to misrepresent.
      loadError: {
        message: "Cannot find module 'node:sqlite' imported from main/index.js",
        at: NOW - 60 * 1000,
      },
    },
  },
  {
    id: "acme.enterprise-compliance-toolkit",
    displayName: "Enterprise Compliance & Audit Reporting Toolkit for Regulated Environments",
    version: "2.4.1-alpha.0+build.3918",
    // Exactly at the schema's 120-character tagline ceiling: the longest
    // second line a manifest can legally produce. `displayName` above has NO
    // schema maximum, so it is the genuinely unbounded one.
    tagline:
      "Continuous compliance evidence collection, control mapping, and audit-ready reporting for every repository",
    description:
      "Collects compliance evidence continuously, maps it onto your control framework, and produces audit-ready reports for every repository in the workspace.",
    capabilities: ["fs:project-read", "fs:user-data-read", "network:fetch"],
    scopes: { network: { allowedUrls: ["https://compliance.example.com/api/v2/evidence"] } },
    record: {
      source: "url",
      installedAt: NOW - 9 * DAY,
      archiveHash: "sha256-66cc",
      originalUrl: "https://compliance.example.com/dist/toolkit-2.4.1-alpha.0.dntr",
      disabled: false,
      updateAvailable: null,
      devMode: false,
      loadError: null,
    },
  },
  {
    id: "acme.ci-watcher",
    displayName: "CI Watcher",
    version: "3.0.0",
    description: "Watches CI runs for the current branch and surfaces failures inline.",
    capabilities: ["network:fetch"],
    scopes: { network: { allowedUrls: ["https://api.github.com"] } },
    record: {
      source: "url",
      installedAt: NOW - 5 * DAY,
      archiveHash: "sha256-77dd",
      originalUrl: "https://plugins.example.com/ci-watcher.dntr",
      disabled: false,
      updateAvailable: null,
      devMode: false,
      loadError: null,
    },
  },
];

/** A trivial, valid ESM entry point. Never executed — discovery only reads the manifest. */
const STUB_MAIN = `export async function activate() {}\nexport async function deactivate() {}\n`;

/**
 * Write the installed-plugin fixtures into the fake home and return the
 * `plugins.installed` record map to seed into the store.
 */
function writeInstalledPlugins(fakeHome: string): Record<string, InstalledFixture["record"]> {
  const pluginsRoot = path.join(fakeHome, ".daintree", "plugins");
  mkdirSync(pluginsRoot, { recursive: true });

  const records: Record<string, InstalledFixture["record"]> = {};
  for (const fixture of INSTALLED) {
    const dir = path.join(pluginsRoot, fixture.id);
    mkdirSync(path.join(dir, "main"), { recursive: true });
    writeFileSync(path.join(dir, "main", "index.js"), STUB_MAIN);

    const manifest: Record<string, unknown> = {
      name: fixture.id,
      version: fixture.version,
      displayName: fixture.displayName,
      description: fixture.description,
      main: "main/index.js",
      engines: { daintree: ">=0.11.0" },
      capabilities: fixture.capabilities ?? [],
    };
    if (fixture.tagline) manifest.tagline = fixture.tagline;
    if (fixture.scopes) manifest.scopes = fixture.scopes;
    if (fixture.settings) {
      manifest.contributes = {
        settings: [
          {
            id: "previewTheme",
            type: "enum",
            label: "Preview theme",
            options: ["github", "minimal", "academic"],
            default: "github",
          },
          {
            id: "syncScroll",
            type: "boolean",
            label: "Sync scrolling",
            description: "Keep the preview aligned with the editor.",
            default: true,
          },
        ],
      };
    }
    writeFileSync(path.join(dir, "plugin.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    if (fixture.devMarker) writeFileSync(path.join(dir, ".dev-marker"), "");
    records[fixture.id] = fixture.record;
  }
  return records;
}

/**
 * Seed the app's electron-store before first launch. `plugins.installed` is the
 * provenance map `PluginInstalledRecordsStore` reads; `plugins.disabled` is the
 * separate id list that actually drives the switch.
 */
function seedStore(
  userDataDir: string,
  records: Record<string, InstalledFixture["record"]>,
  projectDir: string
): void {
  const disabled = Object.entries(records)
    .filter(([, record]) => record.disabled)
    .map(([id]) => id);

  writeFileSync(
    path.join(userDataDir, "config.json"),
    `${JSON.stringify(
      {
        plugins: { installed: records, disabled },
        // Trust the fixture repo's plugin folder so the project section renders
        // its loaded state rather than parking on the trust prompt.
        projectPluginTrust: { [projectDir]: "trusted" },
      },
      null,
      2
    )}\n`
  );
}

async function settle(page: Page, ms = 600): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
  );
  await page.waitForTimeout(ms);
}

const produced: string[] = [];

async function snap(page: Page, slug: string, locator?: string): Promise<void> {
  await settle(page);
  const file = path.join(OUTPUT_DIR, `${slug}${TAG}.png`);
  if (locator) {
    await page.locator(locator).first().screenshot({ path: file, type: "png" });
  } else {
    await page.screenshot({ path: file, type: "png", animations: "disabled", caret: "hide" });
  }
  // Verify AFTER the write rather than trusting it: a harness that reports a
  // shot it did not produce is worse than one that fails loudly.
  if (!existsSync(file)) throw new Error(`snapshot not written: ${file}`);
  produced.push(path.basename(file));
}

const ONLY = (process.env.DAINTREE_SHOT_ONLY ?? "").split(",").filter(Boolean);
const attempted: string[] = [];
const failed: string[] = [];

/** Run a capture step; failures are logged, not fatal — later shots still run. */
async function step(name: string, fn: () => Promise<void>): Promise<void> {
  if (ONLY.length > 0 && !ONLY.includes(name)) return;
  attempted.push(name);
  try {
    await fn();
  } catch (error) {
    failed.push(name);
    console.warn(`[plugin-manager-shots] step "${name}" failed:`, String(error).slice(0, 300));
  }
}

/**
 * Select a plugin row by its visible label and wait for the detail pane to swap.
 *
 * Idempotent on purpose: clicking an ALREADY-selected row clears the selection
 * (the row's handler toggles), so a blind click made a step's outcome depend on
 * what the previous step happened to leave selected.
 */
async function select(page: Page, label: string): Promise<void> {
  const row = page.locator(`${LIST} li`, { hasText: label }).first();
  await row.scrollIntoViewIfNeeded();
  const button = row.locator("button").first();
  if ((await button.getAttribute("aria-current")) === "true") return;
  await button.click();
  await settle(page, 400);
}

/** Open a detail-pane tab by label, waiting for it to exist first. */
async function openTab(page: Page, label: string): Promise<void> {
  const tab = page.locator('[role="tab"]', { hasText: label }).first();
  await tab.waitFor({ state: "visible", timeout: T_MEDIUM });
  await tab.click();
  await settle(page, 300);
}

/** Clear the search box back to the unfiltered list. */
async function clearSearch(page: Page): Promise<void> {
  await page.locator(SEARCH).fill("");
  await settle(page, 300);
}

test("plugin manager review — provenance, states, and overflow", async () => {
  test.info().annotations.push({
    type: "conditional-skip",
    description: "DAINTREE_SHOT_PLUGINMGR is required for the plugin-manager capture",
  });
  test.skip(!RUN, "Set DAINTREE_SHOT_PLUGINMGR to run the plugin-manager capture");

  mkdirSync(OUTPUT_DIR, { recursive: true });

  const fixtureRoot = mkdtempSync(path.join(tmpdir(), "daintree-pluginmgr-fixtures-"));
  // A prefix that does NOT contain "daintree-e2e": launchApp's pre-launch
  // hygiene pkills `node_modules/electron.*daintree-e2e`, which would SIGKILL a
  // concurrent capture session mid-launch.
  const userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-pluginmgrshot-"));

  const fakeHome = path.join(fixtureRoot, "home");
  mkdirSync(path.join(fakeHome, ".config"), { recursive: true });
  const records = writeInstalledPlugins(fakeHome);

  const repo = createFixtureRepo({ name: "plugin-manager-review" });
  // Real project-local plugin tree, so the project section and its trust gate
  // are the product's, not a mock's.
  if (existsSync(PROJECT_PLUGIN_FIXTURE)) {
    cpSync(PROJECT_PLUGIN_FIXTURE, path.join(repo.dir, ".daintree"), { recursive: true });
  }
  seedStore(userDataDir, records, repo.dir);

  if (!existsSync(SAMPLE_PLUGINS_DIR)) {
    throw new Error(
      `Sample plugins missing at ${SAMPLE_PLUGINS_DIR} — run \`npm run build:e2e\` before capturing.`
    );
  }

  let ctx: AppContext | undefined;
  try {
    ctx = await launchApp({
      userDataDir,
      env: {
        DAINTREE_E2E_SIDELOAD_PLUGIN_DIR: SAMPLE_PLUGINS_DIR,
        HOME: fakeHome,
        XDG_CONFIG_HOME: path.join(fakeHome, ".config"),
      },
    });
    let page = ctx.window;
    page = await openAndOnboardProject(ctx.app, page, repo.dir, "plugin-manager-review");
    await dismissBlockingPalette(page);

    if (THEME) {
      await setAppTheme(page, THEME);
      await dismissBlockingPalette(page);
    }
    await settle(page, 1500);

    const open = async (): Promise<void> => {
      await page.evaluate(() =>
        window.dispatchEvent(new CustomEvent("daintree:open-plugin-manager"))
      );
      await expect(page.locator(MANAGER)).toBeVisible({ timeout: T_MEDIUM });
      await settle(page, 800);
    };
    await open();
    await expect(page.locator(LIST)).toBeVisible({ timeout: T_LONG });

    // 1. The surface as it opens: nothing selected, catalogue in the detail pane.
    await step("landing", () => snap(page, "10-landing"));

    // 2. Tight crop of the master column — row rhythm, badges, second-line ragging.
    await step("list", () => snap(page, "11-list", LIST));

    // 2b. The same column scrolled to the third-party rows, where taglines are
    //     mostly absent and row heights go ragged.
    await step("listbottom", async () => {
      await page.locator(LIST).evaluate((el) => {
        el.scrollTop = el.scrollHeight;
      });
      await settle(page, 400);
      await snap(page, "12-list-scrolled", LIST);
      await page.locator(LIST).evaluate((el) => {
        el.scrollTop = 0;
      });
      await settle(page, 300);
    });

    // 3. A built-in with a tagline: the row design's good case.
    await step("builtin", async () => {
      await select(page, "GitHub");
      await snap(page, "20-builtin-selected");
    });

    // 4. An installed plugin with no tagline: the common case.
    await step("notagline", async () => {
      await select(page, "Docker Control");
      await snap(page, "21-no-tagline");
    });

    // 5. Capabilities, their severities, and their concrete scopes.
    await step("permissions", async () => {
      await select(page, "Docker Control");
      await openTab(page, "Permissions");
      await snap(page, "30-permissions");
    });

    // 6. The generated settings form.
    await step("settings", async () => {
      await select(page, "Markdown Studio");
      await openTab(page, "Settings");
      await snap(page, "31-settings");
    });

    // 7. Disabled by the user.
    await step("disabled", async () => {
      await select(page, "Tokyo Night Extras");
      await snap(page, "40-disabled");
    });

    // 8. Dev mode: generation badge and hot-reload state.
    await step("dev", async () => {
      await select(page, "Scratchpad Widget");
      await snap(page, "41-dev-mode");
    });

    // 9. Load failure while the user's own disabled flag is false.
    await step("failed", async () => {
      await select(page, "Telemetry Probe");
      await snap(page, "42-load-failed");
    });

    // 10. Hostile lengths, in the list and in the detail header.
    await step("hostile", async () => {
      await select(page, "Enterprise Compliance");
      await snap(page, "50-hostile-detail");
      await snap(page, "51-hostile-list", LIST);
    });

    // 11. An update is available.
    await step("update", async () => {
      await select(page, "Docker Control");
      await snap(page, "52-update-available");
    });

    // 12. Free-text query: the list flattens and category headers drop.
    await step("search", async () => {
      await page.locator(SEARCH).fill("git");
      await settle(page, 400);
      await snap(page, "60-search");
      await snap(page, "61-search-list", LIST);
      await clearSearch(page);
    });

    // 13. A category chip filter.
    await step("chip", async () => {
      const chip = page.locator(`${MANAGER} button[aria-pressed]`).first();
      await chip.click();
      await settle(page, 400);
      await snap(page, "62-chip-active");
      await chip.click();
      await settle(page, 300);
    });

    // 14. A query that matches nothing.
    await step("empty", async () => {
      await page.locator(SEARCH).fill("zzzznothing");
      await settle(page, 400);
      await snap(page, "63-no-matches");
      await clearSearch(page);
    });

    // 15. The project-plugin section.
    await step("project", async () => {
      await snap(page, "70-project-section", LIST);
      await select(page, "Project Hello");
      await snap(page, "71-project-detail");
    });

    // 16. Install from URL.
    await step("urldialog", async () => {
      await page.locator(`${MANAGER} button`, { hasText: "Install from URL" }).first().click();
      await settle(page, 400);
      await snap(page, "80-install-url-dialog");
      await page.keyboard.press("Escape");
      await settle(page, 300);
    });

    // 17. Uninstall confirm, including its delete-settings checkbox.
    await step("uninstall", async () => {
      await select(page, "Quick Notes");
      await page.locator('[aria-label*="Uninstall" i]').first().click();
      await settle(page, 400);
      await snap(page, "81-uninstall-confirm");
      await page.keyboard.press("Escape");
      await settle(page, 300);
    });

    // 18. Keyboard focus ring on the first row — and, by extension, how many tab
    //     stops the master column costs before the detail pane is reachable.
    await step("focus", async () => {
      await page.locator(SEARCH).focus();
      await page.keyboard.press("Tab");
      await page.keyboard.press("Tab");
      await snap(page, "90-focus-row");
    });

    // 19. prefers-contrast: more.
    await step("contrast", async () => {
      await page.emulateMedia({ contrast: "more" }).catch(() => {});
      await settle(page, 400);
      await snap(page, "95-prefers-contrast-more");
      await snap(page, "96-prefers-contrast-list", LIST);
      await page.emulateMedia({ contrast: "no-preference" }).catch(() => {});
      await settle(page, 300);
    });

    // 20. forced-colors: active — where ring-based badge cut-outs vanish.
    await step("forced", async () => {
      await page.emulateMedia({ forcedColors: "active" }).catch(() => {});
      await settle(page, 400);
      await snap(page, "97-forced-colors");
      await snap(page, "98-forced-colors-list", LIST);
      await page.emulateMedia({ forcedColors: "none" }).catch(() => {});
      await settle(page, 300);
    });

    // Count the artifacts rather than trusting the exit code. A step that threw
    // has already been logged; this makes a silently empty run impossible to
    // mistake for a successful one.
    const onDisk = readdirSync(OUTPUT_DIR).filter(
      (f) => f.endsWith(".png") && (TAG ? f.includes(TAG) : true)
    );
    console.log(
      `[plugin-manager-shots] ${produced.length} shot(s) written from ${attempted.length} step(s); ${onDisk.length} png(s) in ${OUTPUT_DIR}`
    );
    if (failed.length > 0) {
      console.warn(`[plugin-manager-shots] steps that failed: ${failed.join(", ")}`);
    }
    if (produced.length === 0) {
      throw new Error("plugin-manager capture produced no screenshots");
    }
  } finally {
    if (ctx) await closeApp(ctx);
    repo.cleanup();
    rmSync(fixtureRoot, { recursive: true, force: true });
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
