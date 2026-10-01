import { test, expect, type Page } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { closeApp, type AppContext } from "../../helpers/launch";
import { dispatchAction } from "../../helpers/actions";
import { SEL } from "../../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_LONG } from "../../helpers/timeouts";
import {
  launchWithSamplePlugin,
  openPluginManager,
  closePluginManager,
  waitForRichPluginReady,
  getPluginToolbarButtonIds,
  RICH_PLUGIN_LABEL,
  SAMPLE_PLUGIN_LABEL,
} from "../../helpers/plugins";

/**
 * Every spec that drives the sideloaded `hello-daintree` and `rich-daintree`
 * samples shares one launch here: the setup is identical (onboard a bare repo,
 * activate both plugins), so paying it once per former spec bought nothing.
 *
 * Top-level mode is default rather than serial, so a failure relaunches for the
 * remaining groups instead of skipping them. Groups that mutate plugin state run
 * last and restore it: settings and storage clean up their keys, panels
 * re-enables `daintree.rich`, and enable/disable leaves `daintree.hello` on.
 */

const RICH_PLUGIN_ID = "daintree.rich";
const RESTART_REQUIRED = "Restart required to apply plugin changes";
const DANGER_BANNER = "Requests sensitive permissions — review before enabling";
const RICH_SETTING_KEYS = ["greeting", "retries", "verbose", "level", "config", "apiKey"];

let ctx: AppContext;
let fixtureCleanup: (() => void) | undefined;

/**
 * Select a plugin in the manager list. Clicking an already-selected row
 * deselects it, and the selection outlives the overlay closing, so only click
 * when the row is not already current.
 */
async function selectPluginRow(page: Page, label: string): Promise<void> {
  const option = page.locator(SEL.plugin.option).filter({ hasText: label }).first();
  await expect(option).toBeVisible({ timeout: T_MEDIUM });
  const select = option.locator("button").first();
  if ((await select.getAttribute("aria-current")) !== "true") {
    await select.click();
  }
}

async function userSettingValues(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(async (pluginId) => {
    const res = await window.electron.plugin.getSettingValues(pluginId, "user", null);
    return res.values;
  }, RICH_PLUGIN_ID);
}

async function userSecretsSet(page: Page): Promise<string[]> {
  return page.evaluate(async (pluginId) => {
    const res = await window.electron.plugin.getSettingValues(pluginId, "user", null);
    return res.secretsSet;
  }, RICH_PLUGIN_ID);
}

/** The at-rest tier a secret write would use on this host right now. */
async function userSecretTier(page: Page): Promise<string> {
  return page.evaluate(async (pluginId) => {
    const res = await window.electron.plugin.getSettingValues(pluginId, "user", null);
    return res.secretTier;
  }, RICH_PLUGIN_ID);
}

async function resetUserSettings(page: Page): Promise<void> {
  await page.evaluate(
    async ({ pluginId, keys }) => {
      await Promise.all(
        keys.map((key) => window.electron.plugin.deleteSettingValue(pluginId, key, "user", null))
      );
    },
    { pluginId: RICH_PLUGIN_ID, keys: RICH_SETTING_KEYS }
  );
}

/** Open the manager, select the rich plugin, and switch to its Settings tab. */
async function openRichSettings(page: Page): Promise<void> {
  await openPluginManager(page);
  await selectPluginRow(page, RICH_PLUGIN_LABEL);
  const settingsTab = page.locator(SEL.plugin.tabSettings);
  await expect(settingsTab).toBeVisible({ timeout: T_MEDIUM });
  await settingsTab.click();
  await expect(settingsTab).toHaveAttribute("aria-selected", "true");
}

async function setPluginEnabled(page: Page, pluginId: string, enabled: boolean): Promise<void> {
  await page.evaluate(
    async (payload) => window.electron.plugin.setEnabled(payload.pluginId, payload.enabled),
    { pluginId, enabled }
  );
}

test.beforeAll(async () => {
  const { ctx: launched, cleanup } = await launchWithSamplePlugin("plugin-sample-host");
  ctx = launched;
  fixtureCleanup = cleanup;
  await waitForRichPluginReady(ctx.app, ctx.window);
});

test.afterAll(async () => {
  if (ctx?.app) await closeApp(ctx.app);
  fixtureCleanup?.();
});

