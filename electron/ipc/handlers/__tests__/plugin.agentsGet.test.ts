import { beforeEach, describe, expect, it, vi } from "vitest";

const { startPluginHostOnce, waitForCatalog, waitForCatalogWithin, getPluginAgentRegistry } =
  vi.hoisted(() => ({
    startPluginHostOnce: vi.fn(async () => {}),
    waitForCatalog: vi.fn(async () => {}),
    waitForCatalogWithin: vi.fn(async (_ms: number) => {}),
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
    expect(waitForCatalog).not.toHaveBeenCalled();
  });

  it("answers a restore only once the catalog has settled, within a deadline", async () => {
    let settle: () => void = () => {};
    waitForCatalogWithin.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          settle = resolve;
        })
    );
    let answered = false;

    const answer = handleAgentsGet({ forRestore: true }).then((agents) => {
      answered = true;
      return agents;
    });
    await vi.waitFor(() => expect(waitForCatalogWithin).toHaveBeenCalledOnce());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(answered).toBe(false);
    expect(waitForCatalogWithin.mock.calls[0]?.[0]).toBeGreaterThan(0);

    settle();
    await expect(answer).resolves.toEqual({ pi: { id: "pi" } });
  });

  it("doesn't wait on the plugin host's own start, which ends with activation", async () => {
    startPluginHostOnce.mockReturnValueOnce(new Promise<void>(() => {}));

    await expect(handleAgentsGet({ forRestore: true })).resolves.toEqual({ pi: { id: "pi" } });
  });

  it("treats anything but a literal true as an ordinary read", async () => {
    await handleAgentsGet({ forRestore: "yes" } as unknown as { forRestore: boolean });

    expect(startPluginHostOnce).not.toHaveBeenCalled();
  });
});
