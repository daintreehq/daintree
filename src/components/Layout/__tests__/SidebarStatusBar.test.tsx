// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

const seen: Array<boolean | null | undefined> = [];

vi.mock("@/components/Project", () => ({
  ProjectResourceBadge: ({ working }: { working?: boolean | null }) => {
    seen.push(working);
    return <div data-testid="badge" data-working={String(working)} />;
  },
}));

import { useKeepAwakeStore } from "@/store/keepAwakeStore";
import { SidebarStatusBar } from "../SidebarStatusBar";
import type { KeepAwakeState } from "@shared/types";

function state(overrides: { enabled?: boolean; isBlocking?: boolean } = {}): KeepAwakeState {
  return {
    config: { enabled: overrides.enabled ?? true, onBattery: false },
    isBlocking: overrides.isBlocking ?? false,
    revision: 1,
  };
}

afterEach(() => {
  cleanup();
  seen.length = 0;
  useKeepAwakeStore.setState({ visible: false, state: null, loadError: null });
});

describe("SidebarStatusBar", () => {
  it("reports work in flight while the hold is up, and none while it is not", () => {
    useKeepAwakeStore.setState({ state: state({ enabled: true }) });
    const { getByTestId } = render(<SidebarStatusBar />);

    act(() => useKeepAwakeStore.getState().setVisible(true));
    expect(getByTestId("badge").getAttribute("data-working")).toBe("true");

    act(() => useKeepAwakeStore.getState().setVisible(false));
    expect(getByTestId("badge").getAttribute("data-working")).toBe("false");
  });

  it("declines to answer at all once keep-awake is switched off", () => {
    // The hold is pinned false when the feature is disabled, so reading it as
    // "not working" would park the mark on idle through an entire session of
    // real work. `null` is the badge's cue to fall back to process presence.
    useKeepAwakeStore.setState({ state: state({ enabled: false }), visible: false });
    const { getByTestId } = render(<SidebarStatusBar />);

    expect(getByTestId("badge").getAttribute("data-working")).toBe("null");
  });

  it("assumes the feature is on before the first state lands", () => {
    // `state` is null until main answers. Defaulting to disabled would flip the
    // mark to the weaker fallback for the first frames of every launch.
    render(<SidebarStatusBar />);

    expect(seen.at(-1)).not.toBeNull();
  });
});
