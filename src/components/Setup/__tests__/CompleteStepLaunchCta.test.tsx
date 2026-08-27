// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

const { dispatchMock, getDisplayComboMock } = vi.hoisted(() => ({
  dispatchMock: vi.fn(() => Promise.resolve()),
  getDisplayComboMock: vi.fn<(actionId: string) => string>(() => ""),
}));

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: dispatchMock },
}));

vi.mock("@/services/KeybindingService", () => ({
  keybindingService: { getDisplayCombo: getDisplayComboMock },
}));

vi.mock("@/components/icons", () => ({
  Plug: () => null,
  BrandMark: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
    "data-testid": testId,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    "data-testid"?: string;
  }) => (
    <button onClick={onClick} data-testid={testId}>
      {children}
    </button>
  ),
}));

vi.mock("@/config/agents", () => ({
  AGENT_REGISTRY: {
    claude: {
      name: "Claude",
      icon: () => <span data-testid="agent-icon-claude" />,
      color: "#abcabc",
      presets: [],
    },
  },
}));

vi.mock("@/store", () => ({
  useAgentSettingsStore: () => ({}),
}));

vi.mock("@/store/cliAvailabilityStore", () => ({
  useCliAvailabilityStore: () => ({}),
}));

vi.mock("@/store/appThemeStore", () => ({
  useAppThemeStore: () => ({}),
}));

vi.mock("@/clients", () => ({ cliAvailabilityClient: { refresh: () => Promise.resolve({}) } }));
vi.mock("@/clients/appThemeClient", () => ({
  appThemeClient: { setColorScheme: () => Promise.resolve() },
}));
vi.mock("../useAgentSetupPoll", () => ({ useAgentSetupPoll: () => undefined }));
vi.mock("@/lib/notify", () => ({ notify: vi.fn() }));
vi.mock("../SystemRequirementsSection", () => ({ SystemRequirementsSection: () => null }));
vi.mock("../AgentCliStep", () => ({ AgentCliStep: () => null }));
vi.mock("@/components/agents/AgentCard", () => ({ AgentCard: () => null }));

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
    useReducedMotion: () => false,
    m: { div: Passthrough },
    motion: { div: Passthrough },
  };
});

vi.mock("@/components/ui/AppDialog", () => {
  const Dialog = ({ isOpen, children }: { isOpen: boolean; children: React.ReactNode }) =>
    isOpen ? <div>{children}</div> : null;
  const passthrough = ({ children }: { children: React.ReactNode }) => <div>{children}</div>;
  Dialog.Header = passthrough;
  Dialog.Body = passthrough;
  Dialog.Footer = passthrough;
  Dialog.Title = passthrough;
  Dialog.CloseButton = () => null;
  return { AppDialog: Dialog };
});

vi.mock("@/components/ui/Spinner", () => ({ Spinner: () => null }));

import { CompleteStep } from "../AgentSetupWizard";

describe("CompleteStep summary", () => {
  beforeEach(() => {
    dispatchMock.mockClear();
    getDisplayComboMock.mockReset();
    getDisplayComboMock.mockReturnValue("");
  });

  // The completion screen must resolve to a single primary action, and the
  // shell's footer owns it. A button appearing back in the body would put a
  // second competing exit on the last screen of the flow.
  it("renders no action of its own — the shell footer owns the primary", () => {
    const { container } = render(<CompleteStep installedAgents={["claude"]} />);
    expect(container.querySelectorAll("button").length).toBe(0);
  });

  it("summarises the installed agents it is given", () => {
    render(<CompleteStep installedAgents={["claude"]} />);
    expect(screen.getByTestId("agent-card-claude")).toBeTruthy();
    expect(screen.getByText(/1 agent ready to use/i)).toBeTruthy();
  });

  it("explains the empty case instead of listing nothing", () => {
    render(<CompleteStep installedAgents={[]} />);
    expect(screen.queryByTestId("agent-card-claude")).toBeNull();
    expect(screen.getByText(/no agents were installed/i)).toBeTruthy();
  });
});
