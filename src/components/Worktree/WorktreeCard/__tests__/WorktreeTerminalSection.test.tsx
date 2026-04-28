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

const MockClaudeIcon = ({ className }: { className?: string }) => (
  <svg data-testid="agent-icon" data-agent="claude" className={className} />
);
const MockGeminiIcon = ({ className }: { className?: string }) => (
  <svg data-testid="agent-icon" data-agent="gemini" className={className} />
);

vi.mock("@/config/agents", () => ({
  getAgentConfig: (agentId: string) => {
    if (agentId === "claude") return { icon: MockClaudeIcon, color: "#ff0000" };
    if (agentId === "gemini") return { icon: MockGeminiIcon, color: "#00aaff" };
    return undefined;
  },
  isRegisteredAgent: (id: string) => id === "claude" || id === "gemini",
  getAgentIds: () => ["claude", "gemini"],
}));

let terminalCounter = 0;

function makeTerminal(overrides: Partial<TerminalInstance> = {}): TerminalInstance {
  return {
    id: `term-${++terminalCounter}`,
    pid: 1234,
    title: "Test Terminal",
    kind: "terminal",
    location: "grid",
    worktreeId: "wt-1",
    lastActivityTimestamp: Date.now(),
    ...overrides,
  } as TerminalInstance;
}

const baseCounts: WorktreeTerminalSectionProps["counts"] = {
  total: 2,
  byState: { idle: 2, working: 0, waiting: 0, directing: 0, completed: 0, exited: 0 },
};

