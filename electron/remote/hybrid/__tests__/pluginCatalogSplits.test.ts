import { beforeEach, describe, expect, it, vi } from "vitest";

const storeMock = vi.hoisted(() => {
  const data = new Map<string, unknown>();
  return { data, get: vi.fn((key: string) => data.get(key)), set: vi.fn() };
});

vi.mock("../../../store.js", () => ({ store: storeMock }));

import {
  pluginBrowseCatalog,
  pluginInstallFromCatalog,
  pluginPreviewFromCatalog,
} from "../pluginCatalogSplits.js";
import { CHANNELS } from "../../../ipc/channels.js";
import { CHANNEL_LOCALITY } from "../../../ipc/channelLocality.js";
import type { HybridSplit } from "../../../ipc/endpoint.js";

const SOURCE = "https://plugins.example.org/catalog.json";
const REPO = "https://github.com/acme/listed";

function call(args: unknown[], answer: unknown = { status: "cancelled" }) {
  const remote = vi.fn(async (_channel?: string, _args?: unknown[]) => answer);
  const local = vi.fn(async () => {
    throw new Error("a catalog read never runs on this machine");
  });
  return {
    input: {
      hostId: "host-1",
      webContentsId: -3,
      args,
      local,
      remote,
    } as Parameters<HybridSplit>[0],
    remote,
    local,
  };
}

function preview(sourceUrl?: string) {
  return {
    status: "preview",
    preview: {
      url: `${REPO}/releases/download/v1.0.0/acme.listed-1.0.0.dntr`,
      archiveHash: "a".repeat(64),
      installedOnDisk: false,
      manifest: {},
      catalog: {
        id: "acme.listed",
        version: "1.0.0",
        repo: REPO,
        ...(sourceUrl ? { sourceUrl } : {}),
      },
    },
  };
}

describe("catalog splits for a window attached to a host (#17434)", () => {
  beforeEach(() => {
    storeMock.data.clear();
  });

  it("route Browse and catalog installs through this machine", () => {
    for (const channel of [
      CHANNELS.PLUGIN_BROWSE_CATALOG,
      CHANNELS.PLUGIN_PREVIEW_FROM_CATALOG,
      CHANNELS.PLUGIN_INSTALL_FROM_CATALOG,
    ]) {
      expect(CHANNEL_LOCALITY[channel]).toBe("hybrid");
    }
    // The list itself never leaves this machine.
    expect(CHANNEL_LOCALITY["plugin:catalog-sources-get"]).toBe("shell");
    expect(CHANNEL_LOCALITY["plugin:catalog-sources-add"]).toBe("shell");
  });

  it("sends this machine's list with Browse, whatever the renderer passed", async () => {
    storeMock.data.set("pluginCatalogSources", [SOURCE, "http://insecure.example.com/c.json"]);
    const { input, remote } = call([{ sourceUrls: ["https://renderer.example.com/c.json"] }]);
    await pluginBrowseCatalog(input);
    expect(remote).toHaveBeenCalledWith(undefined, [{ sourceUrls: [SOURCE] }]);
  });

  it("refuses a preview from a catalog this machine's person hasn't added, without asking the host", async () => {
    storeMock.data.set("pluginCatalogSources", ["https://other.example.com/c.json"]);
    const { input, remote } = call([{ pluginId: "acme.listed", sourceUrl: SOURCE }, "job-1"]);
    expect(await pluginPreviewFromCatalog(input)).toMatchObject({
      status: "failed",
      errors: [{ code: "catalog_source_unknown" }],
    });
    expect(remote).not.toHaveBeenCalled();
  });

  it("forwards an added catalog in its canonical spelling, with the job", async () => {
    storeMock.data.set("pluginCatalogSources", [SOURCE]);
    const { input, remote } = call(
      [{ pluginId: "acme.listed", sourceUrl: `${SOURCE}#x` }, "job-1"],
      preview(SOURCE)
    );
    expect(await pluginPreviewFromCatalog(input)).toEqual(preview(SOURCE));
    expect(remote).toHaveBeenCalledWith(undefined, [
      { pluginId: "acme.listed", sourceUrl: SOURCE },
      "job-1",
    ]);
  });

  it("refuses an older host's preview, which read Daintree's catalog instead", async () => {
    storeMock.data.set("pluginCatalogSources", [SOURCE]);
    const { input } = call([{ pluginId: "acme.listed", sourceUrl: SOURCE }], preview());
    expect(await pluginPreviewFromCatalog(input)).toMatchObject({
      status: "failed",
      errors: [
        {
          code: "catalog_unavailable",
          message: expect.stringMatching(/Update Daintree on the host/),
        },
      ],
    });
  });

  it("passes Daintree's own catalog straight through", async () => {
    const { input, remote } = call([{ pluginId: "acme.listed" }], preview());
    expect(await pluginPreviewFromCatalog(input)).toEqual(preview());
    expect(remote).toHaveBeenCalledWith();
  });

  it("checks a listing install against the list, and leaves an update's catalog to the host's record", async () => {
    const listing = call([{ pluginId: "acme.listed", version: "1.0.0", sourceUrl: SOURCE }]);
    expect(await pluginInstallFromCatalog(listing.input)).toMatchObject({
      errors: [{ code: "catalog_source_unknown" }],
    });
    expect(listing.remote).not.toHaveBeenCalled();

    const update = call([
      { pluginId: "acme.listed", version: "1.0.1", sourceUrl: SOURCE, intent: "update" },
    ]);
    await pluginInstallFromCatalog(update.input);
    expect(update.remote).toHaveBeenCalledWith();
  });
});
