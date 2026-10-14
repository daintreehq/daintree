import { beforeEach, describe, expect, it } from "vitest";
import {
  useDiagnosticsStore,
  DIAGNOSTICS_MIN_HEIGHT,
  DIAGNOSTICS_DEFAULT_HEIGHT,
} from "../diagnosticsStore";

describe("diagnosticsStore height & maxHeight", () => {
  beforeEach(() => {
    useDiagnosticsStore.setState({
      isOpen: false,
      activeTab: "problems",
      height: DIAGNOSTICS_DEFAULT_HEIGHT,
      maxHeight: 600,
    });
  });

  it("setHeight clamps below the minimum", () => {
    useDiagnosticsStore.getState().setHeight(10);
    expect(useDiagnosticsStore.getState().height).toBe(DIAGNOSTICS_MIN_HEIGHT);
  });

  it("setHeight clamps above the configured maxHeight", () => {
    useDiagnosticsStore.setState({ maxHeight: 400 });
    useDiagnosticsStore.getState().setHeight(9999);
    expect(useDiagnosticsStore.getState().height).toBe(400);
  });

  it("setHeight accepts values inside the allowed range", () => {
    useDiagnosticsStore.setState({ maxHeight: 500 });
    useDiagnosticsStore.getState().setHeight(300);
    expect(useDiagnosticsStore.getState().height).toBe(300);
  });

  it("setMaxHeight floors at DIAGNOSTICS_MIN_HEIGHT", () => {
    useDiagnosticsStore.getState().setMaxHeight(50);
    expect(useDiagnosticsStore.getState().maxHeight).toBe(DIAGNOSTICS_MIN_HEIGHT);
  });

  it("setMaxHeight re-clamps the current height when shrinking the cap", () => {
    useDiagnosticsStore.setState({ maxHeight: 600, height: 500 });
    useDiagnosticsStore.getState().setMaxHeight(300);
    expect(useDiagnosticsStore.getState().maxHeight).toBe(300);
    expect(useDiagnosticsStore.getState().height).toBe(300);
  });

  it("setMaxHeight leaves a smaller current height untouched", () => {
    useDiagnosticsStore.setState({ maxHeight: 400, height: 200 });
    useDiagnosticsStore.getState().setMaxHeight(800);
    expect(useDiagnosticsStore.getState().maxHeight).toBe(800);
    expect(useDiagnosticsStore.getState().height).toBe(200);
  });

  it("setMaxHeight skips subscriber notifications on a no-op", () => {
    useDiagnosticsStore.setState({ maxHeight: 400, height: 200 });
    let notifyCount = 0;
    const unsub = useDiagnosticsStore.subscribe(() => {
      notifyCount += 1;
    });
    useDiagnosticsStore.getState().setMaxHeight(400);
    expect(notifyCount).toBe(0);
    useDiagnosticsStore.getState().setMaxHeight(500);
    expect(notifyCount).toBe(1);
    unsub();
  });
});
