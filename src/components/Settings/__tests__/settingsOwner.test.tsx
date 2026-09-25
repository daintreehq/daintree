// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const platform = vi.hoisted(() => ({ mac: true }));

vi.mock("@/lib/platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/platform")>()),
  isMac: () => platform.mac,
}));

vi.mock("@/lib/remoteHosts", () => ({ isRemoteHostsSupported: () => true }));

import { SettingsOwnerHeaderChip } from "../SettingsDialog";
import {
  GLOBAL_SETTINGS_TAB_IDS,
  PROJECT_SETTINGS_TAB_IDS,
  type SettingsTab,
} from "../settingsTabIds";
import { ownerForTab, SETTINGS_REGISTRY } from "../settingsTabRegistry";
import { _resetHostPlatformForTests, setHostPlatformInfo } from "@/hooks/useHostPlatform";
import { STORE_KEY_OWNERSHIP } from "../../../../electron/storeOwnership";

const ALL_TABS: SettingsTab[] = [...GLOBAL_SETTINGS_TAB_IDS, ...PROJECT_SETTINGS_TAB_IDS];

function attachToHost(hostName: string | null = "studio-01") {
  window.__DAINTREE_HOST_ID__ = { id: "studio" };
  setHostPlatformInfo({ hostName });
}

beforeEach(() => {
  platform.mac = true;
  _resetHostPlatformForTests();
});

afterEach(() => {
  cleanup();
  delete window.__DAINTREE_HOST_ID__;
  _resetHostPlatformForTests();
});

describe("settings tab owners", () => {
  it("every registered tab declares whose values it edits", () => {
    expect(SETTINGS_REGISTRY.map((e) => e.id).sort()).toEqual([...ALL_TABS].sort());
    for (const entry of SETTINGS_REGISTRY) {
      expect(["host", "device", "mixed"], entry.id).toContain((entry as { owner?: unknown }).owner);
    }
  });

  it("files every project tab under the host: per-project settings travel with the project", () => {
    for (const tab of PROJECT_SETTINGS_TAB_IDS) expect(ownerForTab(tab), tab).toBe("host");
  });

  it("follows the store ownership of the settings each single-owner tab writes", () => {
    const writes: [SettingsTab, (keyof typeof STORE_KEY_OWNERSHIP)[]][] = [
      ["agents", ["agentSettings", "userAgentRegistry", "agentUpdateSettings"]],
      ["environment", ["globalEnvironmentVariables"]],
      ["mcp", ["mcpServer"]],
      ["plugins", ["plugins", "pluginCapabilityConsent"]],
      ["code-forge", ["forgeCredentials", "forgeDefaultProviderId"]],
      ["run-history", ["runHistory"]],
      ["assistant", ["helpAssistant"]],
      ["keyboard", ["keybindingOverrides"]],
      ["terminalAppearance", ["appTheme"]],
      ["voice", ["voiceInput"]],
      ["hosts", ["remoteHosts", "hostMode"]],
    ];
    for (const [tab, keys] of writes) {
      for (const key of keys) {
        expect(STORE_KEY_OWNERSHIP[key], `${tab} writes ${key}`).toBe(ownerForTab(tab));
      }
    }
  });

  it("marks pages holding both machines' settings as mixed", () => {
    for (const tab of [
      "general",
      "terminal",
      "notifications",
      "privacy",
      "worktree",
      "toolbar",
    ] as const) {
      expect(ownerForTab(tab), tab).toBe("mixed");
    }
  });
});

describe("settings header owner chip", () => {
  it("renders nothing for any tab in a local window", () => {
    setHostPlatformInfo({ hostName: null });
    for (const tab of ALL_TABS) {
      const { container, unmount } = render(<SettingsOwnerHeaderChip tab={tab} />);
      expect(container.innerHTML, tab).toBe("");
      unmount();
    }
  });

  it("names the host over a host-owned page in a remote window", () => {
    attachToHost();
    render(<SettingsOwnerHeaderChip tab="agents" />);
    expect(screen.getByText("Settings on studio-01")).toBeTruthy();
  });

  it("falls back to the host id until the host's name is known", () => {
    attachToHost(null);
    render(<SettingsOwnerHeaderChip tab="project:general" />);
    expect(screen.getByText("Settings on studio")).toBeTruthy();
  });

  it("names this machine over a device page", () => {
    attachToHost();
    const { unmount } = render(<SettingsOwnerHeaderChip tab="keyboard" />);
    expect(screen.getByText("This Mac")).toBeTruthy();
    unmount();

    platform.mac = false;
    render(<SettingsOwnerHeaderChip tab="voice" />);
    expect(screen.getByText("This machine")).toBeTruthy();
  });

  it("leaves a mixed page's header alone; its sections name their own owners", () => {
    attachToHost();
    const { container } = render(<SettingsOwnerHeaderChip tab="general" />);
    expect(container.innerHTML).toBe("");
  });

  it("keeps the owner in the title's accessible name after a pause", () => {
    attachToHost();
    const { container } = render(
      <h3>
        Agents
        <SettingsOwnerHeaderChip tab="agents" />
      </h3>
    );
    expect(container.querySelector("h3")?.textContent).toBe("Agents, Settings on studio-01");
  });
});
