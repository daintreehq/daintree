// @vitest-environment jsdom
import { StrictMode, createElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import type { PanelMenuItemContribution } from "../../../../shared/types/plugin.js";
import { usePanelMenuItems } from "../react/usePanelMenuItems.js";

type Props = {
  setter?: (items: readonly PanelMenuItemContribution[] | null) => void;
  items: readonly PanelMenuItemContribution[] | null;
};

function renderMenuItems(initial: Props, wrapper?: (props: { children: ReactNode }) => ReactNode) {
  return renderHook(
    ({ setter, items }: Props) => usePanelMenuItems({ setMenuItems: setter }, items),
    { initialProps: initial, ...(wrapper ? { wrapper } : {}) }
  );
}

const OPEN = { actionId: "acme.ledger.open-row", label: "Open row" };

describe("usePanelMenuItems", () => {
  it("publishes on mount and leaves the list to the panel on unmount", () => {
    const setter = vi.fn();
    const { unmount } = renderMenuItems({ setter, items: [OPEN] });
    expect(setter.mock.calls).toEqual([[[OPEN]]]);

    unmount();
    expect(setter).toHaveBeenCalledTimes(1);
  });

  it("skips a fresh array with the same entries and republishes a changed one", () => {
    const setter = vi.fn();
    const { rerender } = renderMenuItems({ setter, items: [OPEN] });
    rerender({ setter, items: [{ ...OPEN }] });
    expect(setter).toHaveBeenCalledTimes(1);

    rerender({ setter, items: [{ ...OPEN, label: "Open Acme" }] });
    rerender({ setter, items: [] });
    rerender({ setter, items: null });
    expect(setter.mock.calls.slice(1)).toEqual([[[{ ...OPEN, label: "Open Acme" }]], [[]], [null]]);
  });

  it("publishes again to a new setter, as a reloaded view's would be", () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderMenuItems({ setter: first, items: [OPEN] });
    rerender({ setter: second, items: [OPEN] });
    expect(second.mock.calls).toEqual([[[OPEN]]]);
  });

  it("publishes once under StrictMode's replayed effects", () => {
    const setter = vi.fn();
    renderMenuItems({ setter, items: [OPEN] }, ({ children }) =>
      createElement(StrictMode, null, children)
    );
    expect(setter).toHaveBeenCalledTimes(1);
  });

  it("says whether the surface has panel menus", () => {
    const { result, rerender } = renderMenuItems({ items: [OPEN] });
    expect(result.current).toBe(false);
    rerender({ setter: vi.fn(), items: [OPEN] });
    expect(result.current).toBe(true);
  });
});
