// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { hasRecipeVariables, splitByRecipeVariables } from "@/utils/recipeVariables";
import { useFleetResolutionPreviewStore } from "@/store/fleetResolutionPreviewStore";
import { useFleetArmingStore } from "@/store/fleetArmingStore";
import {
  useFleetTargetOverridesStore,
  __resetFleetTargetOverridesStoreForTesting,
} from "@/store/fleetTargetOverridesStore";
import { usePanelStore } from "@/store/panelStore";
import { FleetDraftingPill } from "../FleetDraftingPill";
import type { PtyPanelData } from "@shared/types/panel";

function resetStores() {
  useFleetArmingStore.setState({
    armedIds: new Set<string>(),
    armOrder: [],
    armOrderById: {},
    lastArmedId: null,
  });
  usePanelStore.setState({ panelsById: {}, panelIds: [] });
  useFleetResolutionPreviewStore.getState().clear();
  __resetFleetTargetOverridesStoreForTesting();
}

// Merges rather than replaces: an armed id always has a live panel behind it in
// the app, and the pill now reads eligibility off those panels.
function seedPanel(panel: PtyPanelData) {
  usePanelStore.setState((s) => ({
    panelsById: { ...s.panelsById, [panel.id]: panel },
    panelIds: s.panelIds.includes(panel.id) ? s.panelIds : [...s.panelIds, panel.id],
  }));
}

