import { describe, it, expect, beforeEach } from "vitest";
import { useScreenReaderStore } from "../screenReaderStore";

describe("screenReaderStore", () => {
  beforeEach(() => {
    useScreenReaderStore.setState({
      screenReaderMode: "auto",
      osAccessibilityEnabled: false,
    });
  });

  it("resolves to false when auto + OS off", () => {
    useScreenReaderStore.getState().setScreenReaderMode("auto");
    useScreenReaderStore.getState().setOsAccessibilityEnabled(false);
    expect(useScreenReaderStore.getState().resolvedScreenReaderEnabled()).toBe(false);
  });

  it("resolves to true when auto + OS on", () => {
    useScreenReaderStore.getState().setScreenReaderMode("auto");
    useScreenReaderStore.getState().setOsAccessibilityEnabled(true);
    expect(useScreenReaderStore.getState().resolvedScreenReaderEnabled()).toBe(true);
  });

  it("resolves to true when on + OS off", () => {
    useScreenReaderStore.getState().setScreenReaderMode("on");
    useScreenReaderStore.getState().setOsAccessibilityEnabled(false);
    expect(useScreenReaderStore.getState().resolvedScreenReaderEnabled()).toBe(true);
  });

  it("resolves to false when off + OS on", () => {
    useScreenReaderStore.getState().setScreenReaderMode("off");
    useScreenReaderStore.getState().setOsAccessibilityEnabled(true);
    expect(useScreenReaderStore.getState().resolvedScreenReaderEnabled()).toBe(false);
  });

  it("setScreenReaderMode updates mode", () => {
    useScreenReaderStore.getState().setScreenReaderMode("on");
    expect(useScreenReaderStore.getState().screenReaderMode).toBe("on");
  });

  it("setOsAccessibilityEnabled updates OS state", () => {
    useScreenReaderStore.getState().setOsAccessibilityEnabled(true);
    expect(useScreenReaderStore.getState().osAccessibilityEnabled).toBe(true);
  });
});
