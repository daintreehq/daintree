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
    codex: {
      name: "Codex",
      icon: () => <span data-testid="agent-icon-codex" />,
      color: "#123123",
      presets: [],
    },
    opencode: {
      name: "OpenCode",
      icon: () => <span data-testid="agent-icon-opencode" />,
      color: "#456456",
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

const readyClaude: CliAvailability = { claude: "ready" };
const mixed: CliAvailability = { claude: "ready", gemini: "unauthenticated" };
const onlyUnauthenticated: CliAvailability = { gemini: "unauthenticated" };

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
  const TOOLBAR_HINT = "Launch them from the toolbar or with keyboard shortcuts.";
  const PROJECT_HINT = "Open a project to start one in it.";

  const summaryCases: Array<{
    name: string;
    ids: string[];
    availability: CliAvailability;
    line: string;
  }> = [
    {
      name: "one ready agent",
      ids: ["claude"],
      availability: { claude: "ready" },
      line: "You have 1 agent ready to use.",
    },
    {
      name: "two ready agents",
      ids: ["claude", "codex"],
      availability: { claude: "ready", codex: "ready" },
      line: "You have 2 agents ready to use.",
    },
    {
      name: "one ready and one with no credentials detected",
      ids: ["claude", "gemini"],
      availability: { claude: "ready", gemini: "unauthenticated" },
      line: "You have 1 agent ready to use. 1 other agent may ask you to sign in.",
    },
    {
      name: "two ready and two with no credentials detected",
      ids: ["claude", "codex", "gemini", "opencode"],
      availability: {
        claude: "ready",
        codex: "ready",
        gemini: "unauthenticated",
        opencode: "unauthenticated",
      },
      line: "You have 2 agents ready to use. 2 other agents may ask you to sign in.",
    },
    {
      name: "one agent with no credentials detected",
      ids: ["gemini"],
      availability: { gemini: "unauthenticated" },
      line: "You can launch 1 agent, which may ask you to sign in.",
    },
    {
      name: "two agents with no credentials detected",
      ids: ["gemini", "opencode"],
      availability: { gemini: "unauthenticated", opencode: "unauthenticated" },
      line: "You can launch 2 agents, which may ask you to sign in.",
    },
  ];

  it.each(summaryCases)("summarises $name in the whole sentence, in both workspace states", (c) => {
    const availability = c.availability;
    const first = render(<CompleteStep installedAgents={c.ids} availability={availability} />);
    expect(first.container.querySelector("p")?.textContent).toBe(`${c.line} ${TOOLBAR_HINT}`);
    first.unmount();

    const second = render(
      <CompleteStep installedAgents={c.ids} availability={availability} hasWorkspace={false} />
    );
    expect(second.container.querySelector("p")?.textContent).toBe(`${c.line} ${PROJECT_HINT}`);
  });

  it("says nothing about sign-in when every agent is ready", () => {
    render(<CompleteStep installedAgents={["claude"]} availability={readyClaude} />);
    expect(screen.queryByText(/sign in/i)).toBeNull();
    expect(screen.queryByText("No credentials detected")).toBeNull();
  });

  it("lists the agents it is given, in the order it is given them", () => {
    const { container } = render(
      <CompleteStep installedAgents={["gemini", "claude"]} availability={mixed} />
    );
    const cards = Array.from(container.querySelectorAll("[data-testid^='agent-card-']"));
    expect(cards.map((c) => c.getAttribute("data-testid"))).toEqual([
      "agent-card-gemini",
      "agent-card-claude",
    ]);
  });

  it("lists only the agents it is given", () => {
    const { container } = render(
      <CompleteStep installedAgents={["claude"]} availability={readyClaude} />
    );
    expect(container.querySelectorAll("[data-testid^='agent-card-']")).toHaveLength(1);
  });

  it.each([
    { signedOut: "gemini", ready: "claude" },
    { signedOut: "claude", ready: "gemini" },
  ])("marks $signedOut's card, and not $ready's, from availability", ({ signedOut, ready }) => {
    const availability: CliAvailability = { [signedOut]: "unauthenticated", [ready]: "ready" };
    render(<CompleteStep installedAgents={["claude", "gemini"]} availability={availability} />);
    expect(screen.getByTestId(`agent-card-${signedOut}`).textContent).toContain(
      "No credentials detected"
    );
    expect(screen.getByTestId(`agent-card-${ready}`).textContent).not.toContain(
      "No credentials detected"
    );
  });

  it("draws the key glyph for the label, hidden from assistive technology", () => {
    render(<CompleteStep installedAgents={["gemini"]} availability={onlyUnauthenticated} />);
    const status = screen
      .getByTestId("agent-card-gemini")
      .querySelector("[data-agent-status='No credentials detected']");
    const icon = status?.querySelector("svg.lucide-key-round");
    expect(icon).not.toBeNull();
    expect(icon?.getAttribute("aria-hidden")).toBe("true");
  });

  it("keeps the status label readable to assistive technology", () => {
    render(<CompleteStep installedAgents={["gemini"]} availability={onlyUnauthenticated} />);
    const label = screen.getByText("No credentials detected");
    expect(label.closest("[aria-hidden='true']")).toBeNull();
  });

  it("makes no ready claim when no agent is ready", () => {
    render(<CompleteStep installedAgents={["gemini"]} availability={onlyUnauthenticated} />);
    expect(screen.queryByText(/ready to use/i)).toBeNull();
    expect(screen.getByTestId("agent-card-gemini")).toBeTruthy();
  });
});
