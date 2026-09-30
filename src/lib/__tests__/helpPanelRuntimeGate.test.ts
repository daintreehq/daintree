import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ensureHelpPanelRuntime,
  markHelpPanelRuntimeMounted,
  markHelpPanelRuntimeUnmounted,
  onHelpPanelRuntimeRequested,
  resetHelpPanelRuntimeGateForTests,
} from "../helpPanelRuntimeGate";

afterEach(() => {
  resetHelpPanelRuntimeGateForTests();
  vi.useRealTimers();
});

describe("helpPanelRuntimeGate", () => {
  it("resolves immediately once the panel is mounted", async () => {
    markHelpPanelRuntimeMounted();
    const listener = vi.fn();
    onHelpPanelRuntimeRequested(listener);
    await ensureHelpPanelRuntime();
    expect(listener).not.toHaveBeenCalled();
  });

  it("requests a mount and resolves when the panel mounts", async () => {
    const listener = vi.fn();
    onHelpPanelRuntimeRequested(listener);
    let resolved = false;
    const ready = ensureHelpPanelRuntime().then(() => {
      resolved = true;
    });
    expect(listener).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(resolved).toBe(false);
    markHelpPanelRuntimeMounted();
    await ready;
    expect(resolved).toBe(true);
  });

  it("replays a request made before anyone subscribed", () => {
    void ensureHelpPanelRuntime();
    const listener = vi.fn();
    onHelpPanelRuntimeRequested(listener);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("waits again after the panel unmounts", async () => {
    markHelpPanelRuntimeMounted();
    markHelpPanelRuntimeUnmounted();
    const listener = vi.fn();
    onHelpPanelRuntimeRequested(listener);
    void ensureHelpPanelRuntime();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("resolves after the timeout if the panel never mounts", async () => {
    vi.useFakeTimers();
    let resolved = false;
    void ensureHelpPanelRuntime(1000).then(() => {
      resolved = true;
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(resolved).toBe(true);
  });
});
