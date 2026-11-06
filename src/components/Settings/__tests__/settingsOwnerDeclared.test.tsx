// @vitest-environment jsdom
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("@/lib/platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/platform")>()),
  isMac: () => true,
}));

vi.mock("@/lib/remoteHosts", () => ({
  isRemoteShellSupported: () => true,
  isRemoteHostSupported: () => true,
  isEitherRemoteRoleSupported: () => true,
}));

import { SettingsSection } from "../SettingsSection";
import { SettingsOwnerTag } from "../SettingsOwnerTag";
import { SECTION_SETTINGS } from "../settingsSectionOwners";
import { SETTINGS_SEARCH_INDEX } from "../settingsSearchIndex";
import { SETTINGS_REGISTRY, ownerForTab } from "../settingsTabRegistry";
import { _resetHostPlatformForTests, setHostPlatformInfo } from "@/hooks/useHostPlatform";
import {
  _resetSettingOwnersShownForTests,
  ownerOfSetting,
  sharedSettingOwner,
  settingsOwnerMarker,
} from "@/hooks/useSettingsOwner";

const ROOT = path.resolve(__dirname, "../../..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "__tests__" ? [] : sourceFiles(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

function attachToHost() {
  window.__DAINTREE_HOST_ID__ = { id: "studio" };
  setHostPlatformInfo({ hostName: "studio-01" });
}

beforeEach(() => {
  _resetHostPlatformForTests();
  _resetSettingOwnersShownForTests();
});

afterEach(() => {
  cleanup();
  delete window.__DAINTREE_HOST_ID__;
  _resetHostPlatformForTests();
});

describe("a section's shown owner is the setting's declared owner", () => {
  it("never names a machine by hand", () => {
    const files = [
      ...sourceFiles(path.join(ROOT, "components/Settings")),
      ...sourceFiles(path.join(ROOT, "components/Project")),
    ];
    const handWritten = /(ownerMarker|rowOwnerNote|settingsOwnerMarker)\([^)]*"(host|device)"/s;
    const literalOwner = /\bowner:\s*"(host|device|mixed)"/;
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      expect(handWritten.test(source), `${file} marks an owner by hand`).toBe(false);
      expect(literalOwner.test(source), `${file} declares an owner by hand`).toBe(false);
    }
  });

  it("shows the owner the catalog declares for what the section writes", () => {
    attachToHost();
    const { container } = render(
      <>
        <SettingsSection title="Host one" settings={["agentSettings"]}>
          <span />
        </SettingsSection>
        <SettingsSection title="Device one" settings={["keybindingOverrides"]}>
          <span />
        </SettingsSection>
        <SettingsSection title="Both" settings={["agentSettings", "keybindingOverrides"]}>
          <span />
        </SettingsSection>
        <SettingsSection title="Neither">
          <span />
        </SettingsSection>
      </>
    );
    const badges = [...container.querySelectorAll("[role=group]")].map((group) => {
      const heading = group.querySelector("h4");
      const title = heading?.firstChild?.textContent ?? "";
      return [title, (heading?.textContent ?? "").slice(title.length)];
    });
    expect(badges).toEqual([
      ["Host one", "On studio-01"],
      ["Device one", "This Mac"],
      ["Both", ""],
      ["Neither", ""],
    ]);
  });

  it("shows nothing in a local window with no hosts in use", () => {
    render(
      <SettingsSection title="Host one" settings={["agentSettings"]}>
        <span />
      </SettingsSection>
    );
    expect(document.querySelector("h4")?.textContent).toBe("Host one");
  });

  it("names a row that differs from its section", () => {
    attachToHost();
    render(<SettingsOwnerTag settings={["agentSettings"]} />);
    expect(screen.getByText("On studio-01")).toBeTruthy();
  });
});

