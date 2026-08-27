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

// Hoisted so the auto-select assertion can reach the spy. Inline `vi.fn()`s inside
// the selector would also hand the component a fresh action identity every render.
const themeStoreMock = vi.hoisted(() => ({
  setSelectedSchemeId: vi.fn(),
  setSelectedSchemeIdSilent: vi.fn(),
}));

vi.mock("@/store/appThemeStore", () => ({
  useAppThemeStore: (selector: (s: unknown) => unknown) =>
    selector({
      selectedSchemeId: "daintree",
      setSelectedSchemeId: themeStoreMock.setSelectedSchemeId,
      setSelectedSchemeIdSilent: themeStoreMock.setSelectedSchemeIdSilent,
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
  // Expose a test-only "dismiss" button that mirrors AppDialog's real close
  // path: it invokes onBeforeClose first, then onClose only if the gate
  // returns truthy (matching AppDialog.tsx's handleClose behavior).
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
    "data-testid": testId,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    "data-testid"?: string;
  }) => (
    <button onClick={onClick} disabled={disabled} data-testid={testId}>
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

// Clicks the visible footer button whose label matches exactly. Only the
// current step renders, so the match is unambiguous across the wizard flow.
async function clickButton(label: string) {
  const button = Array.from(document.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === label
  );
  expect(button, `expected a "${label}" button to be present`).toBeDefined();
  await act(async () => {
    button!.click();
  });
}

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

    // Click the Skip button (rendered on the first-run entry step — appearance).
    const skipButton = Array.from(document.querySelectorAll("button")).find(
      (b) => b.getAttribute("data-testid") === "agent-setup-exit"
    );
    expect(skipButton, "the exit action should be present on the entry step").toBeDefined();

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

  it("does NOT fire inbox confirmation when the user touched the privacy toggle before closing", async () => {
    const onClose = vi.fn();
    await act(async () => {
      render(
        // A pre-installed agent keeps the agents-step Continue enabled so we
        // can navigate forward to the privacy step where the toggle now lives.
        <AgentSetupWizard
          isOpen
          onClose={onClose}
          isFirstRun
          initialAvailability={{ claude: "ready" }}
        />
      );
    });

    // appearance -> agents -> privacy
    await clickButton("Continue");
    await clickButton("Continue");

    // Find the privacy toggle (role="switch", labeled "Enable crash reporting").
    const toggle = document.querySelector('button[role="switch"]') as HTMLButtonElement | null;
    expect(toggle, "privacy toggle should be present on the privacy step").not.toBeNull();

    await act(async () => {
      toggle!.click();
      // Toggle back to off so the silent-close path still commits "off".
      toggle!.click();
    });

    // Dismiss from the privacy step — the touched toggle suppresses the nag.
    const dismiss = document.querySelector(
      '[data-testid="dialog-dismiss"]'
    ) as HTMLButtonElement | null;
    await act(async () => {
      dismiss!.click();
    });

    expect(setTelemetryLevelMock).toHaveBeenCalledWith("off");
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("commits 'errors' (not 'off') when the user enables crash reporting and clicks Continue on the privacy step", async () => {
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

    // appearance -> agents -> privacy
    await clickButton("Continue");
    await clickButton("Continue");

    const toggle = document.querySelector('button[role="switch"]') as HTMLButtonElement | null;
    expect(toggle, "privacy toggle should be present on the privacy step").not.toBeNull();
    await act(async () => {
      toggle!.click(); // enable crash reporting
    });

    await clickButton("Continue");

    expect(setTelemetryLevelMock).toHaveBeenCalledWith("errors");
    expect(markPromptShownMock).toHaveBeenCalledTimes(1);
    // Continue is an explicit, informed choice — no silent-default nag.
    expect(notifyMock).not.toHaveBeenCalled();
    // The wizard advances (all agents installed -> complete) rather than closing.
    expect(onClose).not.toHaveBeenCalled();
  });

  it("does not fire when isFirstRun is false (commit path is bypassed entirely)", async () => {
    const onClose = vi.fn();
    await act(async () => {
      render(
        <AgentSetupWizard isOpen onClose={onClose} isFirstRun={false} initialAvailability={{}} />
      );
    });

    const skipButton = Array.from(document.querySelectorAll("button")).find(
      (b) => b.getAttribute("data-testid") === "agent-setup-exit"
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
      (b) => b.getAttribute("data-testid") === "agent-setup-exit"
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

  it("invokes onStepChange with the initial appearance step", async () => {
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

    expect(onStepChange).toHaveBeenCalledWith({ type: "appearance" });
  });

  it("fires inbox confirmation when first-run user dismisses via the dialog (onBeforeClose path)", async () => {
    const onClose = vi.fn();
    await act(async () => {
      render(<AgentSetupWizard isOpen onClose={onClose} isFirstRun initialAvailability={{}} />);
    });

    const dismiss = document.querySelector(
      '[data-testid="dialog-dismiss"]'
    ) as HTMLButtonElement | null;
    expect(dismiss, "dialog dismiss handle should be present").not.toBeNull();

    await act(async () => {
      dismiss!.click();
    });

    expect(setTelemetryLevelMock).toHaveBeenCalledWith("off");
    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalled();
  });

  it("still notifies when markPromptShown rejects after setTelemetryLevel succeeds", async () => {
    // Regression guard: a partial IPC failure must not silently revert the
    // user to the original "telemetry off with no signal" state. The
    // preference write is the load-bearing operation; the prompt-shown
    // bookkeeping is best-effort.
    markPromptShownMock.mockRejectedValueOnce(new Error("IPC down"));

    const onClose = vi.fn();
    await act(async () => {
      render(<AgentSetupWizard isOpen onClose={onClose} isFirstRun initialAvailability={{}} />);
    });

    const skipButton = Array.from(document.querySelectorAll("button")).find(
      (b) => b.getAttribute("data-testid") === "agent-setup-exit"
    );
    await act(async () => {
      skipButton!.click();
    });

    expect(setTelemetryLevelMock).toHaveBeenCalledWith("off");
    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalled();
  });

  it("does NOT notify if setTelemetryLevel itself fails (preference was not actually committed)", async () => {
    setTelemetryLevelMock.mockRejectedValueOnce(new Error("IPC down"));

    const onClose = vi.fn();
    await act(async () => {
      render(<AgentSetupWizard isOpen onClose={onClose} isFirstRun initialAvailability={{}} />);
    });

    const skipButton = Array.from(document.querySelectorAll("button")).find(
      (b) => b.getAttribute("data-testid") === "agent-setup-exit"
    );
    await act(async () => {
      skipButton!.click();
    });

    expect(setTelemetryLevelMock).toHaveBeenCalledTimes(1);
    expect(notifyMock).not.toHaveBeenCalled();
    // Wizard still closes — failure should not strand the user.
    expect(onClose).toHaveBeenCalled();
  });
});

describe("AgentSetupWizard first-run theme auto-select", () => {
  beforeEach(() => {
    themeStoreMock.setSelectedSchemeIdSilent.mockClear();
  });

  function setOsPrefersLight(prefersLight: boolean) {
    // Object.assign, not a cast — `as unknown as typeof window.matchMedia` trips the
    // no-unsafe-type-assertion lint ratchet.
    Object.assign(window, {
      matchMedia: (query: string) => ({
        matches: prefersLight && query.includes("prefers-color-scheme: light"),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
        media: query,
        onchange: null,
      }),
    });
  }

  it("crossfades into the OS-preferred theme", async () => {
    // Store is mocked on "daintree" (dark); a light OS makes "bondi" the target.
    setOsPrefersLight(true);

    await act(async () => {
      render(<AgentSetupWizard isOpen onClose={vi.fn()} isFirstRun initialAvailability={{}} />);
    });

    // The wizard has already painted, so the swap fades rather than cutting — but it
    // stays silent, since mirroring the OS is not a user pick.
    expect(themeStoreMock.setSelectedSchemeIdSilent).toHaveBeenCalledWith("bondi", {
      crossfade: true,
    });
  });

  it("does not re-apply a theme that already matches the OS", async () => {
    // Dark OS + a store already on "daintree" — nothing to change, so nothing to fade.
    setOsPrefersLight(false);

    await act(async () => {
      render(<AgentSetupWizard isOpen onClose={vi.fn()} isFirstRun initialAvailability={{}} />);
    });

    expect(themeStoreMock.setSelectedSchemeIdSilent).not.toHaveBeenCalled();
  });
});
