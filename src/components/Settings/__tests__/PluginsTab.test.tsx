// @vitest-environment jsdom

import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { PluginsTab } from "../PluginsTab";
import { SettingsValidationProvider } from "../SettingsValidationRegistry";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { LoadedPluginInfo } from "@shared/types/plugin";

vi.mock("@/utils/logger", () => ({
  logError: vi.fn(),
  logWarn: vi.fn(),
  logInfo: vi.fn(),
  logDebug: vi.fn(),
}));

// AppDialog (used by the uninstall confirm + URL dialog) observes its scroll
// container, which jsdom lacks.
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
      uninstall: vi.fn().mockResolvedValue(undefined),
      checkForUpdate: vi.fn().mockResolvedValue({ status: "up-to-date" }),
      onProvenanceChanged: vi.fn().mockReturnValue(() => {}),
    },
  } as unknown as typeof window.electron;
});

function renderTab() {
  return render(
    <TooltipProvider>
      <SettingsValidationProvider>
        <PluginsTab />
      </SettingsValidationProvider>
    </TooltipProvider>
  );
}

describe("PluginsTab", () => {
  it("renders the section header immediately", async () => {
    renderTab();
    expect(screen.getByText("Installed plugins")).toBeTruthy();
  });

  it("shows an empty state when no plugins are installed", async () => {
    renderTab();
    await waitFor(() => {
      expect(screen.getByText("No plugins installed")).toBeTruthy();
    });
  });

  it("lists installed plugins with a toggle", async () => {
    (window.electron.plugin.list as ReturnType<typeof vi.fn>).mockResolvedValue([makePlugin()]);
    renderTab();
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
    renderTab();
    await waitFor(() => {
      expect(screen.getByText("Acme Demo")).toBeTruthy();
    });
    const toggle = screen.getByRole("switch", { name: "Enable Acme Demo" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
  });

  it("calls setEnabled(false) and shows a restart badge when disabling", async () => {
    (window.electron.plugin.list as ReturnType<typeof vi.fn>).mockResolvedValue([makePlugin()]);
    renderTab();
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
    // After a toggle the main process persists the change and reports it back
    // as disabled+pendingRestart; a tab remount must not lose the cue.
    (window.electron.plugin.list as ReturnType<typeof vi.fn>).mockResolvedValue([
      makePlugin({ disabled: true, pendingRestart: true }),
    ]);
    renderTab();
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
    renderTab();
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
    renderTab();
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
    renderTab();
    expect(screen.getByRole("button", { name: "Install from file" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Install from URL" })).toBeTruthy();
  });

  it("shows a source badge and install time for a file-installed plugin", async () => {
    (window.electron.plugin.list as ReturnType<typeof vi.fn>).mockResolvedValue([
      makePlugin({ source: "sideload", installedAt: Date.now() - 60_000 }),
    ]);
    renderTab();
    await waitFor(() => expect(screen.getByText("Acme Demo")).toBeTruthy());
    expect(screen.getByText("File")).toBeTruthy();
    expect(screen.getByText(/Installed.*ago/)).toBeTruthy();
  });

  it("shows a Dev badge for a dev-mode plugin", async () => {
    (window.electron.plugin.list as ReturnType<typeof vi.fn>).mockResolvedValue([
      makePlugin({ devMode: true }),
    ]);
    renderTab();
    await waitFor(() => expect(screen.getByText("Dev")).toBeTruthy());
  });

  it("renders a load-error indicator when loadError is set", async () => {
    (window.electron.plugin.list as ReturnType<typeof vi.fn>).mockResolvedValue([
      makePlugin({ loadError: { message: "boom", at: 1 } }),
    ]);
    renderTab();
    await waitFor(() => expect(screen.getByText(/Failed to load: boom/)).toBeTruthy());
  });

  it("does not offer uninstall for a built-in plugin", async () => {
    (window.electron.plugin.list as ReturnType<typeof vi.fn>).mockResolvedValue([
      makePlugin({ isBuiltin: true, source: "builtin" }),
    ]);
    renderTab();
    await waitFor(() => expect(screen.getByText("Acme Demo")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Uninstall Acme Demo" })).toBeNull();
    expect(screen.getByText("Built-in")).toBeTruthy();
  });

  it("opens a confirm dialog and uninstalls (settings preserved by default), then re-fetches the list", async () => {
    const listMock = window.electron.plugin.list as ReturnType<typeof vi.fn>;
    listMock.mockResolvedValueOnce([makePlugin()]).mockResolvedValueOnce([]);
    renderTab();
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
    renderTab();
    await waitFor(() => expect(screen.getByText("Acme Demo")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Uninstall Acme Demo" }));
    await waitFor(() => expect(screen.getByText("Uninstall 'Acme Demo'?")).toBeTruthy());

    fireEvent.click(
      screen.getByRole("checkbox", { name: "Also delete stored settings and secrets" })
    );
    fireEvent.click(screen.getByRole("button", { name: "Uninstall plugin" }));
    await waitFor(() =>
      expect(window.electron.plugin.uninstall).toHaveBeenCalledWith("acme.demo", true)
    );
  });

  it("resets the secrets checkbox after cancelling and re-arming uninstall", async () => {
    (window.electron.plugin.list as ReturnType<typeof vi.fn>).mockResolvedValue([makePlugin()]);
    renderTab();
    await waitFor(() => expect(screen.getByText("Acme Demo")).toBeTruthy());

    // Arm, tick the box, then cancel.
    fireEvent.click(screen.getByRole("button", { name: "Uninstall Acme Demo" }));
    await waitFor(() => expect(screen.getByText("Uninstall 'Acme Demo'?")).toBeTruthy());
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Also delete stored settings and secrets" })
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
    renderTab();
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
    renderTab();
    await waitFor(() => expect(screen.getByText("Acme Demo")).toBeTruthy());
    const checkBtn = screen.getByRole("button", { name: "Check Acme Demo for updates" });
    expect(checkBtn.hasAttribute("disabled")).toBe(false);
  });

  it("shows 'Already up to date' when the check finds a matching hash", async () => {
    (window.electron.plugin.list as ReturnType<typeof vi.fn>).mockResolvedValue([urlPlugin()]);
    (window.electron.plugin.checkForUpdate as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: "up-to-date",
    });
    renderTab();
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
    renderTab();
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
    renderTab();
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
    renderTab();
    await waitFor(() => expect(screen.getByText("Acme Demo")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Check Acme Demo for updates" }));

    await waitFor(() => expect(screen.getByText(/HTTP 500/)).toBeTruthy());
  });

  it("opens the URL dialog and routes the URL through installFromUrl", async () => {
    renderTab();
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
    renderTab();
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
    renderTab();
    await waitFor(() => expect(screen.getByText("No plugins installed")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Install from file" }));
    await waitFor(() => expect(screen.getByText(/isn't available yet/)).toBeTruthy());
  });

  it("gates an http:// URL behind a confirm dialog before calling installFromUrl", async () => {
    renderTab();
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
    renderTab();
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
    renderTab();
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
    renderTab();
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
    renderTab();
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
    renderTab();
    await waitFor(() => expect(screen.getByText("No plugins installed")).toBeTruthy());
    expect(listMock).toHaveBeenCalledTimes(1);

    fireProvenance?.();
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(2));
  });
});
