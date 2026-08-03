// @vitest-environment jsdom
/**
 * A dialog-hosted panel whose kind registers after the frame mounted must
 * resolve to its real component in place (#11636).
 *
 * `PanelDialogFrame` used to read the definition registry through the bare
 * `getPanelKindDefinition` getter with no subscription at all, so a plugin
 * panel presented as a dialog rendered `null` forever — a definition arriving
 * later never reached it. Unlike the `GridPanel`/`DockedPanel` half of #11636
 * (a React Compiler memo, invisible to uncompiled vitest), the missing
 * subscription is observable here: this fails without the fix regardless of
 * compilation, because nothing ever schedules the rerender.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";

const LATE_KIND = "acme.late-panel";

const registry = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const definitions: Record<string, { component: () => unknown }> = {};
  return {
    listeners,
    // Replaced on publish so React's Object.is check sees a change; the same
    // reference is returned between publishes, as useSyncExternalStore demands.
    snapshot: { ...definitions } as Record<string, { component: () => unknown }>,
    publish(kind: string, component: () => unknown) {
      definitions[kind] = { component };
      this.notify();
    },
    unpublish(kind: string) {
      delete definitions[kind];
      this.notify();
    },
    notify() {
      this.snapshot = { ...definitions };
      for (const listener of listeners) listener();
    },
    reset() {
      for (const key of Object.keys(definitions)) delete definitions[key];
      this.snapshot = {};
      listeners.clear();
    },
  };
});

vi.mock("@/panels/registry", () => ({
  subscribeToPanelKindDefinitions: (listener: () => void) => {
    registry.listeners.add(listener);
    return () => registry.listeners.delete(listener);
  },
  getPanelKindDefinitionsSnapshot: () => registry.snapshot,
}));

vi.mock("@/components/ui/AppDialog", () => {
  const AppDialog = ({ children }: { children: React.ReactNode }) => (
    <div data-testid="dialog">{children}</div>
  );
  AppDialog.Header = ({ children }: { children: React.ReactNode }) => <>{children}</>;
  AppDialog.Title = ({ children }: { children: React.ReactNode }) => <>{children}</>;
  AppDialog.CloseButton = () => <button>close</button>;
  AppDialog.BodyScroll = ({ children }: { children: React.ReactNode }) => <>{children}</>;
  return { AppDialog };
});

vi.mock("@/components/ui/button", () => ({
  Button: ({ children }: { children: React.ReactNode }) => <button>{children}</button>,
}));

const panelsById = vi.hoisted(() => ({
  current: {} as Record<string, { id: string; kind: string; title: string }>,
}));

vi.mock("@/store/panelStore", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    usePanelStore: (selector: (s: { panelsById: Record<string, unknown> }) => unknown) =>
      useSyncExternalStore(
        () => () => {},
        () => selector({ panelsById: panelsById.current })
      ),
  };
});

const { usePanelDialogStore } = await import("@/store/panelDialogStore");
const { PanelDialogHost } = await import("../PanelDialogHost");

describe("PanelDialogHost late kind registration (#11636)", () => {
  beforeEach(() => {
    registry.reset();
    panelsById.current = {};
    usePanelDialogStore.setState({ dialogStack: [], requestSeq: 0 });
  });

  it("renders a dialog panel whose kind registers after the frame mounted", () => {
    panelsById.current = {
      "late-1": { id: "late-1", kind: LATE_KIND, title: "Late panel" },
    };
    render(<PanelDialogHost />);

    act(() => {
      usePanelDialogStore.setState({ dialogStack: ["late-1"] });
    });

    // The frame is mounted and subscribed, but its kind has no definition yet.
    expect(screen.queryByTestId("late-view")).toBeNull();

    act(() => {
      registry.publish(LATE_KIND, () => <div data-testid="late-view">late view</div>);
    });

    expect(screen.queryByTestId("late-view")).not.toBeNull();
  });

  it("drops the view again when the kind is unregistered", () => {
    panelsById.current = {
      "late-1": { id: "late-1", kind: LATE_KIND, title: "Late panel" },
    };
    render(<PanelDialogHost />);

    act(() => {
      usePanelDialogStore.setState({ dialogStack: ["late-1"] });
    });
    act(() => {
      registry.publish(LATE_KIND, () => <div data-testid="late-view">late view</div>);
    });
    expect(screen.queryByTestId("late-view")).not.toBeNull();

    act(() => {
      registry.unpublish(LATE_KIND);
    });

    expect(screen.queryByTestId("late-view")).toBeNull();
  });
});
