// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, act, fireEvent, cleanup } from "@testing-library/react";

function Pane() {
  return <div data-testid="pane" />;
}

vi.mock("@/panels/registry", async () => {
  const shared = await import("@shared/config/panelKindRegistry");
  let snapshot: Record<string, { component: unknown }> | undefined;
  return {
    subscribeToPanelKindDefinitions: () => () => {},
    getPanelKindDefinitionsSnapshot: () => {
      snapshot ??= Object.fromEntries(
        shared.getPanelKindIds().map((id) => [id, { component: Pane }])
      );
      return snapshot;
    },
  };
});

vi.mock("@/components/ui/AppDialog", () => {
  const AppDialog = ({
    children,
    onClose,
  }: {
    children: React.ReactNode;
    onClose?: () => void;
  }) => (
    <div>
      <button data-testid="dialog-close" onClick={onClose} />
      {children}
    </div>
  );
  AppDialog.Header = ({ children }: { children: React.ReactNode }) => <>{children}</>;
  AppDialog.Title = ({ children }: { children: React.ReactNode }) => <>{children}</>;
  AppDialog.CloseButton = () => null;
  AppDialog.BodyScroll = ({ children }: { children: React.ReactNode }) => <>{children}</>;
  return { AppDialog };
});

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, ...props }: { children: React.ReactNode }) => (
    <button {...props}>{children}</button>
  ),
}));

const removePanel = vi.hoisted(() => vi.fn());
const panelsById = { p1: { id: "p1", kind: "review", title: "Notes" } };

vi.mock("@/store/panelStore", async () => {
  const { useSyncExternalStore } = await import("react");
  const usePanelStore = (selector: (s: { panelsById: Record<string, unknown> }) => unknown) =>
    useSyncExternalStore(
      () => () => {},
      () => selector({ panelsById })
    );
  usePanelStore.getState = () => ({ panelsById, removePanel });
  return { usePanelStore };
});

const { usePanelDialogStore } = await import("@/store/panelDialogStore");
const { PanelDialogHost } = await import("../PanelDialogHost");
const { registerPanelCloseGuard, __resetPanelCloseGuardsForTests } =
  await import("@/services/panelCloseGuard");

beforeEach(() => {
  removePanel.mockClear();
  __resetPanelCloseGuardsForTests();
  usePanelDialogStore.setState({ dialogStack: ["p1"], requestSeq: 0 });
});

afterEach(() => {
  cleanup();
  __resetPanelCloseGuardsForTests();
});

describe("PanelDialogHost close guard (#13815)", () => {
  it("closes straight away when the panel has no guard", async () => {
    render(<PanelDialogHost />);
    await act(async () => {
      fireEvent.click(screen.getByTestId("dialog-close"));
    });
    expect(removePanel).toHaveBeenCalledWith("p1");
  });

  it("keeps the panel when its guard cancels and removes it when it proceeds", async () => {
    let verdict: "proceed" | "cancel" = "cancel";
    registerPanelCloseGuard("p1", async () => verdict);
    render(<PanelDialogHost />);

    await act(async () => {
      fireEvent.click(screen.getByTestId("dialog-close"));
    });
    expect(removePanel).not.toHaveBeenCalled();
    expect(usePanelDialogStore.getState().dialogStack).toEqual(["p1"]);

    verdict = "proceed";
    await act(async () => {
      fireEvent.click(screen.getByTestId("dialog-close"));
    });
    expect(removePanel).toHaveBeenCalledWith("p1");
  });
});
