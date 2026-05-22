// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, cleanup } from "@testing-library/react";
import type { TabGroup } from "@shared/types/panel";

vi.mock("@/lib/utils", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}));

const { panelState, mockPanelStoreApi } = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  let snapshot: { panelsById: Record<string, unknown> } = { panelsById: {} };
  const set = (next: Record<string, unknown>) => {
    // New object identity ensures `useSyncExternalStore` re-renders.
    snapshot = { panelsById: next };
    listeners.forEach((fn) => fn());
  };
  return {
    panelState: { set },
    mockPanelStoreApi: {
      subscribe: (fn: () => void) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      getState: () => snapshot,
    },
  };
});

vi.mock("@/store", () => ({
  panelStoreApi: mockPanelStoreApi,
}));

vi.mock("@/components/Worktree/terminalStateConfig", () => ({
  getEffectiveStateColor: (s: string) => `color-${s}`,
  getEffectiveStateLabel: (s: string) => s,
}));

vi.mock("@/utils/terminalAgentDisplayState", () => ({
  getTerminalAgentDisplayState: (_: unknown, agentState?: string) => agentState ?? "idle",
}));

vi.mock("@/utils/terminalChrome", () => ({
  deriveTerminalChrome: () => ({}),
}));

import { PanelScrollRuler } from "../PanelScrollRuler";

function makePanel(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    title: `panel-${id}`,
    agentState: "idle",
    isVisible: true,
    location: "grid",
    ...overrides,
  };
}

function makeGroup(panelIds: string[]): TabGroup {
  return {
    id: `g-${panelIds.join("-")}`,
    location: "grid",
    panelIds,
    activeTabId: panelIds[0] ?? "",
    worktreeId: null,
  } as unknown as TabGroup;
}

let scrollRoot: HTMLElement;

beforeAll(() => {
  scrollRoot = document.createElement("div");
  document.body.appendChild(scrollRoot);
});

afterEach(() => {
  cleanup();
  panelState.set({});
});

describe("PanelScrollRuler", () => {
  it("returns null when scrollRoot is missing", () => {
    panelState.set({ a: makePanel("a"), b: makePanel("b") });
    const { container } = render(
      <PanelScrollRuler
        scrollRoot={null}
        tabGroups={[makeGroup(["a"]), makeGroup(["b"])]}
        focusedId={null}
      />
    );
    expect(container.firstChild).toBeNull();
  });

  it("returns null when only one grid panel exists (ruler is fleet-monitoring)", () => {
    panelState.set({ a: makePanel("a") });
    const { container } = render(
      <PanelScrollRuler scrollRoot={scrollRoot} tabGroups={[makeGroup(["a"])]} focusedId={null} />
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders one tick per grid panel with state and offscreen attributes", () => {
    panelState.set({
      a: makePanel("a", { agentState: "waiting", isVisible: false }),
      b: makePanel("b", { agentState: "working", isVisible: true }),
    });
    render(
      <PanelScrollRuler
        scrollRoot={scrollRoot}
        tabGroups={[makeGroup(["a"]), makeGroup(["b"])]}
        focusedId={"b"}
      />
    );

    const ticks = screen.getAllByRole("button");
    expect(ticks).toHaveLength(2);
    expect(ticks[0]!.getAttribute("data-panel-id")).toBe("a");
    expect(ticks[0]!.getAttribute("data-state")).toBe("waiting");
    expect(ticks[0]!.getAttribute("data-offscreen")).toBe("true");
    expect(ticks[1]!.getAttribute("data-panel-id")).toBe("b");
    expect(ticks[1]!.getAttribute("data-state")).toBe("working");
    expect(ticks[1]!.getAttribute("data-offscreen")).toBeNull();
  });

  it("updates tick state when the store mutates a panel's agentState", () => {
    // Catches the stale-memo regression: useSyncExternalStore re-renders, but
    // without the snapshot in the activePanels memo deps, the memo returns
    // cached TerminalInstance objects and tick state never updates.
    panelState.set({
      a: makePanel("a", { agentState: "idle" }),
      b: makePanel("b", { agentState: "idle" }),
    });

    render(
      <PanelScrollRuler
        scrollRoot={scrollRoot}
        tabGroups={[makeGroup(["a"]), makeGroup(["b"])]}
        focusedId={null}
      />
    );

    expect(screen.getAllByRole("button")[0]!.getAttribute("data-state")).toBe("idle");

    act(() => {
      panelState.set({
        a: makePanel("a", { agentState: "waiting" }),
        b: makePanel("b", { agentState: "idle" }),
      });
    });

    expect(screen.getAllByRole("button")[0]!.getAttribute("data-state")).toBe("waiting");
  });

  it("clicking a tick scrolls the matching panel element into view", () => {
    panelState.set({
      a: makePanel("a"),
      b: makePanel("b"),
    });

    const panelB = document.createElement("div");
    panelB.setAttribute("data-panel-id", "b");
    const scrollIntoView = vi.fn();
    panelB.scrollIntoView = scrollIntoView;
    document.body.appendChild(panelB);

    render(
      <PanelScrollRuler
        scrollRoot={scrollRoot}
        tabGroups={[makeGroup(["a"]), makeGroup(["b"])]}
        focusedId={null}
      />
    );

    const ticks = screen.getAllByRole("button");
    fireEvent.click(ticks[1]!);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest", behavior: "instant" });

    panelB.remove();
  });
});
