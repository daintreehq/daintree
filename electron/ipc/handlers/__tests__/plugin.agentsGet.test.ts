import { beforeEach, describe, expect, it, vi } from "vitest";

const { startPluginHostOnce, waitForCatalog, waitForCatalogWithin, getPluginAgentRegistry } =
  vi.hoisted(() => ({
    startPluginHostOnce: vi.fn(async () => {}),
    waitForCatalog: vi.fn(async () => {}),
    waitForCatalogWithin: vi.fn(async () => {}),
    getPluginAgentRegistry: vi.fn(() => ({ pi: { id: "pi" } })),
  }));

vi.mock("../plugin/service.js", () => ({
  getPluginService: async () => ({ waitForCatalog, waitForCatalogWithin }),
}));
vi.mock("../../../window/globalServicesInit.js", () => ({ startPluginHostOnce }));
vi.mock("../../../../shared/config/pluginAgentRegistry.js", () => ({ getPluginAgentRegistry }));
vi.mock("../../../services/plugin/PluginContributionBroadcaster.js", () => ({}));
vi.mock("../../../services/plugin/PluginThemeRegistry.js", () => ({}));
vi.mock("../../../services/forgeProviderRegistry.js", () => ({}));

import { handleAgentsGet } from "../plugin/catalog.js";

describe("handleAgentsGet", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("leaves the deferred plugin host alone for an ordinary read", async () => {
    await expect(handleAgentsGet()).resolves.toEqual({ pi: { id: "pi" } });

    expect(waitForCatalog).toHaveBeenCalledOnce();
    expect(startPluginHostOnce).not.toHaveBeenCalled();
  });

  it("starts the host for a restore, which first-interactive is waiting on (#16470)", async () => {
    await expect(handleAgentsGet({ forRestore: true })).resolves.toEqual({ pi: { id: "pi" } });

    expect(startPluginHostOnce).toHaveBeenCalledOnce();
    // A deadline, so a slow scan can't hold hydration open.
    expect(waitForCatalogWithin).toHaveBeenCalledOnce();
    expect(waitForCatalog).not.toHaveBeenCalled();
  });

  it("treats anything but a literal true as an ordinary read", async () => {
    await handleAgentsGet({ forRestore: "yes" } as unknown as { forRestore: boolean });

    expect(startPluginHostOnce).not.toHaveBeenCalled();
  });
});
