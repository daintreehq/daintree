// @vitest-environment jsdom
import { render, screen, fireEvent } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { cliAvailabilityState } = vi.hoisted(() => ({
  cliAvailabilityState: {
    availability: {} as Record<string, string>,
    isInitialized: true,
    hasRealData: true,
  },
}));

vi.mock("@/lib/utils", () => ({ cn: (...args: unknown[]) => args.filter(Boolean).join(" ") }));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, onClick, ...rest }: React.PropsWithChildren<{ onClick?: () => void }>) => (
    <button type="button" onClick={onClick} {...rest}>
      {children}
    </button>
  ),
}));

vi.mock("@/config/agents", () => ({
  AGENT_REGISTRY: {
    claude: { name: "Claude", iconId: "claude", color: "#000", icon: () => null, tooltip: "c" },
    gemini: { name: "Gemini", iconId: "gemini", color: "#000", icon: () => null, tooltip: "g" },
    codex: { name: "Codex", iconId: "codex", color: "#000", icon: () => null, tooltip: "cx" },
  },
}));

vi.mock("@/store/cliAvailabilityStore", () => {
  const store = (selector: (state: typeof cliAvailabilityState) => unknown) =>
    selector(cliAvailabilityState);
  store.getState = () => cliAvailabilityState;
  return { useCliAvailabilityStore: store };
});

import { HelpAgentPicker } from "../HelpAgentPicker";

describe("HelpAgentPicker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cliAvailabilityState.isInitialized = true;
    cliAvailabilityState.hasRealData = true;
    cliAvailabilityState.availability = {};
  });

  it("renders only the agents passed via supportedAgentIds (issue #6612)", () => {
    cliAvailabilityState.availability = {
      claude: "ready",
      gemini: "ready",
      codex: "ready",
    };

    render(<HelpAgentPicker onSelectAgent={vi.fn()} supportedAgentIds={["claude"]} />);

    expect(screen.getByText("Claude")).toBeTruthy();
    expect(screen.queryByText("Gemini")).toBeNull();
    expect(screen.queryByText("Codex")).toBeNull();
  });

  it("renders empty state when supportedAgentIds is empty", () => {
    const { container } = render(
      <HelpAgentPicker onSelectAgent={vi.fn()} supportedAgentIds={[]} />
    );

    expect(screen.getByText("No agents are installed.")).toBeTruthy();
    expect(screen.getByText("Run setup wizard")).toBeTruthy();
    expect(container.textContent).not.toMatch(/Enable an agent/i);
  });

  it("setup wizard CTA dispatches daintree:open-agent-setup-wizard", () => {
    const dispatchSpy = vi.spyOn(window, "dispatchEvent");
    render(<HelpAgentPicker onSelectAgent={vi.fn()} supportedAgentIds={[]} />);

    fireEvent.click(screen.getByText("Run setup wizard"));

    const call = dispatchSpy.mock.calls.find(
      ([event]) => event instanceof CustomEvent && event.type === "daintree:open-agent-setup-wizard"
    );
    expect(call).toBeTruthy();

    dispatchSpy.mockRestore();
  });

  it("renders loading sentinel (not empty state) while real data is pending", () => {
    // hasRealData=false means neither cache nor probe has landed — don't show
    // "No agents installed" prematurely (avoids flash on cold open with cache).
    cliAvailabilityState.hasRealData = false;

    render(<HelpAgentPicker onSelectAgent={vi.fn()} supportedAgentIds={[]} />);

    expect(screen.getByText("Checking for installed agents…")).toBeTruthy();
    expect(screen.queryByText("No agents are installed.")).toBeNull();
    expect(screen.queryByText("Claude")).toBeNull();
  });

  it("calls onSelectAgent when an installed agent is clicked", () => {
    cliAvailabilityState.availability = { claude: "ready" };

    const onSelectAgent = vi.fn();
    render(<HelpAgentPicker onSelectAgent={onSelectAgent} supportedAgentIds={["claude"]} />);

    fireEvent.click(screen.getByText("Claude"));
    expect(onSelectAgent).toHaveBeenCalledWith("claude");
  });
});
