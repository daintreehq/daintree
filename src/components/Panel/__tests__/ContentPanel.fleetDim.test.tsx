// @vitest-environment jsdom
/**
 * ContentPanel — fleet preview "dim unmatched" container behavior (#8696).
 *
 * When a fleet state-preset menu item is hovered, panes that *would* be armed
 * pick up the title-bar lift (`data-fleet-previewed`). Panes that would NOT
 * be armed receive the `data-fleet-dimmed` attribute on the outer container,
 * which is paired with the `.fleet-pane-dimmed` class that drops opacity to
 * 0.5. With no preview active, neither attribute is set.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, cleanup } from "@testing-library/react";

vi.mock("@/components/Terminal/TerminalContextMenu", () => ({
  TerminalContextMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// useWorktreeStore throws when called outside of a provider in some test
// setups — see memory note "throwing-context-hooks-break-isolated-tests".
vi.mock("@/hooks/useWorktreeStore", () => ({
  useWorktreeStore: (selector: (s: { worktrees: Map<string, unknown> }) => unknown) =>
    selector({ worktrees: new Map() }),
}));

vi.mock("@/hooks/useWorktreeColorMap", () => ({
  useWorktreeColorMap: () => undefined,
}));

vi.mock("@/components/DragDrop", () => ({
  useIsDragging: () => false,
}));

vi.mock("@/components/Layout/useDockBlockedState", () => ({
  useDockBlockedState: () => null,
}));

vi.mock("@/utils/terminalChrome", () => ({
  deriveTerminalChrome: () => ({
    agentId: undefined,
    iconId: undefined,
    runtimeKind: "shell",
    isAgent: false,
  }),
}));

vi.mock("@/utils/terminalAgentDisplayState", () => ({
  getTerminalAgentDisplayState: () => undefined,
}));

vi.mock("@/components/Terminal/TerminalHeaderContent", () => ({
  TerminalHeaderContent: () => null,
}));

vi.mock("@/store", () => ({
  usePreferencesStore: (
    selector: (s: { showGridAgentHighlights: boolean; showAgentTaskTitles: boolean }) => unknown
  ) => selector({ showGridAgentHighlights: false, showAgentTaskTitles: true }),
  // ContentPanel resolves the composed display title from the panel store; an
  // empty panelsById makes it fall back to the caller-provided title prop.
  usePanelStore: (selector: (s: { panelsById: Record<string, never> }) => unknown) =>
    selector({ panelsById: {} }),
}));

// PanelHeader renders Radix tooltips; supply passthrough stand-ins so the
// container renders without a TooltipProvider in the test harness.
vi.mock("@/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { ContentPanel } from "../ContentPanel";
import { useFleetArmingStore } from "@/store/fleetArmingStore";

function renderPanel(id: string, kind: "terminal" | "browser" | "dev-preview" = "terminal") {
  return render(
    <ContentPanel
      id={id}
      title={`Panel ${id}`}
      kind={kind}
      isFocused={false}
      onFocus={() => {}}
      onClose={() => {}}
    >
      <div data-testid="panel-body" />
    </ContentPanel>
  );
}

describe("ContentPanel fleet-dim unmatched panes (#8696)", () => {
  beforeEach(() => {
    useFleetArmingStore.setState({ previewArmedIds: new Set<string>() });
  });

  afterEach(() => {
    useFleetArmingStore.setState({ previewArmedIds: new Set<string>() });
    cleanup();
  });

  it("does not dim when no preview is active", () => {
    const { container } = renderPanel("t-1");
    const panel = container.querySelector('[data-panel-id="t-1"]');
    expect(panel).not.toBeNull();
    expect(panel?.getAttribute("data-fleet-dimmed")).toBeNull();
    expect(panel?.className.includes("fleet-pane-dimmed")).toBe(false);
  });

  it("dims when a preview is active and this pane is not in the set", () => {
    const { container } = renderPanel("t-1");
    act(() => {
      useFleetArmingStore.setState({ previewArmedIds: new Set(["t-2", "t-3"]) });
    });
    const panel = container.querySelector('[data-panel-id="t-1"]');
    expect(panel?.getAttribute("data-fleet-dimmed")).toBe("true");
    expect(panel?.className.includes("fleet-pane-dimmed")).toBe(true);
  });

  it("does not dim when this pane IS in the preview set", () => {
    const { container } = renderPanel("t-1");
    act(() => {
      useFleetArmingStore.setState({ previewArmedIds: new Set(["t-1", "t-2"]) });
    });
    const panel = container.querySelector('[data-panel-id="t-1"]');
    expect(panel?.getAttribute("data-fleet-dimmed")).toBeNull();
    expect(panel?.className.includes("fleet-pane-dimmed")).toBe(false);
  });

  it("never dims non-terminal panes (browser, dev-preview)", () => {
    // Browser and dev-preview panes are never arm-eligible, so dimming
    // them during a fleet preview would imply they could have been armed.
    const { container: browser } = renderPanel("b-1", "browser");
    const { container: devPreview } = renderPanel("d-1", "dev-preview");
    act(() => {
      useFleetArmingStore.setState({ previewArmedIds: new Set(["t-2"]) });
    });
    expect(
      browser.querySelector('[data-panel-id="b-1"]')?.getAttribute("data-fleet-dimmed")
    ).toBeNull();
    expect(
      devPreview.querySelector('[data-panel-id="d-1"]')?.getAttribute("data-fleet-dimmed")
    ).toBeNull();
  });

  it("returns to undimmed when the preview clears", () => {
    const { container } = renderPanel("t-1");
    act(() => {
      useFleetArmingStore.setState({ previewArmedIds: new Set(["t-2"]) });
    });
    let panel = container.querySelector('[data-panel-id="t-1"]');
    expect(panel?.getAttribute("data-fleet-dimmed")).toBe("true");
    expect(panel?.className.includes("fleet-pane-dimmed")).toBe(true);
    act(() => {
      useFleetArmingStore.setState({ previewArmedIds: new Set<string>() });
    });
    panel = container.querySelector('[data-panel-id="t-1"]');
    expect(panel?.getAttribute("data-fleet-dimmed")).toBeNull();
    expect(panel?.className.includes("fleet-pane-dimmed")).toBe(false);
  });
});

describe("PanelHeader fleet-preview enter overlay (#8995)", () => {
  beforeEach(() => {
    useFleetArmingStore.setState({ previewArmedIds: new Set<string>() });
  });

  afterEach(() => {
    useFleetArmingStore.setState({ previewArmedIds: new Set<string>() });
    cleanup();
  });

  it("has no enter overlay when the pane is not previewed", () => {
    const { container } = renderPanel("t-1");
    expect(container.querySelector('[data-testid="fleet-preview-enter-overlay"]')).toBeNull();
  });

  it("mounts the enter overlay when the pane joins the preview set", () => {
    const { container } = renderPanel("t-1");
    act(() => {
      useFleetArmingStore.setState({ previewArmedIds: new Set(["t-1"]) });
    });
    expect(container.querySelector('[data-testid="fleet-preview-enter-overlay"]')).not.toBeNull();
  });

  it("remounts the overlay on each false→true transition so the keyframe re-runs", () => {
    const { container } = renderPanel("t-1");

    act(() => {
      useFleetArmingStore.setState({ previewArmedIds: new Set(["t-1"]) });
    });
    const firstOverlay = container.querySelector('[data-testid="fleet-preview-enter-overlay"]');
    expect(firstOverlay).not.toBeNull();

    act(() => {
      useFleetArmingStore.setState({ previewArmedIds: new Set<string>() });
    });
    expect(container.querySelector('[data-testid="fleet-preview-enter-overlay"]')).toBeNull();

    act(() => {
      useFleetArmingStore.setState({ previewArmedIds: new Set(["t-1"]) });
    });
    const secondOverlay = container.querySelector('[data-testid="fleet-preview-enter-overlay"]');
    expect(secondOverlay).not.toBeNull();
    // Distinct DOM node identity proves the overlay was remounted (not
    // merely re-rendered), which is what triggers CSS keyframe replay.
    expect(secondOverlay).not.toBe(firstOverlay);
  });

  it("removes the overlay when the pane leaves the preview set", () => {
    const { container } = renderPanel("t-1");
    act(() => {
      useFleetArmingStore.setState({ previewArmedIds: new Set(["t-1"]) });
    });
    expect(container.querySelector('[data-testid="fleet-preview-enter-overlay"]')).not.toBeNull();
    act(() => {
      useFleetArmingStore.setState({ previewArmedIds: new Set<string>() });
    });
    expect(container.querySelector('[data-testid="fleet-preview-enter-overlay"]')).toBeNull();
  });

  it("scopes the overlay per-pane during a multi-pane preview", () => {
    // Two panes rendered; only one is in the preview set. The non-previewed
    // pane must not pick up the enter cue — this is the core differentiator
    // between the kinetic preview cue and the global multi-select state.
    const { container: previewed } = renderPanel("t-1");
    const { container: untouched } = renderPanel("t-2");
    act(() => {
      useFleetArmingStore.setState({ previewArmedIds: new Set(["t-1"]) });
    });
    expect(previewed.querySelector('[data-testid="fleet-preview-enter-overlay"]')).not.toBeNull();
    expect(untouched.querySelector('[data-testid="fleet-preview-enter-overlay"]')).toBeNull();
  });
});
