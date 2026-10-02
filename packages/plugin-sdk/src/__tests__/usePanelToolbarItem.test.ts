// @vitest-environment jsdom
import { StrictMode, createElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import type { PluginPanelToolbarItemState } from "../../../../shared/types/plugin.js";
import { usePanelToolbarItem } from "../react/usePanelToolbarItem.js";

const ID = "acme.ledger.refresh-quotes";

type Props = {
  setter?: (actionId: string, state: PluginPanelToolbarItemState | null) => void;
  actionId: string;
  state: PluginPanelToolbarItemState | null;
};

function renderToolbarItem(
  initial: Props,
  wrapper?: (props: { children: ReactNode }) => ReactNode
) {
  return renderHook(
    ({ setter, actionId, state }: Props) =>
      usePanelToolbarItem({ setToolbarItemState: setter }, actionId, state),
    { initialProps: initial, ...(wrapper ? { wrapper } : {}) }
  );
}

describe("usePanelToolbarItem", () => {
  it("sets the state on mount and leaves it to the panel on unmount", () => {
    const setter = vi.fn();
    const { unmount } = renderToolbarItem({ setter, actionId: ID, state: { busy: true } });
    expect(setter.mock.calls).toEqual([[ID, { busy: true }]]);

    unmount();
    expect(setter.mock.calls).toEqual([[ID, { busy: true }]]);
  });

  it("skips a re-render whose state is equal field by field", () => {
    const setter = vi.fn();
    const { rerender } = renderToolbarItem({ setter, actionId: ID, state: { text: "Fresh" } });
    rerender({ setter, actionId: ID, state: { text: "Fresh" } });
    expect(setter).toHaveBeenCalledTimes(1);

    rerender({ setter, actionId: ID, state: { text: "Stale" } });
    expect(setter.mock.calls.at(-1)).toEqual([ID, { text: "Stale" }]);
  });

  it("resets the old button before setting a new actionId", () => {
    const setter = vi.fn();
    const { rerender } = renderToolbarItem({ setter, actionId: ID, state: { busy: true } });
    rerender({ setter, actionId: "acme.ledger.export", state: { busy: true } });

    expect(setter.mock.calls).toEqual([
      [ID, { busy: true }],
      [ID, null],
      ["acme.ledger.export", { busy: true }],
    ]);
  });

  it("sends again to a new setter, as a reloaded view's would be", () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderToolbarItem({ setter: first, actionId: ID, state: { busy: true } });
    rerender({ setter: second, actionId: ID, state: { busy: true } });

    expect(second.mock.calls).toEqual([[ID, { busy: true }]]);
    expect(first.mock.calls).toEqual([[ID, { busy: true }]]);
  });

  it("does nothing where the host offers no setter", () => {
    const { rerender, unmount } = renderToolbarItem({ actionId: ID, state: { busy: true } });
    expect(() => {
      rerender({ actionId: ID, state: null });
      unmount();
    }).not.toThrow();
  });

  it("ends set, not reset, after a StrictMode replay", () => {
    const setter = vi.fn();
    renderToolbarItem({ setter, actionId: ID, state: { busy: true } }, ({ children }) =>
      createElement(StrictMode, null, children)
    );

    expect(setter.mock.calls.at(-1)).toEqual([ID, { busy: true }]);
  });
});