function renderSection(overrides: Partial<WorktreeTerminalSectionProps> = {}) {
  const terminals = overrides.terminals ?? [
    makeTerminal({ detectedAgentId: "claude" }),
    makeTerminal({ detectedAgentId: "claude" }),
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
  it("shows agent icon when all terminals share the same detectedAgentId (collapsed)", () => {
    renderSection({
      isExpanded: false,
      terminals: [
        makeTerminal({ detectedAgentId: "claude" }),
        makeTerminal({ detectedAgentId: "claude" }),
      ],
    });
    expect(screen.getByTestId("agent-icon")).toBeDefined();
  });

  it("shows agent icon when all terminals share the same detectedAgentId (expanded)", () => {
    renderSection({
      isExpanded: true,
      terminals: [
        makeTerminal({ detectedAgentId: "claude" }),
        makeTerminal({ detectedAgentId: "claude" }),
      ],
    });
    expect(screen.getByTestId("agent-icon")).toBeDefined();
  });

  it("falls back to SquareTerminal when agents are mixed", () => {
    const { container } = renderSection({
      terminals: [
        makeTerminal({ detectedAgentId: "claude" }),
        makeTerminal({ detectedAgentId: "gemini" }),
      ],
    });
    expect(screen.queryByTestId("agent-icon")).toBeNull();
    expect(container.querySelector("svg.lucide-square-terminal")).toBeTruthy();
  });

  it("falls back to SquareTerminal when no terminals have detectedAgentId", () => {
    const { container } = renderSection({
      terminals: [makeTerminal(), makeTerminal()],
    });
    expect(screen.queryByTestId("agent-icon")).toBeNull();
    expect(container.querySelector("svg.lucide-square-terminal")).toBeTruthy();
  });

  it("falls back to SquareTerminal when some terminals have detectedAgentId and some don't", () => {
    renderSection({
      terminals: [makeTerminal({ detectedAgentId: "claude" }), makeTerminal()],
    });
    expect(screen.queryByTestId("agent-icon")).toBeNull();
  });

  it("shows agent icon for single terminal with detectedAgentId", () => {
    renderSection({
      terminals: [makeTerminal({ detectedAgentId: "claude" })],
      counts: { ...baseCounts, total: 1 },
    });
    expect(screen.getByTestId("agent-icon")).toBeDefined();
  });

  it("falls back to SquareTerminal for unknown agent", () => {
    renderSection({
      terminals: [makeTerminal({ detectedAgentId: "unknown-agent" as never })],
      counts: { ...baseCounts, total: 1 },
    });
    expect(screen.queryByTestId("agent-icon")).toBeNull();
  });

  it("resolves agent from launchAgentId while launch affinity is still active", () => {
    renderSection({
      terminals: [
        makeTerminal({ launchAgentId: "claude", everDetectedAgent: true, agentState: "working" }),
        makeTerminal({ launchAgentId: "claude", everDetectedAgent: true, agentState: "idle" }),
      ],
    });
    expect(screen.getByTestId("agent-icon")).toBeDefined();
  });

  it("demotes launchAgentId-only terminals after explicit agent exit", () => {
    const { container } = renderSection({
      terminals: [
        makeTerminal({ launchAgentId: "claude", agentState: "exited" }),
        makeTerminal({ launchAgentId: "claude", agentState: "exited" }),
      ],
    });
    expect(screen.queryByTestId("agent-icon")).toBeNull();
    expect(container.querySelector("svg.lucide-square-terminal")).toBeTruthy();
  });

  it("prefers detectedAgentId over launchAgentId when both are set", () => {
    renderSection({
      terminals: [
        makeTerminal({ launchAgentId: "claude", detectedAgentId: "gemini" }),
        makeTerminal({ launchAgentId: "claude", detectedAgentId: "gemini" }),
      ],
    });
    // Distinct mock icons per agent lock in precedence: a swapped-arg regression
    // (launchAgentId-wins) would surface the Claude icon instead.
    const icon = screen.getByTestId("agent-icon");
    expect(icon.getAttribute("data-agent")).toBe("gemini");
  });

  it("uses detectedAgentId to classify a plain shell that entered agent mode", () => {
    renderSection({
      terminals: [makeTerminal({ detectedAgentId: "claude" })],
      counts: { ...baseCounts, total: 1 },
    });
    expect(screen.getByTestId("agent-icon")).toBeDefined();
  });

  it("uses runtimeIdentity to classify a plain shell that entered agent mode", () => {
    renderSection({
      terminals: [
        makeTerminal({
          runtimeIdentity: {
            kind: "agent",
            id: "claude",
            iconId: "claude",
            agentId: "claude",
          },
        }),
      ],
      counts: { ...baseCounts, total: 1 },
    });
    expect(screen.getByTestId("agent-icon")).toBeDefined();
  });

  it("does not pass brandColor to the agent icon (renders in currentColor)", () => {
    renderSection({
      terminals: [makeTerminal({ detectedAgentId: "claude" })],
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
    const term = makeTerminal({
      id: "a1",
      detectedAgentId: "claude",
      kind: "terminal",
      hasPty: true,
    });
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

  it("plain click on a runtime-identified agent tile arms it", () => {
    const term = makeTerminal({
      id: "runtime-agent",
      kind: "terminal",
      hasPty: true,
      runtimeIdentity: {
        kind: "agent",
        id: "claude",
        iconId: "claude",
        agentId: "claude",
      },
    });
    const onSelect = vi.fn();
    renderSection({
      isExpanded: true,
      terminals: [term],
      counts: { ...baseCounts, total: 1 },
      onTerminalSelect: onSelect,
    });

    const button = screen.getAllByRole("button", { name: /Test Terminal/i })[0]!;
    fireEvent.click(button);

    expect(useFleetArmingStore.getState().armedIds.has("runtime-agent")).toBe(true);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("shift-click on a sidebar entry toggles a single id (additive single add, no range extend)", () => {
    // The grid uses Shift = single add; the sidebar mirrors the same model
    // so the gesture is consistent across surfaces. There is no range
    // extension on either surface.
    const t1 = makeTerminal({
      id: "a1",
      detectedAgentId: "claude",
      kind: "terminal",
      hasPty: true,
    });
    const t2 = makeTerminal({
      id: "a2",
      detectedAgentId: "claude",
      kind: "terminal",
      hasPty: true,
    });
    const t3 = makeTerminal({
      id: "a3",
      detectedAgentId: "claude",
      kind: "terminal",
      hasPty: true,
    });
    renderSection({
      isExpanded: true,
      terminals: [t1, t2, t3],
      counts: { ...baseCounts, total: 3 },
    });

    const buttons = screen.getAllByRole("button", { name: /Test Terminal/i });
    fireEvent.click(buttons[0]!); // arm a1
    fireEvent.click(buttons[2]!, { shiftKey: true }); // shift-click adds only a3

    const armed = useFleetArmingStore.getState().armedIds;
    expect([...armed].sort()).toEqual(["a1", "a3"]);
  });

  it("cmd-click (metaKey) toggles the armed state without clearing others", () => {
    const t1 = makeTerminal({
      id: "a1",
      detectedAgentId: "claude",
      kind: "terminal",
      hasPty: true,
    });
    const t2 = makeTerminal({
      id: "a2",
      detectedAgentId: "claude",
      kind: "terminal",
      hasPty: true,
    });
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

  it("click on a plain terminal arms it for Fleet broadcast", () => {
    // Fleet peers are live PTY terminals. Agent-only quick actions still
    // re-filter by agent capability at dispatch time.
    const plain = makeTerminal({
      id: "p1",
      kind: "terminal",
      hasPty: true,
    });
    const onSelect = vi.fn();
    renderSection({
      isExpanded: true,
      terminals: [plain],
      counts: { ...baseCounts, total: 1 },
      onTerminalSelect: onSelect,
    });

    const button = screen.getAllByRole("button", { name: /Test Terminal/i })[0]!;
    fireEvent.click(button);

    expect(useFleetArmingStore.getState().armedIds.has("p1")).toBe(true);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("armed tile gets aria-selected=true", () => {
    const term = makeTerminal({
      id: "a1",
      detectedAgentId: "claude",
      kind: "terminal",
      hasPty: true,
    });
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
    const term = makeTerminal({
      id: "a1",
      detectedAgentId: "claude",
      kind: "terminal",
      hasPty: true,
    });
    const { container } = renderSection({
      isExpanded: true,
      terminals: [term],
      counts: { ...baseCounts, total: 1 },
    });

    const scrollContainer = container.querySelector('[aria-multiselectable="true"]');
    expect(scrollContainer).toBeTruthy();
  });
});