// #9558. hello-daintree declares no capabilities, settings or category; its
// contributed skill derives the "AI & agents" category.
test.describe("plugin manager view", () => {
  test("opens the manager and lists the sample plugin under its category", async () => {
    const { window } = ctx;
    await openPluginManager(window);

    // Categories are real headings over real lists, with a trailing count.
    const list = window.locator(SEL.plugin.list);
    await expect(list.getByRole("heading", { name: /^AI & agents\b/ })).toBeVisible({
      timeout: T_MEDIUM,
    });
    const sampleRow = window.locator(SEL.plugin.option).filter({ hasText: SAMPLE_PLUGIN_LABEL });
    await expect(sampleRow).toBeVisible({ timeout: T_MEDIUM });

    // Disabled plugins dim in place with a badge rather than moving section.
    await expect(sampleRow.getByText("Disabled", { exact: true })).toHaveCount(0);

    await closePluginManager(window);
  });

  test("selecting a plugin fills the detail pane and switches tabs", async () => {
    const { window } = ctx;
    await openPluginManager(window);
    await selectPluginRow(window, SAMPLE_PLUGIN_LABEL);

    // Scoped to the detail header: the list row also renders "v0.1.0", which
    // would satisfy a page-wide match without the detail pane populating.
    await expect(window.locator(SEL.plugin.tabOverview)).toHaveAttribute("aria-selected", "true");
    const detailHeading = window.getByRole("heading", { name: SAMPLE_PLUGIN_LABEL });
    await expect(detailHeading).toBeVisible({ timeout: T_MEDIUM });
    await expect(detailHeading.locator("..").getByText("v0.1.0")).toBeVisible();

    // No capabilities and no settings earn no tabs beyond Overview (#11302).
    await expect(window.locator(SEL.plugin.tabPermissions)).toHaveCount(0, { timeout: T_SHORT });
    await expect(window.locator(SEL.plugin.tabSettings)).toHaveCount(0);

    await closePluginManager(window);
  });

  test("the back button dismisses the overlay", async () => {
    const { window } = ctx;
    await openPluginManager(window);

    await window.locator(SEL.plugin.back).click();
    await expect(window.locator(SEL.plugin.manager)).not.toBeVisible({ timeout: T_SHORT });
  });
});

// #9592. rich-daintree declares fs:project-read, fs:project-write (which
// elevates the plugin to "confirm") and a scoped network:fetch.
test.describe("plugin permissions tab", () => {
  test("shows the danger summary and capability rows for a capability-rich plugin", async () => {
    const { window } = ctx;
    await openPluginManager(window);
    await selectPluginRow(window, RICH_PLUGIN_LABEL);

    await window.locator(SEL.plugin.tabPermissions).click();
    await expect(window.locator(SEL.plugin.tabPermissions)).toHaveAttribute(
      "aria-selected",
      "true"
    );

    await expect(window.getByText(DANGER_BANNER)).toBeVisible({ timeout: T_MEDIUM });
    await expect(window.getByText("Write project files")).toBeVisible();
    await expect(window.getByText("Read project files")).toBeVisible();
    await expect(window.getByText("Make network requests")).toBeVisible();
    await expect(window.getByText("https://api.example.com")).toBeVisible();

    await closePluginManager(window);
  });

  test("hides the Permissions tab entirely for the capability-free sample (#11302)", async () => {
    const { window } = ctx;
    await openPluginManager(window);
    await selectPluginRow(window, SAMPLE_PLUGIN_LABEL);

    // Overview must render so the absences below aren't a pane that failed.
    await expect(window.getByRole("tabpanel", { name: "Overview" })).toBeVisible({
      timeout: T_SHORT,
    });
    await expect(window.locator(SEL.plugin.tabPermissions)).toHaveCount(0);
    await expect(window.getByText("No special permissions")).toHaveCount(0);
    await expect(window.getByText(DANGER_BANNER)).toHaveCount(0);

    await closePluginManager(window);
  });
});

