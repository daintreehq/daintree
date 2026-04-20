// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it, beforeEach } from "vitest";
import { useOverlayClaim, useOverlayState } from "../useOverlayState";
import { useUIStore } from "@/store/uiStore";

function NamedClaim({ id, active }: { id: string; active: boolean }) {
  useOverlayClaim(id, active);
  return null;
}

function AnonymousClaim({ active }: { active: boolean }) {
  useOverlayState(active);
  return null;
}

function getClaims() {
  return useUIStore.getState().overlayClaims;
}

beforeEach(() => {
  useUIStore.setState({ overlayClaims: new Set<string>() });
});

describe("useOverlayClaim", () => {
  it("adds the claim when active becomes true", () => {
    render(<NamedClaim id="settings" active={true} />);
    expect(getClaims().has("settings")).toBe(true);
    expect(getClaims().size).toBe(1);
  });

  it("removes the claim when active flips to false", () => {
    const { rerender } = render(<NamedClaim id="settings" active={true} />);
    expect(getClaims().has("settings")).toBe(true);

    rerender(<NamedClaim id="settings" active={false} />);
    expect(getClaims().has("settings")).toBe(false);
    expect(getClaims().size).toBe(0);
  });

  it("removes the claim on unmount", () => {
    const { unmount } = render(<NamedClaim id="settings" active={true} />);
    expect(getClaims().has("settings")).toBe(true);

    unmount();
    expect(getClaims().size).toBe(0);
  });

  it("does not add a claim when active is false from the start", () => {
    render(<NamedClaim id="settings" active={false} />);
    expect(getClaims().size).toBe(0);
  });

  it("collapses duplicate registrations for the same ID", () => {
    render(<NamedClaim id="shared" active={true} />);
    render(<NamedClaim id="shared" active={true} />);
    expect(getClaims().size).toBe(1);
    expect(getClaims().has("shared")).toBe(true);
  });

  it("preserves the Set reference when addOverlayClaim is a no-op", () => {
    const { addOverlayClaim } = useUIStore.getState();
    addOverlayClaim("first");
    const before = useUIStore.getState().overlayClaims;
    addOverlayClaim("first");
    const after = useUIStore.getState().overlayClaims;
    expect(after).toBe(before);
  });

  it("preserves the Set reference when removeOverlayClaim is a no-op", () => {
    const before = useUIStore.getState().overlayClaims;
    useUIStore.getState().removeOverlayClaim("missing");
    const after = useUIStore.getState().overlayClaims;
    expect(after).toBe(before);
  });

  it("tracks rapid toggle cycles", () => {
    const { rerender } = render(<NamedClaim id="toggle" active={false} />);
    expect(getClaims().size).toBe(0);

    rerender(<NamedClaim id="toggle" active={true} />);
    expect(getClaims().size).toBe(1);

    rerender(<NamedClaim id="toggle" active={false} />);
    expect(getClaims().size).toBe(0);

    rerender(<NamedClaim id="toggle" active={true} />);
    expect(getClaims().size).toBe(1);
  });

  it("holds multiple named claims simultaneously", () => {
    const { unmount: unmountA } = render(<NamedClaim id="a" active={true} />);
    render(<NamedClaim id="b" active={true} />);
    expect(getClaims().size).toBe(2);
    expect(getClaims().has("a")).toBe(true);
    expect(getClaims().has("b")).toBe(true);

    unmountA();
    expect(getClaims().size).toBe(1);
    expect(getClaims().has("b")).toBe(true);
  });

  it("swaps the registered claim when the ID changes while active", () => {
    const { rerender } = render(<NamedClaim id="a" active={true} />);
    expect(getClaims().has("a")).toBe(true);
    expect(getClaims().size).toBe(1);

    rerender(<NamedClaim id="b" active={true} />);
    expect(getClaims().has("a")).toBe(false);
    expect(getClaims().has("b")).toBe(true);
    expect(getClaims().size).toBe(1);
  });
});

describe("useOverlayState (backwards-compat shim)", () => {
  it("registers a unique claim per instance", () => {
    const { unmount: unmountA } = render(<AnonymousClaim active={true} />);
    render(<AnonymousClaim active={true} />);
    // Two concurrent anonymous callers must not collide on a single ID — the
    // shim's per-instance useId() gives each its own slot.
    expect(getClaims().size).toBe(2);

    unmountA();
    expect(getClaims().size).toBe(1);
  });

  it("releases the claim on unmount", () => {
    const { unmount } = render(<AnonymousClaim active={true} />);
    expect(getClaims().size).toBe(1);
    unmount();
    expect(getClaims().size).toBe(0);
  });
});
