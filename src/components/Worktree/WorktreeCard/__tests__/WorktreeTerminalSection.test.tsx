/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import type { ReactNode } from "react";
import {
  WorktreeTerminalSection,
  type WorktreeTerminalSectionProps,
} from "../WorktreeTerminalSection";
import type { TerminalInstance } from "@/store/panelStore";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useFleetArmingStore } from "@/store/fleetArmingStore";

vi.mock("react-dom", async () => {
  const actual = await vi.importActual<typeof import("react-dom")>("react-dom");
  return { ...actual, createPortal: (children: ReactNode) => children };
});

vi.mock("@dnd-kit/sortable", () => ({
  SortableContext: ({ children }: { children: ReactNode }) => <>{children}</>,
  verticalListSortingStrategy: {},
}));

vi.mock("@/components/DragDrop/SortableWorktreeTerminal", () => ({
  SortableWorktreeTerminal: ({
    children,
  }: {
    children: (arg: { listeners: Record<string, unknown> }) => ReactNode;
  }) => <>{children({ listeners: {} })}</>,
  getAccordionDragId: (id: string) => `accordion-${id}`,
}));

vi.mock("@/components/Terminal/TerminalIcon", () => ({
  TerminalIcon: ({ className }: { className?: string }) => (
    <svg data-testid="terminal-row-icon" className={className} />
  ),
}));

const MockAgentIcon = ({ className }: { className?: string }) => (
  <svg data-testid="agent-icon" className={className} />
);

vi.mock("@/config/agents", () => ({
  getAgentConfig: (agentId: string) => {
    if (agentId === "claude" || agentId === "gemini") {
      return { icon: MockAgentIcon, color: "#ff0000" };
    }
    return undefined;
  },
  isRegisteredAgent: (id: string) => id === "claude" || id === "gemini",
  getAgentIds: () => ["claude", "gemini"],
}));

function makeTerminal(overrides: Partial<TerminalInstance> = {}): TerminalInstance {
  return {
    id: `term-${Math.random().toString(36).slice(2, 7)}`,
    pid: 1234,
    title: "Test Terminal",
    type: "terminal",
    kind: "terminal",
    location: "grid",
    worktreeId: "wt-1",
    lastActivityTimestamp: Date.now(),
    ...overrides,
  } as TerminalInstance;
}

const baseCounts: WorktreeTerminalSectionProps["counts"] = {
  total: 2,
  byState: { idle: 2, working: 0, running: 0, waiting: 0, directing: 0, completed: 0, exited: 0 },
};

function renderSection(overrides: Partial<WorktreeTerminalSectionProps> = {}) {
  const terminals = overrides.terminals ?? [
    makeTerminal({ agentId: "claude" }),
    makeTerminal({ agentId: "claude" }),
  ];
  return render(
    <TooltipProvider>
      <WorktreeTerminalSection
        worktreeId="wt-1"
        isExpanded={false}
        counts={{ ...baseCounts, total: terminals.length }}
        terminals={terminals}
        onToggle={() => {}}
        onTerminalSelect={() => {}}
        {...overrides}
      />
    </TooltipProvider>
  );
}

describe("WorktreeTerminalSection summary icon", () => {
  it("shows agent icon when all terminals share the same agentId (collapsed)", () => {
    renderSection({
      isExpanded: false,
      terminals: [makeTerminal({ agentId: "claude" }), makeTerminal({ agentId: "claude" })],
    });
    expect(screen.getByTestId("agent-icon")).toBeDefined();
  });

  it("shows agent icon when all terminals share the same agentId (expanded)", () => {
    renderSection({
      isExpanded: true,
      terminals: [makeTerminal({ agentId: "claude" }), makeTerminal({ agentId: "claude" })],
    });
    expect(screen.getByTestId("agent-icon")).toBeDefined();
  });

  it("falls back to SquareTerminal when agents are mixed", () => {
    const { container } = renderSection({
      terminals: [makeTerminal({ agentId: "claude" }), makeTerminal({ agentId: "gemini" })],
    });
    expect(screen.queryByTestId("agent-icon")).toBeNull();
    expect(container.querySelector("svg.lucide-square-terminal")).toBeTruthy();
  });

  it("falls back to SquareTerminal when no terminals have agentId", () => {
    const { container } = renderSection({
      terminals: [makeTerminal({ type: "terminal" }), makeTerminal({ type: "terminal" })],
    });
    expect(screen.queryByTestId("agent-icon")).toBeNull();
    expect(container.querySelector("svg.lucide-square-terminal")).toBeTruthy();
  });

  it("falls back to SquareTerminal when some terminals have agentId and some don't", () => {
    renderSection({
      terminals: [makeTerminal({ agentId: "claude" }), makeTerminal({ type: "terminal" })],
    });
    expect(screen.queryByTestId("agent-icon")).toBeNull();
  });

  it("shows agent icon for single terminal with agentId", () => {
    renderSection({
      terminals: [makeTerminal({ agentId: "claude" })],
      counts: { ...baseCounts, total: 1 },
    });
    expect(screen.getByTestId("agent-icon")).toBeDefined();
  });

  it("falls back to SquareTerminal for unknown agent", () => {
    renderSection({
      terminals: [makeTerminal({ agentId: "unknown-agent" })],
      counts: { ...baseCounts, total: 1 },
    });
    expect(screen.queryByTestId("agent-icon")).toBeNull();
  });

  it("resolves agent from type when agentId is absent (legacy compat)", () => {
    renderSection({
      terminals: [
        makeTerminal({ agentId: undefined, type: "claude" as TerminalInstance["type"] }),
        makeTerminal({ agentId: undefined, type: "claude" as TerminalInstance["type"] }),
      ],
    });
    expect(screen.getByTestId("agent-icon")).toBeDefined();
  });

  it("does not pass brandColor to the agent icon (renders in currentColor)", () => {
    renderSection({
      terminals: [makeTerminal({ agentId: "claude" })],
      counts: { ...baseCounts, total: 1 },
    });
    const icon = screen.getByTestId("agent-icon");
    expect(icon.getAttribute("brandColor")).toBeNull();
    expect(icon.getAttribute("style")).toBeNull();
  });
});

