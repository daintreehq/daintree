// @vitest-environment jsdom
/**
 * The host renders every entry in the dialog stack, not just the top one.
 *
 * This is the guarantee #11243 turns on: a review presented as a dialog can
 * drill into a per-file diff, and unmounting the review to show the diff would
 * discard its staging state (commit draft, selection, filters). Asserting "the
 * component is still mounted" is not enough — a remount would also leave a
 * component mounted — so these tests assert that the *same instance* survives,
 * via a mount counter and live local state.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { useState, useRef } from "react";

const mountCounts = vi.hoisted(() => new Map<string, number>());

/**
 * Stand-in panel component holding local state, so a remount is observable:
 * the draft resets and the mount counter for that id increments.
 */
function StatefulPane({ id, isFocused }: { id: string; isFocused?: boolean }) {
  const [draft, setDraft] = useState("");
  const counted = useRef(false);
  if (!counted.current) {
    counted.current = true;
    mountCounts.set(id, (mountCounts.get(id) ?? 0) + 1);
  }
  return (
    <div data-testid={`pane-${id}`}>
      <span data-testid={`focused-${id}`}>{String(isFocused)}</span>
      <span data-testid={`draft-${id}`}>{draft}</span>
      <button data-testid={`type-${id}`} onClick={() => setDraft("unsaved work")}>
        type
      </button>
    </div>
  );
}

vi.mock("@/panels/registry", () => ({
  getPanelKindDefinition: () => ({ component: StatefulPane }),
}));

vi.mock("@/components/ErrorBoundary", () => ({
  ErrorBoundary: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// AppDialog is exercised by its own suite; here it is a transparent shell so
// these assertions are about the host's stack rendering, nothing else.
vi.mock("@/components/ui/AppDialog", () => {
  const AppDialog = ({
    children,
    zIndex,
  }: {
    children: React.ReactNode;
    zIndex?: string;
  }) => <div data-testid={`dialog-${zIndex ?? "modal"}`}>{children}</div>;
  AppDialog.Header = ({ children }: { children: React.ReactNode }) => <>{children}</>;
  AppDialog.Title = ({ children }: { children: React.ReactNode }) => <>{children}</>;
  AppDialog.CloseButton = () => <button>close</button>;
  AppDialog.BodyScroll = ({ children }: { children: React.ReactNode }) => <>{children}</>;
  return { AppDialog };
});

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, ...props }: { children: React.ReactNode }) => (
    <button {...props}>{children}</button>
  ),
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

function seedPanel(id: string, kind: string) {
  panelsById.current = { ...panelsById.current, [id]: { id, kind, title: kind } };
}

describe("PanelDialogHost stack rendering (#11243)", () => {
  beforeEach(() => {
    mountCounts.clear();
    panelsById.current = {};
    usePanelDialogStore.setState({ dialogStack: [], requestSeq: 0 });
  });

  it("renders nothing when the stack is empty", () => {
    const { container } = render(<PanelDialogHost />);
    expect(container.innerHTML).toBe("");
  });

  it("keeps the parent instance and its unsaved state alive when a child layers on top", () => {
    seedPanel("review-1", "review");
    render(<PanelDialogHost />);

    act(() => {
      usePanelDialogStore.setState({ dialogStack: ["review-1"] });
    });
    // Simulate the user typing a commit message into the review.
    act(() => {
      screen.getByTestId("type-review-1").click();
    });
    expect(screen.getByTestId("draft-review-1").textContent).toBe("unsaved work");

    // Drill into a diff — it layers above rather than replacing.
    seedPanel("diff-1", "diff");
    act(() => {
      usePanelDialogStore.setState({ dialogStack: ["review-1", "diff-1"] });
    });

    expect(screen.queryByTestId("pane-review-1")).not.toBeNull();
    expect(screen.queryByTestId("pane-diff-1")).not.toBeNull();
    // The real assertion: same instance, so the draft is intact.
    expect(screen.getByTestId("draft-review-1").textContent).toBe("unsaved work");
    expect(mountCounts.get("review-1")).toBe(1);
  });

  it("restores the parent untouched when the child closes", () => {
    seedPanel("review-1", "review");
    seedPanel("diff-1", "diff");
    render(<PanelDialogHost />);

    act(() => {
      usePanelDialogStore.setState({ dialogStack: ["review-1"] });
    });
    act(() => {
      screen.getByTestId("type-review-1").click();
    });
    act(() => {
      usePanelDialogStore.setState({ dialogStack: ["review-1", "diff-1"] });
    });
    act(() => {
      usePanelDialogStore.setState({ dialogStack: ["review-1"] });
    });

    expect(screen.queryByTestId("pane-diff-1")).toBeNull();
    expect(screen.getByTestId("draft-review-1").textContent).toBe("unsaved work");
    expect(mountCounts.get("review-1")).toBe(1);
  });

  it("focuses only the topmost frame", () => {
    seedPanel("review-1", "review");
    seedPanel("diff-1", "diff");
    render(<PanelDialogHost />);

    act(() => {
      usePanelDialogStore.setState({ dialogStack: ["review-1", "diff-1"] });
    });

    expect(screen.getByTestId("focused-review-1").textContent).toBe("false");
    expect(screen.getByTestId("focused-diff-1").textContent).toBe("true");
  });

  it("puts layered frames on the nested z-index tier", () => {
    seedPanel("review-1", "review");
    seedPanel("diff-1", "diff");
    render(<PanelDialogHost />);

    act(() => {
      usePanelDialogStore.setState({ dialogStack: ["review-1", "diff-1"] });
    });

    // A child on the base tier would paint underneath its own parent.
    expect(screen.queryByTestId("dialog-modal")).not.toBeNull();
    expect(screen.queryByTestId("dialog-nested")).not.toBeNull();
  });

  it("offers 'Open as panel' only on the topmost frame", () => {
    seedPanel("review-1", "review");
    seedPanel("diff-1", "diff");
    render(<PanelDialogHost />);

    act(() => {
      usePanelDialogStore.setState({ dialogStack: ["review-1", "diff-1"] });
    });

    // Promotion always targets the top, so a suspended parent must not offer it.
    expect(screen.getAllByTestId("panel-dialog-open-as-panel")).toHaveLength(1);
  });

  it("drops a stack entry whose panel record vanished", () => {
    seedPanel("review-1", "review");
    render(<PanelDialogHost />);

    act(() => {
      usePanelDialogStore.setState({ dialogStack: ["review-1"] });
    });
    act(() => {
      panelsById.current = {};
      usePanelDialogStore.setState({ dialogStack: ["review-1"] });
    });

    expect(usePanelDialogStore.getState().dialogStack).toEqual([]);
  });
});
