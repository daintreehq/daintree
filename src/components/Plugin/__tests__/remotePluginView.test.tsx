// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, renderHook } from "@testing-library/react";

const hostConnection = vi.hoisted(() => ({
  value: {
    hostId: "studio-01" as string | null,
    hostName: "studio-01",
    connection: null,
    lastSeenAt: null,
  },
}));
vi.mock("@/hooks/useHostConnection", () => ({ useHostConnection: () => hostConnection.value }));
vi.mock("@/lib/platform", () => ({ isMac: () => true }));

import { isRemoteUnsupportedError, pluginViewImportPath } from "../remotePluginView";
import { remoteTrustSentence, useRemoteTrustSentence } from "../remotePluginTrust";
import { PluginRemoteUnsupportedPlaceholder } from "../PluginRemoteUnsupportedPlaceholder";
import { formatAskedAt } from "../PluginProvenance";

afterEach(() => {
  delete (window as { __DAINTREE_HOST_ID__?: unknown }).__DAINTREE_HOST_ID__;
});

describe("plugin views in a window attached to another machine", () => {
  it("imports a remote view's module from its host, and a local one unchanged", () => {
    const url = "plugin://pi-abc/__dtv-2/dist/view.js";
    expect(pluginViewImportPath(url)).toBe(url);
    window.__DAINTREE_HOST_ID__ = { id: "local" };
    expect(pluginViewImportPath(url)).toBe(url);
    window.__DAINTREE_HOST_ID__ = { id: "studio-01" };
    expect(pluginViewImportPath(url)).toBe("plugin://pi-abc/__dth-studio-01/__dtv-2/dist/view.js");
  });

  it("recognises the host's remote-unsupported refusal by its typed details", () => {
    const refusal = Object.assign(new Error("x"), {
      code: "PLUGIN_INCOMPATIBLE",
      details: {
        code: "PLUGIN_INCOMPATIBLE",
        pluginId: "acme.graph",
        hostId: "local",
        reason: { kind: "remote-unsupported" },
      },
    });
    expect(isRemoteUnsupportedError(refusal)).toBe(true);
    expect(isRemoteUnsupportedError(new Error("boom"))).toBe(false);
    expect(
      isRemoteUnsupportedError({
        details: { code: "PLUGIN_INCOMPATIBLE", reason: { kind: "untrusted" } },
      })
    ).toBe(false);
  });

  it("shows a placeholder naming the machine the plugin needs", () => {
    const { container } = render(
      <PluginRemoteUnsupportedPlaceholder pluginDisplayName="Graph View" />
    );
    expect(container.textContent).toContain(
      "Graph View only works when you're sitting at studio-01"
    );
  });

  it("names both machines when trusting a plugin from a remote window", () => {
    expect(remoteTrustSentence("'Graph View'", "studio-01", false, "this Mac")).toBe(
      "Trusting 'Graph View' on studio-01 also runs its view code on this Mac."
    );
    const remote = renderHook(() => useRemoteTrustSentence("'Graph View'"));
    expect(remote.result.current).toBe(
      "Trusting 'Graph View' on studio-01 also runs its view code on this Mac."
    );
    hostConnection.value = { ...hostConnection.value, hostId: null };
    const local = renderHook(() => useRemoteTrustSentence("'Graph View'"));
    expect(local.result.current).toBeNull();
  });

  it("dates a prompt that waited, with the day when it wasn't today", () => {
    const now = new Date(2026, 8, 25, 12, 0).getTime();
    expect(formatAskedAt(new Date(2026, 8, 25, 3, 12).getTime(), now)).toMatch(/3:12/);
    expect(formatAskedAt(new Date(2026, 8, 23, 3, 12).getTime(), now)).toMatch(/23/);
  });
});
