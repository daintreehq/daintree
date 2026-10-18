// @vitest-environment jsdom
/**
 * Each dialog frame takes the size its opener asked for (#13504) — a plugin's
 * `panel.openPluginPanel` with `size: "workspace"` — and every other opener
 * keeps the host's default surface.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";

const KIND = "acme.triage";

vi.mock("@/panels/registry", () => {
  const snapshot = { [KIND]: { component: () => <div>view</div> } };
  return {
    subscribeToPanelKindDefinitions: () => () => {},
    getPanelKindDefinitionsSnapshot: () => snapshot,
  };
});

vi.mock("@/components/ui/AppDialog", () => {
  const AppDialog = ({ children, size }: { children: React.ReactNode; size?: string }) => (
    <div data-testid="dialog" data-size={size}>
      {children}
    </div>
  );
  AppDialog.Header = ({ children }: { children: React.ReactNode }) => <>{children}</>;
  AppDialog.Title = ({ children }: { children: React.ReactNode }) => <>{children}</>;
  AppDialog.CloseButton = () => <button>close</button>;
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

const sizes = () => screen.queryAllByTestId("dialog").map((el) => el.getAttribute("data-size"));

describe("PanelDialogHost frame sizing (#13504)", () => {
  beforeEach(() => {
    panelsById.current = {
      a: { id: "a", kind: KIND, title: "A" },
      b: { id: "b", kind: KIND, title: "B" },
    };
    usePanelDialogStore.setState({ dialogStack: [], dialogFrames: {}, requestSeq: 0 });
  });

  it("applies the size recorded for the frame", () => {
    render(<PanelDialogHost />);
    act(() => {
      usePanelDialogStore.setState({
        dialogStack: ["a"],
        dialogFrames: { a: { kind: KIND, size: "workspace" } },
      });
    });
    expect(sizes()).toEqual(["workspace"]);
  });

  it("falls back to the host default when the frame has no size", () => {
    render(<PanelDialogHost />);
    act(() => {
      usePanelDialogStore.setState({ dialogStack: ["a"], dialogFrames: { a: { kind: KIND } } });
    });
    const [defaultSize] = sizes();
    expect(defaultSize).toBeTruthy();
    expect(defaultSize).not.toBe("workspace");
  });

  it("sizes layered frames independently", () => {
    render(<PanelDialogHost />);
    act(() => {
      usePanelDialogStore.setState({
        dialogStack: ["a", "b"],
        dialogFrames: { a: { kind: KIND, size: "workspace" }, b: { kind: KIND, size: "sm" } },
      });
    });
    expect(sizes()).toEqual(["workspace", "sm"]);
  });
});
