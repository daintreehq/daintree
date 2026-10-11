// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";

const useDoubleShift = vi.hoisted(() => vi.fn());
vi.mock("@/hooks/useDoubleShift", () => ({ useDoubleShift }));
const dispatch = vi.hoisted(() => vi.fn());
vi.mock("@/services/ActionService", () => ({ actionService: { dispatch } }));

import { usePreferencesStore } from "@/store/preferencesStore";
import { useCanopyStore } from "@/store/canopyStore";
import { useCanopyDoubleShift } from "../useCanopyDoubleShift";

afterEach(() => {
  useCanopyStore.setState({ mode: "unset" });
  usePreferencesStore.setState({ doubleShiftOpensCanopy: true });
  useDoubleShift.mockClear();
  dispatch.mockClear();
});

describe("useCanopyDoubleShift", () => {
  it("listens only once Canopy is on, and only while the preference allows it", () => {
    const enabledFor = (mode: "unset" | "on" | "hidden", preference: boolean) => {
      useCanopyStore.setState({ mode });
      usePreferencesStore.setState({ doubleShiftOpensCanopy: preference });
      const view = renderHook(() => useCanopyDoubleShift());
      const enabled = useDoubleShift.mock.calls.at(-1)?.[1];
      view.unmount();
      return enabled;
    };
    expect(enabledFor("on", true)).toBe(true);
    expect(enabledFor("on", false)).toBe(false);
    expect(enabledFor("unset", true)).toBe(false);
    expect(enabledFor("hidden", true)).toBe(false);
  });

  it("toggles Canopy through its action when the gesture fires", () => {
    useCanopyStore.setState({ mode: "on" });
    renderHook(() => useCanopyDoubleShift());
    expect(dispatch).not.toHaveBeenCalled();
    const fire = useDoubleShift.mock.calls.at(-1)?.[0] as () => void;
    fire();
    expect(dispatch.mock.calls).toEqual([["canopy.toggle", undefined, { source: "keybinding" }]]);
  });
});
