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
const { setGlobalSkipPermissionsMock } = vi.hoisted(() => ({
  setGlobalSkipPermissionsMock: vi.fn(() => Promise.resolve()),
}));
const { dispatchMock } = vi.hoisted(() => ({
  dispatchMock: vi.fn(() => Promise.resolve()),
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

// Hoisted so the auto-select assertion can reach the spy. Inline `vi.fn()`s inside
// the selector would also hand the component a fresh action identity every render.
const themeStoreMock = vi.hoisted(() => ({
  selectedSchemeId: "daintree",
  setSelectedSchemeId: vi.fn(),
  setSelectedSchemeIdSilent: vi.fn(),
}));

vi.mock("@/store/appThemeStore", () => ({
  useAppThemeStore: (selector: (s: unknown) => unknown) =>
    selector({
      selectedSchemeId: themeStoreMock.selectedSchemeId,
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
  actionService: { dispatch: dispatchMock },
}));

vi.mock("@/services/KeybindingService", () => ({
  keybindingService: { getDisplayCombo: () => "", getEffectiveCombo: () => undefined },
}));

vi.mock("../useAgentSetupPoll", () => ({
  useAgentSetupPoll: () => undefined,
}));

const systemState = vi.hoisted(() => ({ fatal: false }));

vi.mock("../SystemRequirementsSection", () => ({
  SystemRequirementsSection: ({
    onCheckingChange,
    onFatalFailureChange,
  }: {
    onCheckingChange: (v: boolean) => void;
    onFatalFailureChange: (v: boolean) => void;
  }) => {
    React.useEffect(() => {
      onCheckingChange(false);
      onFatalFailureChange(systemState.fatal);
    }, [onCheckingChange, onFatalFailureChange]);
    return <div data-testid="system-requirements-stub" />;
  },
}));

vi.mock("../AgentCliStep", () => ({
  AgentCliStep: () => <div data-testid="agent-cli-step-stub" />,
}));

vi.mock("@/components/agents/AgentCard", () => ({
  AgentCard: ({
    agentId,
    onToggle,
  }: {
    agentId: string;
    onToggle: (id: string, checked: boolean) => void;
  }) => (
    <button
      data-testid={`agent-card-${agentId}`}
      aria-label={`select ${agentId}`}
      onClick={() => onToggle(agentId, true)}
    />
  ),
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
  const Footer = ({ children, hint }: { children: React.ReactNode; hint?: React.ReactNode }) => (
    <div>
      {hint}
      {children}
    </div>
  );
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

  it("saves a revised choice after the user goes Back and changes it", async () => {
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
    await clickButton("Continue"); // appearance -> agents
    await clickButton("Continue"); // agents -> privacy
    const toggle = () => document.querySelector('button[role="switch"]') as HTMLButtonElement;
    await act(async () => {
      toggle().click(); // on
    });
    await clickButton("Continue"); // privacy -> permissions
    await clickButton("Back");
    await act(async () => {
      toggle().click(); // off again
    });
    await clickButton("Continue");

    expect(setTelemetryLevelMock.mock.calls.map((c) => (c as unknown[])[0])).toEqual([
      "errors",
      "off",
    ]);
  });

  it("stays on the privacy step when its choice cannot be saved", async () => {
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
    await clickButton("Continue");
    await clickButton("Continue");
    setTelemetryLevelMock.mockRejectedValueOnce(new Error("IPC down"));
    await clickButton("Continue");

    // Still on Privacy (the permissions step has a switch too, so name it),
    // and told why at a priority that reaches a toast.
    expect(document.body.textContent).toContain("Enable crash reporting");
    expect(document.body.textContent).not.toContain("Skip permission prompts for agents");
    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: "error", priority: "high" })
    );
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
    themeStoreMock.selectedSchemeId = "daintree";
  });

  it("leaves a theme the user already chose alone", async () => {
    // A light OS would otherwise pull the user off the theme they picked.
    themeStoreMock.selectedSchemeId = "namib";
    setOsPrefersLight(true);

    await act(async () => {
      render(<AgentSetupWizard isOpen onClose={vi.fn()} isFirstRun initialAvailability={{}} />);
    });

    expect(themeStoreMock.setSelectedSchemeIdSilent).not.toHaveBeenCalled();
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

function buttonLabels(): string[] {
  return Array.from(document.querySelectorAll("button"))
    .map((b) => b.textContent?.trim() ?? "")
    .filter(Boolean);
}

async function openAt(
  availability: Record<string, string>,
  onClose = vi.fn(),
  hasWorkspace = true
) {
  await act(async () => {
    render(
      <AgentSetupWizard
        isOpen
        onClose={onClose}
        isFirstRun={false}
        hasWorkspace={hasWorkspace}
        initialAvailability={availability as never}
      />
    );
  });
  return onClose;
}

/**
 * The completion screen is the last thing a first-run user sees, so it has to
 * resolve to a single obvious move. These assert the shape of that resolution
 * rather than any particular label styling.
 */
describe("AgentSetupWizard completion action", () => {
  beforeEach(() => {
    dispatchMock.mockClear();
    notifyMock.mockClear();
    setGlobalSkipPermissionsMock.mockClear();
    systemState.fatal = false;
  });

  it("leads to a project, not an agent, when no workspace is open", async () => {
    const onClose = await openAt({ claude: "ready" }, vi.fn(), false);
    await clickButton("Continue");

    // An agent launched with no workspace starts in the home directory, so the
    // one forward move is to acquire a workspace first.
    expect(buttonLabels().filter((l) => l !== "Close dialog")).toEqual(["Open a project"]);
    await clickButton("Open a project");
    expect(dispatchMock).toHaveBeenCalledWith("project.add", undefined, { source: "user" });
    expect(dispatchMock).not.toHaveBeenCalledWith("panel.palette", undefined, expect.anything());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("resolves to exactly one action, and it moves forward", async () => {
    await openAt({ claude: "ready" });
    await clickButton("Continue"); // agents -> complete (nothing to install)

    // One footer action, and it starts the work rather than merely dismissing.
    // A companion "Done" would read as if the two differ in what they save when
    // both just close; Escape and the header dismiss remain the way out.
    // (CompleteStep's own suite asserts the summary body renders no buttons.)
    expect(buttonLabels().filter((l) => l !== "Close dialog")).toEqual(["Launch an agent"]);
  });

  it("starts the work and closes when the forward action is taken", async () => {
    const onClose = await openAt({ claude: "ready" });
    await clickButton("Continue");
    await clickButton("Launch an agent");

    expect(dispatchMock).toHaveBeenCalledWith("panel.palette", undefined, { source: "user" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("defers rather than continues from the install step while nothing picked is usable", async () => {
    await openAt({});
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-testid="agent-card-claude"]')!.click();
    });
    await clickButton("Continue"); // agents -> cli (claude is missing)

    // The strongest move on this step must not read as success before anything
    // installed — the install is the step's primary, the exit a deferral.
    expect(buttonLabels()).toContain("Set up later");
    expect(buttonLabels()).not.toContain("Continue");
  });

  it.each([
    [true, "Finish setup"],
    [false, "Open a project"],
  ])(
    "saves rather than celebrates a deferred install (workspace open: %s)",
    async (hasWorkspace, action) => {
      await openAt({}, vi.fn(), hasWorkspace);
      await act(async () => {
        document.querySelector<HTMLButtonElement>('[data-testid="agent-card-claude"]')!.click();
      });
      await clickButton("Continue"); // agents -> cli
      await clickButton("Set up later"); // cli -> complete

      expect(document.body.textContent).toContain("Setup saved");
      expect(document.body.textContent).not.toContain("Setup complete");
      expect(buttonLabels().filter((l) => l !== "Close dialog")).toEqual([action]);
    }
  );

  it("says why the agents step is blocked when a system tool is missing", async () => {
    systemState.fatal = true;
    await openAt({ claude: "ready" });
    expect(document.body.textContent).toContain("Install the missing system tools to continue");
  });

  it("names the exit for what it does — closing the wizard, not skipping a step", async () => {
    await openAt({ claude: "ready" });
    expect(buttonLabels()).toContain("Cancel");
    expect(buttonLabels()).not.toContain("Skip");
  });

  // The step heading is the landing point on open and on every advance: it
  // reads the step's name and instructions before the first control, and keeps
  // Enter off the dismiss button that discards a first run.
  it("lands focus on the current step's heading rather than the dismiss button", async () => {
    await openAt({ claude: "ready" });
    const heading = document.querySelector("h3");
    expect(heading?.textContent).toBe("Choose your AI agents");
    expect(document.activeElement).toBe(heading);

    await clickButton("Continue");
    const next = document.querySelector("h3");
    expect(next?.textContent).toBe("Setup complete");
    expect(document.activeElement).toBe(next);
  });
});