describe("the marks the owner issue called wrong", () => {
  const owner = (key: keyof typeof SECTION_SETTINGS) => sharedSettingOwner(SECTION_SETTINGS[key]);

  it("puts the Ctrl+V clipboard row on this machine, alongside the other input settings", () => {
    expect(SECTION_SETTINGS.agentInput).toContain("remoteHostsPreferences");
    expect(owner("agentInput")).toBe("device");
  });

  it("puts the whole toolbar on this machine, agent pins included (#14702)", () => {
    expect(owner("toolbarLayout")).toBe("device");
    expect(ownerOfSetting("agentToolbarPins")).toBe("device");
    expect(ownerForTab("toolbar")).toBe("device");
    expect(owner("projectToolbar")).toBe("host");
  });

  it("puts the whole Notifications page on this machine, with no section of its own", () => {
    expect(ownerOfSetting("notificationSettings")).toBe("device");
    expect(ownerForTab("notifications")).toBe("device");
    expect(SETTINGS_REGISTRY.find((tab) => tab.id === "notifications")).not.toHaveProperty(
      "sectionSettings"
    );
  });

  it("keeps the sidebar default view and project theme off the host's mark", () => {
    expect(owner("sidebarDefaultView")).toBe("device");
    expect(owner("projectTheme")).toBe("device");
    expect(ownerForTab("project:plugins")).toBe("host");
    expect(ownerForTab("project:general")).toBe("host");
  });
});

describe("the declared settings behind each section", () => {
  it("resolve to the owner each section's controls really write to", () => {
    const expected: Record<keyof typeof SECTION_SETTINGS, "host" | "device"> = {
      systemStatus: "host",
      updates: "device",
      startup: "host",
      openingFolders: "device",
      keepAwake: "device",
      backgroundProjects: "host",
      interfaceElements: "device",
      quickReference: "device",
      privacy: "device",
      sessionHistory: "host",
      terminalResources: "host",
      performanceMode: "device",
      panelLimits: "device",
      projectViews: "device",
      agentInput: "device",
      twoPaneSplit: "device",
      gridLayout: "device",
      scrollback: "device",
      assistiveTechnology: "device",
      worktreePathPattern: "host",
      clientPreferences: "device",
      worktreeSidebar: "device",
      toolbarLayout: "device",
      pluginSilences: "host",
      hardwareAcceleration: "device",
      logging: "device",
      developerTools: "device",
      projectIdentity: "host",
      projectToolbar: "host",
      projectTheme: "device",
      sidebarDefaultView: "device",
    };
    for (const [key, owner] of Object.entries(expected)) {
      expect(sharedSettingOwner(SECTION_SETTINGS[key as keyof typeof SECTION_SETTINGS]), key).toBe(
        owner
      );
    }
  });
});

describe("search results", () => {
  const owned = (id: string) => {
    const entry = SETTINGS_SEARCH_INDEX.find((e) => e.id === id);
    return entry?.settings ? sharedSettingOwner(entry.settings) : null;
  };

  it("carry the owner of each match on a single-owner page and on a mixed one", () => {
    expect(owned("tab-nav-agents")).toBe("host");
    expect(owned("tab-nav-keyboard")).toBe("device");
    expect(owned("terminal-panel-limits")).toBe("device");
    expect(owned("agents-hybrid-input")).toBe("device");
    expect(owned("agents-hybrid-focus")).toBe("device");
    expect(owned("general-keep-awake")).toBe("device");
    expect(owned("general-session-restore")).toBe("host");
    expect(owned("project-theme")).toBe("device");
    expect(owned("project-name")).toBe("host");
  });

  it("leave no match on a mixed page without an owner, bar the About card", () => {
    const mixed = SETTINGS_REGISTRY.filter((tab) => ownerForTab(tab.id) === "mixed").map(
      (tab) => tab.id
    );
    for (const entry of SETTINGS_SEARCH_INDEX) {
      if (!mixed.includes(entry.tab) || entry.kind === "tab-nav") continue;
      if (entry.section === "About") continue;
      expect(
        entry.settings?.length,
        `${entry.tab} / ${entry.section} / ${entry.title}`
      ).toBeGreaterThan(0);
    }
  });

  it("name that owner the way the page does", () => {
    const entry = SETTINGS_SEARCH_INDEX.find((e) => e.id === "terminal-panel-limits");
    const context = { remoteHostName: "studio-01", shown: true };
    expect(settingsOwnerMarker(entry?.settings ?? [], context)).toBe("This Mac");
    const host = SETTINGS_SEARCH_INDEX.find((e) => e.id === "general-session-restore");
    expect(settingsOwnerMarker(host?.settings ?? [], context)).toBe("On studio-01");
  });

  it("resolve every declared setting to an owner", () => {
    for (const entry of SETTINGS_SEARCH_INDEX) {
      for (const ref of entry.settings ?? []) {
        expect(() => ownerOfSetting(ref), `${entry.id} ${ref}`).not.toThrow();
      }
    }
  });
});