function makeAgent(id: string, overrides: Partial<PtyPanelData> = {}): PtyPanelData {
  return {
    id,
    title: id,
    kind: "terminal",
    cwd: "/tmp",
    cols: 80,
    rows: 24,
    detectedAgentId: "claude",
    worktreeId: "wt-1",
    projectId: "proj-1",
    location: "grid",
    agentState: "idle",
    hasPty: true,
    ...(overrides as object),
  } as PtyPanelData;
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

    describe("preview build guard", () => {
      it("preserves previews reference when popover closed and no recipe variables", () => {
        // The guard short-circuits buildFleetTargetPreviews and reuses
        // state.previews — observable as identity preservation across calls.
        const a1 = makeAgent("t-1");
        const a2 = makeAgent("t-2");
        seedPanel(a1);
        seedPanel(a2);
        armAgent("t-1", 0);
        armAgent("t-2", 1);
        // Initial state: previews is the empty array literal at store creation.
        const initial = useFleetResolutionPreviewStore.getState().previews;
        useFleetResolutionPreviewStore.getState().setDraft("hello");
        const after1 = useFleetResolutionPreviewStore.getState().previews;
        useFleetResolutionPreviewStore.getState().setDraft("hello world");
        const after2 = useFleetResolutionPreviewStore.getState().previews;
        expect(after1).toBe(initial);
        expect(after2).toBe(initial);
      });

      it("rebuilds previews on the keystroke that introduces a variable", () => {
        const a1 = makeAgent("t-1");
        const a2 = makeAgent("t-2");
        seedPanel(a1);
        seedPanel(a2);
        armAgent("t-1", 0);
        armAgent("t-2", 1);
        useFleetResolutionPreviewStore.getState().setDraft("hello");
        const before = useFleetResolutionPreviewStore.getState().previews;
        useFleetResolutionPreviewStore.getState().setDraft("hello {{branch_name}}");
        const after = useFleetResolutionPreviewStore.getState().previews;
        expect(after).not.toBe(before);
        expect(useFleetResolutionPreviewStore.getState().open).toBe(true);
        expect(after.length).toBe(2);
      });
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
    // The pill only mounts on the focused armed pane, so the primary has to be
    // one of them for the reach count to mean anything.
    usePanelStore.setState({ focusedId: "t-1" });

    render(<FleetDraftingPill />);
    expect(screen.getByTestId("fleet-drafting-pill")).toBeTruthy();
    expect(screen.getByTestId("fleet-drafting-pill-trigger").textContent).toMatch(
      /Mirroring to 1 peer/
    );
  });

  it("leaves a locked peer out of the reach count and its row (#14964)", () => {
    seedPanel(makeAgent("t-1"));
    seedPanel(makeAgent("t-2"));
    seedPanel(makeAgent("t-3", { isInputLocked: true }));
    armAgent("t-1", 0);
    armAgent("t-2", 1);
    armAgent("t-3", 2);
    usePanelStore.setState({ focusedId: "t-1" });
    useFleetResolutionPreviewStore.getState().setDraft("deploy {{branch_name}}");

    render(<FleetDraftingPill />);
    expect(screen.getByTestId("fleet-drafting-pill-trigger").textContent).toMatch(
      /Mirroring to 1 peer/
    );
    const rows = screen.getAllByTestId("fleet-resolution-row");
    const locked = rows.find((row) => row.textContent?.includes("t-3"))!;
    expect(locked.textContent).toContain("Input locked");
    expect(locked.querySelector("[data-testid='fleet-resolution-row-textarea']")).toBeNull();
    for (const row of rows) {
      if (row !== locked) expect(row.textContent).not.toContain("Input locked");
    }
    expect(screen.getAllByTestId("fleet-resolution-row-textarea")).toHaveLength(2);
  });

  it("updates an open preview when a peer is locked or unlocked without another keystroke", () => {
    seedPanel(makeAgent("t-1"));
    seedPanel(makeAgent("t-2"));
    armAgent("t-1", 0);
    armAgent("t-2", 1);
    usePanelStore.setState({ focusedId: "t-1" });
    useFleetResolutionPreviewStore.getState().setDraft("deploy {{branch_name}}");
    render(<FleetDraftingPill />);
    const rowFor = (id: string) =>
      screen.getAllByTestId("fleet-resolution-row").find((row) => row.textContent?.includes(id))!;
    expect(rowFor("t-2").textContent).not.toContain("Input locked");

    act(() => seedPanel(makeAgent("t-2", { isInputLocked: true })));
    expect(rowFor("t-2").textContent).toContain("Input locked");

    act(() => seedPanel(makeAgent("t-2", { isInputLocked: false })));
    expect(rowFor("t-2").textContent).not.toContain("Input locked");
    expect(useFleetResolutionPreviewStore.getState().draft).toBe("deploy {{branch_name}}");
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

describe("FleetDraftingPill — per-target edit and skip (#8691)", () => {
  beforeEach(() => {
    resetStores();
    const a1 = makeAgent("t-1");
    const a2 = makeAgent("t-2");
    usePanelStore.setState({
      panelsById: { "t-1": a1, "t-2": a2 },
      panelIds: ["t-1", "t-2"],
    });
    armAgent("t-1", 0);
    armAgent("t-2", 1);
    useFleetResolutionPreviewStore.getState().setDraft("deploy {{branch_name}}");
  });

  it("renders one textarea per non-excluded row", () => {
    render(<FleetDraftingPill />);
    const textareas = screen.getAllByTestId("fleet-resolution-row-textarea");
    expect(textareas).toHaveLength(2);
  });

  it("writes overrides through the store when the textarea changes", () => {
    render(<FleetDraftingPill />);
    const textareas = screen.getAllByTestId(
      "fleet-resolution-row-textarea"
    ) as HTMLTextAreaElement[];
    fireEvent.change(textareas[1]!, { target: { value: "custom override" } });
    expect(useFleetTargetOverridesStore.getState().payloadOverrides["t-2"]).toBe("custom override");
  });

  it("clears the override when the textarea returns to the resolved default", () => {
    render(<FleetDraftingPill />);
    const previews = useFleetResolutionPreviewStore.getState().previews;
    const t2Resolved = previews.find((p) => p.terminalId === "t-2")!.resolvedPayload;
    const textareas = screen.getAllByTestId(
      "fleet-resolution-row-textarea"
    ) as HTMLTextAreaElement[];
    fireEvent.change(textareas[1]!, { target: { value: "edited" } });
    expect(useFleetTargetOverridesStore.getState().payloadOverrides["t-2"]).toBe("edited");
    fireEvent.change(textareas[1]!, { target: { value: t2Resolved } });
    expect(useFleetTargetOverridesStore.getState().payloadOverrides["t-2"]).toBeUndefined();
  });

  it("toggles a skip via the include checkbox", () => {
    render(<FleetDraftingPill />);
    const checkboxes = screen.getAllByTestId("fleet-resolution-row-include");
    expect(checkboxes[1]!.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(checkboxes[1]!);
    expect(useFleetTargetOverridesStore.getState().skippedIds.has("t-2")).toBe(true);
  });

  it("toggles a skip exactly once when the row's title is clicked", () => {
    render(<FleetDraftingPill />);
    const include = screen.getAllByTestId("fleet-resolution-row-include")[1]!;
    const title = include.closest("label")?.querySelector("span.truncate");
    expect(title).toBeTruthy();
    fireEvent.click(title!);
    expect(useFleetTargetOverridesStore.getState().skippedIds.has("t-2")).toBe(true);
    expect(include.getAttribute("aria-checked")).toBe("false");
  });

  it("prevents Enter inside an override textarea from bubbling", () => {
    render(<FleetDraftingPill />);
    const textarea = screen.getAllByTestId(
      "fleet-resolution-row-textarea"
    )[0] as HTMLTextAreaElement;
    const event = new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
    });
    const result = textarea.dispatchEvent(event);
    // defaultPrevented = true means the handler called preventDefault.
    expect(result).toBe(false);
  });

  it("clears overrides when the popover closes (user dismiss)", () => {
    render(<FleetDraftingPill />);
    act(() => {
      useFleetTargetOverridesStore.getState().setPayloadOverride("t-1", "x");
      useFleetTargetOverridesStore.getState().setSkipped("t-2", true);
    });
    // Simulate user dismissing the popover.
    act(() => {
      useFleetResolutionPreviewStore.getState().setOpen(false);
    });
    expect(useFleetTargetOverridesStore.getState().payloadOverrides).toEqual({});
    expect(useFleetTargetOverridesStore.getState().skippedIds.size).toBe(0);
  });

  it("disables the textarea for skipped targets", () => {
    render(<FleetDraftingPill />);
    act(() => {
      useFleetTargetOverridesStore.getState().setSkipped("t-2", true);
    });
    const textareas = screen.getAllByTestId(
      "fleet-resolution-row-textarea"
    ) as HTMLTextAreaElement[];
    expect(textareas[1]!.disabled).toBe(true);
  });

  it("shows a divergence dot on the trigger when overrides or skips exist", () => {
    render(<FleetDraftingPill />);
    expect(screen.queryByTestId("fleet-drafting-pill-divergence-dot")).toBeNull();
    act(() => {
      useFleetTargetOverridesStore.getState().setPayloadOverride("t-1", "x");
    });
    expect(screen.getByTestId("fleet-drafting-pill-divergence-dot")).toBeTruthy();
  });
});

describe("the preview for a draft with context tokens (#14953)", () => {
  beforeEach(() => {
    resetStores();
    useFleetArmingStore.setState({ crossHostTargets: [] });
    seedPanel(makeAgent("t-1", { cwd: "/wt/one" }));
    seedPanel(makeAgent("t-2", { cwd: "/wt/two" }));
    armAgent("t-1", 0);
    armAgent("t-2", 1);
    usePanelStore.setState({ focusedId: "t-1" });
  });

  const rowFor = (id: string) =>
    screen.getAllByTestId("fleet-resolution-row").find((row) => row.textContent?.includes(id))!;

  it("opens on the keystroke that adds a token and closes when it's gone", () => {
    useFleetResolutionPreviewStore.getState().setDraft("Review");
    expect(useFleetResolutionPreviewStore.getState().open).toBe(false);
    useFleetResolutionPreviewStore.getState().setDraft("Review @diff");
    const state = useFleetResolutionPreviewStore.getState();
    expect(state.hasContext).toBe(true);
    expect(state.open).toBe(true);
    expect(state.previews).toHaveLength(2);
    useFleetResolutionPreviewStore.getState().setDraft("Review @dif");
    expect(useFleetResolutionPreviewStore.getState().open).toBe(false);
  });

  it("says, row by row, whose context each agent is sent", () => {
    useFleetResolutionPreviewStore.getState().setDraft("Review @diff and @terminal");
    render(<FleetDraftingPill />);
    const one = rowFor("t-1").querySelector("[data-testid='fleet-resolution-row-context']");
    const two = rowFor("t-2").querySelector("[data-testid='fleet-resolution-row-context']");
    expect(one?.textContent).toContain("@diff from /wt/one");
    expect(two?.textContent).toContain("@diff from /wt/two");
    expect(two?.textContent).toContain("@terminal from its own output");
  });

  it("follows a per-target edit, and says nothing for a skipped agent", () => {
    useFleetResolutionPreviewStore.getState().setDraft("Review @diff");
    render(<FleetDraftingPill />);
    act(() => {
      useFleetTargetOverridesStore.getState().setPayloadOverride("t-2", "Review your changes");
      useFleetTargetOverridesStore.getState().setSkipped("t-1", true);
    });
    expect(screen.queryByTestId("fleet-resolution-row-context")).toBeNull();
  });

  it("flags an agent on another host, which the token can't reach", () => {
    useFleetArmingStore.setState({
      crossHostTargets: [
        {
          key: "remote-key",
          hostId: "studio" as never,
          hostName: "Studio",
          terminalId: "r-1",
          title: "remote",
        },
      ],
    });
    useFleetResolutionPreviewStore.getState().setDraft("Review @diff");
    render(<FleetDraftingPill />);
    const remote = rowFor("remote");
    expect(
      remote.querySelector("[data-testid='fleet-resolution-row-context-blocked']")?.textContent
    ).toContain("@diff can't reach another host");
    expect(remote.querySelector("[data-testid='fleet-resolution-row-context']")).toBeNull();
    expect(
      rowFor("t-1").querySelector("[data-testid='fleet-resolution-row-context-blocked']")
    ).toBeNull();
  });
});
