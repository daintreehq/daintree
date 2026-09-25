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
import type { PtyPanelData } from "@shared/types/panel";
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
  SortableWorktreeTerminal: ({ children }: { children: ReactNode }) => <>{children}</>,
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

function makeTerminal(overrides: Partial<PtyPanelData> = {}): PtyPanelData {
  return {
    id: `term-${++terminalCounter}`,
    pid: 1234,
    title: "Test Terminal",
    kind: "terminal",
    location: "grid",
    worktreeId: "wt-1",
    lastActivityTimestamp: Date.now(),
    cwd: "/tmp",
    cols: 80,
    rows: 24,
    ...overrides,
  } as PtyPanelData;
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

  it("drops the summary glyph once expanded, where the child rows carry agent identity", () => {
    // The glyph earns its ~18px of a 240px column only while the sessions it
    // summarises are hidden. Expanded, every child row is directly below the
    // trigger carrying its own agent glyph, and the trigger's copy pushed
    // "Active sessions" onto a different column from "Details" — the row the
    // card presents as its sibling. Collapsed it stays, which the test above
    // pins; this asserts the pair, not either value.
    const collapsed = renderSection({
      terminals: [
        makeTerminal({ detectedAgentId: "claude" }),
        makeTerminal({ detectedAgentId: "claude" }),
      ],
    });
    expect(screen.getByTestId("agent-icon")).toBeDefined();
    collapsed.unmount();

    renderSection({
      isExpanded: true,
      terminals: [
        makeTerminal({ detectedAgentId: "claude" }),
        makeTerminal({ detectedAgentId: "claude" }),
      ],
    });
    expect(screen.queryByTestId("agent-icon")).toBeNull();
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

  it("does not paint the agent icon directly (renders in currentColor)", () => {
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

  it("an armable row exposes its fleet membership as a pressed state", () => {
    // A row's button toggles membership, which is `aria-pressed` on a button.
    // `aria-selected` is not a button attribute, so it was never announced.
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

    const button = screen.getAllByRole("button", { name: /Test Terminal/i })[0]!;
    expect(button.getAttribute("aria-pressed")).toBe("false");
    act(() => {
      useFleetArmingStore.getState().armId("a1");
    });
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(button.hasAttribute("aria-selected")).toBe(false);
  });

  it("a row that opens rather than toggles claims no pressed state", () => {
    const docked = makeTerminal({ id: "d1", kind: "terminal", hasPty: true, location: "dock" });
    renderSection({
      isExpanded: true,
      terminals: [docked],
      counts: { ...baseCounts, total: 1 },
    });

    const button = screen.getAllByRole("button", { name: /Test Terminal/i })[0]!;
    expect(button.hasAttribute("aria-pressed")).toBe(false);
  });

  it("a row's button is described by where its session lives", () => {
    // The placement mark is a glyph with a hover tooltip; without a
    // description the keyboard and a screen reader never learn it, and two
    // sessions with the same name differ only by it.
    const docked = makeTerminal({ id: "d1", kind: "terminal", hasPty: true, location: "dock" });
    const onGrid = makeTerminal({ id: "g1", kind: "terminal", hasPty: true, location: "grid" });
    renderSection({
      isExpanded: true,
      terminals: [docked, onGrid],
      counts: { ...baseCounts, total: 2 },
    });

    const descriptions = screen.getAllByRole("button", { name: /Test Terminal/i }).map((button) => {
      const id = button.getAttribute("aria-describedby");
      return id ? document.getElementById(id)?.textContent : null;
    });
    expect(descriptions).toEqual(["Docked", "On grid"]);
  });

  it("a running command joins the row's description beside its placement", () => {
    const running = makeTerminal({
      id: "r1",
      kind: "terminal",
      hasPty: true,
      location: "dock",
      activityStatus: "working",
      lastCommand: "npm run test -- --watch",
    });
    renderSection({
      isExpanded: true,
      terminals: [running],
      counts: { ...baseCounts, total: 1 },
    });

    const button = screen.getAllByRole("button", { name: /Test Terminal/i })[0]!;
    const ids = (button.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean);
    const described = ids.map((id) => document.getElementById(id)?.textContent);
    expect(described).not.toContain(undefined);
    expect(described).toEqual(expect.arrayContaining(["npm run test -- --watch", "Docked"]));
  });

  it("names a row by its title alone, with placement kept to the description", () => {
    const docked = makeTerminal({ id: "d1", kind: "terminal", hasPty: true, location: "dock" });
    renderSection({
      isExpanded: true,
      terminals: [docked],
      counts: { ...baseCounts, total: 1 },
    });

    const button = screen.getAllByRole("button", { name: /Test Terminal/i })[0]!;
    const labelIds = (button.getAttribute("aria-labelledby") ?? "").split(/\s+/).filter(Boolean);
    expect(labelIds.map((id) => document.getElementById(id)?.textContent)).toEqual([docked.title]);
  });

  it("keeps description ids unique when the same session renders twice", () => {
    // The sidebar card and the overview grid can both show one session.
    const term = makeTerminal({ id: "same", kind: "terminal", hasPty: true, location: "dock" });
    renderSection({ isExpanded: true, terminals: [term], counts: { ...baseCounts, total: 1 } });
    renderSection({ isExpanded: true, terminals: [term], counts: { ...baseCounts, total: 1 } });

    const buttons = screen.getAllByRole("button", { name: /Test Terminal/i });
    expect(buttons.length).toBe(2);
    const refs = buttons.map((b) => b.getAttribute("aria-describedby"));
    expect(new Set(refs).size).toBe(2);
  });

  it("only claims multi-selection on a role that supports it", () => {
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

    for (const el of container.querySelectorAll("[aria-multiselectable]")) {
      expect(["listbox", "grid", "tree", "treegrid", "tablist"]).toContain(el.getAttribute("role"));
    }
  });
});

// Terminal row state icon: active states (working/waiting/directing) pass
// through regardless of identity (#6650 boot window). Once the agent chrome is
// live, the indicator stays visible — idle/missing/completed state coerce to
// waiting so the activity indicator never silently disappears mid-flight.
describe("WorktreeTerminalSection row state icon", () => {
  beforeEach(() => {
    useFleetArmingStore.setState({
      armedIds: new Set<string>(),
      armOrder: [],
      armOrderById: {},
      lastArmedId: null,
    });
  });

  it("renders working icon when agentState='working' and no agent identity is set", () => {
    const term = makeTerminal({
      id: "no-id-1",
      kind: "terminal",
      hasPty: true,
      agentState: "working",
    });
    const { container } = renderSection({
      isExpanded: true,
      terminals: [term],
      counts: { ...baseCounts, total: 1 },
    });
    const row = container.querySelector('[data-terminal-id="no-id-1"]');
    expect(row).not.toBeNull();
    expect(row?.getAttribute("data-terminal-agent-state")).toBe("working");
    const stateIcon = row?.querySelector('[aria-label="working"]');
    expect(stateIcon).not.toBeNull();
  });

  it("renders waiting icon for identity-less terminal with agentState='waiting'", () => {
    const term = makeTerminal({
      id: "no-id-2",
      kind: "terminal",
      hasPty: true,
      agentState: "waiting",
    });
    const { container } = renderSection({
      isExpanded: true,
      terminals: [term],
      counts: { ...baseCounts, total: 1 },
    });
    const row = container.querySelector('[data-terminal-id="no-id-2"]');
    const stateIcon = row?.querySelector('[aria-label="waiting"]');
    expect(stateIcon).not.toBeNull();
  });

  it("renders waiting icon when agentState='idle' and agent chrome is live", () => {
    const term = makeTerminal({
      id: "idle-1",
      kind: "terminal",
      hasPty: true,
      detectedAgentId: "claude",
      agentState: "idle",
    });
    const { container } = renderSection({
      isExpanded: true,
      terminals: [term],
      counts: { ...baseCounts, total: 1 },
    });
    const row = container.querySelector('[data-terminal-id="idle-1"]');
    const waitingIcon = row?.querySelector('[aria-label="waiting"]');
    expect(waitingIcon).not.toBeNull();
  });

  it("does not render any state icon when agentState='exited'", () => {
    const term = makeTerminal({
      id: "exited-1",
      kind: "terminal",
      hasPty: true,
      launchAgentId: "claude",
      agentState: "exited",
    });
    const { container } = renderSection({
      isExpanded: true,
      terminals: [term],
      counts: { ...baseCounts, total: 1 },
    });
    const row = container.querySelector('[data-terminal-id="exited-1"]');
    const stateIcons = row?.querySelectorAll(
      '[aria-label="working"], [aria-label="waiting"], [aria-label="directing"], [aria-label="done"], [aria-label="exited"], [aria-label="idle"]'
    );
    expect(stateIcons?.length ?? 0).toBe(0);
  });

  it("does not render any state icon during the post-exit IPC race (stale agentState)", () => {
    // Renderer can receive `terminal:exit` (sets exitCode/runtimeStatus) before
    // the `agent:state-changed` "exited" event lands — agentState may still
    // read "working". The chrome's hasExited gate must suppress the indicator.
    const term = makeTerminal({
      id: "exit-race-1",
      kind: "terminal",
      hasPty: true,
      launchAgentId: "claude",
      agentState: "working",
      runtimeStatus: "exited",
      exitCode: 0,
    });
    const { container } = renderSection({
      isExpanded: true,
      terminals: [term],
      counts: { ...baseCounts, total: 1 },
    });
    const row = container.querySelector('[data-terminal-id="exit-race-1"]');
    const stateIcons = row?.querySelectorAll(
      '[aria-label="working"], [aria-label="waiting"], [aria-label="directing"], [aria-label="done"], [aria-label="exited"], [aria-label="idle"]'
    );
    expect(stateIcons?.length ?? 0).toBe(0);
  });

  it("renders waiting icon when agentState='completed' and agent chrome is live", () => {
    const term = makeTerminal({
      id: "completed-1",
      kind: "terminal",
      hasPty: true,
      detectedAgentId: "claude",
      agentState: "completed",
    });
    const { container } = renderSection({
      isExpanded: true,
      terminals: [term],
      counts: { ...baseCounts, total: 1 },
    });
    const row = container.querySelector('[data-terminal-id="completed-1"]');
    const waitingIcon = row?.querySelector('[aria-label="waiting"]');
    expect(waitingIcon).not.toBeNull();
  });

  it("does not render state icon when agentState is undefined (plain shell)", () => {
    const term = makeTerminal({
      id: "plain-1",
      kind: "terminal",
      hasPty: true,
    });
    const { container } = renderSection({
      isExpanded: true,
      terminals: [term],
      counts: { ...baseCounts, total: 1 },
    });
    const row = container.querySelector('[data-terminal-id="plain-1"]');
    const stateIcons = row?.querySelectorAll("[aria-label]");
    const stateRelated = Array.from(stateIcons ?? []).filter((el) => {
      const label = el.getAttribute("aria-label");
      return (
        label === "working" || label === "waiting" || label === "directing" || label === "idle"
      );
    });
    expect(stateRelated.length).toBe(0);
  });
});

describe("WorktreeTerminalSection collapsed pill state indicators", () => {
  it("renders multi-state indicators when collapsed with mixed agent states", () => {
    renderSection({
      isExpanded: false,
      counts: {
        total: 5,
        byState: { idle: 0, working: 2, waiting: 2, directing: 0, completed: 1, exited: 0 },
      },
    });
    const indicators = screen.getByTestId("collapsed-session-indicators");
    expect(indicators).toBeDefined();
    const countSpans = indicators.querySelectorAll(".font-mono.tabular-nums");
    expect(countSpans.length).toBe(3);
  });

  it("renders single state indicator when only one non-idle state has count", () => {
    renderSection({
      isExpanded: false,
      counts: {
        total: 3,
        byState: { idle: 0, working: 3, waiting: 0, directing: 0, completed: 0, exited: 0 },
      },
    });
    const indicators = screen.getByTestId("collapsed-session-indicators");
    expect(indicators).toBeDefined();
    const countSpans = indicators.querySelectorAll(".font-mono.tabular-nums");
    expect(countSpans.length).toBe(1);
  });

  it("sets aria-label with full state breakdown on the role=img container", () => {
    renderSection({
      isExpanded: false,
      counts: {
        total: 5,
        byState: { idle: 3, working: 2, waiting: 2, directing: 0, completed: 1, exited: 0 },
      },
    });
    const indicators = screen.getByTestId("collapsed-session-indicators");
    expect(indicators.getAttribute("role")).toBe("img");
    expect(indicators.getAttribute("aria-label")).toBe("5 sessions: 2 working, 2 waiting, 1 done");
  });

  it("does not render indicators when section is expanded", () => {
    renderSection({
      isExpanded: true,
      counts: {
        total: 3,
        byState: { idle: 0, working: 2, waiting: 1, directing: 0, completed: 0, exited: 0 },
      },
    });
    expect(screen.queryByTestId("collapsed-session-indicators")).toBeNull();
  });

  it("renders nothing when all terminals are idle", () => {
    renderSection({
      isExpanded: false,
      counts: {
        total: 2,
        byState: { idle: 2, working: 0, waiting: 0, directing: 0, completed: 0, exited: 0 },
      },
    });
    expect(screen.queryByTestId("collapsed-session-indicators")).toBeNull();
  });

  it("renders nothing when all non-idle states have zero count", () => {
    renderSection({
      isExpanded: false,
      counts: {
        total: 0,
        byState: { idle: 0, working: 0, waiting: 0, directing: 0, completed: 0, exited: 0 },
      },
    });
    expect(screen.queryByTestId("collapsed-session-indicators")).toBeNull();
  });
});

describe("WorktreeTerminalSection drag handle reveal", () => {
  it("leaves the grip's visibility to the shared reveal rule in sidebar.css", () => {
    // A Tailwind opacity on the grip itself would fight the CSS reveal (which
    // is what hides it at rest and shows it on hover and keyboard focus).
    renderSection({ isExpanded: true });
    const handles = screen.getAllByRole("button", { name: "Drag to move terminal" });
    expect(handles.length).toBeGreaterThanOrEqual(1);
    for (const handle of handles) {
      expect(handle.hasAttribute("data-session-grip")).toBe(true);
      expect(handle.className).not.toMatch(/(^|\s)([\w-]+:)*opacity-/);
    }
  });
});

describe("WorktreeTerminalSection collapsed trigger name", () => {
  it("names itself once, starting with the visible summary, and repeats no count", () => {
    // Left to name-from-content the button read its visible "N active" and then
    // the nested cluster's own name, which restates the total. It also has to
    // start with what is on screen, so speech input can target it.
    const terminals = [
      makeTerminal({ detectedAgentId: "claude" }),
      makeTerminal({ detectedAgentId: "claude" }),
      makeTerminal({ detectedAgentId: "claude" }),
    ];
    renderSection({
      isExpanded: false,
      terminals,
      counts: {
        total: 3,
        byState: { idle: 0, working: 2, waiting: 1, directing: 0, completed: 0, exited: 0 },
      },
    });
    const button = document.querySelector<HTMLButtonElement>('button[aria-expanded="false"]')!;
    const name = button.getAttribute("aria-label") ?? "";
    // The visible words sit in separate flex items, so compare without spaces.
    const squash = (text: string) => text.replace(/\s+/g, "");
    const visible = squash(button.querySelector("span")!.textContent ?? "");
    expect(visible.length).toBeGreaterThan(0);
    expect(squash(name).startsWith(visible)).toBe(true);
    expect(name.match(/\b3\b/g) ?? []).toHaveLength(1);
    expect(name).toContain("2 working");
    expect(name).toContain("1 waiting");
    expect(button.querySelector("div")).toBeNull();
  });
});
