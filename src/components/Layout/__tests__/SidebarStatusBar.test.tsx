// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

vi.mock("@/components/Project", () => ({
  ProjectResourceBadge: ({ holdingWakeLock }: { holdingWakeLock?: boolean }) => (
    <div data-testid="badge" data-holding={String(holdingWakeLock)} />
  ),
}));

import { useKeepAwakeStore } from "@/store/keepAwakeStore";
import { SidebarStatusBar } from "../SidebarStatusBar";

afterEach(() => {
  cleanup();
  useKeepAwakeStore.setState({ visible: false, state: null, loadError: null });
});

describe("SidebarStatusBar", () => {
  it("passes the hold through for the popover to explain", () => {
    const { getByTestId } = render(<SidebarStatusBar />);
    expect(getByTestId("badge").getAttribute("data-holding")).toBe("false");

    act(() => useKeepAwakeStore.getState().setVisible(true));
    expect(getByTestId("badge").getAttribute("data-holding")).toBe("true");
  });

  it("hands the badge no activity verdict of its own", () => {
    // The hold looked like a ready-made "is Daintree working", but
    // PowerSaveBlockerService releases it on battery by default while agents
    // keep working — so it must not reach the badge as anything but the hold.
    const { getByTestId } = render(<SidebarStatusBar />);
    const badge = getByTestId("badge");

    expect(badge.getAttribute("data-working")).toBeNull();
    expect(badge.getAttribute("data-active")).toBeNull();
  });
});
