// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act } from "@testing-library/react";

const { notifyMock } = vi.hoisted(() => ({
  notifyMock: vi.fn(),
}));
const { setTelemetryLevelMock, markPromptShownMock } = vi.hoisted(() => ({
  setTelemetryLevelMock: vi.fn(() => Promise.resolve()),
  markPromptShownMock: vi.fn(() => Promise.resolve()),
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
  const Dialog = ({ isOpen, children }: { isOpen: boolean; children: React.ReactNode }) =>
    isOpen ? <div data-testid="app-dialog">{children}</div> : null;
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
  privacy: { setTelemetryLevel: setTelemetryLevelMock },
  telemetry: { markPromptShown: markPromptShownMock },
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

describe("AgentSetupWizard silent-default privacy notify", () => {
  beforeEach(() => {
    notifyMock.mockClear();
    setTelemetryLevelMock.mockClear();
    markPromptShownMock.mockClear();
  });

  it("fires inbox confirmation when first-run user clicks Skip without touching the toggle", async () => {
    const onClose = vi.fn();
    await act(async () => {
      render(<AgentSetupWizard isOpen onClose={onClose} isFirstRun initialAvailability={{}} />);
    });

    // Click the Skip button (rendered inside the selection-step footer).
    const skipButton = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent === "Skip"
    );
    expect(skipButton, "Skip button should be present on selection step").toBeDefined();

    await act(async () => {
      skipButton!.click();
    });

    expect(setTelemetryLevelMock).toHaveBeenCalledWith("off");
    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "info",
        priority: "low",
        countable: false,
        title: "Crash reporting off by default",
        message: expect.stringContaining("Settings"),
      })
    );
    expect(onClose).toHaveBeenCalled();
  });

  it("does NOT fire inbox confirmation when the user touched the privacy toggle before skipping", async () => {
    const onClose = vi.fn();
    await act(async () => {
      render(<AgentSetupWizard isOpen onClose={onClose} isFirstRun initialAvailability={{}} />);
    });

    // Find the privacy toggle (role="switch", labeled "Enable crash reporting").
    const toggle = document.querySelector(
      'button[role="switch"][aria-label="Enable crash reporting"]'
    ) as HTMLButtonElement | null;
    expect(toggle, "privacy toggle should be present on first-run selection step").not.toBeNull();

    await act(async () => {
      toggle!.click();
      // Toggle back to off so the silent-close path still commits "off".
      toggle!.click();
    });

    const skipButton = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent === "Skip"
    );
    await act(async () => {
      skipButton!.click();
    });

    expect(setTelemetryLevelMock).toHaveBeenCalledWith("off");
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("does not fire when isFirstRun is false (commit path is bypassed entirely)", async () => {
    const onClose = vi.fn();
    await act(async () => {
      render(
        <AgentSetupWizard isOpen onClose={onClose} isFirstRun={false} initialAvailability={{}} />
      );
    });

    const skipButton = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent === "Skip"
    );
    await act(async () => {
      skipButton!.click();
    });

    expect(setTelemetryLevelMock).not.toHaveBeenCalled();
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("notifies only once when Skip is clicked again after the first commit settles", async () => {
    const onClose = vi.fn();
    await act(async () => {
      render(<AgentSetupWizard isOpen onClose={onClose} isFirstRun initialAvailability={{}} />);
    });

    const skipButton = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent === "Skip"
    );

    await act(async () => {
      skipButton!.click();
    });
    await act(async () => {
      skipButton!.click();
    });

    expect(setTelemetryLevelMock).toHaveBeenCalledTimes(1);
    expect(notifyMock).toHaveBeenCalledTimes(1);
  });

  it("invokes onStepChange with the initial selection step", async () => {
    const onStepChange = vi.fn();
    await act(async () => {
      render(
        <AgentSetupWizard
          isOpen
          onClose={vi.fn()}
          isFirstRun
          initialAvailability={{}}
          onStepChange={onStepChange}
        />
      );
    });

    expect(onStepChange).toHaveBeenCalledWith({ type: "selection" });
  });
});
