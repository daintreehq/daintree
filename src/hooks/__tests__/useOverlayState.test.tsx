// @vitest-environment jsdom
import { render, renderHook } from "@testing-library/react";
import { describe, expect, it, beforeEach } from "vitest";
import {
  useOverlayClaim,
  useOverlayOpen,
  useOverlayState,
  useTopmostOverlay,
} from "../useOverlayState";
import { useUIStore } from "@/store/uiStore";

function NamedClaim({ id, active }: { id: string; active: boolean }) {
  useOverlayClaim(id, active);
  return null;
}

function AnonymousClaim({ active }: { active: boolean }) {
  useOverlayState(active);
  return null;
}

function getStack() {
  return useUIStore.getState().overlayStack;
}

beforeEach(() => {
  useUIStore.setState({ overlayStack: [] });
});

describe("useOverlayClaim", () => {
  it("removes the claim on unmount", () => {
    const { unmount } = render(<NamedClaim id="settings" active={true} />);
    expect(getStack().includes("settings")).toBe(true);

    unmount();
    expect(getStack().length).toBe(0);
  });

  it("collapses duplicate registrations for the same ID", () => {
    render(<NamedClaim id="shared" active={true} />);
    render(<NamedClaim id="shared" active={true} />);
    expect(getStack().length).toBe(1);
    expect(getStack().includes("shared")).toBe(true);
  });

  it("preserves the array reference when addOverlayClaim is a no-op", () => {
    const { addOverlayClaim } = useUIStore.getState();
    addOverlayClaim("first");
    const before = useUIStore.getState().overlayStack;
    addOverlayClaim("first");
    const after = useUIStore.getState().overlayStack;
    expect(after).toBe(before);
  });

  it("preserves the array reference when removeOverlayClaim is a no-op", () => {
    const before = useUIStore.getState().overlayStack;
    useUIStore.getState().removeOverlayClaim("missing");
    const after = useUIStore.getState().overlayStack;
    expect(after).toBe(before);
  });

  it("tracks rapid toggle cycles", () => {
    const { rerender } = render(<NamedClaim id="toggle" active={false} />);
    expect(getStack().length).toBe(0);

    rerender(<NamedClaim id="toggle" active={true} />);
    expect(getStack().length).toBe(1);

    rerender(<NamedClaim id="toggle" active={false} />);
    expect(getStack().length).toBe(0);

    rerender(<NamedClaim id="toggle" active={true} />);
    expect(getStack().length).toBe(1);
  });

  it("holds multiple named claims simultaneously", () => {
    const { unmount: unmountA } = render(<NamedClaim id="a" active={true} />);
    render(<NamedClaim id="b" active={true} />);
    expect(getStack().length).toBe(2);
    expect(getStack().includes("a")).toBe(true);
    expect(getStack().includes("b")).toBe(true);

    unmountA();
    expect(getStack().length).toBe(1);
    expect(getStack().includes("b")).toBe(true);
  });

  it("swaps the registered claim when the ID changes while active", () => {
    const { rerender } = render(<NamedClaim id="a" active={true} />);
    expect(getStack().includes("a")).toBe(true);
    expect(getStack().length).toBe(1);

    rerender(<NamedClaim id="b" active={true} />);
    expect(getStack().includes("a")).toBe(false);
    expect(getStack().includes("b")).toBe(true);
    expect(getStack().length).toBe(1);
  });
});

describe("useOverlayState (backwards-compat shim)", () => {
  it("registers a unique claim per instance", () => {
    const { unmount: unmountA } = render(<AnonymousClaim active={true} />);
    render(<AnonymousClaim active={true} />);
    // Two concurrent anonymous callers must not collide on a single ID — the
    // shim's per-instance useId() gives each its own slot.
    expect(getStack().length).toBe(2);

    unmountA();
    expect(getStack().length).toBe(1);
  });
});

describe("useOverlayOpen", () => {
  it("flips to false when the claim is released", () => {
    useUIStore.getState().addOverlayClaim("settings");
    const { result, rerender } = renderHook(() => useOverlayOpen("settings"));
    expect(result.current).toBe(true);

    useUIStore.getState().removeOverlayClaim("settings");
    rerender();
    expect(result.current).toBe(false);
  });

  it("isolates each id from unrelated stack mutations", () => {
    useUIStore.getState().addOverlayClaim("other");
    const { result } = renderHook(() => useOverlayOpen("settings"));
    expect(result.current).toBe(false);
  });
});

describe("useTopmostOverlay", () => {
  it("updates when the topmost claim is released", () => {
    useUIStore.getState().addOverlayClaim("a");
    useUIStore.getState().addOverlayClaim("b");
    const { result, rerender } = renderHook(() => useTopmostOverlay());
    expect(result.current).toBe("b");

    useUIStore.getState().removeOverlayClaim("b");
    rerender();
    expect(result.current).toBe("a");
  });

  it("returns undefined once the stack drains", () => {
    useUIStore.getState().addOverlayClaim("a");
    const { result, rerender } = renderHook(() => useTopmostOverlay());
    expect(result.current).toBe("a");

    useUIStore.getState().removeOverlayClaim("a");
    rerender();
    expect(result.current).toBeUndefined();
  });
});
