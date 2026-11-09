// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { useEffect } from "react";

const dispatch = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
vi.mock("@/services/ActionService", () => ({ actionService: { dispatch } }));
const viewCached = vi.hoisted(() => ({ current: false }));
vi.mock("@/lib/viewCacheState", () => ({ isProjectViewCached: () => viewCached.current }));

import { useCanopyStore } from "@/store/canopyStore";
import { useCanopyPanelShown } from "../useCanopyPanelShown";

/** Every mount of the panel, so a panel shown for one commit is caught too. */
let mounts = 0;
function Panel() {
  useEffect(() => {
    mounts += 1;
  }, []);
  return <div data-testid="panel" />;
}

/** ModalHostLayer's use of the gate: the panel mounts only while it is shown. */
function Host() {
  return useCanopyPanelShown() ? <Panel /> : null;
}

const OPEN_WINDOW = ["canopy.openWindow", undefined, { source: "user" }];

afterEach(() => {
  useCanopyStore.setState({ mode: "unset", isOpen: false });
  mounts = 0;
  dispatch.mockClear();
  viewCached.current = false;
  delete window.__DAINTREE_HOST_ID__;
});

describe("useCanopyPanelShown (#16578)", () => {
  it("shows the panel a project view opens before Canopy is on, where it offers turning it on", () => {
    useCanopyStore.setState({ mode: "unset", isOpen: false });
    const view = render(<Host />);
    expect(view.queryByTestId("panel")).toBeNull();

    act(() => useCanopyStore.getState().toggle());

    expect(view.queryByTestId("panel")).not.toBeNull();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("never mounts a panel asked for once Canopy is on, and opens the window instead", () => {
    useCanopyStore.setState({ mode: "on", isOpen: false });
    render(<Host />);

    act(() => useCanopyStore.getState().open());

    expect(mounts).toBe(0);
    expect(useCanopyStore.getState().isOpen).toBe(false);
    expect(dispatch.mock.calls).toEqual([OPEN_WINDOW]);
  });

  it("puts the offer away as Canopy turns on and opens the window, so turning it off shows nothing", () => {
    useCanopyStore.setState({ mode: "unset", isOpen: true });
    const view = render(<Host />);
    expect(view.queryByTestId("panel")).not.toBeNull();

    act(() => useCanopyStore.setState({ mode: "on" }));
    expect(view.queryByTestId("panel")).toBeNull();
    expect(useCanopyStore.getState().isOpen).toBe(false);
    expect(dispatch.mock.calls).toEqual([OPEN_WINDOW]);

    act(() => useCanopyStore.setState({ mode: "unset" }));
    expect(view.queryByTestId("panel")).toBeNull();
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("only puts away a panel left open in a view the user has left, opening no window from it", () => {
    // Asked for while its code loaded, then the project switched away before it mounted.
    useCanopyStore.setState({ mode: "unset", isOpen: true });
    viewCached.current = true;
    render(<Host />);

    act(() => useCanopyStore.setState({ mode: "on" }));

    expect(useCanopyStore.getState().isOpen).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("opens nothing while no panel was asked for", () => {
    useCanopyStore.setState({ mode: "unset", isOpen: false });
    render(<Host />);

    act(() => useCanopyStore.setState({ mode: "on" }));

    expect(dispatch).not.toHaveBeenCalled();
  });

  it("keeps a remote host's panel, which opens only when this machine's window couldn't", () => {
    window.__DAINTREE_HOST_ID__ = { id: "host-1" };
    useCanopyStore.setState({ mode: "on", isOpen: false });
    const view = render(<Host />);

    act(() => useCanopyStore.getState().open());

    expect(view.queryByTestId("panel")).not.toBeNull();
    expect(useCanopyStore.getState().isOpen).toBe(true);
    expect(dispatch).not.toHaveBeenCalled();
  });
});
