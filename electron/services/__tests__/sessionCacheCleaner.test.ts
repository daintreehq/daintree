import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

type SessionListener = (ses: Electron.Session) => void;

const { appMock, sessionMock, sessionCreatedListeners } = vi.hoisted(() => {
  const listeners: SessionListener[] = [];
  return {
    sessionCreatedListeners: listeners,
    appMock: {
      getPath: vi.fn<(name: string) => string>(() => ""),
      on: vi.fn((event: string, listener: SessionListener) => {
        if (event === "session-created") listeners.push(listener);
      }),
      removeListener: vi.fn((event: string, listener: SessionListener) => {
        const index = listeners.indexOf(listener);
        if (event === "session-created" && index >= 0) listeners.splice(index, 1);
      }),
    },
    sessionMock: {
      defaultSession: null as Electron.Session | null,
      fromPartition: vi.fn(),
    },
  };
});

vi.mock("electron", () => ({ app: appMock, session: sessionMock }));

import {
  _resetSessionCacheCleanerForTesting,
  clearAllSessionCaches,
  startSessionCacheTracking,
  trackSession,
} from "../sessionCacheCleaner.js";

interface FakeSession {
  storagePath: string | null;
  clearCache: Mock<() => Promise<void>>;
  clearCodeCaches: Mock<(options: Electron.ClearCodeCachesOptions) => Promise<void>>;
}

function fakeSession(storagePath: string | null): FakeSession {
  return {
    storagePath,
    clearCache: vi.fn(() => Promise.resolve()),
    clearCodeCaches: vi.fn(() => Promise.resolve()),
  };
}

const asSession = (ses: FakeSession): Electron.Session => ses as unknown as Electron.Session;

const PRESERVED_ENTRIES = [
  "Cookies",
  "Local Storage/leveldb/000003.log",
  "IndexedDB/http_localhost_3000.indexeddb.leveldb/LOG",
  "Session Storage/LOG",
  "Service Worker/CacheStorage/index.txt",
  "GPUCache/data_0",
];

let sessionData: string;
let partitionsRoot: string;
let defaultSession: FakeSession;

function partitionDir(name: string): string {
  return path.join(partitionsRoot, name);
}

function seedFile(file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "x");
}

function seedPartition(name: string): string {
  const dir = partitionDir(name);
  seedFile(path.join(dir, "Cache", "Cache_Data", "index"));
  seedFile(path.join(dir, "Code Cache", "js", "index"));
  for (const entry of PRESERVED_ENTRIES) {
    seedFile(path.join(dir, entry));
  }
  return dir;
}

function expectCachesRemoved(dir: string): void {
  expect(fs.existsSync(path.join(dir, "Cache"))).toBe(false);
  expect(fs.existsSync(path.join(dir, "Code Cache"))).toBe(false);
  expect(fs.readdirSync(dir).filter((name) => name.includes("daintree-clearing"))).toEqual([]);
}

function expectPreserved(dir: string): void {
  for (const entry of PRESERVED_ENTRIES) {
    expect(fs.existsSync(path.join(dir, entry))).toBe(true);
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  _resetSessionCacheCleanerForTesting();
  sessionCreatedListeners.length = 0;
  sessionData = fs.mkdtempSync(path.join(os.tmpdir(), "daintree-session-cache-"));
  partitionsRoot = path.join(sessionData, "Partitions");
  appMock.getPath.mockImplementation(() => sessionData);
  defaultSession = fakeSession(sessionData);
  sessionMock.defaultSession = asSession(defaultSession);
});

afterEach(() => {
  vi.restoreAllMocks();
  _resetSessionCacheCleanerForTesting();
  fs.rmSync(sessionData, { recursive: true, force: true });
});

describe("session tracking", () => {
  it("records persistent sessions from session-created and ignores in-memory ones", async () => {
    startSessionCacheTracking();
    expect(sessionCreatedListeners).toHaveLength(1);

    const browser = fakeSession(partitionDir("browser-alpha"));
    const paintSurface = fakeSession(null);
    sessionCreatedListeners[0](asSession(browser));
    sessionCreatedListeners[0](asSession(paintSurface));

    await clearAllSessionCaches();

    expect(browser.clearCache).toHaveBeenCalledTimes(1);
    expect(paintSurface.clearCache).not.toHaveBeenCalled();
  });

  it("registers a single listener and removes it on dispose", () => {
    const stop = startSessionCacheTracking();
    expect(startSessionCacheTracking()).toBe(stop);
    expect(sessionCreatedListeners).toHaveLength(1);

    stop();
    expect(sessionCreatedListeners).toHaveLength(0);
  });
});

