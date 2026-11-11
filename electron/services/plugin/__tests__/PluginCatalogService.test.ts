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

const electronMock = vi.hoisted(() => {
  const state = { userData: "" };
  return {
    state,
    getPath: vi.fn(() => state.userData),
    fetch: vi.fn<(url: string, init: RequestInit) => Promise<Response>>(),
  };
});

/** Each queued hold pauses the next cache write until released. */
const writeGate = vi.hoisted(() => ({
  holds: [] as Array<{ started: () => void; release: Promise<void> }>,
}));

vi.mock("../../../utils/logger.js", () => ({
  createLogger: () => logger,
}));

vi.mock("electron", () => ({
  app: { getPath: electronMock.getPath },
  net: { fetch: electronMock.fetch },
}));

vi.mock("../../../utils/fs.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../utils/fs.js")>();
  return {
    ...actual,
    resilientAtomicWriteFile: vi.fn(
      async (...args: Parameters<typeof actual.resilientAtomicWriteFile>) => {
        const hold = writeGate.holds.shift();
        if (hold) {
          hold.started();
          await hold.release;
        }
        return actual.resilientAtomicWriteFile(...args);
      }
    ),
  };
});

import {
  PluginCatalogService,
  getPluginCatalogService,
  type PluginCatalogDeps,
} from "../PluginCatalogService.js";
import { resilientAtomicWriteFile } from "../../../utils/fs.js";
import {
  PLUGIN_CATALOG_BROWSE_TTL_MS,
  PLUGIN_CATALOG_CACHE_FILENAME,
  PLUGIN_CATALOG_FETCH_TIMEOUT_MS,
  PLUGIN_CATALOG_MAX_BYTES,
  PLUGIN_CATALOG_URL,
} from "../../../../shared/config/pluginCatalog.js";
import {
  CATALOG_WITH_MALFORMED_ENTRY,
  DIGEST_A,
  VALID_CATALOG,
  catalogEntry,
} from "./pluginCatalogFixtures.js";

type FetchImpl = NonNullable<PluginCatalogDeps["fetchImpl"]>;

const T0 = 1_800_000_000_000;

function jsonResponse(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json", ...headers },
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

const ok =
  (body: unknown = VALID_CATALOG) =>
  () =>
    jsonResponse(body);
const offline = () => {
  throw new TypeError("net::ERR_INTERNET_DISCONNECTED");
};
const notFound = () => new Response("Not Found", { status: 404 });

/** A valid catalog document padded to exactly `size` bytes. */
function paddedCatalog(size: number): Uint8Array {
  const head = '{"entries":[],"pad":"';
  const tail = '"}';
  return new TextEncoder().encode(head + "x".repeat(size - head.length - tail.length) + tail);
}

/** A body with no declared length, delivered in chunks. */
function streamed(bytes: Uint8Array, cancel: () => void = () => {}): Response {
  const chunk = 512 * 1024;
  let offset = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= bytes.length) {
          controller.close();
          return;
        }
        controller.enqueue(bytes.subarray(offset, offset + chunk));
        offset += chunk;
      },
      cancel,
    })
  );
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function holdNextWrite(): { started: Promise<void>; release: () => void } {
  const started = deferred();
  const release = deferred();
  writeGate.holds.push({ started: started.resolve, release: release.promise });
  return { started: started.promise, release: release.resolve };
}

