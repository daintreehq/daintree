import { describe, expect, it, vi } from "vitest";
import type { ActionManifestEntry } from "../../../../shared/types/actions.js";

vi.mock("electron", () => ({
  app: {
    getVersion: () => "0.0.0-test",
  },
}));

import { lookupManifestEntry } from "../sessionToolDiscovery.js";
import { NoFrontendAttachedError, RendererBridgeUnavailableError } from "../rendererBridge.js";
import { getExternalBaseManifest, getViewlessHelpBaseManifest } from "../baseManifest.js";

describe("lookupManifestEntry with no frontend attached (#15731)", () => {
  const noFrontend = () => Promise.reject(new NoFrontendAttachedError("ws-1"));
  const cold = () => null;

  it("finds a viewless-only action's own entry, output schema included", async () => {
    // `agent.listModels` runs in main without a view but is not in the external tier.
    expect(getExternalBaseManifest().some((e) => e.id === "agent.listModels")).toBe(false);

    const entry = await lookupManifestEntry("agent.listModels", cold, noFrontend);

    expect(entry?.id).toBe("agent.listModels");
    expect(entry?.outputSchema).toMatchObject({ type: "object" });
    expect(entry?.danger).toBe(
      getViewlessHelpBaseManifest().find((e) => e.id === "agent.listModels")?.danger
    );
  });

  it("still resolves an external-tier action as before", async () => {
    const external = getExternalBaseManifest().find((e) => e.id === "terminal.list");
    expect(external).toBeDefined();

    const entry = await lookupManifestEntry("terminal.list", cold, noFrontend);

    expect(entry).toEqual(external);
  });

  it("returns undefined for an action neither catalog describes", async () => {
    await expect(lookupManifestEntry("plugin.notARealTool", cold, noFrontend)).resolves.toBe(
      undefined
    );
  });

  it("does not read the viewless catalog when the manifest failed for another reason", async () => {
    const unavailable = () => Promise.reject(new RendererBridgeUnavailableError());

    await expect(lookupManifestEntry("agent.listModels", cold, unavailable)).resolves.toBe(
      undefined
    );
  });

  it("prefers a warm cache over either catalog", async () => {
    const cached = { id: "agent.listModels", danger: "safe" } as ActionManifestEntry;
    const request = vi.fn();

    const entry = await lookupManifestEntry("agent.listModels", () => [cached], request);

    expect(entry).toBe(cached);
    expect(request).not.toHaveBeenCalled();
  });
});
