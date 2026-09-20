// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

vi.mock("@/components/Project", () => ({
  ProjectResourceBadge: ({ statusItems }: { statusItems: React.ReactNode }) => (
    <div data-testid="badge" data-has-status={statusItems === null ? "false" : "true"}>
      {statusItems}
    </div>
  ),
}));

vi.mock("../KeepAwakeIndicator", () => ({
  KeepAwakeIndicator: () => <span data-testid="keep-awake-indicator" />,
}));

import { useKeepAwakeStore } from "@/store/keepAwakeStore";
import { SidebarStatusBar } from "../SidebarStatusBar";

afterEach(() => {
  cleanup();
  useKeepAwakeStore.setState({ visible: false });
});

describe("SidebarStatusBar", () => {
  it("passes null, not an empty element, while nothing is held", () => {
    const { getByTestId, queryByTestId } = render(<SidebarStatusBar />);

    // The badge keys its row on null, so an always-truthy element here would
    // leave an empty footer row behind.
    expect(getByTestId("badge").getAttribute("data-has-status")).toBe("false");
    expect(queryByTestId("keep-awake-indicator")).toBeNull();
  });

  it("shows the keep-awake indicator while the hold is visible", () => {
    const { getByTestId, queryByTestId } = render(<SidebarStatusBar />);

    act(() => useKeepAwakeStore.getState().setVisible(true));
    expect(getByTestId("keep-awake-indicator")).not.toBeNull();

    act(() => useKeepAwakeStore.getState().setVisible(false));
    expect(queryByTestId("keep-awake-indicator")).toBeNull();
  });
});
