import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";

const logger = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("../../../utils/logger.js", () => ({
  createLogger: () => logger,
}));

import {
  PluginCatalogService,
  getPluginCatalogService,
  type PluginCatalogDeps,
} from "../PluginCatalogService.js";
import {
  PLUGIN_CATALOG_BROWSE_TTL_MS,
  PLUGIN_CATALOG_MAX_BYTES,
  PLUGIN_CATALOG_URL,
} from "../../../../shared/config/pluginCatalog.js";
import { CATALOG_WITH_MALFORMED_ENTRY, VALID_CATALOG, catalogEntry } from "./pluginCatalogFixtures.js";

type FetchImpl = NonNullable<PluginCatalogDeps["fetchImpl"]>;

const T0 = 1_800_000_000_000;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function respondWith(...responses: Array<() => Response | Promise<Response>>) {
  const queue = [...responses];
  return vi.fn<FetchImpl>(async () => {
    const next = queue.shift();
    if (!next) throw new Error("unexpected fetch");
    return next();
  });
}

const ok = (body: unknown = VALID_CATALOG) => () => jsonResponse(body);
const offline = () => {
  throw new TypeError("net::ERR_INTERNET_DISCONNECTED");
};
const notFound = () => new Response("Not Found", { status: 404 });

describe("PluginCatalogService", () => {
  let tmpDir: string;
  let cachePath: string;
  let now: number;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "plugin-catalog-"));
    cachePath = path.join(tmpDir, "plugin-catalog.json");
    now = T0;
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function service(fetchImpl: FetchImpl, overrides: Partial<PluginCatalogDeps> = {}) {
    return new PluginCatalogService({ cachePath, fetchImpl, now: () => now, ...overrides });
  }

  async function seedCache(fetchedAt: number, catalog: unknown = VALID_CATALOG): Promise<void> {
    await fs.writeFile(cachePath, JSON.stringify({ fetchedAt, catalog }), "utf-8");
  }

  async function cacheExists(): Promise<boolean> {
    return fs.access(cachePath).then(
      () => true,
      () => false
    );
  }

  it("does nothing until something asks for the catalog", async () => {
    const fetchImpl = respondWith(ok());
    service(fetchImpl);
    getPluginCatalogService();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await cacheExists()).toBe(false);
  });

  it("returns the same shared service to every caller", () => {
    expect(getPluginCatalogService()).toBe(getPluginCatalogService());
  });

  it("fetches without the HTTP cache, under a deadline, and caches the result", async () => {
    const fetchImpl = respondWith(ok());
    const result = await service(fetchImpl).getCatalog("browse");

    expect(result).toMatchObject({ status: "available", fresh: true, fetchedAt: T0 });
    expect(result.status === "available" && result.catalog.entries).toHaveLength(3);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(PLUGIN_CATALOG_URL);
    expect(init).toMatchObject({ cache: "no-store", credentials: "omit" });
    expect(init.signal).toBeInstanceOf(AbortSignal);

    const persisted = JSON.parse(await fs.readFile(cachePath, "utf-8"));
    expect(persisted.fetchedAt).toBe(T0);
    expect(persisted.catalog.entries).toHaveLength(3);
  });

  describe("browse", () => {
    it("reuses a cache inside the browse window without fetching", async () => {
      await seedCache(T0 - PLUGIN_CATALOG_BROWSE_TTL_MS + 1);
      const fetchImpl = respondWith();
      const result = await service(fetchImpl).getCatalog("browse");
      expect(result).toMatchObject({ status: "available", fresh: true });
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("revalidates a cache at the edge of the window", async () => {
      await seedCache(T0 - PLUGIN_CATALOG_BROWSE_TTL_MS);
      const fetchImpl = respondWith(ok());
      const result = await service(fetchImpl).getCatalog("browse");
      expect(result).toMatchObject({ status: "available", fresh: true, fetchedAt: T0 });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it("falls back to a stale cache while offline, marked as stale", async () => {
      await seedCache(T0 - PLUGIN_CATALOG_BROWSE_TTL_MS * 4);
      const result = await service(respondWith(offline)).getCatalog("browse");
      expect(result).toMatchObject({
        status: "available",
        fresh: false,
        failure: "unreachable",
        fetchedAt: T0 - PLUGIN_CATALOG_BROWSE_TTL_MS * 4,
      });
    });

    it("refetches once the window passes in the same session", async () => {
      const fetchImpl = respondWith(ok(), ok({ entries: [] }));
      const svc = service(fetchImpl);
      await svc.getCatalog("browse");
      now += PLUGIN_CATALOG_BROWSE_TTL_MS;
      const result = await svc.getCatalog("browse");
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(result.status === "available" && result.catalog.entries).toEqual([]);
    });

    it("never treats a cache from the future as fresh", async () => {
      await seedCache(T0 + 60_000);
      const fetchImpl = respondWith(ok());
      await service(fetchImpl).getCatalog("browse");
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it("revalidates after the clock goes backwards", async () => {
      const fetchImpl = respondWith(ok(), ok());
      const svc = service(fetchImpl);
      await svc.getCatalog("browse");
      now -= 1000;
      await svc.getCatalog("browse");
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });
  });

  describe("install", () => {
    it("revalidates even a cache inside the browse window", async () => {
      await seedCache(T0 - 1000);
      const fetchImpl = respondWith(ok());
      const result = await service(fetchImpl).getCatalog("install");
      expect(result).toMatchObject({ status: "available", fresh: true, fetchedAt: T0 });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it("offline with a young cache: stale, with no entries to install from", async () => {
      await seedCache(T0 - 1000);
      const result = await service(respondWith(offline)).getCatalog("install");
      expect(result).toEqual({ status: "stale", fetchedAt: T0 - 1000, failure: "unreachable" });
    });

    it("offline with no cache: unavailable", async () => {
      const result = await service(respondWith(offline)).getCatalog("install");
      expect(result).toEqual({ status: "unavailable", failure: "unreachable" });
    });
  });

  describe("failures", () => {
    it("reads a 404 as not published, quietly", async () => {
      const result = await service(respondWith(notFound)).getCatalog("browse");
      expect(result).toEqual({ status: "unavailable", failure: "not-published" });
      expect(logger.warn).not.toHaveBeenCalled();
      expect(logger.error).not.toHaveBeenCalled();
    });

    it("keeps a cached catalog for browsing when the file 404s", async () => {
      await seedCache(T0 - PLUGIN_CATALOG_BROWSE_TTL_MS * 2);
      const svc = service(respondWith(notFound, notFound));
      expect(await svc.getCatalog("browse")).toMatchObject({
        status: "available",
        fresh: false,
        failure: "not-published",
      });
      expect(await svc.getCatalog("install")).toMatchObject({
        status: "stale",
        failure: "not-published",
      });
    });

    it("reads another error status as unreachable", async () => {
      const result = await service(
        respondWith(() => new Response("", { status: 503 }))
      ).getCatalog("browse");
      expect(result).toEqual({ status: "unavailable", failure: "unreachable" });
    });

    it("reads a timeout as unreachable", async () => {
      const timeout = () => {
        throw new DOMException("The operation timed out.", "TimeoutError");
      };
      const result = await service(respondWith(timeout)).getCatalog("install");
      expect(result).toEqual({ status: "unavailable", failure: "unreachable" });
    });

    it("refuses a body that isn't JSON", async () => {
      const result = await service(respondWith(() => new Response("<html>"))).getCatalog(
        "browse"
      );
      expect(result).toEqual({ status: "unavailable", failure: "invalid" });
    });

    it("refuses a catalog with a malformed entry and keeps the last good cache", async () => {
      await seedCache(T0 - PLUGIN_CATALOG_BROWSE_TTL_MS * 2);
      const svc = service(respondWith(ok(CATALOG_WITH_MALFORMED_ENTRY)));
      const result = await svc.getCatalog("browse");
      expect(result).toMatchObject({ status: "available", fresh: false, failure: "invalid" });
      expect(result.status === "available" && result.catalog.entries).toHaveLength(3);
      const persisted = JSON.parse(await fs.readFile(cachePath, "utf-8"));
      expect(persisted.fetchedAt).toBe(T0 - PLUGIN_CATALOG_BROWSE_TTL_MS * 2);
    });

    it("refuses a body whose declared length is over the limit", async () => {
      const big = () =>
        new Response("{}", { headers: { "content-length": String(PLUGIN_CATALOG_MAX_BYTES + 1) } });
      const result = await service(respondWith(big)).getCatalog("browse");
      expect(result).toEqual({ status: "unavailable", failure: "invalid" });
    });

    it("stops reading an undeclared body once it passes the limit", async () => {
      const cancel = vi.fn();
      let pulled = 0;
      const endless = () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              pulled += 1;
              controller.enqueue(new Uint8Array(1024 * 1024));
            },
            cancel,
          })
        );
      const result = await service(respondWith(endless)).getCatalog("browse");
      expect(result).toEqual({ status: "unavailable", failure: "invalid" });
      expect(cancel).toHaveBeenCalled();
      expect(pulled).toBeLessThanOrEqual(PLUGIN_CATALOG_MAX_BYTES / (1024 * 1024) + 2);
    });

    it("ignores a corrupt or invalid cache file", async () => {
      await fs.writeFile(cachePath, "{not json", "utf-8");
      expect(await service(respondWith(offline)).getCatalog("browse")).toEqual({
        status: "unavailable",
        failure: "unreachable",
      });

      await seedCache(T0 - 1000, CATALOG_WITH_MALFORMED_ENTRY);
      expect(await service(respondWith(offline)).getCatalog("browse")).toEqual({
        status: "unavailable",
        failure: "unreachable",
      });

      await fs.writeFile(cachePath, JSON.stringify({ catalog: VALID_CATALOG }), "utf-8");
      expect(await service(respondWith(offline)).getCatalog("browse")).toEqual({
        status: "unavailable",
        failure: "unreachable",
      });
    });

    it("keeps a fetched catalog in memory when the cache can't be written", async () => {
      const blocked = path.join(tmpDir, "not-a-dir");
      await fs.writeFile(blocked, "", "utf-8");
      const svc = service(respondWith(ok(), offline), {
        cachePath: path.join(blocked, "plugin-catalog.json"),
      });
      expect(await svc.getCatalog("browse")).toMatchObject({ status: "available", fresh: true });
      now += PLUGIN_CATALOG_BROWSE_TTL_MS;
      expect(await svc.getCatalog("browse")).toMatchObject({
        status: "available",
        fresh: false,
        fetchedAt: T0,
      });
      expect(logger.warn).toHaveBeenCalledWith("Catalog cache write failed", expect.anything());
    });
  });

  describe("concurrent callers", () => {
    it("share one fetch, and each gets the answer its own mode allows", async () => {
      await seedCache(T0 - PLUGIN_CATALOG_BROWSE_TTL_MS * 2);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const fetchImpl = respondWith(async () => {
        await gate;
        return offline();
      });
      const svc = service(fetchImpl);
      const pending = Promise.all([
        svc.getCatalog("browse"),
        svc.getCatalog("install"),
        svc.lookup("daintreehq.continue-session", "0.1.1"),
      ]);
      await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalled());
      release();
      const [browse, install, lookup] = await pending;

      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(browse).toMatchObject({ status: "available", fresh: false });
      expect(install).toMatchObject({ status: "stale" });
      expect(lookup).toMatchObject({ status: "stale" });
    });

    it("retries on the next call after a failed fetch", async () => {
      const fetchImpl = respondWith(offline, ok());
      const svc = service(fetchImpl);
      expect(await svc.getCatalog("install")).toMatchObject({ status: "unavailable" });
      expect(await svc.getCatalog("install")).toMatchObject({ status: "available" });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });
  });

  describe("lookup", () => {
    it("finds an exact listed release", async () => {
      const result = await service(respondWith(ok())).lookup(
        "daintreehq.continue-session",
        "0.1.0"
      );
      expect(result).toMatchObject({
        status: "listed",
        fetchedAt: T0,
        entry: { id: "daintreehq.continue-session", version: "0.1.0" },
      });
    });

    it("says not listed only after a successful fetch", async () => {
      const result = await service(respondWith(ok())).lookup(
        "daintreehq.continue-session",
        "9.9.9"
      );
      expect(result).toEqual({ status: "not-listed", fetchedAt: T0 });
    });

    it("tells an unavailable catalog apart from a missing release", async () => {
      const result = await service(respondWith(notFound)).lookup(
        "daintreehq.continue-session",
        "0.1.1"
      );
      expect(result).toEqual({ status: "unavailable", failure: "not-published" });
    });

    it("forgets a release the next catalog delisted", async () => {
      const fetchImpl = respondWith(ok(), ok({ entries: [catalogEntry()] }));
      const svc = service(fetchImpl);
      expect(await svc.lookup("daintreehq.continue-session", "0.1.0")).toMatchObject({
        status: "listed",
      });
      expect(await svc.lookup("daintreehq.continue-session", "0.1.0")).toMatchObject({
        status: "not-listed",
      });
    });
  });
});
