// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

const platform = vi.hoisted(() => ({ mac: true }));

vi.mock("@/lib/platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/platform")>()),
  isMac: () => platform.mac,
}));

vi.mock("@/lib/remoteHosts", () => ({
  isRemoteShellSupported: () => true,
  isRemoteHostSupported: () => true,
  isEitherRemoteRoleSupported: () => true,
}));

import { SettingsOwnerHeaderChip } from "../SettingsDialog";
import {
  GLOBAL_SETTINGS_TAB_IDS,
  PROJECT_SETTINGS_TAB_IDS,
  type SettingsTab,
} from "../settingsTabIds";
import { getSettingsTabEntry, ownerForTab } from "../settingsTabRegistry";
import { _resetHostPlatformForTests, setHostPlatformInfo } from "@/hooks/useHostPlatform";
import {
  _resetSettingOwnersShownForTests,
  ownerOfSetting,
  sharedSettingOwner,
} from "@/hooks/useSettingsOwner";
import { SETTINGS_SEARCH_INDEX } from "../settingsSearchIndex";

const ALL_TABS: SettingsTab[] = [...GLOBAL_SETTINGS_TAB_IDS, ...PROJECT_SETTINGS_TAB_IDS];

function attachToHost(hostName: string | null = "studio-01") {
  window.__DAINTREE_HOST_ID__ = { id: "studio" };
  setHostPlatformInfo({ hostName });
}

beforeEach(() => {
  platform.mac = true;
  _resetHostPlatformForTests();
  _resetSettingOwnersShownForTests();
});

afterEach(() => {
  cleanup();
  delete window.__DAINTREE_HOST_ID__;
  _resetHostPlatformForTests();
});

describe("settings tab owners", () => {
  it("files every project tab under the host: per-project settings travel with the project", () => {
    for (const tab of PROJECT_SETTINGS_TAB_IDS) expect(ownerForTab(tab), tab).toBe("host");
  });

  it("reads each tab's owner from the settings it writes", () => {
    for (const tab of ALL_TABS) {
      const entry = getSettingsTabEntry(tab);
      expect(entry?.settings.length, tab).toBeGreaterThan(0);
      const owners = new Set(entry?.settings.map((ref) => ownerOfSetting(ref)));
      expect(ownerForTab(tab), tab).toBe(owners.size === 1 ? [...owners][0] : "mixed");
    }
  });

  it("files the pages the owner issue named under the owner their settings declare", () => {
    expect(ownerForTab("agents")).toBe("host");
    expect(ownerForTab("environment")).toBe("host");
    expect(ownerForTab("keyboard")).toBe("device");
    expect(ownerForTab("voice")).toBe("device");
    expect(ownerForTab("hosts")).toBe("device");
    // The toolbar's agent pins are this machine's too (#14702).
    expect(ownerForTab("toolbar")).toBe("device");
    for (const tab of ["general", "terminal", "troubleshooting"] as const) {
      expect(ownerForTab(tab), tab).toBe("mixed");
    }
  });
});

describe("settings header owner chip", () => {
  it("renders nothing for any tab in a local window with no hosts in use", () => {
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

  it("names the owner in a local window once hosts are in use", async () => {
    Object.assign(window, {
      electron: { remoteHosts: { isInUse: vi.fn(() => Promise.resolve(true)) } },
    });
    const { container } = render(<SettingsOwnerHeaderChip tab="keyboard" />);
    await waitFor(() => expect(container.textContent).toContain("This Mac"));
    cleanup();
    render(<SettingsOwnerHeaderChip tab="agents" />);
    await waitFor(() => expect(screen.getByText("Shared with Shells")).toBeTruthy());
    delete (window as { electron?: unknown }).electron;
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

describe("settings header owner chip with another machine picked (#14706)", () => {
  it("names the picked host over its work settings, even from a local window", () => {
    render(<SettingsOwnerHeaderChip tab="general" picked="studio-03" />);
    expect(screen.getByText("Settings on studio-03")).toBeTruthy();
  });

  it("says a device page is this machine's own, even from a local window", () => {
    render(<SettingsOwnerHeaderChip tab="keyboard" picked={null} />);
    expect(screen.getByText("This Mac")).toBeTruthy();
  });

  it("leaves open only pages whose every result names the machine being edited", () => {
    // A pick keeps this machine's pages and search results; a host mark among them
    // would name the window's host while another machine is the one being edited.
    const leftOpen = SETTINGS_SEARCH_INDEX.filter(
      (entry) => !entry.plugin && ownerForTab(entry.tab) === "device"
    );
    expect(leftOpen.length).toBeGreaterThan(0);
    for (const entry of leftOpen) {
      if (entry.settings) expect(sharedSettingOwner(entry.settings), entry.id).toBe("device");
    }
  });
});