describe("PluginCatalogService", () => {
  let tmpDir: string;
  let cachePath: string;
  let now: number;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "plugin-catalog-"));
    cachePath = path.join(tmpDir, PLUGIN_CATALOG_CACHE_FILENAME);
    now = T0;
    writeGate.holds = [];
    electronMock.state.userData = tmpDir;
    vi.clearAllMocks();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function service(fetchImpl: FetchImpl, overrides: Partial<PluginCatalogDeps> = {}) {
    return new PluginCatalogService({ cachePath, fetchImpl, now: () => now, ...overrides });
  }

  async function seedCache(fetchedAt: number, catalog: unknown = VALID_CATALOG): Promise<void> {
    await fs.writeFile(cachePath, JSON.stringify({ fetchedAt, catalog }), "utf-8");
  }

  it("does nothing until something asks for the catalog", async () => {
    const fetchImpl = respondWith(ok());
    const clock = vi.fn(() => T0);
    new PluginCatalogService({ cachePath, fetchImpl, now: clock });
    new PluginCatalogService();
    getPluginCatalogService();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(clock).not.toHaveBeenCalled();
    expect(electronMock.getPath).not.toHaveBeenCalled();
    expect(electronMock.fetch).not.toHaveBeenCalled();
    expect(await fs.readdir(tmpDir)).toEqual([]);
  });

  it("returns one shared service to every caller", () => {
    const shared = getPluginCatalogService();
    expect(shared).toBeInstanceOf(PluginCatalogService);
    expect(getPluginCatalogService()).toBe(shared);
  });

  it("fetches without the HTTP cache, under a deadline, and caches the result", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const fetchImpl = respondWith(ok());
    const result = await service(fetchImpl).getCatalog("browse");

    expect(result).toEqual({
      status: "available",
      catalog: VALID_CATALOG,
      fetchedAt: T0,
      fresh: true,
    });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(PLUGIN_CATALOG_URL);
    expect(init).toMatchObject({
      cache: "no-store",
      credentials: "omit",
      headers: { Accept: "application/json" },
    });
    expect(timeout).toHaveBeenCalledWith(PLUGIN_CATALOG_FETCH_TIMEOUT_MS);
    expect(init.signal).toBe(timeout.mock.results[0].value);

    const persisted = JSON.parse(await fs.readFile(cachePath, "utf-8"));
    expect(persisted).toEqual({ fetchedAt: T0, catalog: VALID_CATALOG });
  });

  it("caches under userData and fetches through net.fetch by default", async () => {
    electronMock.fetch.mockResolvedValueOnce(jsonResponse(VALID_CATALOG));
    const result = await new PluginCatalogService().getCatalog("browse");

    expect(result).toMatchObject({ status: "available", fresh: true });
    expect(electronMock.getPath).toHaveBeenCalledWith("userData");
    expect(electronMock.fetch).toHaveBeenCalledWith(
      PLUGIN_CATALOG_URL,
      expect.objectContaining({ cache: "no-store" })
    );
    const persisted = JSON.parse(await fs.readFile(cachePath, "utf-8"));
    expect(persisted.catalog).toEqual(VALID_CATALOG);
  });

  it("persists the validated catalog, not the raw body, and reads it back", async () => {
    const nested = path.join(tmpDir, "nested", "dir", PLUGIN_CATALOG_CACHE_FILENAME);
    const body = { entries: [catalogEntry({ sha256: DIGEST_A.toUpperCase(), tagline: "x" })] };
    await service(respondWith(ok(body)), { cachePath: nested }).getCatalog("browse");

    const persisted = JSON.parse(await fs.readFile(nested, "utf-8"));
    expect(persisted.catalog.entries[0].sha256).toBe(DIGEST_A);
    expect(persisted.catalog.entries[0]).not.toHaveProperty("tagline");

    now += PLUGIN_CATALOG_BROWSE_TTL_MS * 2;
    const reloaded = await service(respondWith(offline), { cachePath: nested }).getCatalog(
      "browse"
    );
    expect(reloaded).toEqual({
      status: "available",
      catalog: persisted.catalog,
      fetchedAt: T0,
      fresh: false,
      failure: "unreachable",
    });
  });

  it("keeps nothing on disk when the cache is disabled", async () => {
    const svc = service(respondWith(ok()), { cachePath: null });
    expect(await svc.getCatalog("browse")).toMatchObject({ status: "available" });
    expect(await fs.readdir(tmpDir)).toEqual([]);
    expect(electronMock.getPath).not.toHaveBeenCalled();
  });

  describe("browse", () => {
    it("reuses a cache inside the browse window without fetching", async () => {
      const fetchedAt = T0 - PLUGIN_CATALOG_BROWSE_TTL_MS + 1;
      await seedCache(fetchedAt);
      const fetchImpl = respondWith();
      const result = await service(fetchImpl).getCatalog("browse");
      expect(result).toEqual({
        status: "available",
        catalog: VALID_CATALOG,
        fetchedAt,
        fresh: true,
      });
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
      const fetchedAt = T0 - PLUGIN_CATALOG_BROWSE_TTL_MS * 4;
      await seedCache(fetchedAt);
      const result = await service(respondWith(offline)).getCatalog("browse");
      expect(result).toEqual({
        status: "available",
        catalog: VALID_CATALOG,
        fetchedAt,
        fresh: false,
        failure: "unreachable",
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

    it("never reuses a fetch that finished before it asked, even while its write is pending", async () => {
      const write = holdNextWrite();
      const fetchImpl = respondWith(ok(), offline);
      const svc = service(fetchImpl);

      const browse = svc.getCatalog("browse");
      await write.started;
      const install = svc.getCatalog("install");
      write.release();

      expect(await browse).toMatchObject({ status: "available", fresh: true });
      expect(await install).toEqual({ status: "stale", fetchedAt: T0, failure: "unreachable" });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it("writes overlapping fetches to disk in order, so the newer catalog lands last", async () => {
      const first = holdNextWrite();
      const newer = { entries: [catalogEntry()] };
      const fetchImpl = respondWith(ok(), ok(newer));
      const svc = service(fetchImpl);

      const browse = svc.getCatalog("browse");
      await first.started;
      const install = svc.getCatalog("install");
      await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
      // Time for an unordered write of the newer catalog to start; an ordered
      // one waits behind the held write whatever the delay.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(resilientAtomicWriteFile).toHaveBeenCalledTimes(1);

      first.release();
      await Promise.all([browse, install]);
      expect(resilientAtomicWriteFile).toHaveBeenCalledTimes(2);
      const persisted = JSON.parse(await fs.readFile(cachePath, "utf-8"));
      expect(persisted.catalog).toEqual(newer);
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
        catalog: VALID_CATALOG,
        fresh: false,
        failure: "not-published",
      });
      expect(await svc.getCatalog("install")).toMatchObject({
        status: "stale",
        failure: "not-published",
      });
    });

    it("reads another error status as unreachable", async () => {
      const result = await service(respondWith(() => new Response("", { status: 503 }))).getCatalog(
        "browse"
      );
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
      const result = await service(respondWith(() => new Response("<html>"))).getCatalog("browse");
      expect(result).toEqual({ status: "unavailable", failure: "invalid" });
    });

    it("refuses a body that isn't UTF-8", async () => {
      const bytes = Buffer.concat([
        Buffer.from('{"entries":[],"note":"'),
        Buffer.from([0xff]),
        Buffer.from('"}'),
      ]);
      const result = await service(respondWith(() => new Response(bytes))).getCatalog("browse");
      expect(result).toEqual({ status: "unavailable", failure: "invalid" });
    });

    it("refuses a catalog with a malformed entry and keeps the last good cache", async () => {
      await seedCache(T0 - PLUGIN_CATALOG_BROWSE_TTL_MS * 2);
      const before = await fs.readFile(cachePath, "utf-8");
      const svc = service(respondWith(ok(CATALOG_WITH_MALFORMED_ENTRY)));
      const result = await svc.getCatalog("browse");
      expect(result).toMatchObject({
        status: "available",
        catalog: VALID_CATALOG,
        fresh: false,
        failure: "invalid",
      });
      expect(await fs.readFile(cachePath, "utf-8")).toBe(before);
    });

    it.each([
      [PLUGIN_CATALOG_MAX_BYTES, "available"],
      [PLUGIN_CATALOG_MAX_BYTES + 1, "unavailable"],
    ])("checks a declared length of %i bytes against the limit", async (length, status) => {
      const declared = () => jsonResponse({ entries: [] }, { "content-length": String(length) });
      const result = await service(respondWith(declared), { cachePath: null }).getCatalog("browse");
      expect(result.status).toBe(status);
    });

    it.each([
      [PLUGIN_CATALOG_MAX_BYTES, "available"],
      [PLUGIN_CATALOG_MAX_BYTES + 1, "unavailable"],
    ])("checks an undeclared body of %i bytes against the limit", async (size, status) => {
      const result = await service(
        respondWith(() => streamed(paddedCatalog(size))),
        {
          cachePath: null,
        }
      ).getCatalog("browse");
      expect(result.status).toBe(status);
    });

    it("cancels an undeclared body once it passes the limit", async () => {
      const cancel = vi.fn();
      const tooLong = paddedCatalog(PLUGIN_CATALOG_MAX_BYTES + 2 * 1024 * 1024);
      const result = await service(
        respondWith(() => streamed(tooLong, cancel)),
        {
          cachePath: null,
        }
      ).getCatalog("browse");
      expect(result).toEqual({ status: "unavailable", failure: "invalid" });
      expect(cancel).toHaveBeenCalled();
    });

    it.each([
      ["corrupt JSON", "{not json"],
      [
        "a malformed catalog",
        JSON.stringify({ fetchedAt: T0 - 1000, catalog: CATALOG_WITH_MALFORMED_ENTRY }),
      ],
      ["no timestamp", JSON.stringify({ catalog: VALID_CATALOG })],
      ["an infinite timestamp", '{"fetchedAt":1e400,"catalog":{"entries":[]}}'],
    ])("ignores a cache file with %s", async (_label, contents) => {
      await fs.writeFile(cachePath, contents, "utf-8");
      expect(await service(respondWith(offline)).getCatalog("browse")).toEqual({
        status: "unavailable",
        failure: "unreachable",
      });
    });

    it("keeps a fetched catalog in memory when the cache can't be written", async () => {
      const blocked = path.join(tmpDir, "not-a-dir");
      await fs.writeFile(blocked, "", "utf-8");
      const svc = service(respondWith(ok(), offline), {
        cachePath: path.join(blocked, PLUGIN_CATALOG_CACHE_FILENAME),
      });
      expect(await svc.getCatalog("browse")).toMatchObject({ status: "available", fresh: true });
      now += PLUGIN_CATALOG_BROWSE_TTL_MS;
      expect(await svc.getCatalog("browse")).toEqual({
        status: "available",
        catalog: VALID_CATALOG,
        fetchedAt: T0,
        fresh: false,
        failure: "unreachable",
      });
      expect(logger.warn).toHaveBeenCalledWith("Catalog cache write failed", expect.anything());
    });
  });

  describe("concurrent callers", () => {
    it("share one fetch, and each gets the answer its own mode allows", async () => {
      await seedCache(T0 - PLUGIN_CATALOG_BROWSE_TTL_MS * 2);
      const started = deferred();
      const gate = deferred();
      const fetchImpl = respondWith(async () => {
        started.resolve();
        await gate.promise;
        return offline();
      });
      const svc = service(fetchImpl);
      const pending = Promise.all([
        svc.getCatalog("browse"),
        svc.getCatalog("install"),
        svc.lookup("daintreehq.continue-session", "0.1.1"),
      ]);
      await started.promise;
      gate.resolve();
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
      expect(result).toEqual({ status: "listed", entry: VALID_CATALOG.entries[0], fetchedAt: T0 });
    });

    it("says not listed only after a successful fetch", async () => {
      const result = await service(respondWith(ok())).lookup(
        "daintreehq.continue-session",
        "9.9.9"
      );
      expect(result).toEqual({ status: "not-listed", fetchedAt: T0 });
    });

    it("matches the id as well as the version", async () => {
      const result = await service(respondWith(ok())).lookup("acme.other", "0.1.1");
      expect(result).toEqual({ status: "not-listed", fetchedAt: T0 });
    });

    it("tells an unavailable catalog apart from a missing release", async () => {
      const result = await service(respondWith(notFound)).lookup(
        "daintreehq.continue-session",
        "0.1.1"
      );
      expect(result).toEqual({ status: "unavailable", failure: "not-published" });
    });

    it("resolves the newest stable release when no version is named", async () => {
      const result = await service(respondWith(ok())).lookup("daintreehq.continue-session");
      expect(result).toEqual({ status: "listed", entry: VALID_CATALOG.entries[1], fetchedAt: T0 });
    });

    it("orders by semver, not by catalog order or by string", async () => {
      const release = (version: string) =>
        catalogEntry({
          version,
          url: `https://github.com/daintreehq/plugin-continue-session/releases/download/v${version}/daintreehq.continue-session-${version}.dntr`,
        });
      const result = await service(
        respondWith(ok({ entries: [release("0.10.0"), release("0.9.0"), release("1.0.0-rc.1")] }))
      ).lookup("daintreehq.continue-session");
      expect(result).toMatchObject({ status: "listed", entry: { version: "0.10.0" } });
    });

    it("resolves a prerelease only when the plugin has no stable release", async () => {
      const result = await service(respondWith(ok())).lookup("acme.linear-context");
      expect(result).toMatchObject({ status: "listed", entry: { version: "2.0.0-rc.1+build.7" } });
    });

    it("says not listed for an unknown id with no version", async () => {
      const result = await service(respondWith(ok())).lookup("acme.unknown");
      expect(result).toEqual({ status: "not-listed", fetchedAt: T0 });
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
