// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

// ConfirmDialog's scroll-shadow hook observes its scroll container, which jsdom
// does not implement. Declared as a real ResizeObserver so no cast is needed.
class ResizeObserverStub implements ResizeObserver {
  constructor(_callback: ResizeObserverCallback) {}
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver ??= ResizeObserverStub;

const dispatch = vi.fn<(id: string, args: unknown, opts: unknown) => Promise<void>>(() =>
  Promise.resolve()
);

vi.mock("@/services/ActionService", () => ({
  actionService: {
    dispatch: (id: string, args: unknown, opts: unknown) => dispatch(id, args, opts),
  },
}));

import { usePluginPanelReloadConfirmStore } from "@/store/pluginPanelReloadConfirmStore";
import { PluginPanelReloadConfirmDialog } from "../PluginPanelReloadConfirmDialog";

beforeEach(() => {
  cleanup();
  dispatch.mockClear();
  usePluginPanelReloadConfirmStore.setState({ pending: null, approvedPanelId: null });
});

function stage(): void {
  usePluginPanelReloadConfirmStore
    .getState()
    .request({ panelId: "plugin-1", panelTitle: "Dashboard" });
}

describe("PluginPanelReloadConfirmDialog (#12611)", () => {
  it("renders nothing until a reload is staged", () => {
    const { container } = render(<PluginPanelReloadConfirmDialog />);
    expect(container.innerHTML).toBe("");
  });

  it("names the panel and what reloading it loses", () => {
    stage();
    render(<PluginPanelReloadConfirmDialog />);

    expect(screen.getByText("Reload panel with unsaved changes?")).toBeTruthy();
    expect(screen.getByText(/Dashboard has changes it hasn't saved/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reload panel" })).toBeTruthy();
  });

  it("approves one reload of that panel and dispatches it again", () => {
    stage();
    render(<PluginPanelReloadConfirmDialog />);

    fireEvent.click(screen.getByRole("button", { name: "Reload panel" }));

    expect(dispatch).toHaveBeenCalledWith(
      "plugin.reloadPanel",
      { panelId: "plugin-1" },
      { source: "user" }
    );
    const state = usePluginPanelReloadConfirmStore.getState();
    expect(state.pending).toBeNull();
    expect(state.consumeApproval("plugin-1")).toBe(true);
    expect(state.consumeApproval("plugin-1")).toBe(false);
  });

  it("cancels without reloading or approving anything", () => {
    stage();
    render(<PluginPanelReloadConfirmDialog />);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(dispatch).not.toHaveBeenCalled();
    const state = usePluginPanelReloadConfirmStore.getState();
    expect(state.pending).toBeNull();
    expect(state.consumeApproval("plugin-1")).toBe(false);
  });
});
