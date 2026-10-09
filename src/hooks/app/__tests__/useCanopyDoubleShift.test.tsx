// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";

const useDoubleShift = vi.hoisted(() => vi.fn());
vi.mock("@/hooks/useDoubleShift", () => ({ useDoubleShift }));
vi.mock("@/services/ActionService", () => ({ actionService: { dispatch: vi.fn() } }));

import { usePreferencesStore } from "@/store/preferencesStore";
import { useCanopyStore } from "@/store/canopyStore";
import { useCanopyDoubleShift } from "../useCanopyDoubleShift";

afterEach(() => {
  useCanopyStore.setState({ mode: "unset" });
  usePreferencesStore.setState({ doubleShiftOpensCanopy: true });
  useDoubleShift.mockClear();
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
});
