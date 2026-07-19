import { beforeEach, describe, expect, it } from "vitest";
import { useUIStore } from "../uiStore";

describe("useUIStore overlay stack", () => {
  beforeEach(() => {
    useUIStore.setState({ overlayStack: [] });
  });

  it("starts with an empty stack", () => {
    expect(useUIStore.getState().overlayStack.length).toBe(0);
    expect(useUIStore.getState().hasOpenOverlays()).toBe(false);
  });

  it("addOverlayClaim records a named claim", () => {
    useUIStore.getState().addOverlayClaim("settings");
    expect(useUIStore.getState().overlayStack.includes("settings")).toBe(true);
    expect(useUIStore.getState().overlayStack.length).toBe(1);
    expect(useUIStore.getState().hasOpenOverlays()).toBe(true);
  });

  it("addOverlayClaim collapses duplicate registrations for the same ID", () => {
    useUIStore.getState().addOverlayClaim("settings");
    useUIStore.getState().addOverlayClaim("settings");
    expect(useUIStore.getState().overlayStack.length).toBe(1);
  });

  it("addOverlayClaim returns the same array reference when the ID already exists", () => {
    useUIStore.getState().addOverlayClaim("settings");
    const before = useUIStore.getState().overlayStack;
    useUIStore.getState().addOverlayClaim("settings");
    const after = useUIStore.getState().overlayStack;
    expect(after).toBe(before);
  });

  it("addOverlayClaim allocates a new array reference when a new ID is added", () => {
    const before = useUIStore.getState().overlayStack;
    useUIStore.getState().addOverlayClaim("settings");
    const after = useUIStore.getState().overlayStack;
    expect(after).not.toBe(before);
  });

  it("addOverlayClaim appends to the tail so the latest claim is topmost", () => {
    useUIStore.getState().addOverlayClaim("a");
    useUIStore.getState().addOverlayClaim("b");
    useUIStore.getState().addOverlayClaim("c");
    expect(useUIStore.getState().overlayStack).toEqual(["a", "b", "c"]);
  });

  it("removeOverlayClaim releases a named claim", () => {
    useUIStore.getState().addOverlayClaim("settings");
    useUIStore.getState().removeOverlayClaim("settings");
    expect(useUIStore.getState().overlayStack.length).toBe(0);
    expect(useUIStore.getState().hasOpenOverlays()).toBe(false);
  });

  it("removeOverlayClaim is a no-op for an unknown ID and preserves the array reference", () => {
    const before = useUIStore.getState().overlayStack;
    useUIStore.getState().removeOverlayClaim("never-added");
    const after = useUIStore.getState().overlayStack;
    expect(after).toBe(before);
  });

  it("removeOverlayClaim preserves the order of remaining claims", () => {
    useUIStore.getState().addOverlayClaim("a");
    useUIStore.getState().addOverlayClaim("b");
    useUIStore.getState().addOverlayClaim("c");
    useUIStore.getState().removeOverlayClaim("b");
    expect(useUIStore.getState().overlayStack).toEqual(["a", "c"]);
  });

  it("tracks multiple simultaneous claims independently", () => {
    useUIStore.getState().addOverlayClaim("settings");
    useUIStore.getState().addOverlayClaim("project-switcher");
    expect(useUIStore.getState().overlayStack.length).toBe(2);

    useUIStore.getState().removeOverlayClaim("settings");
    expect(useUIStore.getState().overlayStack.length).toBe(1);
    expect(useUIStore.getState().overlayStack.includes("project-switcher")).toBe(true);
  });
});