// #10473, #9286, #11304. Declared contributions reach the main-process
// registries and the surfaces that render them.
test.describe("plugin contributions", () => {
  test("registers the contributed agent in the main-process registry", async () => {
    const agents = await ctx.window.evaluate(() => window.electron.plugin.getAgents());

    expect(agents["rich-sample"]).toBeDefined();
    expect(agents["rich-sample"]).toMatchObject({
      id: "rich-sample",
      name: "Rich Sample",
      command: "echo",
      color: "#6366f1",
      iconId: "bot",
    });
  });

  test("registers the contributed keybinding in the main-process registry", async () => {
    // Registry-only: firing CmdOrCtrl+Shift+R needs a focused scope and
    // resolves to different modifiers per platform.
    const keybindings = await ctx.window.evaluate(() => window.electron.plugin.keybindings());
    const richBinding = keybindings.find((entry) => entry.item.actionId === "daintree.rich.ready");

    expect(richBinding).toBeDefined();
    expect(richBinding).toMatchObject({
      pluginId: "daintree.rich",
      item: {
        actionId: "daintree.rich.ready",
        combo: "CmdOrCtrl+Shift+R",
        scope: "global",
      },
    });
  });

  test("registers the contributed context-menu item in the main-process registry", async () => {
    const items = await ctx.window.evaluate(() => window.electron.plugin.contextMenuItems());
    const richItem = items.find((entry) => entry.item.label === "Rich sample action");

    expect(richItem).toBeDefined();
    expect(richItem).toMatchObject({
      pluginId: "daintree.rich",
      item: {
        actionId: "daintree.rich.ready",
        location: "worktree",
        label: "Rich sample action",
      },
    });
  });

  // A worktree card exposes the same item list through two surfaces, so a
  // contributed item has to reach the Extensions submenu in both.
  test("surfaces the contributed item in both worktree menus", async () => {
    const { window } = ctx;
    const card = window.locator(SEL.worktree.mainCard);
    await expect(card).toBeVisible({ timeout: T_LONG });

    const pluginItem = window.getByRole("menuitem", { name: "Rich sample action" });
    const expectPluginItem = async () => {
      const extensionsTrigger = window.getByRole("menuitem", {
        name: "Extensions",
        exact: true,
      });
      await expect(extensionsTrigger).toBeVisible({ timeout: T_SHORT });
      // Hover doesn't reliably open Radix submenus on Linux CI.
      await extensionsTrigger.click();
      await expect(pluginItem).toBeVisible({ timeout: T_SHORT });
    };
    const closeMenu = async () => {
      await window.keyboard.press("Escape");
      await expect(window.locator('[role="menu"]')).toHaveCount(0, { timeout: T_SHORT });
    };

    await test.step("Actions dropdown lists the plugin item", async () => {
      await card.locator(SEL.worktree.actionsMenu).click();
      await expectPluginItem();
      await closeMenu();
    });

    await test.step("Right-click menu lists the plugin item", async () => {
      await card.click({ button: "right", position: { x: 40, y: 12 } });
      await expectPluginItem();
      await closeMenu();
    });
  });

  test("registers the contributed toolbar button in the main-process registry", async () => {
    // The registry namespaces the manifest's `ping` as `daintree.hello.ping`.
    const buttonIds = await getPluginToolbarButtonIds(ctx.window);
    expect(buttonIds).toContain("daintree.hello.ping");
  });

  test("renders the contributed toolbar button inside the plugin tray", async () => {
    const { window } = ctx;
    const toolbar = window.getByRole("toolbar", { name: "Main toolbar" });
    const trayTrigger = toolbar.getByRole("button", { name: "Plugin tray", exact: true });
    const trayRow = window.getByRole("menuitem", { name: /Hello ping/ });
    // Structural, not role-based: a top-level plugin button that overflowed is
    // still in the DOM but hidden, so a role query would "prove" absence for
    // the wrong reason.
    const topLevelSlot = toolbar.locator('[data-toolbar-button-id="daintree.hello.ping"]');

    // Gate on the tray existing first: the renderer learns about contributions
    // over a broadcast that lands after the registration the fixture waits on,
    // so an absence check before this would pass because nothing had rendered.
    // Structural again, because an overflowed item keeps an aria-hidden wrapper
    // that getByRole refuses to match.
    await expect(toolbar.locator('[data-toolbar-button-id="plugin-tray"]')).toBeAttached({
      timeout: T_MEDIUM,
    });

    // The contribution no longer owns a top-level slot of its own (#11304).
    await expect(topLevelSlot).toHaveCount(0);

    // Narrow windows can evict the tray into overflow, where the menu inlines
    // the grouped contributions — so the row itself must be reachable there.
    // The assertion is on the row: a tray that never lists its contributions
    // must fail even when the trigger is reachable.
    await expect(async () => {
      try {
        if (await trayTrigger.isVisible()) {
          await trayTrigger.click({ timeout: 2_000 });
          await expect(trayRow).toBeVisible({ timeout: 1_000 });
          return;
        }
        const overflowButtons = toolbar.getByRole("button", { name: /more toolbar items/i });
        const count = await overflowButtons.count();
        for (let index = 0; index < count; index++) {
          const overflowButton = overflowButtons.nth(index);
          if (!(await overflowButton.isVisible())) continue;
          await overflowButton.click({ timeout: 2_000 });
          if (await trayRow.isVisible()) return;
          await window.keyboard.press("Escape");
        }
        await expect(trayRow, "Hello ping row reachable via the tray or overflow").toBeVisible({
          timeout: 500,
        });
      } finally {
        await window.keyboard.press("Escape");
      }
    }).toPass({ timeout: T_MEDIUM, intervals: [250] });
  });
});

