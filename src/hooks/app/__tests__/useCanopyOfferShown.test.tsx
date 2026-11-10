// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { useEffect } from "react";

const dispatch = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
vi.mock("@/services/ActionService", () => ({ actionService: { dispatch } }));
const viewCached = vi.hoisted(() => ({ current: false }));
vi.mock("@/lib/viewCacheState", () => ({ isProjectViewCached: () => viewCached.current }));

import { useCanopyStore } from "@/store/canopyStore";
import { useCanopyOfferShown } from "../useCanopyOfferShown";

/** Every mount of the offer, so an offer shown for one commit is caught too. */
let mounts = 0;
function Offer() {
  useEffect(() => {
    mounts += 1;
  }, []);
  return <div data-testid="offer" />;
}

/** ModalHostLayer's use of the gate: the offer mounts only while it is shown. */
function Host() {
  return useCanopyOfferShown() ? <Offer /> : null;
}

const OPEN_WINDOW = ["canopy.openWindow", undefined, { source: "user" }];

// jsdom reports no focus with nothing focused; the user is in this view unless a case says not.
beforeEach(() => {
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
  useCanopyStore.setState({ mode: "unset", isOpen: false });
  mounts = 0;
  dispatch.mockClear();
  viewCached.current = false;
  delete window.__DAINTREE_HOST_ID__;
});

describe("useCanopyOfferShown (#16578, #16581)", () => {
  it("shows the offer a project view opens before Canopy is on", () => {
    useCanopyStore.setState({ mode: "unset", isOpen: false });
    const view = render(<Host />);
    expect(view.queryByTestId("offer")).toBeNull();

    act(() => useCanopyStore.getState().toggle());

    expect(view.queryByTestId("offer")).not.toBeNull();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("never mounts an offer asked for once Canopy is on, and opens the window instead", () => {
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
    expect(view.queryByTestId("offer")).not.toBeNull();

    act(() => useCanopyStore.setState({ mode: "on" }));
    expect(view.queryByTestId("offer")).toBeNull();
    expect(useCanopyStore.getState().isOpen).toBe(false);
    expect(dispatch.mock.calls).toEqual([OPEN_WINDOW]);

    act(() => useCanopyStore.setState({ mode: "unset" }));
    expect(view.queryByTestId("offer")).toBeNull();
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("only puts away an offer left open in a view the user has left, opening no window from it", () => {
    // Asked for while its code loaded, then the project switched away before it mounted.
    useCanopyStore.setState({ mode: "unset", isOpen: true });
    viewCached.current = true;
    render(<Host />);

    act(() => useCanopyStore.setState({ mode: "on" }));

    expect(useCanopyStore.getState().isOpen).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("only puts away the offer in a window the user has left, as Canopy turns on from another", () => {
    useCanopyStore.setState({ mode: "unset", isOpen: true });
    vi.mocked(document.hasFocus).mockReturnValue(false);
    render(<Host />);

    act(() => useCanopyStore.setState({ mode: "on" }));

    expect(useCanopyStore.getState().isOpen).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("opens nothing while no offer was asked for", () => {
    useCanopyStore.setState({ mode: "unset", isOpen: false });
    render(<Host />);

    act(() => useCanopyStore.setState({ mode: "on" }));

    expect(dispatch).not.toHaveBeenCalled();
  });

  it.each(["on", "unset"] as const)(
    "mounts nothing in a view on a remote host (host's Canopy %s), and opens no window from it",
    (mode) => {
      window.__DAINTREE_HOST_ID__ = { id: "host-1" };
      useCanopyStore.setState({ mode, isOpen: false });
      render(<Host />);

      act(() => useCanopyStore.getState().open());

      expect(mounts).toBe(0);
      expect(useCanopyStore.getState().isOpen).toBe(false);
      expect(dispatch).not.toHaveBeenCalled();
    }
  );
});
