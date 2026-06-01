// @vitest-environment jsdom

import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { PluginManagerView } from "../PluginManagerView";
import { usePluginManagerStore } from "@/store/pluginManagerStore";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { LoadedPluginInfo, SettingDefinition } from "@shared/types/plugin";

vi.mock("@/utils/logger", () => ({
  logError: vi.fn(),
  logWarn: vi.fn(),
  logInfo: vi.fn(),
  logDebug: vi.fn(),
}));

// PluginSettingsForm reads the active project via this selector.
vi.mock("@/store/projectStore", () => ({
  useProjectStore: (selector: (s: { currentProject: { id: string } | null }) => unknown) =>
    selector({ currentProject: null }),
}));

// ScrollShadow uses ResizeObserver, which jsdom lacks.
class StubResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", StubResizeObserver);

// The restart-required bar renders InlineStatusBanner, which reads
// prefers-reduced-motion; jsdom has no matchMedia.
vi.stubGlobal("matchMedia", (query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addListener() {},
  removeListener() {},
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent() {
    return false;
  },
}));

function makePlugin(overrides: Partial<LoadedPluginInfo> = {}): LoadedPluginInfo {
  return {
    manifest: {
      name: "acme.demo",
      version: "1.0.0",
      displayName: "Acme Demo",
      description: "A demo plugin",
      contributes: {
        panels: [],
        toolbarButtons: [],
        menuItems: [],
        commands: [],
        experimental_views: [],
        experimental_mcpServers: [],
        keybindings: [],
        contextMenus: [],
        forgeProviders: [],
        fileDecorationProviders: [],
        agents: [],
      },
    },
    dir: "/plugins/acme.demo",
    loadedAt: 123,
    isBuiltin: false,
    disabled: false,
    pendingRestart: false,
    source: "sideload",
    installedAt: 123,
    archiveHash: null,
    originalUrl: null,
    loadError: null,
    updateAvailable: null,
    devMode: false,
    pluginDanger: "safe",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  usePluginManagerStore.setState({ isOpen: true });
  window.electron = {
    plugin: {
      list: vi.fn().mockResolvedValue([]),
      setEnabled: vi.fn().mockResolvedValue(undefined),
      installFromFile: vi.fn().mockResolvedValue({ status: "not-implemented" }),
      installFromUrl: vi.fn().mockResolvedValue({ status: "not-implemented" }),
      installFromPath: vi.fn().mockResolvedValue({ status: "not-implemented" }),
      getDroppedFilePath: vi.fn().mockReturnValue(null),
      uninstall: vi.fn().mockResolvedValue(undefined),
      checkForUpdate: vi.fn().mockResolvedValue({ status: "up-to-date" }),
      onProvenanceChanged: vi.fn().mockReturnValue(() => {}),
      // PluginSettingsForm hydrates stored values for any plugin that
      // contributes settings — stub the full surface so those rows render.
      getSettingValues: vi.fn().mockResolvedValue({ values: {}, secretsSet: [] }),
      setSettingValue: vi.fn().mockResolvedValue(undefined),
      deleteSettingValue: vi.fn().mockResolvedValue(undefined),
      revealSecretSetting: vi.fn().mockResolvedValue(null),
    },
    // The restart-required bar relaunches via this app IPC.
    app: {
      resetAndRelaunch: vi.fn().mockResolvedValue(undefined),
    },
  } as unknown as typeof window.electron;
});

const SETTINGS_FIXTURE: SettingDefinition[] = [{ id: "apiKey", type: "string", label: "API key" }];

function makePluginWithSettings(overrides: Partial<LoadedPluginInfo> = {}): LoadedPluginInfo {
  const base = makePlugin(overrides);
  return {
    ...base,
    manifest: {
      ...base.manifest,
      contributes: { ...base.manifest.contributes, settings: SETTINGS_FIXTURE },
    },
  };
}

function renderDialog() {
  return render(
    <TooltipProvider>
      <PluginManagerView />
    </TooltipProvider>
  );
}

/**
 * Click a plugin's list row to populate the detail pane. Metadata, actions, and
 * settings live in the detail pane now (#9555), so most assertions need the
 * plugin selected first.
 */
async function selectPlugin(name = "Acme Demo") {
  fireEvent.click(await screen.findByRole("option", { name: new RegExp(name, "i") }));
}