// #9592. The main process performs the download, so page.route() cannot stand
// in for it; this covers the renderer-side dialog and its HTTP gate only.
test.describe("plugin install-from-URL dialog", () => {
  test("opens the dialog and gates the Install button on a non-empty URL", async () => {
    const { window } = ctx;
    await openPluginManager(window);

    await window.getByRole("button", { name: "Install plugin" }).click();
    await window.locator(SEL.plugin.installFromUrlButton).click();

    const urlDialog = window.locator(SEL.plugin.urlDialog);
    const urlInput = window.locator(SEL.plugin.urlInput);
    await expect(urlInput).toBeVisible({ timeout: T_MEDIUM });

    // Scoped to the dialog so the footer button doesn't collide with the
    // "Install from file"/"Install from URL" triggers.
    const installButton = urlDialog.getByRole("button", { name: "Install", exact: true });
    await expect(installButton).toBeDisabled();

    await urlInput.fill("https://example.com/plugin.dntr");
    await expect(installButton).toBeEnabled();

    await urlDialog.getByRole("button", { name: "Cancel" }).click();
    await expect(urlInput).toBeHidden({ timeout: T_SHORT });

    await closePluginManager(window);
  });

  test("an http:// URL routes through the HTTP confirm gate, which can be cancelled", async () => {
    const { window } = ctx;
    await openPluginManager(window);

    await window.getByRole("button", { name: "Install plugin" }).click();
    await window.locator(SEL.plugin.installFromUrlButton).click();

    const urlDialog = window.locator(SEL.plugin.urlDialog);
    const urlInput = window.locator(SEL.plugin.urlInput);
    await expect(urlInput).toBeVisible({ timeout: T_MEDIUM });
    await urlInput.fill("http://example.com/plugin.dntr");

    await urlDialog.getByRole("button", { name: "Install", exact: true }).click();

    // The non-HTTPS URL raises "Install over HTTP?" before any download.
    const httpDialog = window.locator(SEL.plugin.httpWarningDialog);
    await expect(httpDialog).toBeVisible({ timeout: T_MEDIUM });

    await httpDialog.getByRole("button", { name: "Cancel" }).click();
    await expect(httpDialog).toBeHidden({ timeout: T_SHORT });

    // The URL dialog stays open behind the dismissed gate; close it before the
    // manager so its focus trap doesn't swallow the manager-close click.
    const urlDialogCancel = urlDialog.getByRole("button", { name: "Cancel" });
    if (await urlDialogCancel.isVisible()) {
      await urlDialogCancel.click();
      await expect(urlInput).toBeHidden({ timeout: T_SHORT });
    }

    await closePluginManager(window);
  });
});

