// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { hasRecipeVariables, splitByRecipeVariables } from "@/utils/recipeVariables";
import { useFleetResolutionPreviewStore } from "@/store/fleetResolutionPreviewStore";
import { useFleetArmingStore } from "@/store/fleetArmingStore";
import { usePanelStore } from "@/store/panelStore";
import { FleetDraftingPill } from "../FleetDraftingPill";
import type { TerminalInstance } from "@shared/types";

function resetStores() {
  useFleetArmingStore.setState({
    armedIds: new Set<string>(),
    armOrder: [],
    armOrderById: {},
    lastArmedId: null,
  });
  usePanelStore.setState({ panelsById: {}, panelIds: [] });
  useFleetResolutionPreviewStore.getState().clear();
}

function seedPanel(panel: TerminalInstance) {
  usePanelStore.setState({
    panelsById: { [panel.id]: panel },
    panelIds: [panel.id],
  });
}

function makeAgent(id: string, overrides: Partial<TerminalInstance> = {}): TerminalInstance {
  return {
    id,
    title: id,
    kind: "terminal",
    detectedAgentId: "claude",
    worktreeId: "wt-1",
    projectId: "proj-1",
    location: "grid",
    agentState: "idle",
    hasPty: true,
    ...(overrides as object),
  } as TerminalInstance;
}

function armAgent(terminalId: string, index: number) {
  useFleetArmingStore.setState((s) => {
    const nextArmed = new Set(s.armedIds);
    nextArmed.add(terminalId);
    const nextOrder = [...s.armOrder];
    if (!nextOrder.includes(terminalId)) {
      nextOrder.splice(index, 0, terminalId);
    }
    const byId: Record<string, number> = {};
    nextOrder.forEach((id, i) => {
      byId[id] = i;
    });
    return { armedIds: nextArmed, armOrder: nextOrder, armOrderById: byId };
  });
}

describe("hasRecipeVariables", () => {
  it("returns false for plain text", () => {
    expect(hasRecipeVariables("hello world")).toBe(false);
  });

  it("returns false for non-recipe {{...}} patterns", () => {
    expect(hasRecipeVariables("{{foo}}")).toBe(false);
  });

  it("returns true for {{branch_name}}", () => {
    expect(hasRecipeVariables("Review {{branch_name}}")).toBe(true);
  });

  it("returns true for {{issue_number}}", () => {
    expect(hasRecipeVariables("fix #{{issue_number}}")).toBe(true);
  });

  it("returns true for {{pr_number}}", () => {
    expect(hasRecipeVariables("PR {{pr_number}}")).toBe(true);
  });

  it("returns true for {{number}}", () => {
    expect(hasRecipeVariables("{{number}}")).toBe(true);
  });

  it("returns true for {{worktree_path}}", () => {
    expect(hasRecipeVariables("cd {{worktree_path}}")).toBe(true);
  });

  it("returns false for empty string", () => {
    expect(hasRecipeVariables("")).toBe(false);
  });
});

describe("splitByRecipeVariables", () => {
  it("returns single text part for plain text", () => {
    const parts = splitByRecipeVariables("hello world");
    expect(parts).toEqual([{ text: "hello world", isVar: false }]);
  });

  it("splits on recipe variables", () => {
    const parts = splitByRecipeVariables("fix {{issue_number}} in {{branch_name}}");
    expect(parts).toEqual([
      { text: "fix ", isVar: false },
      { text: "{{issue_number}}", isVar: true },
      { text: " in ", isVar: false },
      { text: "{{branch_name}}", isVar: true },
    ]);
  });

  it("returns empty array for empty string", () => {
    expect(splitByRecipeVariables("")).toEqual([]);
  });
});