describe("PluginManagerView", () => {
  it("renders the section header immediately", async () => {
    renderDialog();
    expect(screen.getByText("Installed plugins")).toBeTruthy();
  });

  it("shows an empty state when no plugins are installed", async () => {
    renderDialog();
    await waitFor(() => {
      expect(screen.getByText("No plugins installed")).toBeTruthy();
    });
  });

  it("lists installed plugins with a toggle", async () => {
    (window.electron.plugin.list as ReturnType<typeof vi.fn>).mockResolvedValue([makePlugin()]);
    renderDialog();
    await waitFor(() => {
      expect(screen.getByText("Acme Demo")).toBeTruthy();
    });
    const toggle = screen.getByRole("switch", { name: "Enable Acme Demo" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
  });

  it("renders a disabled plugin with the switch off", async () => {
    (window.electron.plugin.list as ReturnType<typeof vi.fn>).mockResolvedValue([
      makePlugin({ disabled: true }),
    ]);
    renderDialog();
    await waitFor(() => {
      expect(screen.getByText("Acme Demo")).toBeTruthy();
    });
    const toggle = screen.getByRole("switch", { name: "Enable Acme Demo" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
  });

  it("renders a plugin's settings form in the detail pane once selected", async () => {
    (window.electron.plugin.list as ReturnType<typeof vi.fn>).mockResolvedValue([
      makePluginWithSettings(),
    ]);
    renderDialog();
    // Settings are not rendered until the plugin is selected — no layout shift
    // from inline expansion (#9555).
    await waitFor(() => expect(screen.getByText("Acme Demo")).toBeTruthy());
    // Before selection there is no detail pane, so no Settings tab or form.
    expect(screen.queryByRole("tab", { name: "Settings" })).toBeNull();
    expect(window.electron.plugin.getSettingValues).not.toHaveBeenCalled();

    await selectPlugin();
    // After selection the Settings tab appears — click it to show the form.
    fireEvent.click(await screen.findByRole("tab", { name: "Settings" }));
    expect(screen.getByLabelText("API key")).toBeTruthy();
    await waitFor(() =>
      expect(window.electron.plugin.getSettingValues).toHaveBeenCalledWith(
        "acme.demo",
        "user",
        null
      )
    );
  });

  it("renders the settings form for a disabled plugin too", async () => {
    (window.electron.plugin.list as ReturnType<typeof vi.fn>).mockResolvedValue([
      makePluginWithSettings({ disabled: true }),
    ]);
    renderDialog();
    await waitFor(() => expect(screen.getByText("Acme Demo")).toBeTruthy());
    // Settings persist independently of the plugin's runtime, so the form is
    // available even with the plugin toggled off.
    const toggle = screen.getByRole("switch", { name: "Enable Acme Demo" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");

    await selectPlugin();
    // Click the Settings tab to show the form.
    fireEvent.click(await screen.findByRole("tab", { name: "Settings" }));
    expect(screen.getByLabelText("API key")).toBeTruthy();
    // Hydration must run for disabled plugins too — the values are stored
    // independently of the plugin's runtime.
    await waitFor(() =>
      expect(window.electron.plugin.getSettingValues).toHaveBeenCalledWith(
        "acme.demo",
        "user",
        null
      )
    );
  });

  it("shows a no-settings note in the detail pane when a plugin contributes none", async () => {
    (window.electron.plugin.list as ReturnType<typeof vi.fn>).mockResolvedValue([makePlugin()]);
    renderDialog();
    await waitFor(() => expect(screen.getByText("Acme Demo")).toBeTruthy());

    await selectPlugin();
    // Navigate to the Settings tab to confirm no-settings note.
    fireEvent.click(await screen.findByRole("tab", { name: "Settings" }));
    expect(await screen.findByText("This plugin has no settings.")).toBeTruthy();
  });

  it("shows an empty detail pane before any plugin is selected", async () => {
    (window.electron.plugin.list as ReturnType<typeof vi.fn>).mockResolvedValue([
      makePluginWithSettings(),
    ]);
    renderDialog();
    await waitFor(() => expect(screen.getByText("Acme Demo")).toBeTruthy());
    expect(screen.getByText("Select a plugin")).toBeTruthy();
    expect(screen.queryByRole("tab", { name: "Settings" })).toBeNull();
  });

  it("marks the selected row with aria-selected", async () => {
    (window.electron.plugin.list as ReturnType<typeof vi.fn>).mockResolvedValue([makePlugin()]);
    renderDialog();
    await waitFor(() => expect(screen.getByText("Acme Demo")).toBeTruthy());

    const option = screen.getByRole("option", { name: /Acme Demo/i });
    expect(option.getAttribute("aria-selected")).toBe("false");
    fireEvent.click(option);
    await waitFor(() =>
      expect(screen.getByRole("option", { name: /Acme Demo/i }).getAttribute("aria-selected")).toBe(
        "true"
      )
    );
  });

  it("deselects the plugin when its already-selected row is clicked again", async () => {
    (window.electron.plugin.list as ReturnType<typeof vi.fn>).mockResolvedValue([
      makePluginWithSettings(),
    ]);
    renderDialog();
    await waitFor(() => expect(screen.getByText("Acme Demo")).toBeTruthy());

    // First click selects and fills the detail pane — Settings tab appears.
    await selectPlugin();
    expect(await screen.findByRole("tab", { name: "Settings" })).toBeTruthy();
    expect(screen.getByRole("option", { name: /Acme Demo/i }).getAttribute("aria-selected")).toBe(
      "true"
    );

    // Clicking the same row again clears the selection and restores the prompt.
    await selectPlugin();
    await waitFor(() =>
      expect(screen.getByRole("option", { name: /Acme Demo/i }).getAttribute("aria-selected")).toBe(
        "false"
      )
    );
    expect(screen.getByText("Select a plugin")).toBeTruthy();
    expect(screen.queryByRole("tab", { name: "Settings" })).toBeNull();
  });

  it("clears the detail pane when the selected plugin is uninstalled elsewhere", async () => {
    let fireProvenance: (() => void) | undefined;
    (window.electron.plugin.onProvenanceChanged as ReturnType<typeof vi.fn>).mockImplementation(
      (cb: () => void) => {
        fireProvenance = cb;
        return () => {};
      }
    );
    const listMock = window.electron.plugin.list as ReturnType<typeof vi.fn>;
    listMock.mockResolvedValueOnce([makePluginWithSettings()]).mockResolvedValueOnce([]);
    renderDialog();
    await selectPlugin();
    // Settings tab is visible in the detail pane after selection.
    expect(await screen.findByRole("tab", { name: "Settings" })).toBeTruthy();

    // The plugin disappears from the refreshed list — selection must reset.
    fireProvenance?.();
    await waitFor(() => expect(screen.getByText("No plugins installed")).toBeTruthy());
    expect(screen.queryByRole("tab", { name: "Settings" })).toBeNull();
  });

  it("renders settings in the detail pane, not inside the list row", async () => {
    (window.electron.plugin.list as ReturnType<typeof vi.fn>).mockResolvedValue([
      makePluginWithSettings(),
    ]);
    renderDialog();
    await selectPlugin();
    // Click the Settings tab to show the form.
    fireEvent.click(await screen.findByRole("tab", { name: "Settings" }));
    await screen.findByLabelText("API key");
    // The settings form and its fields must live outside the listbox — the
    // whole point of the master-detail split (#9555) is that the list row
    // never expands inline.
    const listbox = within(screen.getByRole("listbox"));
    expect(listbox.queryByLabelText("API key")).toBeNull();
  });

  it("toggling the enable switch does not select the row", async () => {
    (window.electron.plugin.list as ReturnType<typeof vi.fn>).mockResolvedValue([makePlugin()]);
    renderDialog();
    await waitFor(() => expect(screen.getByText("Acme Demo")).toBeTruthy());

    // The switch is a sibling of the selection button, not nested — clicking it
    // must not populate the detail pane.
    fireEvent.click(screen.getByRole("switch", { name: "Enable Acme Demo" }));
    await waitFor(() =>
      expect(window.electron.plugin.setEnabled).toHaveBeenCalledWith("acme.demo", false)
    );
    expect(screen.getByRole("option", { name: /Acme Demo/i }).getAttribute("aria-selected")).toBe(
      "false"
    );
    expect(screen.getByText("Select a plugin")).toBeTruthy();
  });

  it("re-hydrates settings for the newly selected plugin when switching", async () => {
    const pluginA = makePluginWithSettings();
    const pluginB = makePluginWithSettings({
      manifest: {
        ...makePlugin().manifest,
        name: "beta.demo",
        displayName: "Beta Demo",
        contributes: { ...makePlugin().manifest.contributes, settings: SETTINGS_FIXTURE },
      },
    });
    (window.electron.plugin.list as ReturnType<typeof vi.fn>).mockResolvedValue([pluginA, pluginB]);
    renderDialog();

    await selectPlugin("Acme Demo");
    // Click the Settings tab to trigger PluginSettingsForm mount and hydration.
    fireEvent.click(await screen.findByRole("tab", { name: "Settings" }));
    await waitFor(() =>
      expect(window.electron.plugin.getSettingValues).toHaveBeenCalledWith(
        "acme.demo",
        "user",
        null
      )
    );

    // Switching plugins remounts the detail pane — click Settings tab again.
    await selectPlugin("Beta Demo");
    fireEvent.click(await screen.findByRole("tab", { name: "Settings" }));
    await waitFor(() =>
      expect(window.electron.plugin.getSettingValues).toHaveBeenCalledWith(
        "beta.demo",
        "user",
        null
      )
    );
  });

  it("closes an armed uninstall confirm on a cross-window provenance change", async () => {
    let fireProvenance: (() => void) | undefined;
    (window.electron.plugin.onProvenanceChanged as ReturnType<typeof vi.fn>).mockImplementation(
      (cb: () => void) => {
        fireProvenance = cb;
        return () => {};
      }
    );
    (window.electron.plugin.list as ReturnType<typeof vi.fn>).mockResolvedValue([makePlugin()]);
    renderDialog();
    await selectPlugin();

    fireEvent.click(await screen.findByRole("button", { name: "Uninstall Acme Demo" }));
    await waitFor(() => expect(screen.getByText("Uninstall 'Acme Demo'?")).toBeTruthy());

    // Another window mutated the list — the stale confirm must close so it can't
    // fire uninstall against a record that may have changed underneath it.
    fireProvenance?.();
    await waitFor(() => expect(screen.queryByText("Uninstall 'Acme Demo'?")).toBeNull());
    expect(window.electron.plugin.uninstall).not.toHaveBeenCalled();
  });

  it("calls setEnabled(false) and shows a restart badge when disabling", async () => {
    (window.electron.plugin.list as ReturnType<typeof vi.fn>).mockResolvedValue([makePlugin()]);
    renderDialog();
    await waitFor(() => {
      expect(screen.getByText("Acme Demo")).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("switch", { name: "Enable Acme Demo" }));

    await waitFor(() => {
      expect(window.electron.plugin.setEnabled).toHaveBeenCalledWith("acme.demo", false);
    });
    await waitFor(() => {
      expect(screen.getByText("Restart required")).toBeTruthy();
    });
  });

  it("keeps the restart badge after a remount (pendingRestart comes from listPlugins)", async () => {
    (window.electron.plugin.list as ReturnType<typeof vi.fn>).mockResolvedValue([
      makePlugin({ disabled: true, pendingRestart: true }),
    ]);
    renderDialog();
    await waitFor(() => {
      expect(screen.getByText("Restart required")).toBeTruthy();
    });
    const toggle = screen.getByRole("switch", { name: "Enable Acme Demo" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
  });

  it("reverts the switch and shows an error when setEnabled rejects", async () => {
    (window.electron.plugin.list as ReturnType<typeof vi.fn>).mockResolvedValue([makePlugin()]);
    (window.electron.plugin.setEnabled as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("disk full")
    );
    renderDialog();
    await waitFor(() => {
      expect(screen.getByText("Acme Demo")).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("switch", { name: "Enable Acme Demo" }));

    await waitFor(() => {
      expect(screen.getByText(/disk full/i)).toBeTruthy();
    });
    const toggle = screen.getByRole("switch", { name: "Enable Acme Demo" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByText("Restart required")).toBeNull();
  });

  it("clears the restart badge when toggled back to the startup state", async () => {
    (window.electron.plugin.list as ReturnType<typeof vi.fn>).mockResolvedValue([makePlugin()]);
    renderDialog();
    await waitFor(() => {
      expect(screen.getByText("Acme Demo")).toBeTruthy();
    });
    const toggle = () => screen.getByRole("switch", { name: "Enable Acme Demo" });

    fireEvent.click(toggle());
    await waitFor(() => expect(screen.getByText("Restart required")).toBeTruthy());

    fireEvent.click(toggle());
    await waitFor(() => expect(screen.queryByText("Restart required")).toBeNull());
    expect(window.electron.plugin.setEnabled).toHaveBeenLastCalledWith("acme.demo", true);
  });

  it("renders the install buttons immediately, before the list resolves", () => {
    // list() never resolves in this test — chrome must still paint.
    (window.electron.plugin.list as ReturnType<typeof vi.fn>).mockReturnValue(
      new Promise(() => {})
    );
    renderDialog();
    expect(screen.getByRole("button", { name: "Install from file" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Install from URL" })).toBeTruthy();
  });

  it("shows a source badge in the row and install time in the detail pane", async () => {
    (window.electron.plugin.list as ReturnType<typeof vi.fn>).mockResolvedValue([
      makePlugin({ source: "sideload", installedAt: Date.now() - 60_000 }),
    ]);
    renderDialog();
    await waitFor(() => expect(screen.getByText("Acme Demo")).toBeTruthy());
    // Source badge is scannable in the list row.
    expect(screen.getByText("File")).toBeTruthy();
    // Install time lives in the detail pane.
    await selectPlugin();
    expect(await screen.findByText(/Installed.*ago/)).toBeTruthy();
  });

  it("shows a Dev badge for a dev-mode plugin", async () => {
    (window.electron.plugin.list as ReturnType<typeof vi.fn>).mockResolvedValue([
      makePlugin({ devMode: true }),
    ]);
    renderDialog();
    await waitFor(() => expect(screen.getByText("Dev")).toBeTruthy());
  });

  it("renders a load-error indicator in the detail pane when loadError is set", async () => {
    (window.electron.plugin.list as ReturnType<typeof vi.fn>).mockResolvedValue([
      makePlugin({ loadError: { message: "boom", at: 1 } }),
    ]);
    renderDialog();
    await waitFor(() => expect(screen.getByText("Acme Demo")).toBeTruthy());
    await selectPlugin();
    // Load error is on the Overview tab (default) — no tab click needed.
    expect(await screen.findByText(/Failed to load: boom/)).toBeTruthy();
  });

  it("does not offer uninstall for a built-in plugin", async () => {
    (window.electron.plugin.list as ReturnType<typeof vi.fn>).mockResolvedValue([
      makePlugin({ isBuiltin: true, source: "builtin" }),
    ]);
    renderDialog();
    await waitFor(() => expect(screen.getByText("Acme Demo")).toBeTruthy());
    // The section header row (aria-disabled option) and the row badge both say
    // "Built-in". The listbox contains the row; assert the badge by scoping to
    // the listbox, which excludes the section header label outside it.
    const listbox = screen.getByRole("listbox");
    const builtinBadges = within(listbox).getAllByText("Built-in");
    expect(builtinBadges.length).toBeGreaterThanOrEqual(1);
    // Uninstall lives in the detail pane now — select and confirm it's absent
    // for a built-in.
    await selectPlugin();
    // Navigate to Settings tab to check "no settings" note (built-in has no settings).
    fireEvent.click(await screen.findByRole("tab", { name: "Settings" }));
    expect(await screen.findByText("This plugin has no settings.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Uninstall Acme Demo" })).toBeNull();
  });

  it("opens a confirm dialog and uninstalls (settings preserved by default), then re-fetches the list", async () => {
    const listMock = window.electron.plugin.list as ReturnType<typeof vi.fn>;
    listMock.mockResolvedValueOnce([makePlugin()]).mockResolvedValueOnce([]);
    renderDialog();
    await selectPlugin();

    fireEvent.click(await screen.findByRole("button", { name: "Uninstall Acme Demo" }));
    await waitFor(() => expect(screen.getByText("Uninstall 'Acme Demo'?")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Uninstall plugin" }));
    await waitFor(() =>
      expect(window.electron.plugin.uninstall).toHaveBeenCalledWith("acme.demo", false)
    );
    await waitFor(() => expect(screen.getByText("No plugins installed")).toBeTruthy());
    expect(listMock).toHaveBeenCalledTimes(2);
  });

  it("passes deleteSettings=true when the secrets checkbox is checked", async () => {
    const listMock = window.electron.plugin.list as ReturnType<typeof vi.fn>;
    listMock.mockResolvedValueOnce([makePlugin()]).mockResolvedValueOnce([]);
    renderDialog();
    await selectPlugin();

    fireEvent.click(await screen.findByRole("button", { name: "Uninstall Acme Demo" }));
    await waitFor(() => expect(screen.getByText("Uninstall 'Acme Demo'?")).toBeTruthy());

    fireEvent.click(
      screen.getByRole("checkbox", { name: "Also delete this plugin's saved settings" })
    );
    fireEvent.click(screen.getByRole("button", { name: "Uninstall plugin" }));
    await waitFor(() =>
      expect(window.electron.plugin.uninstall).toHaveBeenCalledWith("acme.demo", true)
    );
  });

  it("resets the secrets checkbox after cancelling and re-arming uninstall", async () => {
    (window.electron.plugin.list as ReturnType<typeof vi.fn>).mockResolvedValue([makePlugin()]);
    renderDialog();
    await selectPlugin();

    // Arm, tick the box, then cancel.
    fireEvent.click(await screen.findByRole("button", { name: "Uninstall Acme Demo" }));
    await waitFor(() => expect(screen.getByText("Uninstall 'Acme Demo'?")).toBeTruthy());
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Also delete this plugin's saved settings" })
    );
    fireEvent.click(screen.getByRole("button", { name: "Keep plugin" }));

    // Re-arm and confirm without touching the box — the prior tick must not leak.
    fireEvent.click(screen.getByRole("button", { name: "Uninstall Acme Demo" }));
    await waitFor(() => expect(screen.getByText("Uninstall 'Acme Demo'?")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Uninstall plugin" }));
    await waitFor(() =>
      expect(window.electron.plugin.uninstall).toHaveBeenCalledWith("acme.demo", false)
    );
  });

  it("disables the check-for-update button for a file-installed plugin", async () => {
    (window.electron.plugin.list as ReturnType<typeof vi.fn>).mockResolvedValue([makePlugin()]);
    renderDialog();
    await selectPlugin();
    const checkBtn = await screen.findByRole("button", { name: "Check Acme Demo for updates" });
    expect(checkBtn.hasAttribute("disabled")).toBe(true);
  });

  const urlPlugin = (overrides: Partial<LoadedPluginInfo> = {}) =>
    makePlugin({
      source: "url",
      originalUrl: "https://example.com/p.dntr",
      archiveHash: "abc123",
      ...overrides,
    });

  it("enables the check-for-update button for a URL-installed plugin", async () => {
    (window.electron.plugin.list as ReturnType<typeof vi.fn>).mockResolvedValue([urlPlugin()]);
    renderDialog();
    await selectPlugin();
    const checkBtn = await screen.findByRole("button", { name: "Check Acme Demo for updates" });
    expect(checkBtn.hasAttribute("disabled")).toBe(false);
  });

  it("shows 'Already up to date' when the check finds a matching hash", async () => {
    (window.electron.plugin.list as ReturnType<typeof vi.fn>).mockResolvedValue([urlPlugin()]);
    (window.electron.plugin.checkForUpdate as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: "up-to-date",
    });
    renderDialog();
    await selectPlugin();

    fireEvent.click(await screen.findByRole("button", { name: "Check Acme Demo for updates" }));

    await waitFor(() =>
      expect(window.electron.plugin.checkForUpdate).toHaveBeenCalledWith("acme.demo")
    );
    await waitFor(() => expect(screen.getByText("Already up to date")).toBeTruthy());
  });

  it("opens a confirm dialog with the new version and reinstalls on confirm", async () => {
    (window.electron.plugin.list as ReturnType<typeof vi.fn>).mockResolvedValue([urlPlugin()]);
    (window.electron.plugin.checkForUpdate as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: "available",
      name: "acme.demo",
      version: "2.0.0",
      capabilities: ["network:fetch"],
    });
    renderDialog();
    await selectPlugin();

    fireEvent.click(await screen.findByRole("button", { name: "Check Acme Demo for updates" }));

    await waitFor(() => expect(screen.getByText("Update 'Acme Demo'?")).toBeTruthy());
    expect(screen.getByText("v2.0.0")).toBeTruthy();
    expect(screen.getByText("network:fetch")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Reinstall plugin" }));
    await waitFor(() =>
      expect(window.electron.plugin.installFromUrl).toHaveBeenCalledWith(
        "https://example.com/p.dntr"
      )
    );
  });

  it("guards against double-clicks while a check is in flight", async () => {
    (window.electron.plugin.list as ReturnType<typeof vi.fn>).mockResolvedValue([urlPlugin()]);
    // Never-resolving check keeps the in-flight guard active across both clicks.
    (window.electron.plugin.checkForUpdate as ReturnType<typeof vi.fn>).mockReturnValue(
      new Promise(() => {})
    );
    renderDialog();
    await selectPlugin();

    const btn = await screen.findByRole("button", { name: "Check Acme Demo for updates" });
    fireEvent.click(btn);
    fireEvent.click(btn);

    expect(window.electron.plugin.checkForUpdate).toHaveBeenCalledTimes(1);
  });

  it("shows an error when the update check fails to fetch", async () => {
    (window.electron.plugin.list as ReturnType<typeof vi.fn>).mockResolvedValue([urlPlugin()]);
    (window.electron.plugin.checkForUpdate as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: "fetch-failed",
      message: "HTTP 500",
    });
    renderDialog();
    await selectPlugin();

    fireEvent.click(await screen.findByRole("button", { name: "Check Acme Demo for updates" }));

    await waitFor(() => expect(screen.getByText(/HTTP 500/)).toBeTruthy());
  });

  it("opens the URL dialog and routes the URL through installFromUrl", async () => {
    renderDialog();
    await waitFor(() => expect(screen.getByText("No plugins installed")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Install from URL" }));
    await waitFor(() => expect(screen.getByLabelText("Plugin URL")).toBeTruthy());

    fireEvent.change(screen.getByLabelText("Plugin URL"), {
      target: { value: "https://example.com/p.dntr" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Install" }));

    await waitFor(() =>
      expect(window.electron.plugin.installFromUrl).toHaveBeenCalledWith(
        "https://example.com/p.dntr"
      )
    );
  });

  it("keeps the URL dialog open and shows an error on an invalid URL", async () => {
    (window.electron.plugin.installFromUrl as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: "invalid-url",
    });
    renderDialog();
    await waitFor(() => expect(screen.getByText("No plugins installed")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Install from URL" }));
    await waitFor(() => expect(screen.getByLabelText("Plugin URL")).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Plugin URL"), { target: { value: "not a url" } });
    fireEvent.click(screen.getByRole("button", { name: "Install" }));

    await waitFor(() => expect(screen.getByText(/valid URL/)).toBeTruthy());
    // Dialog stays open so the user can correct the URL.
    expect(screen.getByLabelText("Plugin URL")).toBeTruthy();
  });

  it("shows a notice when install-from-file isn't implemented yet", async () => {
    renderDialog();
    await waitFor(() => expect(screen.getByText("No plugins installed")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Install from file" }));
    await waitFor(() => expect(screen.getByText(/isn't available yet/)).toBeTruthy());
  });

  it("gates an http:// URL behind a confirm dialog before calling installFromUrl", async () => {
    renderDialog();
    await waitFor(() => expect(screen.getByText("No plugins installed")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Install from URL" }));
    await waitFor(() => expect(screen.getByLabelText("Plugin URL")).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Plugin URL"), {
      target: { value: "http://example.com/p.dntr" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Install" }));

    // The confirm gate appears and the IPC call has NOT fired yet.
    await waitFor(() => expect(screen.getByText("Install over HTTP?")).toBeTruthy());
    expect(window.electron.plugin.installFromUrl).not.toHaveBeenCalled();
  });

  it("cancelling the http confirm does not call installFromUrl", async () => {
    renderDialog();
    await waitFor(() => expect(screen.getByText("No plugins installed")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Install from URL" }));
    await waitFor(() => expect(screen.getByLabelText("Plugin URL")).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Plugin URL"), {
      target: { value: "http://example.com/p.dntr" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Install" }));
    await waitFor(() => expect(screen.getByText("Install over HTTP?")).toBeTruthy());

    // The destructive confirm renders as an alertdialog — scope to it so the
    // URL dialog's own "Cancel" (animating out) doesn't collide.
    const confirm = within(screen.getByRole("alertdialog"));
    fireEvent.click(confirm.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByText("Install over HTTP?")).toBeNull());
    expect(window.electron.plugin.installFromUrl).not.toHaveBeenCalled();
    // Cancelling reopens the URL dialog with the typed URL intact so the user
    // can switch to https.
    await waitFor(() =>
      expect((screen.getByLabelText("Plugin URL") as HTMLInputElement).value).toBe(
        "http://example.com/p.dntr"
      )
    );
  });

  it("confirming the http warning routes the URL through installFromUrl", async () => {
    (window.electron.plugin.installFromUrl as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: "installed",
      pluginId: "acme.demo",
    });
    renderDialog();
    await waitFor(() => expect(screen.getByText("No plugins installed")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Install from URL" }));
    await waitFor(() => expect(screen.getByLabelText("Plugin URL")).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Plugin URL"), {
      target: { value: "http://example.com/p.dntr" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Install" }));
    await waitFor(() => expect(screen.getByText("Install over HTTP?")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Install over HTTP" }));
    await waitFor(() =>
      expect(window.electron.plugin.installFromUrl).toHaveBeenCalledWith(
        "http://example.com/p.dntr"
      )
    );
  });

  it("shows a tailored error when a URL install fails with size_exceeded", async () => {
    (window.electron.plugin.installFromUrl as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: "failed",
      errors: [{ code: "size_exceeded", message: "too big" }],
    });
    renderDialog();
    await waitFor(() => expect(screen.getByText("No plugins installed")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Install from URL" }));
    await waitFor(() => expect(screen.getByLabelText("Plugin URL")).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Plugin URL"), {
      target: { value: "https://example.com/p.dntr" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Install" }));

    await waitFor(() => expect(screen.getByText(/larger than the 30 MB limit/)).toBeTruthy());
  });

  it("shows a tailored error when a URL install times out", async () => {
    (window.electron.plugin.installFromUrl as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: "failed",
      errors: [{ code: "fetch_timeout", message: "slow" }],
    });
    renderDialog();
    await waitFor(() => expect(screen.getByText("No plugins installed")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Install from URL" }));
    await waitFor(() => expect(screen.getByLabelText("Plugin URL")).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Plugin URL"), {
      target: { value: "https://example.com/p.dntr" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Install" }));

    await waitFor(() => expect(screen.getByText(/download timed out/)).toBeTruthy());
  });

  it("re-fetches the list when a provenance-changed event fires", async () => {
    let fireProvenance: (() => void) | undefined;
    (window.electron.plugin.onProvenanceChanged as ReturnType<typeof vi.fn>).mockImplementation(
      (cb: () => void) => {
        fireProvenance = cb;
        return () => {};
      }
    );
    const listMock = window.electron.plugin.list as ReturnType<typeof vi.fn>;
    listMock.mockResolvedValue([]);
    renderDialog();
    await waitFor(() => expect(screen.getByText("No plugins installed")).toBeTruthy());
    expect(listMock).toHaveBeenCalledTimes(1);

    fireProvenance?.();
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(2));
  });

  it("routes an http reinstall through the HTTP warning gate before installing", async () => {
    (window.electron.plugin.list as ReturnType<typeof vi.fn>).mockResolvedValue([
      urlPlugin({ originalUrl: "http://example.com/p.dntr" }),
    ]);
    (window.electron.plugin.checkForUpdate as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: "available",
      name: "acme.demo",
      version: "2.0.0",
      capabilities: [],
    });
    renderDialog();
    await selectPlugin();

    fireEvent.click(await screen.findByRole("button", { name: "Check Acme Demo for updates" }));
    await waitFor(() => expect(screen.getByText("Update 'Acme Demo'?")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Reinstall plugin" }));
    // The HTTP gate must intercept the reinstall — installFromUrl stays unfired.
    await waitFor(() => expect(screen.getByText("Install over HTTP?")).toBeTruthy());
    expect(window.electron.plugin.installFromUrl).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Install over HTTP" }));
    await waitFor(() =>
      expect(window.electron.plugin.installFromUrl).toHaveBeenCalledWith(
        "http://example.com/p.dntr"
      )
    );
  });

  it("hides the empty state when the initial list load fails", async () => {
    (window.electron.plugin.list as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("backend down")
    );
    renderDialog();
    await waitFor(() => expect(screen.getByText(/backend down/)).toBeTruthy());
    expect(screen.queryByText("No plugins installed")).toBeNull();
  });

  describe("deep links (#9559)", () => {
    // jsdom lacks scrollIntoView; the open-route effect calls it.
    beforeEach(() => {
      Element.prototype.scrollIntoView = vi.fn();
    });

    it("pre-fills the URL dialog for an install intent without installing", async () => {
      const onConsumed = vi.fn();
      render(
        <TooltipProvider>
          <PluginManagerView
            deepLinkIntent={{ action: "install", url: "https://example.com/p.dntr" }}
            onDeepLinkConsumed={onConsumed}
          />
        </TooltipProvider>
      );

      await waitFor(() =>
        expect((screen.getByLabelText("Plugin URL") as HTMLInputElement).value).toBe(
          "https://example.com/p.dntr"
        )
      );
      // Never auto-installs — the user must press install (gates stay intact).
      expect(window.electron.plugin.installFromUrl).not.toHaveBeenCalled();
      expect(onConsumed).toHaveBeenCalledOnce();
    });

    it("scrolls to and highlights the target row for an open intent", async () => {
      (window.electron.plugin.list as ReturnType<typeof vi.fn>).mockResolvedValue([
        makePlugin({ manifest: { ...makePlugin().manifest, name: "acme.demo" } }),
      ]);
      const onConsumed = vi.fn();
      render(
        <TooltipProvider>
          <PluginManagerView
            deepLinkIntent={{ action: "open", pluginId: "acme.demo" }}
            onDeepLinkConsumed={onConsumed}
          />
        </TooltipProvider>
      );

      await waitFor(() => expect(Element.prototype.scrollIntoView).toHaveBeenCalled());
      expect(onConsumed).toHaveBeenCalledOnce();
    });

    it("does not clobber a URL dialog the user already has open", async () => {
      const { rerender } = render(
        <TooltipProvider>
          <PluginManagerView
            deepLinkIntent={{ action: "install", url: "https://first.example/p.dntr" }}
            onDeepLinkConsumed={() => {}}
          />
        </TooltipProvider>
      );
      await waitFor(() =>
        expect((screen.getByLabelText("Plugin URL") as HTMLInputElement).value).toBe(
          "https://first.example/p.dntr"
        )
      );
      // User edits the field…
      fireEvent.change(screen.getByLabelText("Plugin URL"), {
        target: { value: "https://user-typed.example/p.dntr" },
      });
      // …a second deep link arrives while the dialog is open — it must not win.
      rerender(
        <TooltipProvider>
          <PluginManagerView
            deepLinkIntent={{ action: "install", url: "https://second.example/p.dntr" }}
            onDeepLinkConsumed={() => {}}
          />
        </TooltipProvider>
      );
      expect((screen.getByLabelText("Plugin URL") as HTMLInputElement).value).toBe(
        "https://user-typed.example/p.dntr"
      );
    });

    it("shows a notice when an open intent targets an uninstalled plugin", async () => {
      (window.electron.plugin.list as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      render(
        <TooltipProvider>
          <PluginManagerView
            deepLinkIntent={{ action: "open", pluginId: "missing.plugin" }}
            onDeepLinkConsumed={() => {}}
          />
        </TooltipProvider>
      );

      await waitFor(() =>
        expect(screen.getByText(/Plugin "missing\.plugin" isn't installed/)).toBeTruthy()
      );
    });
  });

  describe("restart-required bar", () => {
    it("hides the bar when no plugin is pending a restart", async () => {
      (window.electron.plugin.list as ReturnType<typeof vi.fn>).mockResolvedValue([makePlugin()]);
      renderDialog();
      await waitFor(() => expect(screen.getByText("Acme Demo")).toBeTruthy());
      expect(screen.queryByText("Restart required to apply plugin changes")).toBeNull();
    });

    it("shows the bar when a plugin reports pendingRestart", async () => {
      (window.electron.plugin.list as ReturnType<typeof vi.fn>).mockResolvedValue([
        makePlugin({ disabled: true, pendingRestart: true }),
      ]);
      renderDialog();
      await waitFor(() =>
        expect(screen.getByText("Restart required to apply plugin changes")).toBeTruthy()
      );
      expect(screen.getByRole("button", { name: "Restart" })).toBeTruthy();
    });

    it("appears after a toggle flips a plugin into the pending-restart state", async () => {
      (window.electron.plugin.list as ReturnType<typeof vi.fn>).mockResolvedValue([makePlugin()]);
      renderDialog();
      await waitFor(() => expect(screen.getByText("Acme Demo")).toBeTruthy());
      expect(screen.queryByText("Restart required to apply plugin changes")).toBeNull();

      fireEvent.click(screen.getByRole("switch", { name: "Enable Acme Demo" }));
      await waitFor(() =>
        expect(screen.getByText("Restart required to apply plugin changes")).toBeTruthy()
      );
    });

    it("confirms before relaunching and does not restart until confirmed", async () => {
      (window.electron.plugin.list as ReturnType<typeof vi.fn>).mockResolvedValue([
        makePlugin({ disabled: true, pendingRestart: true }),
      ]);
      renderDialog();
      await waitFor(() => expect(screen.getByRole("button", { name: "Restart" })).toBeTruthy());

      fireEvent.click(screen.getByRole("button", { name: "Restart" }));
      await waitFor(() => expect(screen.getByText("Restart Daintree now?")).toBeTruthy());
      expect(window.electron.app.resetAndRelaunch).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole("button", { name: "Restart Daintree" }));
      await waitFor(() => expect(window.electron.app.resetAndRelaunch).toHaveBeenCalledTimes(1));
    });

    it("does not relaunch when the restart confirm is cancelled", async () => {
      (window.electron.plugin.list as ReturnType<typeof vi.fn>).mockResolvedValue([
        makePlugin({ disabled: true, pendingRestart: true }),
      ]);
      renderDialog();
      await waitFor(() => expect(screen.getByRole("button", { name: "Restart" })).toBeTruthy());

      fireEvent.click(screen.getByRole("button", { name: "Restart" }));
      await waitFor(() => expect(screen.getByText("Restart Daintree now?")).toBeTruthy());

      const confirm = within(screen.getByRole("alertdialog"));
      fireEvent.click(confirm.getByRole("button", { name: "Not now" }));
      await waitFor(() => expect(screen.queryByText("Restart Daintree now?")).toBeNull());
      expect(window.electron.app.resetAndRelaunch).not.toHaveBeenCalled();
    });

    it("relaunches once and keeps the confirm open while the relaunch is in flight", async () => {
      // A never-resolving relaunch keeps `isRestarting` latched so we can probe
      // the in-flight UI (blocked close) and the double-invoke guard.
      (window.electron.app.resetAndRelaunch as ReturnType<typeof vi.fn>).mockReturnValue(
        new Promise(() => {})
      );
      (window.electron.plugin.list as ReturnType<typeof vi.fn>).mockResolvedValue([
        makePlugin({ disabled: true, pendingRestart: true }),
      ]);
      renderDialog();
      await waitFor(() => expect(screen.getByRole("button", { name: "Restart" })).toBeTruthy());

      fireEvent.click(screen.getByRole("button", { name: "Restart" }));
      await waitFor(() => expect(screen.getByText("Restart Daintree now?")).toBeTruthy());

      // Double-click the confirm before the in-flight state commits — only one
      // relaunch request must go out.
      const confirmBtn = within(screen.getByRole("alertdialog")).getByRole("button", {
        name: "Restart Daintree",
      });
      fireEvent.click(confirmBtn);
      fireEvent.click(confirmBtn);
      await waitFor(() => expect(window.electron.app.resetAndRelaunch).toHaveBeenCalledTimes(1));

      // The confirm stays open (close is blocked) while the relaunch is pending.
      expect(screen.getByText("Restart Daintree now?")).toBeTruthy();
    });

    it("re-enables the restart flow when resetAndRelaunch rejects", async () => {
      (window.electron.app.resetAndRelaunch as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("EROFS")
      );
      (window.electron.plugin.list as ReturnType<typeof vi.fn>).mockResolvedValue([
        makePlugin({ disabled: true, pendingRestart: true }),
      ]);
      renderDialog();
      await waitFor(() => expect(screen.getByRole("button", { name: "Restart" })).toBeTruthy());

      fireEvent.click(screen.getByRole("button", { name: "Restart" }));
      await waitFor(() => expect(screen.getByText("Restart Daintree now?")).toBeTruthy());
      fireEvent.click(
        within(screen.getByRole("alertdialog")).getByRole("button", { name: "Restart Daintree" })
      );
      await waitFor(() => expect(window.electron.app.resetAndRelaunch).toHaveBeenCalledTimes(1));

      // After the rejection the confirm is dismissible again and a second
      // attempt fires a fresh relaunch request — the user isn't stranded.
      await waitFor(() =>
        expect(
          within(screen.getByRole("alertdialog"))
            .getByRole("button", { name: "Restart Daintree" })
            .hasAttribute("disabled")
        ).toBe(false)
      );
      fireEvent.click(
        within(screen.getByRole("alertdialog")).getByRole("button", { name: "Restart Daintree" })
      );
      await waitFor(() => expect(window.electron.app.resetAndRelaunch).toHaveBeenCalledTimes(2));
    });

    it("keeps the bar visible across selecting and deselecting a row", async () => {
      (window.electron.plugin.list as ReturnType<typeof vi.fn>).mockResolvedValue([
        makePlugin({ disabled: true, pendingRestart: true }),
      ]);
      renderDialog();
      await waitFor(() =>
        expect(screen.getByText("Restart required to apply plugin changes")).toBeTruthy()
      );

      // The bar derives from plugin state, not the detail-pane selection
      // lifecycle — it must survive a select then deselect.
      await selectPlugin();
      expect(screen.getByText("Restart required to apply plugin changes")).toBeTruthy();
      await selectPlugin();
      expect(screen.getByText("Restart required to apply plugin changes")).toBeTruthy();
    });
  });

  describe("grouping", () => {
    // Distinct manifest names + display names so each plugin is uniquely
    // addressable across sections. Section headers are now role="option"
    // aria-disabled rows inside role="presentation" wrappers (LESSON #9006 —
    // role="group" inside role="listbox" drops under Chromium 146 + VoiceOver).
    const named = (
      overrides: Partial<Omit<LoadedPluginInfo, "manifest">> & {
        manifest?: Partial<LoadedPluginInfo["manifest"]>;
      } = {}
    ): LoadedPluginInfo => {
      const { manifest: manifestOverride, ...rest } = overrides;
      const base = makePlugin(rest);
      return {
        ...base,
        manifest: { ...base.manifest, ...manifestOverride },
      };
    };

    // Section header rows are aria-disabled options with aria-label set to the
    // section name. Find a plugin's section by locating the section header option
    // and the nearest listbox, then scoping within it.
    const pluginInSection = (sectionLabel: string, pluginName: string) => {
      const listbox = screen.getByRole("listbox");
      const sectionHeader = within(listbox).getByRole("option", {
        name: sectionLabel,
      });
      // The section header and its sibling rows share a role="presentation" parent.
      const sectionContainer = sectionHeader.closest("[role='presentation']") as HTMLElement;
      return within(sectionContainer).getByText(pluginName);
    };

    const sectionExists = (sectionLabel: string) => {
      const listbox = screen.getByRole("listbox");
      return within(listbox).queryByRole("option", { name: sectionLabel }) !== null;
    };

    it("places an enabled built-in plugin in the Built-in section", async () => {
      (window.electron.plugin.list as ReturnType<typeof vi.fn>).mockResolvedValue([
        named({
          manifest: { name: "core.tools", displayName: "Core Tools" },
          isBuiltin: true,
          source: "builtin",
        }),
      ]);
      renderDialog();
      await waitFor(() => expect(screen.getByText("Core Tools")).toBeTruthy());
      expect(pluginInSection("Built-in", "Core Tools")).toBeTruthy();
      expect(sectionExists("Disabled")).toBe(false);
      expect(sectionExists("Installed")).toBe(false);
    });

    it("places an enabled user plugin in the Installed section", async () => {
      (window.electron.plugin.list as ReturnType<typeof vi.fn>).mockResolvedValue([
        named({ manifest: { name: "acme.demo", displayName: "Acme Demo" }, source: "sideload" }),
      ]);
      renderDialog();
      await waitFor(() => expect(screen.getByText("Acme Demo")).toBeTruthy());
      expect(pluginInSection("Installed", "Acme Demo")).toBeTruthy();
      expect(sectionExists("Built-in")).toBe(false);
    });

    it("places a disabled built-in in the Disabled section, not Built-in", async () => {
      (window.electron.plugin.list as ReturnType<typeof vi.fn>).mockResolvedValue([
        named({
          manifest: { name: "core.tools", displayName: "Core Tools" },
          isBuiltin: true,
          source: "builtin",
          disabled: true,
        }),
      ]);
      renderDialog();
      await waitFor(() => expect(screen.getByText("Core Tools")).toBeTruthy());
      expect(pluginInSection("Disabled", "Core Tools")).toBeTruthy();
      expect(sectionExists("Built-in")).toBe(false);
    });

    it("places a disabled user plugin in the Disabled section", async () => {
      (window.electron.plugin.list as ReturnType<typeof vi.fn>).mockResolvedValue([
        named({ manifest: { name: "acme.demo", displayName: "Acme Demo" }, disabled: true }),
      ]);
      renderDialog();
      await waitFor(() => expect(screen.getByText("Acme Demo")).toBeTruthy());
      expect(pluginInSection("Disabled", "Acme Demo")).toBeTruthy();
    });

    it("renders all three sections for a mixed list and hides none", async () => {
      (window.electron.plugin.list as ReturnType<typeof vi.fn>).mockResolvedValue([
        named({
          manifest: { name: "core.tools", displayName: "Core Tools" },
          isBuiltin: true,
          source: "builtin",
        }),
        named({ manifest: { name: "acme.demo", displayName: "Acme Demo" }, source: "sideload" }),
        named({ manifest: { name: "old.thing", displayName: "Old Thing" }, disabled: true }),
      ]);
      renderDialog();
      await waitFor(() => expect(screen.getByText("Core Tools")).toBeTruthy());
      expect(pluginInSection("Built-in", "Core Tools")).toBeTruthy();
      expect(pluginInSection("Installed", "Acme Demo")).toBeTruthy();
      expect(pluginInSection("Disabled", "Old Thing")).toBeTruthy();
      // Each plugin lands in exactly one section.
      expect(screen.getAllByText("Core Tools").length).toBe(1);
      expect(screen.getAllByText("Acme Demo").length).toBe(1);
      expect(screen.getAllByText("Old Thing").length).toBe(1);
      // Sections render in the order Built-in → Installed → Disabled.
      // The section headers are aria-disabled options with aria-labelledby
      // pointing to their id. Verify DOM order by checking option ids.
      const listbox = screen.getByRole("listbox");
      const sectionHeaders = within(listbox)
        .getAllByRole("option", { hidden: true })
        .filter((el) => el.getAttribute("aria-disabled") === "true")
        .map((el) => el.getAttribute("aria-label"));
      expect(sectionHeaders).toEqual(["Built-in", "Installed", "Disabled"]);
    });

    it("omits the Disabled section when every plugin is enabled", async () => {
      (window.electron.plugin.list as ReturnType<typeof vi.fn>).mockResolvedValue([
        named({ manifest: { name: "acme.demo", displayName: "Acme Demo" } }),
      ]);
      renderDialog();
      await waitFor(() => expect(screen.getByText("Acme Demo")).toBeTruthy());
      expect(sectionExists("Disabled")).toBe(false);
    });

    it("omits the Built-in and Installed sections when every plugin is disabled", async () => {
      (window.electron.plugin.list as ReturnType<typeof vi.fn>).mockResolvedValue([
        named({ manifest: { name: "acme.demo", displayName: "Acme Demo" }, disabled: true }),
      ]);
      renderDialog();
      await waitFor(() => expect(screen.getByText("Acme Demo")).toBeTruthy());
      expect(sectionExists("Built-in")).toBe(false);
      expect(sectionExists("Installed")).toBe(false);
      expect(sectionExists("Disabled")).toBe(true);
    });

    it("preserves alphabetical order within a section", async () => {
      (window.electron.plugin.list as ReturnType<typeof vi.fn>).mockResolvedValue([
        named({ manifest: { name: "z.plugin", displayName: "Zebra" } }),
        named({ manifest: { name: "a.plugin", displayName: "Alpha" } }),
      ]);
      renderDialog();
      await waitFor(() => expect(screen.getByText("Alpha")).toBeTruthy());
      const listbox = screen.getByRole("listbox");
      const sectionHeader = within(listbox).getByRole("option", { name: "Installed" });
      const sectionContainer = sectionHeader.closest("[role='presentation']") as HTMLElement;
      const labels = within(sectionContainer)
        .getAllByText(/Alpha|Zebra/)
        .map((el) => el.textContent);
      expect(labels).toEqual(["Alpha", "Zebra"]);
    });
  });

  describe("search (#9557)", () => {
    // The search box only appears once the list is long enough to need it
    // (PLUGIN_SEARCH_MIN_ITEMS = 10). Generate distinct, addressable plugins.
    const make = (
      name: string,
      overrides: Partial<Omit<LoadedPluginInfo, "manifest">> & {
        manifest?: Partial<LoadedPluginInfo["manifest"]>;
      } = {}
    ): LoadedPluginInfo => {
      const { manifest: manifestOverride, ...rest } = overrides;
      const base = makePlugin(rest);
      return {
        ...base,
        manifest: {
          ...base.manifest,
          name: `pkg.${name}`,
          displayName: name,
          ...manifestOverride,
        },
      };
    };

    const manyPlugins = (count: number) =>
      Array.from({ length: count }, (_, i) => make(`Plugin${String(i).padStart(2, "0")}`));

    it("hides the filter input below the item threshold", async () => {
      (window.electron.plugin.list as ReturnType<typeof vi.fn>).mockResolvedValue(manyPlugins(9));
      renderDialog();
      await waitFor(() => expect(screen.getByText("Plugin00")).toBeTruthy());
      expect(screen.queryByLabelText("Filter plugins")).toBeNull();
    });

    it("shows the filter input at the item threshold", async () => {
      (window.electron.plugin.list as ReturnType<typeof vi.fn>).mockResolvedValue(manyPlugins(10));
      renderDialog();
      await waitFor(() => expect(screen.getByLabelText("Filter plugins")).toBeTruthy());
    });

    it("filters the list by free text", async () => {
      const plugins = [
        ...manyPlugins(10),
        make("Notepad", { manifest: { name: "pkg.notepad", displayName: "Notepad" } }),
      ];
      (window.electron.plugin.list as ReturnType<typeof vi.fn>).mockResolvedValue(plugins);
      renderDialog();
      const input = await screen.findByLabelText("Filter plugins");
      fireEvent.change(input, { target: { value: "Notepad" } });
      await waitFor(() => expect(screen.getByText("Notepad")).toBeTruthy());
      expect(screen.queryByText("Plugin00")).toBeNull();
    });

    it("injects an operator token when a filter chip is clicked", async () => {
      const plugins = [
        ...manyPlugins(10),
        make("CoreThing", {
          manifest: { name: "pkg.core", displayName: "CoreThing" },
          isBuiltin: true,
          source: "builtin",
        }),
      ];
      (window.electron.plugin.list as ReturnType<typeof vi.fn>).mockResolvedValue(plugins);
      renderDialog();
      await screen.findByLabelText("Filter plugins");
      fireEvent.click(screen.getByRole("button", { name: "Built-in" }));
      const input = screen.getByLabelText<HTMLInputElement>("Filter plugins");
      expect(input.value).toBe("@builtin");
      await waitFor(() => expect(screen.getByText("CoreThing")).toBeTruthy());
      expect(screen.queryByText("Plugin00")).toBeNull();
    });

    it("appends an operator chip after existing free text", async () => {
      (window.electron.plugin.list as ReturnType<typeof vi.fn>).mockResolvedValue(manyPlugins(10));
      renderDialog();
      const input = await screen.findByLabelText<HTMLInputElement>("Filter plugins");
      fireEvent.change(input, { target: { value: "notes" } });
      fireEvent.click(screen.getByRole("button", { name: "Installed" }));
      expect(screen.getByLabelText<HTMLInputElement>("Filter plugins").value).toBe(
        "notes @installed"
      );
    });

    it("does not duplicate an operator that is already present (case-insensitive)", async () => {
      (window.electron.plugin.list as ReturnType<typeof vi.fn>).mockResolvedValue(manyPlugins(10));
      renderDialog();
      const input = await screen.findByLabelText<HTMLInputElement>("Filter plugins");
      fireEvent.change(input, { target: { value: "@BUILTIN" } });
      fireEvent.click(screen.getByRole("button", { name: "Built-in" }));
      expect(screen.getByLabelText<HTMLInputElement>("Filter plugins").value).toBe("@BUILTIN");
    });

    it("filters by the @cap operator with a colon-bearing value", async () => {
      const plugins = [
        ...manyPlugins(10),
        make("NetPlugin", {
          manifest: {
            name: "pkg.net",
            displayName: "NetPlugin",
            capabilities: ["network:fetch"],
          },
        }),
      ];
      (window.electron.plugin.list as ReturnType<typeof vi.fn>).mockResolvedValue(plugins);
      renderDialog();
      const input = await screen.findByLabelText("Filter plugins");
      fireEvent.change(input, { target: { value: "@cap:network:fetch" } });
      await waitFor(() => expect(screen.getByText("NetPlugin")).toBeTruthy());
      expect(screen.queryByText("Plugin00")).toBeNull();
    });

    it("renders a flat list with no group sections while filtering", async () => {
      (window.electron.plugin.list as ReturnType<typeof vi.fn>).mockResolvedValue(manyPlugins(10));
      renderDialog();
      const input = await screen.findByLabelText("Filter plugins");
      fireEvent.change(input, { target: { value: "Plugin00" } });
      await waitFor(() => expect(screen.queryByText("Plugin01")).toBeNull());
      expect(screen.getByText("Plugin00")).toBeTruthy();
      // When filtering, section header options are gone.
      const listbox = screen.getByRole("listbox");
      expect(within(listbox).queryByRole("option", { name: "Installed" })).toBeNull();
    });

    it("shows a zero-result state with a Clear search control", async () => {
      (window.electron.plugin.list as ReturnType<typeof vi.fn>).mockResolvedValue(manyPlugins(10));
      renderDialog();
      const input = await screen.findByLabelText("Filter plugins");
      fireEvent.change(input, { target: { value: "zzzznomatch" } });
      await waitFor(() => expect(screen.getByText("No matching plugins")).toBeTruthy());
      fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
      await waitFor(() => expect(screen.getByText("Plugin00")).toBeTruthy());
    });

    it("clears the selected plugin when the filter hides it", async () => {
      const plugins = [
        ...manyPlugins(10),
        make("Notepad", { manifest: { name: "pkg.notepad", displayName: "Notepad" } }),
      ];
      (window.electron.plugin.list as ReturnType<typeof vi.fn>).mockResolvedValue(plugins);
      renderDialog();
      await screen.findByLabelText("Filter plugins");
      fireEvent.click(await screen.findByRole("option", { name: /Plugin00/ }));
      // Detail pane now shows the selected plugin's uninstall control.
      await waitFor(() => expect(screen.getByRole("button", { name: /uninstall/i })).toBeTruthy());
      const input = screen.getByLabelText("Filter plugins");
      fireEvent.change(input, { target: { value: "Notepad" } });
      // Plugin00 is filtered out, so the detail pane falls back to its empty state.
      await waitFor(() => expect(screen.getByText("Select a plugin")).toBeTruthy());
    });
  });
});