// #10892. The sample's `tdd-workflow` skill, found and loaded by a real MCP
// client over HTTP against the built-in server.
test.describe("plugin skills over MCP", () => {
  let client: Client | undefined;
  let transport: StreamableHTTPClientTransport | undefined;

  test.afterAll(async () => {
    if (client) await client.close().catch(() => {});
    if (transport) await transport.close().catch(() => {});
    await ctx?.window
      ?.evaluate(async () => {
        await window.electron.mcpServer.setEnabled(false);
      })
      .catch(() => {});
  });

  test("exposes the sample plugin's skill via skills.search / skills.load", async () => {
    await ctx.window.evaluate(async () => {
      await window.electron.mcpServer.setEnabled(true);
    });

    await expect
      .poll(
        async () => {
          const status = await ctx.window.evaluate(async () =>
            window.electron.mcpServer.getStatus()
          );
          return status.port ?? 0;
        },
        { timeout: T_LONG }
      )
      .toBeGreaterThan(0);

    const status = await ctx.window.evaluate(async () => window.electron.mcpServer.getStatus());
    expect(status.port ?? 0).toBeGreaterThan(0);
    expect(status.apiKey.length).toBeGreaterThan(0);

    client = new Client({ name: "e2e-skills-client", version: "1.0.0" });
    transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${status.port}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${status.apiKey}` } },
    });
    await client.connect(transport);

    const toolNames = (await client.listTools()).tools.map((tool) => tool.name);
    expect(toolNames).toContain("skills.search");
    expect(toolNames).toContain("skills.load");

    const search = await client.callTool({ name: "skills.search", arguments: { query: "tdd" } });
    const searchData = search.structuredContent as { skills: Array<{ id: string }> };
    expect(searchData.skills.map((s) => s.id)).toContain("daintree.hello.tdd-workflow");

    const loaded = await client.callTool({
      name: "skills.load",
      arguments: { id: "daintree.hello.tdd-workflow" },
    });
    const loadedData = loaded.structuredContent as { id: string; body: string };
    expect(loadedData.id).toBe("daintree.hello.tdd-workflow");
    // The body is returned verbatim with the frontmatter stripped.
    expect(loadedData.body).toContain("Red-Green-Refactor");
    expect(loadedData.body).not.toContain("applies_to");
  });
});

// #9592. The generated form against rich-daintree's one-field-of-every-type
// manifest. Controls stay disabled until values load and text fields commit on
// blur, so every interaction gates on toBeEnabled() and then tabs away.
test.describe.serial("plugin settings form", () => {
  test.beforeAll(async () => {
    await resetUserSettings(ctx.window);
  });

  test.afterAll(async () => {
    if (ctx?.window) await resetUserSettings(ctx.window).catch(() => {});
  });

  test("persists a string field on blur", async () => {
    const { window } = ctx;
    await openRichSettings(window);

    const input = window.getByLabel("Greeting", { exact: true });
    await expect(input).toBeEnabled({ timeout: T_MEDIUM });
    await input.fill("howdy");
    await window.keyboard.press("Tab");

    await expect.poll(() => userSettingValues(window)).toMatchObject({ greeting: "howdy" });

    await closePluginManager(window);
  });

  test("persists a valid number and rejects an out-of-range one", async () => {
    const { window } = ctx;
    await openRichSettings(window);

    const input = window.getByLabel("Retries", { exact: true });
    await expect(input).toBeEnabled({ timeout: T_MEDIUM });
    await input.fill("7");
    await window.keyboard.press("Tab");
    await expect.poll(() => userSettingValues(window)).toMatchObject({ retries: 7 });

    // Above max (10) → inline error, stored value unchanged.
    await input.fill("99");
    await window.keyboard.press("Tab");
    await expect(window.getByText("Must be at most 10")).toBeVisible();
    await expect.poll(() => userSettingValues(window)).toMatchObject({ retries: 7 });

    await closePluginManager(window);
  });

  test("toggles a boolean field", async () => {
    const { window } = ctx;
    await openRichSettings(window);

    const toggle = window.getByRole("switch", { name: "Verbose mode" });
    await expect(toggle).toBeEnabled({ timeout: T_MEDIUM });
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "true");

    await expect.poll(() => userSettingValues(window)).toMatchObject({ verbose: true });

    await closePluginManager(window);
  });

  test("persists an enum selection", async () => {
    const { window } = ctx;
    await openRichSettings(window);

    const choices = window.getByRole("radiogroup", { name: "Log level", exact: true });
    await expect(choices).toBeVisible({ timeout: T_MEDIUM });
    await choices.getByRole("radio", { name: "warn", exact: true }).click();

    await expect.poll(() => userSettingValues(window)).toMatchObject({ level: "warn" });

    await closePluginManager(window);
  });

  test("persists valid JSON and rejects malformed JSON", async () => {
    const { window } = ctx;
    await openRichSettings(window);

    const textarea = window.getByLabel("Extra config", { exact: true });
    await expect(textarea).toBeEnabled({ timeout: T_MEDIUM });
    await textarea.fill('{"key":"val"}');
    await window.keyboard.press("Tab");
    await expect.poll(() => userSettingValues(window)).toMatchObject({ config: { key: "val" } });

    await textarea.fill("{bad");
    await window.keyboard.press("Tab");
    await expect(window.getByText("Enter valid JSON")).toBeVisible();
    await expect.poll(() => userSettingValues(window)).toMatchObject({ config: { key: "val" } });

    await closePluginManager(window);
  });

  test("stores a secret and reveals it on demand", async () => {
    const { window } = ctx;
    await openRichSettings(window);

    const input = window.getByLabel("API key", { exact: true });
    await expect(input).toBeEnabled({ timeout: T_MEDIUM });
    await expect(input).toHaveAttribute("type", "password");
    await input.fill("s3cr3t");
    await window.keyboard.press("Tab");

    // A host with no OS keychain refuses the secret rather than storing it in
    // plaintext: the typed value stays in the field beside the error.
    if ((await userSecretTier(window)) === "unavailable") {
      await expect(window.getByText(/wasn't saved/)).toBeVisible({ timeout: T_MEDIUM });
      await expect(input).toHaveValue("s3cr3t");
      expect(await userSecretsSet(window)).not.toContain("apiKey");
      await closePluginManager(window);
      return;
    }

    // Reported as set; the value itself never rides on getSettingValues.
    await expect.poll(() => userSecretsSet(window)).toContain("apiKey");

    const reveal = window.getByRole("button", { name: "Show API key" });
    await expect(reveal).toBeVisible({ timeout: T_MEDIUM });
    await expect(reveal).toHaveAttribute("aria-pressed", "false");
    await reveal.click();
    await expect(reveal).toHaveAttribute("aria-pressed", "true");
    await expect(input).toHaveAttribute("type", "text");
    await expect(input).toHaveValue("s3cr3t");

    await closePluginManager(window);
  });

  test("resets a field back to its default", async () => {
    const { window } = ctx;
    await openRichSettings(window);

    const input = window.getByLabel("Greeting", { exact: true });
    await expect(input).toBeEnabled({ timeout: T_MEDIUM });
    await input.fill("temporary");
    await window.keyboard.press("Tab");
    await expect.poll(() => userSettingValues(window)).toMatchObject({ greeting: "temporary" });

    // The reset affordance reads `storedValue` at mount, so remount the tab.
    await window.locator(SEL.plugin.tabOverview).click();
    await window.locator(SEL.plugin.tabSettings).click();

    const reset = window.getByRole("button", { name: "Reset Greeting to default" });
    await expect(reset).toBeVisible({ timeout: T_MEDIUM });
    await reset.click();

    await expect
      .poll(async () =>
        Object.prototype.hasOwnProperty.call(await userSettingValues(window), "greeting")
      )
      .toBe(false);

    await closePluginManager(window);
  });

  test("persists a project-scoped field, verified by reload", async () => {
    const { window } = ctx;
    const openProjectSetting = async () => {
      const result = await dispatchAction(window, "plugin.openSettings", {
        pluginId: RICH_PLUGIN_ID,
        key: "projectNote",
      });
      expect(result.ok, JSON.stringify(result)).toBe(true);
    };
    await openProjectSetting();

    const input = window.getByLabel("Project note", { exact: true });
    await expect(input).toBeEnabled({ timeout: T_MEDIUM });
    await input.fill("scoped-note");
    await window.keyboard.press("Tab");

    // Reopen the field through its project-scoped home to verify it rehydrates.
    await window.getByRole("button", { name: "Close settings" }).click();
    await openProjectSetting();

    const reloaded = window.getByLabel("Project note", { exact: true });
    await expect(reloaded).toBeEnabled({ timeout: T_MEDIUM });
    await expect(reloaded).toHaveValue("scoped-note");

    await window.getByRole("button", { name: "Close settings" }).click();
  });
});

// #10556. The rich sample's `storage-roundtrip` action writes, reads and
// deletes across the user, project and worktree scopes through the real host
// and reports what it saw. Its danger level raises the Run confirm dialog.
test.describe("plugin private storage", () => {
  const STORAGE_ACTION = `${RICH_PLUGIN_ID}.storage-roundtrip`;
  // The action writes "STORAGE-ONLY" under the `greeting` key, which is also a
  // declared setting id, and then deletes it again before returning.
  const GREETING_SENTINEL = "SETTINGS-SENTINEL";

  async function runStorageRoundtrip(page: Page) {
    const pending = dispatchAction<Record<string, unknown>>(page, STORAGE_ACTION, undefined, {
      source: "menu",
    });
    const confirmButton = page.locator(SEL.confirmDialog.confirm).filter({
      hasText: "Rich: Storage round-trip",
    });
    await expect(confirmButton).toBeVisible();
    await confirmButton.click();
    return pending;
  }

  test.afterAll(async () => {
    await ctx?.window
      ?.evaluate(
        (pluginId) => window.electron.plugin.deleteSettingValue(pluginId, "greeting", "user", null),
        RICH_PLUGIN_ID
      )
      .catch(() => {});
  });

  test("round-trips values across scopes and honours delete", async () => {
    const result = await runStorageRoundtrip(ctx.window);
    if (!result.ok) throw new Error(`storage round-trip failed: ${JSON.stringify(result)}`);
    const report = result.result;

    expect(report.user).toEqual({ n: 1 });
    expect(report.project).toEqual({ n: 2 });

    // The onboarded project root is itself the active worktree, so worktree
    // scope must resolve here rather than fall back to the host's error.
    expect(report.worktreeError).toBeUndefined();
    expect(report.worktree).toEqual({ n: 3 });

    // Storage has a real delete; settings does not.
    expect(report.userAfterDelete).toBeUndefined();
  });

  test("storage is a separate store from settings — no key collision leaks", async () => {
    // Seed the colliding setting first. The action both writes and then deletes
    // `greeting` in storage, so if the two stores were one, the stored setting
    // would come back as "STORAGE-ONLY" or be gone — never as the sentinel.
    await ctx.window.evaluate(
      ({ pluginId, value }) =>
        window.electron.plugin.setSettingValue(pluginId, "greeting", value, "user", null),
      { pluginId: RICH_PLUGIN_ID, value: GREETING_SENTINEL }
    );
    await expect
      .poll(() => userSettingValues(ctx.window))
      .toMatchObject({ greeting: GREETING_SENTINEL });

    const result = await runStorageRoundtrip(ctx.window);
    if (!result.ok) throw new Error(`storage round-trip failed: ${JSON.stringify(result)}`);

    // The storage write reads back from the storage store...
    expect(result.result.storageGreeting).toBe("STORAGE-ONLY");

    // ...and the settings store the UI reads from still holds the sentinel.
    const settings = await userSettingValues(ctx.window);
    expect(settings.greeting).not.toBe("STORAGE-ONLY");
    expect(settings.greeting).toBe(GREETING_SENTINEL);
  });
});

// #10473, #10512, #11208, #11636. Serial: the hot-swap test reuses the panel
// the mount test opened and briefly disables daintree.rich, so it runs last.
test.describe.serial("plugin panels", () => {
  test("registers the contributed panel kind in the main-process registry", async () => {
    const kinds = await ctx.window.evaluate(() => window.electron.plugin.getPanelKinds());
    const richPanel = kinds.find((kind) => kind.id === "daintree.rich.rich-panel");

    expect(richPanel).toBeDefined();
    expect(richPanel).toMatchObject({
      id: "daintree.rich.rich-panel",
      name: "Rich Panel",
      extensionId: "daintree.rich",
      hasPty: false,
      showInPalette: true,
    });
  });

  // #10512: a registered plugin panel never reached a mounted GridPanel. This
  // view imports nothing, isolating a plugin:// failure from a React-contract
  // failure (covered below).
  test("mounts the contributed view's React component in the grid", async () => {
    await dispatchAction(
      ctx.window,
      "panel.openPluginPanel",
      { kind: "daintree.rich.rich-panel" },
      { source: "menu" }
    );

    await expect(ctx.window.getByText("Rich panel view mounted")).toBeVisible({
      timeout: T_LONG,
    });
  });

  // #11208: all five React specifiers mapped to the vendor-react code-split
  // chunk, whose exports are Rolldown's private cross-chunk interface. The
  // build-time guard proves the facade chunks carry the right names; this
  // proves the shipped import map resolves them under the real app:// protocol
  // and CSP. Ordered before the hook-panel test so a regression names the
  // specifiers that lost exports.
  test("resolves every mapped specifier to its public export surface", async () => {
    // A string rather than a callback so `await import(...)` reaches the page
    // verbatim instead of through Playwright's TS transform.
    const probe = `(async () => {
      const CONTRACT = {
        "react": ["useState", "useEffect", "useMemo", "useCallback", "useRef",
                  "useContext", "useReducer", "createElement", "forwardRef",
                  "memo", "createContext", "lazy"],
        "react/jsx-runtime": ["jsx", "jsxs"],
        "react/jsx-dev-runtime": [],
        "react-dom": ["createPortal", "flushSync"],
        "react-dom/client": ["createRoot", "hydrateRoot"]
      };
      const rows = [];
      const fragments = new Map();
      for (const specifier of Object.keys(CONTRACT)) {
        const row = { specifier, error: null, missing: [], notFunctions: [],
                      fragmentType: "absent", hasOwnJsxDEV: false, versionType: "absent" };
        try {
          const ns = await import(specifier);
          for (const name of CONTRACT[specifier]) {
            if (!Object.hasOwn(ns, name)) row.missing.push(name);
            else if (typeof ns[name] !== "function") {
              row.notFunctions.push(name + ":" + typeof ns[name]);
            }
          }
          if (Object.hasOwn(ns, "Fragment")) {
            row.fragmentType = typeof ns.Fragment;
            fragments.set(specifier, ns.Fragment);
          }
          if (Object.hasOwn(ns, "version")) row.versionType = typeof ns.version;
          row.hasOwnJsxDEV = Object.hasOwn(ns, "jsxDEV");
        } catch (err) {
          row.error = String((err && err.message) || err);
        }
        rows.push(row);
      }
      const fragmentValues = [...fragments.values()];
      const distinctFragments = new Set(fragmentValues).size;
      return { rows, fragmentOwners: [...fragments.keys()], distinctFragments };
    })()`;

    const { rows, fragmentOwners, distinctFragments } = await ctx.window.evaluate<{
      rows: Array<{
        specifier: string;
        error: string | null;
        missing: string[];
        notFunctions: string[];
        fragmentType: string;
        hasOwnJsxDEV: boolean;
        versionType: string;
      }>;
      fragmentOwners: string[];
      distinctFragments: number;
    }>(probe);

    // The whole shape at once, so a failure names every broken specifier.
    expect(
      rows.map((r) => ({
        specifier: r.specifier,
        error: r.error,
        missing: r.missing,
        notFunctions: r.notFunctions,
      }))
    ).toEqual([
      { specifier: "react", error: null, missing: [], notFunctions: [] },
      { specifier: "react/jsx-runtime", error: null, missing: [], notFunctions: [] },
      { specifier: "react/jsx-dev-runtime", error: null, missing: [], notFunctions: [] },
      { specifier: "react-dom", error: null, missing: [], notFunctions: [] },
      { specifier: "react-dom/client", error: null, missing: [], notFunctions: [] },
    ]);

    // Fragment is a live symbol on the three specifiers that document it. Not a
    // single-instance proof: React uses the registered Symbol.for, so duplicate
    // copies agree too. The hook-panel test below is the single-instance proof.
    expect(fragmentOwners).toEqual(["react", "react/jsx-runtime", "react/jsx-dev-runtime"]);
    expect(rows.filter((r) => r.fragmentType === "symbol").map((r) => r.specifier)).toEqual(
      fragmentOwners
    );
    expect(distinctFragments).toBe(1);

    // Catches a facade whose names resolve but whose bindings are hollow.
    expect(rows.filter((r) => r.versionType === "string").map((r) => r.specifier)).toEqual([
      "react",
      "react-dom",
      "react-dom/client",
    ]);

    // Production jsx-dev-runtime exports `jsxDEV` as undefined; only hasOwn
    // tells a present-but-undefined export from a map serving nothing.
    const jsxDev = rows.find((r) => r.specifier === "react/jsx-dev-runtime");
    expect(jsxDev?.hasOwnJsxDEV).toBe(true);
  });

  // Built by the public @daintreehq/plugin-vite preset. Reaching the
  // post-effect "ready" needs the named react imports, react/jsx-runtime and
  // the host's single React instance (a duplicate throws "Invalid hook call").
  test("mounts a hook-based view that imports React through the host import map", async () => {
    await dispatchAction(
      ctx.window,
      "panel.openPluginPanel",
      { kind: "daintree.rich.hook-panel" },
      { source: "menu" }
    );

    await expect(ctx.window.getByText("Hook panel view ready")).toBeVisible({
      timeout: T_LONG,
    });
  });

  // #11636: React Compiler cached the panel-kind definition from the fiber's
  // first render, so a panel restored before its plugin registered sat on
  // "Plugin unavailable". Only the compiled bundle shows it. Panel kinds
  // register on plugin load, so disable/re-enable is the lever; both directions
  // are asserted on the same data-panel-id.
  test("hot-swaps a live panel when its plugin kind is unregistered and registered again", async () => {
    const opened = await dispatchAction<{ panelId: string }>(
      ctx.window,
      "panel.openPluginPanel",
      { kind: "daintree.rich.rich-panel" },
      { source: "menu" }
    );
    if (!opened.ok) throw new Error(`Failed to open rich panel: ${opened.error.message}`);

    const panel = ctx.window.locator(`[data-panel-id="${opened.result.panelId}"]`);
    const unavailable = panel.getByRole("region", { name: "Plugin unavailable" });

    await expect(panel.getByText("Rich panel view mounted")).toBeVisible({ timeout: T_LONG });

    try {
      await setPluginEnabled(ctx.window, RICH_PLUGIN_ID, false);
      await expect(unavailable).toBeVisible({ timeout: T_LONG });
    } finally {
      // Re-enable even on failure so the shared launch isn't stranded.
      await setPluginEnabled(ctx.window, RICH_PLUGIN_ID, true);
    }

    await waitForRichPluginReady(ctx.app, ctx.window);

    await expect(panel.getByText("Rich panel view mounted")).toBeVisible({ timeout: T_LONG });
    await expect(unavailable).toHaveCount(0);
  });
});

// #9284, #9304, #9558. Toggling a built-in plugin transitions the live
// registry in place. Last in the file because it flips daintree.hello.
test.describe.serial("plugin enable/disable", () => {
  const isDisabled = () =>
    ctx.window.evaluate(async () => {
      const plugins = await globalThis.window.electron.plugin.list();
      return plugins.find((plugin) => plugin.manifest.name === "daintree.hello")?.disabled === true;
    });

  test("disabling a built-in plugin keeps its row stable and updates live state without a restart", async () => {
    const { window } = ctx;
    await openPluginManager(window);

    const toggle = window.getByRole("switch", { name: `Enable ${SAMPLE_PLUGIN_LABEL}` });
    await expect(toggle).toBeChecked();

    const sampleRow = window.locator(SEL.plugin.option).filter({ hasText: SAMPLE_PLUGIN_LABEL });
    const initialBounds = await sampleRow.boundingBox();
    expect(initialBounds).not.toBeNull();

    await toggle.click();

    await expect(toggle).not.toBeChecked();
    await expect.poll(isDisabled, { timeout: T_MEDIUM }).toBe(true);
    await expect(sampleRow).toBeVisible();
    await expect.poll(() => sampleRow.boundingBox()).toEqual(initialBounds);

    await expect(window.getByText(RESTART_REQUIRED)).not.toBeVisible({ timeout: T_MEDIUM });

    await toggle.click();
    await expect(toggle).toBeChecked();
    await expect.poll(isDisabled, { timeout: T_MEDIUM }).toBe(false);
    await expect(window.getByText(RESTART_REQUIRED)).not.toBeVisible({ timeout: T_MEDIUM });
  });

  test("re-enabling a built-in plugin does not require a restart confirmation", async () => {
    const { window } = ctx;
    // open() is idempotent, so this is safe whether or not the manager is open.
    await openPluginManager(window);
    const toggle = window.getByRole("switch", { name: `Enable ${SAMPLE_PLUGIN_LABEL}` });
    await toggle.click();
    // The switch flips optimistically and rolls back on error, so confirm each
    // toggle landed in main before reading anything off the UI.
    await expect.poll(isDisabled, { timeout: T_MEDIUM }).toBe(true);

    await expect(window.getByText(RESTART_REQUIRED)).not.toBeVisible({ timeout: T_MEDIUM });

    await toggle.click();
    await expect(toggle).toBeChecked();
    await expect.poll(isDisabled, { timeout: T_MEDIUM }).toBe(false);
    await expect(window.getByText("Restart Daintree now?")).not.toBeVisible({ timeout: T_SHORT });
  });
});
