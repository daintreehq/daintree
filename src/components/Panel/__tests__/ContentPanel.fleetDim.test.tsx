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
  usePreferencesStore: (selector: (s: { showGridAgentHighlights: boolean }) => unknown) =>
    selector({ showGridAgentHighlights: false }),
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
