// @vitest-environment jsdom

import { render, screen, fireEvent, waitFor, cleanup, act, within } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/utils", () => ({ cn: (...args: unknown[]) => args.filter(Boolean).join(" ") }));

vi.mock("../SettingsSection", () => ({
  SettingsSection: ({
    children,
    title,
    id,
  }: {
    children: React.ReactNode;
    title: string;
    id?: string;
  }) => (
    <section data-testid={`section-${title}`} id={id}>
      <h3>{title}</h3>
      {children}
    </section>
  ),
}));

vi.mock("../SettingsSubtabBar", () => ({
  SettingsSubtabBar: () => null,
  subtabPanelProps: (group: string, activeId: string) => ({
    role: "tabpanel",
    id: `settings-subtabpanel-${group}-${activeId}`,
    "aria-labelledby": `settings-subtab-${group}-${activeId}`,
    tabIndex: -1,
  }),
}));

vi.mock("@/store", () => ({
  usePreferencesStore: (selector: (state: Record<string, boolean>) => unknown) =>
    selector({
      showProjectPulse: true,
      showDeveloperTools: false,
      showGridAgentHighlights: true,
      showDockAgentHighlights: true,
    }),
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
  getAgentConfig: (id: string) => ({
    name: id.charAt(0).toUpperCase() + id.slice(1),
    color: "#888888",
    icon: () => null,
  }),
  // GeneralTab now renders each row through AgentCard's `resolveIdentity`, which reads
  // the brand mark, colour and blurb as well as the name.
  AGENT_DESCRIPTIONS: {} as Record<string, string>,
}));

const mockLogError = vi.fn<(message: string, error?: unknown) => void>();
vi.mock("@/utils/logger", () => ({
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: (message: string, error?: unknown) => mockLogError(message, error),
}));

const mockDispatch = vi.fn();
vi.mock("@/services/ActionService", () => ({
  actionService: {
    dispatch: (actionId: string, ...rest: unknown[]) => mockDispatch(actionId, ...rest),
  },
}));

type Pending = { resolve: (v: unknown) => void; reject: (e: unknown) => void };
const pending = new Map<string, Pending>();
const DEFERRED = new Set([
  "hibernation.getConfig",
  "sessionRestore.getConfig",
  "idleTerminalNotify.getConfig",
  "idleBackgroundAutoClose.getConfig",
]);

beforeEach(() => {
  vi.clearAllMocks();
  pending.clear();
  mockDispatch.mockImplementation((actionId: string) => {
    if (DEFERRED.has(actionId)) {
      return new Promise((resolve, reject) => pending.set(actionId, { resolve, reject }));
    }
    if (actionId === "cliAvailability.get") return Promise.resolve({ ok: true, result: {} });
    return Promise.resolve({ ok: true, result: undefined });
  });
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
});

async function renderGeneralTab(activeSubtab: string) {
  const { GeneralTab } = await import("../GeneralTab");
  return render(
    <GeneralTab
      appVersion="1.0.0"
      onNavigateToAgents={vi.fn()}
      activeSubtab={activeSubtab}
      onSubtabChange={vi.fn()}
    />
  );
}

const switchDisabled = (name: string) =>
  screen.getByRole("switch", { name }).hasAttribute("disabled");

