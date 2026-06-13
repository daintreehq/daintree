// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act } from "@testing-library/react";

const { notifyMock } = vi.hoisted(() => ({
  notifyMock: vi.fn(),
}));
const { setGlobalSkipPermissionsMock } = vi.hoisted(() => ({
  setGlobalSkipPermissionsMock: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/lib/notify", () => ({
  notify: notifyMock,
}));

vi.mock("framer-motion", () => {
  const Passthrough = React.forwardRef<HTMLDivElement, React.PropsWithChildren<unknown>>(
    ({ children }, _ref) => <>{children}</>
  );
  return {
    AnimatePresence: ({ children }: React.PropsWithChildren<unknown>) => <>{children}</>,
    LazyMotion: ({ children }: React.PropsWithChildren<unknown>) => <>{children}</>,
    domAnimation: {},
    domMax: {},
    LayoutGroup: ({ children }: React.PropsWithChildren<unknown>) => <>{children}</>,
    useReducedMotion: () => true,
    m: { div: Passthrough },
    motion: { div: Passthrough },
  };
});

const agentSettingsStoreState = {
  setAgentPinned: vi.fn(() => Promise.resolve()),
  setGlobalSkipPermissions: setGlobalSkipPermissionsMock,
  initialize: vi.fn(() => Promise.resolve()),
};
vi.mock("@/store", () => ({
  useAgentSettingsStore: Object.assign(
    (selector?: (s: unknown) => unknown) =>
      selector ? selector(agentSettingsStoreState) : agentSettingsStoreState,
    { getState: () => agentSettingsStoreState }
  ),
}));

vi.mock("@/store/cliAvailabilityStore", () => ({
  useCliAvailabilityStore: (selector: (s: unknown) => unknown) =>
    selector({ isLoading: false, isRefreshing: false, availability: {}, hasRealData: true }),
}));

vi.mock("@/store/appThemeStore", () => ({
  useAppThemeStore: (selector: (s: unknown) => unknown) =>
    selector({
      selectedSchemeId: "daintree",
      setSelectedSchemeId: vi.fn(),
      setSelectedSchemeIdSilent: vi.fn(),
    }),
}));

vi.mock("@/clients", () => ({
  cliAvailabilityClient: { refresh: vi.fn(() => Promise.resolve({})) },
}));

vi.mock("@/clients/appThemeClient", () => ({
  appThemeClient: { setColorScheme: vi.fn(() => Promise.resolve()) },
}));

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: vi.fn(() => Promise.resolve()) },
}));

vi.mock("@/services/KeybindingService", () => ({
  keybindingService: { getDisplayCombo: () => "" },
}));

vi.mock("../useAgentSetupPoll", () => ({
  useAgentSetupPoll: () => undefined,
}));

vi.mock("../SystemRequirementsSection", () => ({
  SystemRequirementsSection: ({ onCheckingChange }: { onCheckingChange: (v: boolean) => void }) => {
    React.useEffect(() => {
      onCheckingChange(false);
    }, [onCheckingChange]);
    return <div data-testid="system-requirements-stub" />;
  },
}));

vi.mock("../AgentCliStep", () => ({
  AgentCliStep: () => <div data-testid="agent-cli-step-stub" />,
}));

vi.mock("@/components/agents/AgentCard", () => ({
  AgentCard: ({ agentId }: { agentId: string }) => <div data-testid={`agent-card-${agentId}`} />,
}));

vi.mock("@/components/ui/AppDialog", () => {
  const Dialog = ({
    isOpen,
    onClose,
    onBeforeClose,
    children,
  }: {
    isOpen: boolean;
    onClose?: () => void;
    onBeforeClose?: () => boolean | Promise<boolean>;
    children: React.ReactNode;
  }) =>
    isOpen ? (
      <div data-testid="app-dialog">
        <button
          data-testid="dialog-dismiss"
          onClick={async () => {
            const proceed = onBeforeClose ? await onBeforeClose() : true;
            if (proceed && onClose) onClose();
          }}
        />
        {children}
      </div>
    ) : null;
  const Header = ({ children }: { children: React.ReactNode }) => <div>{children}</div>;
  const Body = ({ children }: { children: React.ReactNode }) => <div>{children}</div>;
  const Footer = ({ children }: { children: React.ReactNode }) => <div>{children}</div>;
  const Title = ({ children }: { children: React.ReactNode }) => <div>{children}</div>;
  const CloseButton = () => <button data-testid="close-button-stub" />;
  Dialog.Header = Header;
  Dialog.Body = Body;
  Dialog.Footer = Footer;
  Dialog.Title = Title;
  Dialog.CloseButton = CloseButton;
  return { AppDialog: Dialog };
});

vi.mock("@/components/ui/Spinner", () => ({
  Spinner: () => <div data-testid="spinner-stub" />,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
    disabled,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    disabled?: boolean;
  }) => (
    <button onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
}));