describe("useFleetResolutionPreviewStore", () => {
  beforeEach(() => {
    resetStores();
  });

  describe("setDraft", () => {
    it("sets hasVariables false for plain text", () => {
      useFleetResolutionPreviewStore.getState().setDraft("hello");
      const state = useFleetResolutionPreviewStore.getState();
      expect(state.draft).toBe("hello");
      expect(state.hasVariables).toBe(false);
      expect(state.open).toBe(false);
    });

    it("sets hasVariables true and opens for recipe variable", () => {
      useFleetResolutionPreviewStore.getState().setDraft("fix {{branch_name}}");
      const state = useFleetResolutionPreviewStore.getState();
      expect(state.hasVariables).toBe(true);
      expect(state.open).toBe(true);
    });

    it("closes and resets userDismissed when variables removed", () => {
      useFleetResolutionPreviewStore.getState().setDraft("fix {{branch_name}}");
      expect(useFleetResolutionPreviewStore.getState().open).toBe(true);

      useFleetResolutionPreviewStore.getState().setDraft("hello");
      const state = useFleetResolutionPreviewStore.getState();
      expect(state.open).toBe(false);
      expect(state.userDismissed).toBe(false);
    });

    it("does not reopen after user dismissed until variables cleared", () => {
      useFleetResolutionPreviewStore.getState().setDraft("fix {{branch_name}}");
      expect(useFleetResolutionPreviewStore.getState().open).toBe(true);

      useFleetResolutionPreviewStore.getState().setOpen(false); // user dismisses
      const afterDismiss = useFleetResolutionPreviewStore.getState();
      expect(afterDismiss.open).toBe(false);
      expect(afterDismiss.userDismissed).toBe(true);

      // next keystroke still has variables — stays closed
      useFleetResolutionPreviewStore.getState().setDraft("fix {{branch_name}} please");
      const afterKeystroke = useFleetResolutionPreviewStore.getState();
      expect(afterKeystroke.open).toBe(false);
    });

    it("reopens after user dismissed and then variables cleared", () => {
      useFleetResolutionPreviewStore.getState().setDraft("fix {{branch_name}}");
      useFleetResolutionPreviewStore.getState().setOpen(false); // dismiss

      useFleetResolutionPreviewStore.getState().setDraft("hello"); // clear variables
      expect(useFleetResolutionPreviewStore.getState().userDismissed).toBe(false);

      useFleetResolutionPreviewStore.getState().setDraft("fix {{branch_name}} again"); // reintroduce
      const state = useFleetResolutionPreviewStore.getState();
      expect(state.open).toBe(true);
    });
  });

  describe("clear", () => {
    it("resets all state", () => {
      const store = useFleetResolutionPreviewStore.getState();
      store.setDraft("fix {{branch_name}}");
      store.clear();
      const state = useFleetResolutionPreviewStore.getState();
      expect(state.draft).toBe("");
      expect(state.hasVariables).toBe(false);
      expect(state.open).toBe(false);
      expect(state.userDismissed).toBe(false);
      expect(state.previews).toEqual([]);
    });
  });
});

describe("FleetDraftingPill", () => {
  beforeEach(() => {
    resetStores();
  });

  it("renders null when less than 2 armed", () => {
    const { container } = render(<FleetDraftingPill />);
    expect(container.firstChild).toBeNull();
  });

  it("renders the pill with peer count when multiple armed", () => {
    const a1 = makeAgent("t-1");
    const a2 = makeAgent("t-2");
    seedPanel(a1);
    seedPanel(a2);
    armAgent("t-1", 0);
    armAgent("t-2", 1);

    render(<FleetDraftingPill />);
    expect(screen.getByTestId("fleet-drafting-pill")).toBeTruthy();
    expect(screen.getByText(/Mirroring to 1 peer/)).toBeTruthy();
  });

  it("shows peer count for multiple peers", () => {
    const a1 = makeAgent("t-1");
    const a2 = makeAgent("t-2");
    const a3 = makeAgent("t-3");
    seedPanel(a1);
    seedPanel(a2);
    seedPanel(a3);
    armAgent("t-1", 0);
    armAgent("t-2", 1);
    armAgent("t-3", 2);

    render(<FleetDraftingPill />);
    expect(screen.getByText(/Mirroring to 2 peers/)).toBeTruthy();
  });

  it("does not show chevron when no recipe variables in draft", () => {
    const a1 = makeAgent("t-1");
    const a2 = makeAgent("t-2");
    seedPanel(a1);
    seedPanel(a2);
    armAgent("t-1", 0);
    armAgent("t-2", 1);
    useFleetResolutionPreviewStore.getState().setDraft("hello");

    render(<FleetDraftingPill />);
    expect(screen.queryByTestId("fleet-resolution-popover")).toBeNull();
  });
});