describe("GeneralTab — config groups render before their data", () => {
  it("renders Startup immediately, disabled until the stored value is known", async () => {
    const { container } = await renderGeneralTab("overview");

    expect(container.querySelector("#general-session-restore")).not.toBeNull();
    expect(switchDisabled("Restore live projects")).toBe(true);

    await act(async () => {
      pending.get("sessionRestore.getConfig")?.resolve({ ok: true, result: { enabled: false } });
    });
    await waitFor(() => expect(switchDisabled("Restore live projects")).toBe(false));
    expect(
      screen.getByRole("switch", { name: "Restore live projects" }).getAttribute("aria-checked")
    ).toBe("false");
  });

  it("renders every hibernation group immediately, with no threshold selected while unknown", async () => {
    const { container } = await renderGeneralTab("hibernation");

    for (const id of [
      "general-idle-terminal-notify",
      "general-idle-terminal-threshold",
      "general-idle-background-auto-close",
      "general-idle-background-threshold",
      "general-hibernation",
      "general-hibernation-threshold",
    ]) {
      expect(container.querySelector(`#${id}`)).not.toBeNull();
    }
    expect(screen.queryByText(/Loading hibernation settings/)).toBeNull();
    expect(switchDisabled("Hibernate inactive projects")).toBe(true);
    const threshold = within(screen.getByRole("radiogroup", { name: "Hibernate after" }));
    for (const option of threshold.getAllByRole("radio")) {
      expect(option.getAttribute("aria-checked")).toBe("false");
      expect(option.hasAttribute("disabled")).toBe(true);
    }
  });

  it("keeps a failed group's rows in place, disabled, with the error and Retry above them", async () => {
    await renderGeneralTab("hibernation");

    await act(async () => {
      pending.get("hibernation.getConfig")?.reject(new Error("ipc down"));
    });

    expect(await screen.findByText("Couldn't load hibernation settings")).toBeTruthy();
    expect(switchDisabled("Hibernate inactive projects")).toBe(true);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    });
    await act(async () => {
      pending
        .get("hibernation.getConfig")
        ?.resolve({ ok: true, result: { enabled: true, inactiveThresholdHours: 24 } });
    });

    await waitFor(() => expect(switchDisabled("Hibernate inactive projects")).toBe(false));
    expect(screen.queryByText("Couldn't load hibernation settings")).toBeNull();
  });

  it("keeps a failed save on its group with a Retry that resends the attempted value", async () => {
    await renderGeneralTab("overview");
    await act(async () => {
      pending.get("sessionRestore.getConfig")?.resolve({ ok: true, result: { enabled: true } });
    });
    await waitFor(() => expect(switchDisabled("Restore live projects")).toBe(false));

    mockDispatch.mockImplementationOnce(() =>
      Promise.resolve({ ok: false, error: { message: "disk full" } })
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("switch", { name: "Restore live projects" }));
    });

    const startup = screen.getByTestId("section-Startup");
    const banner = await within(startup).findByRole("alert");
    expect(banner.textContent).toMatch(/Couldn't save/);
    expect(
      screen.getByRole("switch", { name: "Restore live projects" }).getAttribute("aria-checked")
    ).toBe("true");

    mockDispatch.mockImplementationOnce(() =>
      Promise.resolve({ ok: true, result: { enabled: false } })
    );
    await act(async () => {
      fireEvent.click(within(startup).getByRole("button", { name: "Retry" }));
    });
    expect(mockDispatch).toHaveBeenLastCalledWith(
      "sessionRestore.updateConfig",
      { enabled: false },
      { source: "user" }
    );
    await waitFor(() => expect(within(startup).queryByRole("alert")).toBeNull());
  });

  it("sends one retry however fast Retry is clicked", async () => {
    await renderGeneralTab("overview");
    await act(async () => {
      pending.get("sessionRestore.getConfig")?.resolve({ ok: true, result: { enabled: true } });
    });
    await waitFor(() => expect(switchDisabled("Restore live projects")).toBe(false));

    mockDispatch.mockImplementationOnce(() =>
      Promise.resolve({ ok: false, error: { message: "disk full" } })
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("switch", { name: "Restore live projects" }));
    });
    const startup = screen.getByTestId("section-Startup");
    const retry = await within(startup).findByRole("button", { name: "Retry" });

    let finish: (v: unknown) => void = () => {};
    mockDispatch.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const before = mockDispatch.mock.calls.filter(
      ([id]) => id === "sessionRestore.updateConfig"
    ).length;
    act(() => {
      fireEvent.click(retry);
      fireEvent.click(retry);
    });
    await act(async () => {
      finish({ ok: true, result: { enabled: false } });
    });
    const after = mockDispatch.mock.calls.filter(
      ([id]) => id === "sessionRestore.updateConfig"
    ).length;
    expect(after - before).toBe(1);
  });

  it("a new edit retires the old Retry, so a stale resend can't roll it back", async () => {
    await renderGeneralTab("overview");
    await act(async () => {
      pending.get("sessionRestore.getConfig")?.resolve({ ok: true, result: { enabled: true } });
    });
    await waitFor(() => expect(switchDisabled("Restore live projects")).toBe(false));

    mockDispatch.mockImplementationOnce(() =>
      Promise.resolve({ ok: false, error: { message: "disk full" } })
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("switch", { name: "Restore live projects" }));
    });
    const startup = screen.getByTestId("section-Startup");
    await within(startup).findByRole("button", { name: "Retry" });

    // The new edit's own save stays in flight, so only the edit starting can clear it.
    mockDispatch.mockImplementationOnce(() => new Promise(() => {}));
    await act(async () => {
      fireEvent.click(screen.getByRole("switch", { name: "Restore live projects" }));
    });
    expect(within(startup).queryByRole("button", { name: "Retry" })).toBeNull();
  });
});
