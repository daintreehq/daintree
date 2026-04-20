// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { FleetScopeComposerHeader } from "../FleetScopeComposerHeader";
import { useFleetArmingStore } from "@/store/fleetArmingStore";
import { useFleetComposerStore } from "@/store/fleetComposerStore";
import { useFleetDeckStore } from "@/store/fleetDeckStore";
import { usePanelStore } from "@/store/panelStore";

function resetStores() {
  useFleetArmingStore.setState({
    armedIds: new Set<string>(),
    armOrder: [],
    armOrderById: {},
    lastArmedId: null,
  });
  useFleetComposerStore.setState({
    draft: "",
    dryRunRequested: false,
    lastFailedIds: [],
    lastBroadcastPrompt: "",
  });
  useFleetDeckStore.setState({ isOpen: false });
  usePanelStore.setState({ panelsById: {}, panelIds: [] });
}

describe("FleetScopeComposerHeader", () => {
  beforeEach(() => {
    resetStores();
  });

  it("renders the broadcast label with agent and worktree counts", () => {
    useFleetArmingStore.getState().armIds(["a", "b"]);
    render(<FleetScopeComposerHeader agentCount={2} worktreeCount={3} />);
    expect(screen.getByText("Broadcasting to 2 agents across 3 worktrees")).toBeTruthy();
  });

  it("uses singular forms for a single agent and single worktree", () => {
    useFleetArmingStore.getState().armIds(["a"]);
    render(<FleetScopeComposerHeader agentCount={1} worktreeCount={1} />);
    expect(screen.getByText("Broadcasting to 1 agent across 1 worktree")).toBeTruthy();
  });

  it("mounts the FleetComposer inside the header", () => {
    useFleetArmingStore.getState().armIds(["a"]);
    render(<FleetScopeComposerHeader agentCount={1} worktreeCount={1} />);
    expect(screen.getByTestId("fleet-composer")).toBeTruthy();
  });

  it("autofocuses the composer textarea on mount", () => {
    useFleetArmingStore.getState().armIds(["a"]);
    const originalFocus = HTMLTextAreaElement.prototype.focus;
    const spy = vi.fn();
    HTMLTextAreaElement.prototype.focus = spy;
    try {
      // Effect ordering: child (FleetComposer) registers the focus handler
      // in its mount effect first, then the parent header's mount effect
      // invokes focusFleetComposer() which calls textarea.focus().
      render(<FleetScopeComposerHeader agentCount={1} worktreeCount={1} />);
      expect(spy).toHaveBeenCalled();
    } finally {
      HTMLTextAreaElement.prototype.focus = originalFocus;
    }
  });

  it("suppresses its own FleetComposer when the Fleet Deck is open", () => {
    // The deck renders its own FleetComposer; double-mounting would cause
    // the single-slot focus registry to be hijacked by whichever mounts
    // second, misdirecting terminal.focusFleetComposer.
    useFleetArmingStore.getState().armIds(["a"]);
    useFleetDeckStore.setState({ isOpen: true });
    render(<FleetScopeComposerHeader agentCount={1} worktreeCount={1} />);
    expect(screen.queryByTestId("fleet-composer")).toBeNull();
    // The label is still shown so users know they are in broadcast context.
    expect(screen.getByText("Broadcasting to 1 agent across 1 worktree")).toBeTruthy();
  });
});
