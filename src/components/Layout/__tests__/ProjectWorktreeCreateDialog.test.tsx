// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PanelKindConfig } from "@shared/config/panelKindRegistry";
import { _resetForTests } from "@/lib/escapeStack";

vi.mock("@/store/portalStore", () => ({
  usePortalStore: () => ({ isOpen: false, width: 0 }),
}));

vi.mock("@/hooks/useOverlayState", () => ({
  useOverlayState: () => {},
}));

vi.mock("@/lib/scrollbarGutter", () => ({
  SCROLLBAR_GUTTER_VAR: "--app-scrollbar-gutter",
  measureScrollbarGutter: vi.fn(() => 0),
  publishScrollbarGutter: vi.fn(() => 0),
}));

vi.mock("@/components/Plugin/ProjectSurfaceFrame", () => ({
  ProjectSurfaceFrame: ({
    surfaceActions,
    children,
  }: {
    surfaceActions?: ReactNode;
    children: ReactNode;
  }) => (
    <div>
      {surfaceActions}
      {children}
    </div>
  ),
}));

vi.mock("@/components/Plugin/ProjectSurfaceView", () => ({
  ProjectSurfaceView: () => <button>Plugin field</button>,
}));

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
);

import { ProjectWorktreeCreateDialog } from "../ProjectWorktreeCreateDialog";

const CONFIG: PanelKindConfig = {
  id: "plugin.acme.create",
  name: "Acme create",
  iconId: "puzzle",
  color: "#ffffff",
  hasPty: false,
  canRestart: false,
  canConvert: false,
  extensionId: "project__p1__acme",
  componentPath: "plugin://acme/1/create.js",
};

describe("ProjectWorktreeCreateDialog hand-off to stock (#15236)", () => {
  let opener: HTMLButtonElement;

  beforeEach(() => {
    vi.useFakeTimers();
    _resetForTests();
    opener = document.createElement("button");
    opener.textContent = "New worktree";
    document.body.appendChild(opener);
    opener.focus();
  });

  afterEach(() => {
    cleanup();
    opener.remove();
    vi.useRealTimers();
  });

  function setup() {
    // Where focus is when stock takes over is what stock records as its opener.
    const focusAtHandOff: Array<Element | null> = [];
    const onUseStock = vi.fn(() => {
      focusAtHandOff.push(document.activeElement);
    });
    const dialog = (leavingForStock: boolean) => (
      <ProjectWorktreeCreateDialog
        config={CONFIG}
        isOpen
        leavingForStock={leavingForStock}
        onClose={() => {}}
        onUseStock={onUseStock}
      />
    );
    return { dialog, onUseStock, focusAtHandOff };
  }

  it("closes and hands over with focus back on the opener when stock is chosen inside it", async () => {
    const { dialog, onUseStock, focusAtHandOff } = setup();
    const { rerender } = render(dialog(false));
    await act(() => vi.runAllTimersAsync());
    screen.getByRole("button", { name: "Plugin field" }).focus();

    rerender(dialog(true));
    expect(onUseStock).not.toHaveBeenCalled();
    await act(() => vi.runAllTimersAsync());

    expect(onUseStock).toHaveBeenCalledTimes(1);
    expect(focusAtHandOff).toEqual([opener]);
    expect(screen.queryByTestId("plugin-worktree-create-dialog")).toBeNull();
  });

  it("does the same from its Standard dialog button", async () => {
    const { dialog, onUseStock, focusAtHandOff } = setup();
    render(dialog(false));
    await act(() => vi.runAllTimersAsync());

    fireEvent.click(screen.getByRole("button", { name: "Standard dialog…" }));
    expect(onUseStock).not.toHaveBeenCalled();
    await act(() => vi.runAllTimersAsync());

    expect(onUseStock).toHaveBeenCalledTimes(1);
    expect(focusAtHandOff).toEqual([opener]);
  });
});
