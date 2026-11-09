// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useCanopyStore } from "@/store/canopyStore";
import { useCanopyPanelShown } from "../useCanopyPanelShown";

afterEach(() => useCanopyStore.setState({ mode: "unset", isOpen: false }));

describe("useCanopyPanelShown (#16578)", () => {
  it("shows the panel a project view opens before Canopy is on, where it offers turning it on", () => {
    useCanopyStore.setState({ mode: "unset", isOpen: false });
    const { result } = renderHook(() => useCanopyPanelShown());
    expect(result.current).toBe(false);

    act(() => useCanopyStore.getState().toggle());

    expect(result.current).toBe(true);
  });

  it("never shows a panel asked for once Canopy is on, and puts it away", () => {
    useCanopyStore.setState({ mode: "on", isOpen: false });
    const { result } = renderHook(() => useCanopyPanelShown());

    act(() => useCanopyStore.getState().open());

    expect(result.current).toBe(false);
    expect(useCanopyStore.getState().isOpen).toBe(false);
  });

  it("puts away the offer as Canopy turns on, so turning it off again shows nothing", () => {
    useCanopyStore.setState({ mode: "unset", isOpen: true });
    const { result } = renderHook(() => useCanopyPanelShown());
    expect(result.current).toBe(true);

    act(() => useCanopyStore.setState({ mode: "on" }));
    expect(result.current).toBe(false);
    expect(useCanopyStore.getState().isOpen).toBe(false);

    act(() => useCanopyStore.setState({ mode: "unset" }));
    expect(result.current).toBe(false);
  });
});
