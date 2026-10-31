import { describe, expect, it, vi } from "vitest";
import type { ActionManifestEntry } from "../../../../shared/types/actions.js";

vi.mock("electron", () => ({
  app: {
    getVersion: () => "0.0.0-test",
  },
}));

import { lookupManifestEntry } from "../sessionToolDiscovery.js";
import {
  NoFrontendAttachedError,
  RendererBridgeUnavailableError,
  WorkspaceBindingError,
} from "../rendererBridge.js";
import { MCP_EXTERNAL_BASE_MANIFEST } from "../generated/mcpExternalBaseManifest.js";
import { MCP_VIEWLESS_BASE_MANIFEST } from "../generated/mcpViewlessBaseManifest.js";

describe("lookupManifestEntry with no frontend attached (#15731)", () => {
  const noFrontend = () => Promise.reject(new NoFrontendAttachedError("ws-1"));
  const cold = () => null;

  // Derived from the artifacts so the fixture follows a tool moving between
  // tiers; `agent.listModels` is the case the issue names, today's first match.
  const externalIds = new Set(MCP_EXTERNAL_BASE_MANIFEST.map((e) => e.id));
  const viewlessOnly = MCP_VIEWLESS_BASE_MANIFEST.find(
    (e) => !externalIds.has(e.id) && e.outputSchema !== undefined
  );

  it("has a viewless-only action with an output schema to look up", () => {
    expect(viewlessOnly).toBeDefined();
  });

  it("finds a viewless-only action's own entry, output schema and danger included", async () => {
    const entry = await lookupManifestEntry(viewlessOnly!.id, cold, noFrontend);

    expect(entry?.id).toBe(viewlessOnly!.id);
    expect(entry?.outputSchema).toEqual(viewlessOnly!.outputSchema);
    expect(entry?.danger).toBe(viewlessOnly!.danger);
  });

  it("still resolves an external-tier action as before", async () => {
    const external = MCP_EXTERNAL_BASE_MANIFEST.find((e) => e.id === "terminal.list");
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

    await expect(lookupManifestEntry(viewlessOnly!.id, cold, unavailable)).resolves.toBe(undefined);
  });

  it("rethrows a lost route instead of answering from the catalog", async () => {
    // Only "no frontend attached" is served from the host's catalog; a missing
    // or ambiguous workspace route is the bound-session guard's to report (#12082).
    const lost = () => Promise.reject(new WorkspaceBindingError("ws-1", "not-found"));

    await expect(lookupManifestEntry(viewlessOnly!.id, cold, lost)).rejects.toBeInstanceOf(
      WorkspaceBindingError
    );
  });

  it("prefers a warm cache over either catalog", async () => {
    const cached = { id: viewlessOnly!.id, danger: "safe" } as ActionManifestEntry;
    const request = vi.fn();

    const entry = await lookupManifestEntry(viewlessOnly!.id, () => [cached], request);

    expect(entry).toBe(cached);
    expect(request).not.toHaveBeenCalled();
  });
});