describe("clearAllSessionCaches — live sessions", () => {
  it("clears HTTP and code caches for default, app, portal, browser, and preview sessions", async () => {
    const live = [
      fakeSession(partitionDir("daintree")),
      fakeSession(partitionDir("portal")),
      fakeSession(partitionDir("browser-alpha")),
      fakeSession(partitionDir("dev-preview-alpha-main-panel1")),
    ];
    live.forEach((ses) => trackSession(asSession(ses)));

    const result = await clearAllSessionCaches();

    for (const ses of [defaultSession, ...live]) {
      expect(ses.clearCache).toHaveBeenCalledTimes(1);
      expect(ses.clearCodeCaches).toHaveBeenCalledWith({});
    }
    expect(result).toEqual({ cleared: 5, failed: 0 });
    expect(sessionMock.fromPartition).not.toHaveBeenCalled();
  });

  it("clears a session tracked twice only once", async () => {
    const app = fakeSession(partitionDir("daintree"));
    trackSession(asSession(app));
    trackSession(asSession(app));

    const result = await clearAllSessionCaches();

    expect(app.clearCache).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ cleared: 2, failed: 0 });
  });

  it("still clears the code cache and other sessions when one HTTP clear fails", async () => {
    const portal = fakeSession(partitionDir("portal"));
    portal.clearCache.mockRejectedValue(new Error("disk cache busy"));
    const browser = fakeSession(partitionDir("browser-alpha"));
    trackSession(asSession(portal));
    trackSession(asSession(browser));

    const result = await clearAllSessionCaches();

    expect(portal.clearCodeCaches).toHaveBeenCalledWith({});
    expect(browser.clearCache).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ cleared: 2, failed: 1 });
  });

  it("counts a session once when both cache clears fail, including synchronous throws", async () => {
    defaultSession.clearCache.mockRejectedValue(new Error("http"));
    defaultSession.clearCodeCaches.mockImplementation(() => {
      throw new Error("code");
    });

    const result = await clearAllSessionCaches();

    expect(result).toEqual({ cleared: 0, failed: 1 });
  });

  it("coalesces overlapping requests into one clear", async () => {
    let release!: () => void;
    defaultSession.clearCache.mockReturnValue(
      new Promise<void>((resolve) => {
        release = resolve;
      })
    );

    const first = clearAllSessionCaches();
    const second = clearAllSessionCaches();
    expect(second).toBe(first);

    release();
    await first;
    expect(defaultSession.clearCache).toHaveBeenCalledTimes(1);

    await clearAllSessionCaches();
    expect(defaultSession.clearCache).toHaveBeenCalledTimes(2);
  });
});

describe("clearAllSessionCaches — unopened partitions on disk", () => {
  it("removes only HTTP and code caches from recognized unopened partitions", async () => {
    const names = ["browser-beta", "browser", "dev-preview-beta-main-panel2", "project-legacy"];
    const dirs = names.map(seedPartition);

    const result = await clearAllSessionCaches();

    for (const dir of dirs) {
      expectCachesRemoved(dir);
      expectPreserved(dir);
    }
    expect(result).toEqual({ cleared: 1 + names.length, failed: 0 });
    expect(sessionMock.fromPartition).not.toHaveBeenCalled();
  });

  it("leaves unrecognized partitions untouched", async () => {
    const dir = seedPartition("plugin-foo");

    const result = await clearAllSessionCaches();

    expect(fs.existsSync(path.join(dir, "Cache", "Cache_Data", "index"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "Code Cache", "js", "index"))).toBe(true);
    expect(result).toEqual({ cleared: 1, failed: 0 });
  });

  it("clears live partitions through the API instead of deleting their cache dirs", async () => {
    const dir = seedPartition("daintree");
    const app = fakeSession(dir);
    trackSession(asSession(app));

    const result = await clearAllSessionCaches();

    expect(app.clearCache).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(path.join(dir, "Cache", "Cache_Data", "index"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "Code Cache", "js", "index"))).toBe(true);
    expect(result).toEqual({ cleared: 2, failed: 0 });
  });

  it("uses the API for a partition that opens after the live pass started", async () => {
    const dir = seedPartition("browser-late");
    const late = fakeSession(dir);
    defaultSession.clearCache.mockImplementation(() => {
      trackSession(asSession(late));
      return Promise.resolve();
    });

    const result = await clearAllSessionCaches();

    expect(late.clearCache).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(path.join(dir, "Cache", "Cache_Data", "index"))).toBe(true);
    expect(result).toEqual({ cleared: 2, failed: 0 });
  });

  it("treats a missing Partitions directory or missing cache dirs as already clear", async () => {
    expect(await clearAllSessionCaches()).toEqual({ cleared: 1, failed: 0 });

    fs.mkdirSync(partitionDir("browser-empty"), { recursive: true });
    expect(await clearAllSessionCaches()).toEqual({ cleared: 2, failed: 0 });
  });

  it("removes cache dirs a previous clear detached but could not delete", async () => {
    const dir = seedPartition("portal");
    trackSession(asSession(fakeSession(dir)));
    seedFile(path.join(dir, "Cache.daintree-clearing-0a1b2c", "Cache_Data", "index"));

    const result = await clearAllSessionCaches();

    expect(fs.existsSync(path.join(dir, "Cache.daintree-clearing-0a1b2c"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "Cache", "Cache_Data", "index"))).toBe(true);
    expect(result).toEqual({ cleared: 2, failed: 0 });
  });

  it("reports a partition whose cache dir can't be detached", async () => {
    const dir = seedPartition("browser-locked");
    const realRename = fs.renameSync;
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(from).endsWith(`${path.sep}Code Cache`)) {
        throw Object.assign(new Error("EBUSY: resource busy"), { code: "EBUSY" });
      }
      realRename(from, to);
    });

    const result = await clearAllSessionCaches();

    expect(fs.existsSync(path.join(dir, "Cache"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "Code Cache", "js", "index"))).toBe(true);
    expectPreserved(dir);
    expect(result).toEqual({ cleared: 1, failed: 1 });
  });

  it("reports failure when the partition directory can't be listed", async () => {
    fs.writeFileSync(partitionsRoot, "not a directory");

    const result = await clearAllSessionCaches();

    expect(result).toEqual({ cleared: 1, failed: 1 });
  });
});
