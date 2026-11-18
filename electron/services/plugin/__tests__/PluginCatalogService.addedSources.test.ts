import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { createHash } from "node:crypto";

// Every hop's name is resolved before it connects; answer public unless a test says otherwise.
vi.mock("node:dns/promises", () => {
  const lookup = vi.fn();
  return { default: { lookup }, lookup };
});

const electronMock = vi.hoisted(() => ({
  state: { userData: "" },
  fetch: vi.fn<(url: string, init: RequestInit) => Promise<Response>>(),
}));

vi.mock("electron", () => ({
  app: { getPath: () => electronMock.state.userData },
  net: { fetch: electronMock.fetch },
}));

vi.mock("../../../utils/logger.js", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import dns from "node:dns/promises";
import {
  PluginCatalogService,
  forgetPluginCatalogSourcesExcept,
  getPluginCatalogService,
} from "../PluginCatalogService.js";
import { createManualRedirectFetch } from "../../../utils/netManualRedirectFetch.js";
import { FakeElectronNet, type FakeRoute } from "../../../utils/__tests__/helpers/fakeElectronNet.js";
import { PLUGIN_CATALOG_SOURCE_CACHE_DIR } from "../../../../shared/config/pluginCatalog.js";
import { VALID_CATALOG, catalogEntry } from "./pluginCatalogFixtures.js";

const SOURCE = "https://plugins.example.org/catalog.json";
const OTHER = "https://plugins.example.org/other.json";
const T0 = 1_800_000_000_000;

const mockLookup = dns.lookup as unknown as ReturnType<typeof vi.fn>;

function resolveAllTo(...addresses: string[]) {
  mockLookup.mockImplementation(async () => addresses.map((address) => ({ address, family: 4 })));
}

function json(body: unknown): FakeRoute {
  return {
    status: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

function cacheFile(dir: string, sourceUrl: string): string {
  const name = `${createHash("sha256").update(sourceUrl).digest("hex")}.json`;
  return path.join(dir, PLUGIN_CATALOG_SOURCE_CACHE_DIR, name);
}

describe("PluginCatalogService for a catalog the person added (#17434)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "plugin-catalog-added-"));
    electronMock.state.userData = tmpDir;
    mockLookup.mockReset();
    resolveAllTo("140.82.112.3");
    electronMock.fetch.mockReset();
  });

  afterEach(async () => {
    await forgetPluginCatalogSourcesExcept([], null);
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function service(net: FakeElectronNet, sourceUrl = SOURCE) {
    return new PluginCatalogService({
      sourceUrl,
      manualFetch: createManualRedirectFetch(net.request),
      now: () => T0,
    });
  }

  it("reads its own URL through the guarded fetch, never Daintree's", async () => {
    const net = new FakeElectronNet({ [SOURCE]: json(VALID_CATALOG) });
    const result = await service(net).browse();

    expect(result.status).toBe("available");
    expect(net.connected).toEqual([SOURCE]);
    expect(electronMock.fetch).not.toHaveBeenCalled();
    // The listing names the catalog that listed it; the catalog itself can't.
    if (result.status !== "available") throw new Error("unreachable");
    expect(result.listings.length).toBeGreaterThan(0);
    expect(result.listings.every((listing) => listing.sourceUrl === SOURCE)).toBe(true);
  });

  it("keeps its cache apart from Daintree's and from every other catalog", async () => {
    await service(new FakeElectronNet({ [SOURCE]: json(VALID_CATALOG) })).browse();

    const persisted = JSON.parse(await fs.readFile(cacheFile(tmpDir, SOURCE), "utf-8"));
    expect(persisted.sourceUrl).toBe(SOURCE);
    await expect(fs.access(path.join(tmpDir, "plugin-catalog.json"))).rejects.toThrow();

    // A cache file can't stand in for another catalog: copied under OTHER's
    // name, it names SOURCE and is ignored, so an offline OTHER has nothing.
    await fs.copyFile(cacheFile(tmpDir, SOURCE), cacheFile(tmpDir, OTHER));
    const offline = new FakeElectronNet({ [OTHER]: { error: "net::ERR_INTERNET_DISCONNECTED" } });
    expect(await service(offline, OTHER).browse()).toEqual({
      status: "unavailable",
      failure: "unreachable",
    });
  });

  it("answers a browse from its own cache once it can't be refreshed", async () => {
    await service(new FakeElectronNet({ [SOURCE]: json(VALID_CATALOG) })).browse();
    const offline = new FakeElectronNet({ [SOURCE]: { error: "net::ERR_TIMED_OUT" } });
    const later = new PluginCatalogService({
      sourceUrl: SOURCE,
      manualFetch: createManualRedirectFetch(offline.request),
      now: () => T0 + 60 * 60 * 1000,
    });
    const result = await later.browse();
    expect(result).toMatchObject({ status: "available", stale: true, failure: "unreachable" });
  });

  it.each([
    ["a loopback address", "https://127.0.0.1/catalog.json"],
    ["a private network", "https://10.0.0.8/catalog.json"],
    ["plain http", "http://plugins.example.org/catalog.json"],
    ["a URL with credentials", "https://user:pass@plugins.example.org/catalog.json"],
  ])("refuses a redirect to %s without connecting to it", async (_, target) => {
    const net = new FakeElectronNet({ [SOURCE]: { redirect: target }, [target]: json(VALID_CATALOG) });
    const lookup = await service(net).lookup("daintreehq.continue-session");

    expect(lookup).toEqual({ status: "unavailable", failure: "unreachable" });
    expect(net.connected).toEqual([SOURCE]);
  });

  it("refuses a public name that resolves to a private address before connecting", async () => {
    resolveAllTo("192.168.1.20");
    const net = new FakeElectronNet({ [SOURCE]: json(VALID_CATALOG) });
    expect(await service(net).browse()).toEqual({ status: "unavailable", failure: "unreachable" });
    expect(net.connected).toEqual([]);
  });

  it("follows a redirect to another public https host", async () => {
    const moved = "https://cdn.example.net/catalog.json";
    const net = new FakeElectronNet({
      [SOURCE]: { redirect: moved },
      [moved]: json({ entries: [catalogEntry()] }),
    });
    const lookup = await service(net).lookup("daintreehq.continue-session", "0.1.1");
    expect(lookup.status).toBe("listed");
    expect(net.connected).toEqual([SOURCE, moved]);
  });

  it("gives each catalog one shared client, apart from Daintree's own", () => {
    const own = getPluginCatalogService();
    const added = getPluginCatalogService(SOURCE);
    expect(getPluginCatalogService(SOURCE)).toBe(added);
    expect(added).not.toBe(own);
    expect(getPluginCatalogService(OTHER)).not.toBe(added);
  });

  it("lets go of the clients and caches of catalogs a Browse no longer names", async () => {
    const dir = path.join(tmpDir, PLUGIN_CATALOG_SOURCE_CACHE_DIR);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(cacheFile(tmpDir, SOURCE), "{}");
    await fs.writeFile(cacheFile(tmpDir, OTHER), "{}");
    const kept = getPluginCatalogService(SOURCE);
    const dropped = getPluginCatalogService(OTHER);

    await forgetPluginCatalogSourcesExcept([SOURCE]);

    expect(getPluginCatalogService(SOURCE)).toBe(kept);
    expect(getPluginCatalogService(OTHER)).not.toBe(dropped);
    expect(await fs.readdir(dir)).toEqual([path.basename(cacheFile(tmpDir, SOURCE))]);
  });
});
