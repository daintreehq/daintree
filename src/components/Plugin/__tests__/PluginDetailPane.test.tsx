// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { PluginDetailPane } from "../PluginDetailPane";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  BUILT_IN_PLUGIN_CAPABILITIES,
  type BuiltInPluginCapability,
  type LoadedPluginInfo,
} from "@shared/types/plugin";

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

function makePlugin(overrides: Partial<LoadedPluginInfo> = {}): LoadedPluginInfo {
  return {
    manifest: {
      name: "acme.demo",
      version: "1.0.0",
      displayName: "Acme Demo",
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
    loadedAt: 1,
    isBuiltin: false,
    disabled: false,
    pendingRestart: false,
    source: "sideload",
    installedAt: 1,
    archiveHash: null,
    originalUrl: null,
    loadError: null,
    updateAvailable: null,
    devMode: false,
    pluginDanger: "safe",
    ...overrides,
  };
}

function withCapabilities(
  caps: BuiltInPluginCapability[],
  overrides: Partial<LoadedPluginInfo> = {}
): LoadedPluginInfo {
  const base = makePlugin(overrides);
  return {
    ...base,
    manifest: { ...base.manifest, capabilities: caps, ...overrides.manifest },
  };
}

// Capabilities now live behind the "Permissions" subtab in the graduated
// tabbed detail pane (#9558); activate it so the permission rows render.
function renderPane(plugin: LoadedPluginInfo) {
  const result = render(
    <TooltipProvider>
      <PluginDetailPane
        plugin={plugin}
        checkingUpdate={false}
        upToDate={false}
        onUninstall={vi.fn()}
        onCheckForUpdate={vi.fn()}
      />
    </TooltipProvider>
  );
  fireEvent.click(screen.getByRole("tab", { name: "Permissions" }));
  return result;
}

describe("PluginDetailPane capabilities", () => {
  it("shows the no-permissions empty state when no capabilities are declared", () => {
    renderPane(makePlugin());
    expect(screen.getByText("No special permissions")).toBeTruthy();
  });

  it("renders a labelled row for each declared capability", () => {
    renderPane(withCapabilities(["fs:project-read", "shell:exec"]));
    expect(screen.getByText("Read project files")).toBeTruthy();
    expect(screen.getByText("Run shell commands")).toBeTruthy();
  });

  it("does not show the danger summary banner when pluginDanger is safe", () => {
    renderPane(withCapabilities(["fs:project-read"], { pluginDanger: "safe" }));
    expect(screen.queryByText(/Requests sensitive permissions/)).toBeNull();
  });

  it("shows the danger summary banner when pluginDanger is confirm", () => {
    renderPane(withCapabilities(["shell:exec"], { pluginDanger: "confirm" }));
    expect(screen.getByText(/Requests sensitive permissions/)).toBeTruthy();
  });

  it("lists the network allowlist under the network:fetch row when scoped", () => {
    const plugin = withCapabilities(["network:fetch"], {
      pluginDanger: "safe",
      manifest: {
        ...makePlugin().manifest,
        capabilities: ["network:fetch"],
        scopes: { network: { allowedUrls: ["https://api.example.com/v1"] } },
      },
    });
    renderPane(plugin);
    expect(screen.getByText("https://api.example.com/v1")).toBeTruthy();
  });

  it("renders a label for every built-in capability when all are declared", () => {
    renderPane(withCapabilities([...BUILT_IN_PLUGIN_CAPABILITIES]));
    // One representative label per family, covering all three severity tiers.
    for (const label of [
      "Read project files",
      "Write project files",
      "Make network requests",
      "Launch agents",
      "Register agent CLIs",
      "Run git commands",
      "Read clipboard",
      "Run shell commands",
    ]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
  });

  it("renders capabilities in BUILT_IN_PLUGIN_CAPABILITIES order, not manifest order", () => {
    // Declared shell:exec first, but fs:project-read sorts earlier in the canon.
    renderPane(withCapabilities(["shell:exec", "fs:project-read"]));
    const list = screen.getByText("Read project files").closest("ul");
    expect(list).toBeTruthy();
    const labels = within(list as HTMLElement)
      .getAllByText(/Read project files|Run shell commands/)
      .map((el) => el.textContent);
    expect(labels[0]).toBe("Read project files");
    expect(labels[1]).toBe("Run shell commands");
  });
});
