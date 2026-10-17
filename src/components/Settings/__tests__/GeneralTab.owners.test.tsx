// @vitest-environment jsdom

import { render, cleanup, act } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/platform")>()),
  isMac: () => true,
}));

vi.mock("@/lib/utils", () => ({ cn: (...args: unknown[]) => args.filter(Boolean).join(" ") }));

vi.mock("../SettingsSection", () => ({
  SettingsSection: ({
    children,
    title,
    badge,
  }: {
    children: React.ReactNode;
    title: string;
    badge?: string;
  }) => (
    <section data-section={title} data-badge={badge ?? ""}>
      {children}
    </section>
  ),
}));

vi.mock("../SettingsSubtabBar", () => ({
  SettingsSubtabBar: () => null,
  subtabPanelProps: () => ({ role: "tabpanel" }),
}));

vi.mock("@/store", () => ({
  usePreferencesStore: (selector: (state: Record<string, boolean>) => unknown) =>
    selector({ showProjectPulse: true }),
}));

vi.mock("@/services/KeybindingService", () => ({
  keybindingService: {
    subscribe: vi.fn(() => () => {}),
    loadOverrides: vi.fn(() => Promise.resolve()),
    getBinding: vi.fn(() => null),
    getEffectiveCombo: vi.fn(() => null),
    formatComboForDisplay: vi.fn(() => ""),
  },
}));

vi.mock("@/config/agents", () => ({
  getAgentIds: () => ["claude"],
  getAgentConfig: (id: string) => ({ name: id, color: "#888888", icon: () => null }),
  AGENT_DESCRIPTIONS: {} as Record<string, string>,
}));

vi.mock("@/utils/logger", () => ({
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

vi.mock("@/services/ActionService", () => ({
  actionService: {
    dispatch: vi.fn((actionId: string) =>
      Promise.resolve({ ok: true, result: actionId === "cliAvailability.get" ? {} : undefined })
    ),
  },
}));

import { _resetHostPlatformForTests, setHostPlatformInfo } from "@/hooks/useHostPlatform";

beforeEach(() => {
  _resetHostPlatformForTests();
  Object.assign(window, {
    electron: {
      update: {
        getChannel: vi.fn(() => Promise.resolve("stable")),
        setChannel: vi.fn(),
        getLastCheck: vi.fn(() => Promise.resolve(null)),
      },
    },
  });
});

afterEach(() => {
  cleanup();
  delete window.__DAINTREE_HOST_ID__;
  _resetHostPlatformForTests();
});

async function badgesOn(subtab: string): Promise<Record<string, string>> {
  const { GeneralTab } = await import("../GeneralTab");
  let container!: HTMLElement;
  await act(async () => {
    ({ container } = render(
      <GeneralTab
        appVersion="1.0.0"
        onNavigateToAgents={vi.fn()}
        activeSubtab={subtab}
        onSubtabChange={vi.fn()}
      />
    ));
  });
  return Object.fromEntries(
    [...container.querySelectorAll("section[data-section]")].map((el) => [
      el.getAttribute("data-section"),
      el.getAttribute("data-badge"),
    ])
  );
}

describe("General in a window attached to another host", () => {
  beforeEach(() => {
    window.__DAINTREE_HOST_ID__ = { id: "studio" };
    setHostPlatformInfo({ hostName: "studio-01" });
  });

  it("names the owner of each overview section", async () => {
    const badges = await badgesOn("overview");
    expect(badges).toMatchObject({
      "System status": "On studio-01",
      Startup: "On studio-01",
      "Opening folders": "This Mac",
      "Keep awake": "This Mac",
      Updates: "This Mac",
    });
  });

  it("files background-project housekeeping under the host", async () => {
    expect(await badgesOn("hibernation")).toMatchObject({ "Background projects": "On studio-01" });
  });

  it("files interface preferences under this machine", async () => {
    expect(await badgesOn("display")).toMatchObject({ "Interface elements": "This Mac" });
  });
});

describe("General in a local window", () => {
  it("marks no section, so the page renders as it always has", async () => {
    for (const subtab of ["overview", "hibernation", "display"]) {
      const badges = await badgesOn(subtab);
      expect(Object.keys(badges).length, subtab).toBeGreaterThan(0);
      for (const [section, badge] of Object.entries(badges)) {
        expect(badge, `${subtab} / ${section}`).toBe("");
      }
      cleanup();
    }
  });
});
