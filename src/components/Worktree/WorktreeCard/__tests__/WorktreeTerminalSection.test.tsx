/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import {
  WorktreeTerminalSection,
  type WorktreeTerminalSectionProps,
} from "../WorktreeTerminalSection";
import type { TerminalInstance } from "@/store/terminalStore";
import { TooltipProvider } from "@/components/ui/tooltip";

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