vi.mock("@/components/icons", () => ({
  Plug: () => null,
  BrandMark: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const electronStub = {
  privacy: { setTelemetryLevel: vi.fn(() => Promise.resolve()) },
  telemetry: { markPromptShown: vi.fn(() => Promise.resolve()) },
};

vi.stubGlobal("window", {
  ...globalThis.window,
  electron: electronStub,
  matchMedia: () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
    media: "",
    onchange: null,
  }),
});

import { AgentSetupWizard } from "../AgentSetupWizard";

async function clickButton(label: string) {
  const button = Array.from(document.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === label
  );
  expect(button, `expected a "${label}" button to be present`).toBeDefined();
  await act(async () => {
    button!.click();
  });
}

// Navigate appearance -> agents -> privacy -> permissions. All selected agents
// are pre-installed, so cli is skipped and the permissions step renders after
// three Continue clicks.
async function gotoPermissionsStep() {
  await clickButton("Continue"); // appearance -> agents
  await clickButton("Continue"); // agents -> privacy
  await clickButton("Continue"); // privacy -> permissions
}

function permissionsToggle(): HTMLButtonElement {
  const toggle = document.querySelector('button[role="switch"]') as HTMLButtonElement | null;
  expect(toggle, "permissions toggle should be present on the permissions step").not.toBeNull();
  return toggle!;
}

describe("AgentSetupWizard permissions step", () => {
  beforeEach(() => {
    notifyMock.mockClear();
    setGlobalSkipPermissionsMock.mockClear();
    setGlobalSkipPermissionsMock.mockImplementation(() => Promise.resolve());
  });

  it("renders the permissions step with the toggle defaulting to off", async () => {
    await act(async () => {
      render(
        <AgentSetupWizard
          isOpen
          onClose={vi.fn()}
          isFirstRun
          initialAvailability={{ claude: "ready" }}
        />
      );
    });

    await gotoPermissionsStep();

    const toggle = permissionsToggle();
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    // Accessibility: the switch points at the risk copy via aria-describedby.
    const describedBy = toggle.getAttribute("aria-describedby");
    expect(describedBy, "switch must wire aria-describedby to the risk copy").toBeTruthy();
    expect(document.getElementById(describedBy!)).not.toBeNull();
    // No autofocus on the switch.
    expect(document.activeElement).not.toBe(toggle);
  });

  it("writes the explicit off choice and advances on Continue when the toggle is left off", async () => {
    const onClose = vi.fn();
    await act(async () => {
      render(
        <AgentSetupWizard
          isOpen
          onClose={onClose}
          isFirstRun
          initialAvailability={{ claude: "ready" }}
        />
      );
    });

    await gotoPermissionsStep();
    await clickButton("Continue"); // permissions -> complete

    // Explicit off is persisted so a stale `true` can't survive first-run.
    expect(setGlobalSkipPermissionsMock).toHaveBeenCalledTimes(1);
    expect(setGlobalSkipPermissionsMock).toHaveBeenCalledWith(false);
    expect(notifyMock).not.toHaveBeenCalled();
    // Advanced to the summary, not closed.
    expect(document.body.textContent).toContain("Setup complete");
  });

  it("commits true before advancing when the toggle is enabled", async () => {
    await act(async () => {
      render(
        <AgentSetupWizard
          isOpen
          onClose={vi.fn()}
          isFirstRun
          initialAvailability={{ claude: "ready" }}
        />
      );
    });

    await gotoPermissionsStep();
    await act(async () => {
      permissionsToggle().click();
    });
    await clickButton("Continue");

    expect(setGlobalSkipPermissionsMock).toHaveBeenCalledWith(true);
    expect(notifyMock).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Setup complete");
  });

  it("stays on the permissions step and surfaces an error when the save fails", async () => {
    setGlobalSkipPermissionsMock.mockRejectedValueOnce(new Error("IPC down"));

    const onClose = vi.fn();
    await act(async () => {
      render(
        <AgentSetupWizard
          isOpen
          onClose={onClose}
          isFirstRun
          initialAvailability={{ claude: "ready" }}
        />
      );
    });

    await gotoPermissionsStep();
    await act(async () => {
      permissionsToggle().click();
    });
    await clickButton("Continue");

    expect(setGlobalSkipPermissionsMock).toHaveBeenCalledWith(true);
    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(notifyMock).toHaveBeenCalledWith(expect.objectContaining({ type: "error" }));
    // Did not advance — still on the permissions step, summary not shown.
    expect(document.body.textContent).toContain("Agent permissions");
    expect(document.body.textContent).not.toContain("Setup complete");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("does not write the setting when the user closes from the permissions step", async () => {
    const onClose = vi.fn();
    await act(async () => {
      render(
        <AgentSetupWizard
          isOpen
          onClose={onClose}
          isFirstRun
          initialAvailability={{ claude: "ready" }}
        />
      );
    });

    await gotoPermissionsStep();
    const dismiss = document.querySelector(
      '[data-testid="dialog-dismiss"]'
    ) as HTMLButtonElement | null;
    await act(async () => {
      dismiss!.click();
    });

    // Close is not consent — the global skip setting must never be written here.
    expect(setGlobalSkipPermissionsMock).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });
});
