import { beforeEach, describe, expect, it } from "vitest";
import { useUIStore } from "../uiStore";

describe("useUIStore overlay claims", () => {
  beforeEach(() => {
    useUIStore.setState({ overlayClaims: new Set<string>() });
  });

  it("starts with an empty claim set", () => {
    expect(useUIStore.getState().overlayClaims.size).toBe(0);
    expect(useUIStore.getState().hasOpenOverlays()).toBe(false);
  });

  it("addOverlayClaim records a named claim", () => {
    useUIStore.getState().addOverlayClaim("settings");
    expect(useUIStore.getState().overlayClaims.has("settings")).toBe(true);
    expect(useUIStore.getState().overlayClaims.size).toBe(1);
    expect(useUIStore.getState().hasOpenOverlays()).toBe(true);
  });

  it("addOverlayClaim collapses duplicate registrations for the same ID", () => {
    useUIStore.getState().addOverlayClaim("settings");
    useUIStore.getState().addOverlayClaim("settings");
    expect(useUIStore.getState().overlayClaims.size).toBe(1);
  });

  it("addOverlayClaim returns the same Set reference when the ID already exists", () => {
    useUIStore.getState().addOverlayClaim("settings");
    const before = useUIStore.getState().overlayClaims;
    useUIStore.getState().addOverlayClaim("settings");
    const after = useUIStore.getState().overlayClaims;
    expect(after).toBe(before);
  });

  it("addOverlayClaim allocates a new Set reference when a new ID is added", () => {
    const before = useUIStore.getState().overlayClaims;
    useUIStore.getState().addOverlayClaim("settings");
    const after = useUIStore.getState().overlayClaims;
    expect(after).not.toBe(before);
  });

  it("removeOverlayClaim releases a named claim", () => {
    useUIStore.getState().addOverlayClaim("settings");
    useUIStore.getState().removeOverlayClaim("settings");
    expect(useUIStore.getState().overlayClaims.size).toBe(0);
    expect(useUIStore.getState().hasOpenOverlays()).toBe(false);
  });

  it("removeOverlayClaim is a no-op for an unknown ID and preserves the Set reference", () => {
    const before = useUIStore.getState().overlayClaims;
    useUIStore.getState().removeOverlayClaim("never-added");
    const after = useUIStore.getState().overlayClaims;
    expect(after).toBe(before);
  });

  it("tracks multiple simultaneous claims independently", () => {
    useUIStore.getState().addOverlayClaim("settings");
    useUIStore.getState().addOverlayClaim("project-switcher");
    expect(useUIStore.getState().overlayClaims.size).toBe(2);

    useUIStore.getState().removeOverlayClaim("settings");
    expect(useUIStore.getState().overlayClaims.size).toBe(1);
    expect(useUIStore.getState().overlayClaims.has("project-switcher")).toBe(true);
  });
});
