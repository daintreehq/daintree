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
  keybindingService: {
    getDisplayCombo: getDisplayComboMock,
    getEffectiveCombo: getDisplayComboMock,
  },
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
    gemini: {
      name: "Gemini",
      icon: () => <span data-testid="agent-icon-gemini" />,
      color: "#defdef",
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

import type { CliAvailability } from "@shared/types";
import { CompleteStep } from "../AgentSetupWizard";

const readyClaude: CliAvailability = { claude: "ready" } as CliAvailability;
const mixed: CliAvailability = { claude: "ready", gemini: "unauthenticated" } as CliAvailability;
const onlyUnauthenticated: CliAvailability = { gemini: "unauthenticated" } as CliAvailability;

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
    const { container } = render(
      <CompleteStep installedAgents={["claude"]} availability={readyClaude} />
    );
    expect(container.querySelectorAll("button").length).toBe(0);
  });

  it("summarises the installed agents it is given", () => {
    render(<CompleteStep installedAgents={["claude"]} availability={readyClaude} />);
    expect(screen.getByTestId("agent-card-claude")).toBeTruthy();
    expect(screen.getByText(/1 agent ready to use/i)).toBeTruthy();
  });

  it("explains the empty case instead of listing nothing", () => {
    render(<CompleteStep installedAgents={[]} availability={{}} />);
    expect(screen.queryByTestId("agent-card-claude")).toBeNull();
    expect(screen.getByText(/no agent is ready yet/i)).toBeTruthy();
  });

  it("does not celebrate a deferred install, and names one way back", () => {
    const { container } = render(<CompleteStep installedAgents={[]} availability={{}} />);
    expect(container.querySelector("svg")).toBeNull();
    expect(screen.getAllByText(/Settings → Agents/)).toHaveLength(1);
  });

  it("points at a project when there is nowhere to launch into yet", () => {
    render(
      <CompleteStep installedAgents={["claude"]} availability={readyClaude} hasWorkspace={false} />
    );
    expect(screen.getByText(/open a project to start one/i)).toBeTruthy();
    expect(screen.queryByText(/launch them from the toolbar/i)).toBeNull();
  });

  // Settings → General counts only `ready` as ready and files `unauthenticated`
  // under needs attention. The summary has to use the word for the same
  // observation, or setup looks like it succeeded and then regressed.
  it("says nothing about sign-in when every agent is ready", () => {
    render(<CompleteStep installedAgents={["claude"]} availability={readyClaude} />);
    expect(screen.queryByText(/sign in/i)).toBeNull();
    expect(screen.queryByText("No credentials detected")).toBeNull();
  });

  it("counts only ready agents as ready and names the rest", () => {
    render(<CompleteStep installedAgents={["claude", "gemini"]} availability={mixed} />);
    expect(
      screen.getByText(
        /You have 1 agent ready to use\. 1 other agent may ask you to sign in\. Launch them/
      )
    ).toBeTruthy();
  });

  it("marks the card of an agent with no credentials detected, and only that card", () => {
    render(<CompleteStep installedAgents={["claude", "gemini"]} availability={mixed} />);
    const gemini = screen.getByTestId("agent-card-gemini");
    expect(gemini.textContent).toContain("No credentials detected");
    expect(screen.getByTestId("agent-card-claude").textContent).not.toContain(
      "No credentials detected"
    );
  });

  it("keeps the status label readable to assistive technology", () => {
    render(<CompleteStep installedAgents={["gemini"]} availability={onlyUnauthenticated} />);
    const label = screen.getByText("No credentials detected");
    expect(label.closest("[aria-hidden='true']")).toBeNull();
  });

  it("makes no ready claim when no agent is ready", () => {
    render(<CompleteStep installedAgents={["gemini"]} availability={onlyUnauthenticated} />);
    expect(screen.queryByText(/ready to use/i)).toBeNull();
    expect(screen.getByText(/You can launch 1 agent, which may ask you to sign in\./)).toBeTruthy();
    expect(screen.getByTestId("agent-card-gemini")).toBeTruthy();
  });

  it("keeps the project hint when nothing is ready and there is no workspace", () => {
    render(
      <CompleteStep
        installedAgents={["gemini"]}
        availability={onlyUnauthenticated}
        hasWorkspace={false}
      />
    );
    expect(screen.getByText(/open a project to start one/i)).toBeTruthy();
  });
});