describe("WorktreeTerminalSection arming click handlers", () => {
  beforeEach(() => {
    useFleetArmingStore.setState({
      armedIds: new Set<string>(),
      armOrder: [],
      armOrderById: {},
      lastArmedId: null,
    });
  });

  it("plain click on an eligible agent tile arms it", () => {
    const term = makeTerminal({ id: "a1", agentId: "claude", kind: "agent", hasPty: true });
    const onSelect = vi.fn();
    renderSection({
      isExpanded: true,
      terminals: [term],
      counts: { ...baseCounts, total: 1 },
      onTerminalSelect: onSelect,
    });

    // The row button renders "Test Terminal" as the title
    const button = screen.getAllByRole("button", { name: /Test Terminal/i })[0]!;
    fireEvent.click(button);

    expect(useFleetArmingStore.getState().armedIds.has("a1")).toBe(true);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("shift-click extends the armed range from lastArmedId", () => {
    const t1 = makeTerminal({ id: "a1", agentId: "claude", kind: "agent", hasPty: true });
    const t2 = makeTerminal({ id: "a2", agentId: "claude", kind: "agent", hasPty: true });
    const t3 = makeTerminal({ id: "a3", agentId: "claude", kind: "agent", hasPty: true });
    renderSection({
      isExpanded: true,
      terminals: [t1, t2, t3],
      counts: { ...baseCounts, total: 3 },
    });

    const buttons = screen.getAllByRole("button", { name: /Test Terminal/i });
    fireEvent.click(buttons[0]!); // arm a1 — becomes anchor
    fireEvent.click(buttons[2]!, { shiftKey: true }); // extend to a3

    const armed = useFleetArmingStore.getState().armedIds;
    expect([...armed].sort()).toEqual(["a1", "a2", "a3"]);
  });

  it("cmd-click (metaKey) toggles the armed state without clearing others", () => {
    const t1 = makeTerminal({ id: "a1", agentId: "claude", kind: "agent", hasPty: true });
    const t2 = makeTerminal({ id: "a2", agentId: "claude", kind: "agent", hasPty: true });
    renderSection({
      isExpanded: true,
      terminals: [t1, t2],
      counts: { ...baseCounts, total: 2 },
    });

    const buttons = screen.getAllByRole("button", { name: /Test Terminal/i });
    fireEvent.click(buttons[0]!); // arm a1
    fireEvent.click(buttons[1]!, { metaKey: true }); // cmd+click a2 — also arms

    const armed = useFleetArmingStore.getState().armedIds;
    expect([...armed].sort()).toEqual(["a1", "a2"]);
  });

  it("click on non-eligible tile calls onTerminalSelect (legacy)", () => {
    const nonAgent = makeTerminal({
      id: "p1",
      kind: "terminal",
      agentId: undefined,
      hasPty: true,
    });
    const onSelect = vi.fn();
    renderSection({
      isExpanded: true,
      terminals: [nonAgent],
      counts: { ...baseCounts, total: 1 },
      onTerminalSelect: onSelect,
    });

    const button = screen.getAllByRole("button", { name: /Test Terminal/i })[0]!;
    fireEvent.click(button);

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(useFleetArmingStore.getState().armedIds.size).toBe(0);
  });

  it("armed tile gets aria-selected=true", () => {
    const term = makeTerminal({ id: "a1", agentId: "claude", kind: "agent", hasPty: true });
    renderSection({
      isExpanded: true,
      terminals: [term],
      counts: { ...baseCounts, total: 1 },
    });
    act(() => {
      useFleetArmingStore.getState().armId("a1");
    });

    const button = screen.getAllByRole("button", { name: /Test Terminal/i })[0]!;
    expect(button.getAttribute("aria-selected")).toBe("true");
  });

  it("scroll container has aria-multiselectable", () => {
    const term = makeTerminal({ id: "a1", agentId: "claude", kind: "agent", hasPty: true });
    const { container } = renderSection({
      isExpanded: true,
      terminals: [term],
      counts: { ...baseCounts, total: 1 },
    });

    const scrollContainer = container.querySelector('[aria-multiselectable="true"]');
    expect(scrollContainer).toBeTruthy();
  });
});
