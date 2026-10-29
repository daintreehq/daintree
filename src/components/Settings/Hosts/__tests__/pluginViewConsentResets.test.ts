import { afterEach, describe, expect, it, vi } from "vitest";
import {
  _resetPluginViewConsentResetsForTesting,
  holdPluginViewRetries,
  notePluginViewConsentReset,
  onPluginViewConsentReset,
} from "../pluginViewConsentResets";

const PROJECT_PLUGIN = `project__${"a".repeat(64)}__acme.peek`;

afterEach(() => {
  _resetPluginViewConsentResetsForTesting();
});

describe("pluginViewConsentResets", () => {
  it("retries a blocked view at once when nothing holds it back", () => {
    const retry = vi.fn();
    onPluginViewConsentReset("studio-01", "acme.graph", retry);
    notePluginViewConsentReset("studio-01", "acme.graph");
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("waits for the last hold, then retries once however many resets landed", () => {
    const retry = vi.fn();
    onPluginViewConsentReset("studio-01", "acme.graph", retry);
    const releaseSettings = holdPluginViewRetries();
    const releaseOther = holdPluginViewRetries();
    notePluginViewConsentReset("studio-01", "acme.graph");
    notePluginViewConsentReset("studio-01");
    expect(retry).not.toHaveBeenCalled();

    releaseSettings();
    releaseSettings();
    expect(retry).not.toHaveBeenCalled();
    releaseOther();
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("matches the exact instance on that host, or every plugin on a host-wide reset", () => {
    const graph = vi.fn();
    const peek = vi.fn();
    const elsewhere = vi.fn();
    onPluginViewConsentReset("studio-01", "acme.graph", graph);
    onPluginViewConsentReset("studio-01", PROJECT_PLUGIN, peek);
    onPluginViewConsentReset("studio-02", "acme.graph", elsewhere);

    notePluginViewConsentReset("studio-01", "acme.peek");
    expect(peek).not.toHaveBeenCalled();
    notePluginViewConsentReset("studio-01", PROJECT_PLUGIN);
    expect(peek).toHaveBeenCalledTimes(1);
    expect(graph).not.toHaveBeenCalled();

    notePluginViewConsentReset("studio-01");
    expect(graph).toHaveBeenCalledTimes(1);
    expect(peek).toHaveBeenCalledTimes(2);
    expect(elsewhere).not.toHaveBeenCalled();
  });

  it("retries only views blocked when the reset landed, and none that went away", () => {
    const gone = vi.fn();
    const release = holdPluginViewRetries();
    const unsubscribe = onPluginViewConsentReset("studio-01", "acme.graph", gone);
    notePluginViewConsentReset("studio-01", "acme.graph");
    unsubscribe();
    // Asked again after the reset and refused again: not asked a third time.
    const refusedAgain = vi.fn();
    onPluginViewConsentReset("studio-01", "acme.graph", refusedAgain);
    release();
    expect(gone).not.toHaveBeenCalled();
    expect(refusedAgain).not.toHaveBeenCalled();
  });
});
