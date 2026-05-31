// @vitest-environment jsdom

import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { PluginManagerDialog } from "../PluginManagerDialog";
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

// AppDialog observes its scroll container, which jsdom lacks.
class StubResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", StubResizeObserver);

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
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
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
      <PluginManagerDialog isOpen onClose={() => {}} />
    </TooltipProvider>
  );
}

describe("PluginManagerDialog", () => {
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

  it("renders a plugin's settings form inline when it contributes settings", async () => {
    (window.electron.plugin.list as ReturnType<typeof vi.fn>).mockResolvedValue([
      makePluginWithSettings(),
    ]);
    renderDialog();
    await waitFor(() => expect(screen.getByText("Acme Demo")).toBeTruthy());
    expect(screen.getByText("Settings")).toBeTruthy();
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
    expect(screen.getByText("Settings")).toBeTruthy();
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

  it("renders no settings section when a plugin contributes none", async () => {
    (window.electron.plugin.list as ReturnType<typeof vi.fn>).mockResolvedValue([makePlugin()]);
    renderDialog();
    await waitFor(() => expect(screen.getByText("Acme Demo")).toBeTruthy());
    expect(screen.queryByText("Settings")).toBeNull();
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

  it("shows a source badge and install time for a file-installed plugin", async () => {
    (window.electron.plugin.list as ReturnType<typeof vi.fn>).mockResolvedValue([
      makePlugin({ source: "sideload", installedAt: Date.now() - 60_000 }),
    ]);
    renderDialog();
    await waitFor(() => expect(screen.getByText("Acme Demo")).toBeTruthy());
    expect(screen.getByText("File")).toBeTruthy();
    expect(screen.getByText(/Installed.*ago/)).toBeTruthy();
  });

  it("shows a Dev badge for a dev-mode plugin", async () => {
    (window.electron.plugin.list as ReturnType<typeof vi.fn>).mockResolvedValue([
      makePlugin({ devMode: true }),
    ]);
    renderDialog();
    await waitFor(() => expect(screen.getByText("Dev")).toBeTruthy());
  });

  it("renders a load-error indicator when loadError is set", async () => {
    (window.electron.plugin.list as ReturnType<typeof vi.fn>).mockResolvedValue([
      makePlugin({ loadError: { message: "boom", at: 1 } }),
    ]);
    renderDialog();
    await waitFor(() => expect(screen.getByText(/Failed to load: boom/)).toBeTruthy());
  });

  it("does not offer uninstall for a built-in plugin", async () => {
    (window.electron.plugin.list as ReturnType<typeof vi.fn>).mockResolvedValue([
      makePlugin({ isBuiltin: true, source: "builtin" }),
    ]);
    renderDialog();
    await waitFor(() => expect(screen.getByText("Acme Demo")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Uninstall Acme Demo" })).toBeNull();
    expect(screen.getByText("Built-in")).toBeTruthy();
  });

  it("opens a confirm dialog and uninstalls (settings preserved by default), then re-fetches the list", async () => {
    const listMock = window.electron.plugin.list as ReturnType<typeof vi.fn>;
    listMock.mockResolvedValueOnce([makePlugin()]).mockResolvedValueOnce([]);
    renderDialog();
    await waitFor(() => expect(screen.getByText("Acme Demo")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Uninstall Acme Demo" }));
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
    await waitFor(() => expect(screen.getByText("Acme Demo")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Uninstall Acme Demo" }));
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
    await waitFor(() => expect(screen.getByText("Acme Demo")).toBeTruthy());

    // Arm, tick the box, then cancel.
    fireEvent.click(screen.getByRole("button", { name: "Uninstall Acme Demo" }));
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
    await waitFor(() => expect(screen.getByText("Acme Demo")).toBeTruthy());
    const checkBtn = screen.getByRole("button", { name: "Check Acme Demo for updates" });
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
    await waitFor(() => expect(screen.getByText("Acme Demo")).toBeTruthy());
    const checkBtn = screen.getByRole("button", { name: "Check Acme Demo for updates" });
    expect(checkBtn.hasAttribute("disabled")).toBe(false);
  });

  it("shows 'Already up to date' when the check finds a matching hash", async () => {
    (window.electron.plugin.list as ReturnType<typeof vi.fn>).mockResolvedValue([urlPlugin()]);
    (window.electron.plugin.checkForUpdate as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: "up-to-date",
    });
    renderDialog();
    await waitFor(() => expect(screen.getByText("Acme Demo")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Check Acme Demo for updates" }));

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
    await waitFor(() => expect(screen.getByText("Acme Demo")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Check Acme Demo for updates" }));

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
    await waitFor(() => expect(screen.getByText("Acme Demo")).toBeTruthy());

    const btn = screen.getByRole("button", { name: "Check Acme Demo for updates" });
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
    await waitFor(() => expect(screen.getByText("Acme Demo")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Check Acme Demo for updates" }));

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
    await waitFor(() => expect(screen.getByText("Acme Demo")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Check Acme Demo for updates" }));
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
});
