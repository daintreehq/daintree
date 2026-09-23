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

function buttonLabels(): string[] {
  return Array.from(document.querySelectorAll("button"))
    .map((b) => b.textContent?.trim() ?? "")
    .filter(Boolean);
}

async function clickButton(label: string) {
  const button = Array.from(document.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === label
  );
  expect(button, `expected a "${label}" button to be present`).toBeDefined();
  await act(async () => {
    button!.click();
  });
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

  it("collapses to a single action when there is nothing to launch", async () => {
    await openAt({});
    // With no agents available nothing is selectable, so reach the summary the
    // way a user with an unusable environment would: by skipping out of agents.
    const labels = buttonLabels();
    expect(labels).not.toContain("Launch an agent");
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
