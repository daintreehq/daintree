import fs from "node:fs";
import {
  buildBrowserPartition,
  buildDevPreviewPartition,
  partitionProjectKey,
  remotePartitionKeyPrefix,
} from "../../../shared/utils/partitionUtils.js";
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
  clearHostPartitions,
  clearRetiredPortalPartitions,
  isHostPartitionDirName,
  isRetiredPortalPartitionDirName,
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

const dirName = (partition: string) => partition.replace(/^persist:/, "");
const browserOf = (hostId: string, projectId: string) =>
  dirName(buildBrowserPartition(partitionProjectKey(projectId, hostId)));
const devPreviewOf = (hostId: string, projectId: string) =>
  dirName(buildDevPreviewPartition(partitionProjectKey(projectId, hostId), "main", "panel-1"));
/** The directory of a host's Portal session, as builds before #17257 named it. */
const retiredPortalOf = (hostId: string) =>
  dirName(buildBrowserPartition(`${remotePartitionKeyPrefix(hostId)}-portal`));

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
  it("clears HTTP and code caches for default, app, browser, and preview sessions", async () => {
    const live = [
      fakeSession(partitionDir("daintree")),
      fakeSession(partitionDir("browser-alpha")),
      fakeSession(partitionDir("dev-preview-alpha-main-panel1")),
    ];
    live.forEach((ses) => trackSession(asSession(ses)));

    const result = await clearAllSessionCaches();

    for (const ses of [defaultSession, ...live]) {
      expect(ses.clearCache).toHaveBeenCalledTimes(1);
      expect(ses.clearCodeCaches).toHaveBeenCalledWith({});
    }
    expect(result).toEqual({ cleared: 4, failed: 0 });
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
    const app = fakeSession(partitionDir("daintree"));
    app.clearCache.mockRejectedValue(new Error("disk cache busy"));
    const browser = fakeSession(partitionDir("browser-alpha"));
    trackSession(asSession(app));
    trackSession(asSession(browser));

    const result = await clearAllSessionCaches();

    expect(app.clearCodeCaches).toHaveBeenCalledWith({});
    expect(browser.clearCache).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ cleared: 2, failed: 1 });
  });

  it("reports a code-cache failure even when the HTTP clear succeeds", async () => {
    const preview = fakeSession(partitionDir("dev-preview-alpha-main-panel1"));
    preview.clearCodeCaches.mockRejectedValue(new Error("code cache busy"));
    const browser = fakeSession(partitionDir("browser-alpha"));
    trackSession(asSession(preview));
    trackSession(asSession(browser));

    const result = await clearAllSessionCaches();

    expect(preview.clearCache).toHaveBeenCalledTimes(1);
    expect(browser.clearCodeCaches).toHaveBeenCalledWith({});
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
    const dir = seedPartition("daintree");
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

  it("reports a detached cache that can't be removed and removes it on the next clear", async () => {
    const dir = seedPartition("browser-stuck");
    vi.spyOn(fs.promises, "rm").mockRejectedValueOnce(
      Object.assign(new Error("EBUSY: resource busy"), { code: "EBUSY" })
    );

    expect(await clearAllSessionCaches()).toEqual({ cleared: 1, failed: 1 });
    expect(fs.readdirSync(dir).filter((name) => name.includes("daintree-clearing"))).toHaveLength(
      1
    );

    expect(await clearAllSessionCaches()).toEqual({ cleared: 2, failed: 0 });
    expectCachesRemoved(dir);
    expectPreserved(dir);
  });

  it("never traverses an unopened symlinked partition and reports it", async () => {
    const liveDir = seedPartition("daintree");
    trackSession(asSession(fakeSession(liveDir)));
    fs.symlinkSync(liveDir, partitionDir("browser-alias"), "dir");
    const renameSpy = vi.spyOn(fs, "renameSync");

    const result = await clearAllSessionCaches();

    expect(renameSpy).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(liveDir, "Cache", "Cache_Data", "index"))).toBe(true);
    expect(fs.existsSync(path.join(liveDir, "Code Cache", "js", "index"))).toBe(true);
    expect(result).toEqual({ cleared: 2, failed: 1 });
  });

  it("clears a symlinked partition opened by name through the API only", async () => {
    const relocated = path.join(sessionData, "relocated-browser");
    fs.mkdirSync(partitionsRoot, { recursive: true });
    fs.renameSync(seedPartition("browser-moved"), relocated);
    fs.symlinkSync(relocated, partitionDir("browser-moved"), "dir");
    const moved = fakeSession(partitionDir("browser-moved"));
    trackSession(asSession(moved));

    const result = await clearAllSessionCaches();

    expect(moved.clearCache).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(path.join(relocated, "Cache", "Cache_Data", "index"))).toBe(true);
    expect(result).toEqual({ cleared: 2, failed: 0 });
  });

  it("reports failure when the partition directory can't be listed", async () => {
    fs.writeFileSync(partitionsRoot, "not a directory");

    const result = await clearAllSessionCaches();

    expect(result).toEqual({ cleared: 1, failed: 1 });
  });
});

describe("clearHostPartitions", () => {
  it("names every session a host's projects and retired portal use, and no other host's", () => {
    for (const name of [
      browserOf("studio", "proj-1"),
      devPreviewOf("studio", "proj-1"),
      retiredPortalOf("studio"),
    ]) {
      expect(isHostPartitionDirName(name, "studio")).toBe(true);
    }
    for (const name of [
      browserOf("studio-2", "proj-1"),
      devPreviewOf("studio-2", "proj-1"),
      retiredPortalOf("studio-2"),
      dirName(buildBrowserPartition("proj-1")),
      "daintree",
    ]) {
      expect(isHostPartitionDirName(name, "studio")).toBe(false);
    }
  });

  it("wipes the host's partitions whole, open or not, and leaves the rest", async () => {
    const closed = seedPartition(browserOf("studio", "proj-1"));
    const open = seedPartition(devPreviewOf("studio", "proj-2"));
    const neighbour = seedPartition(browserOf("studio-2", "proj-1"));
    const local = seedPartition(dirName(buildBrowserPartition("proj-1")));
    const live = { storagePath: open, clearData: vi.fn(() => Promise.resolve()) };
    trackSession(live as unknown as Electron.Session);

    const result = await clearHostPartitions("studio");

    expect(result).toEqual({ cleared: 2, failed: 0 });
    expect(fs.existsSync(closed)).toBe(false);
    expect(live.clearData).toHaveBeenCalledTimes(1);
    expectPreserved(neighbour);
    expectPreserved(local);
    expect(fs.readdirSync(partitionsRoot).some((n) => n.includes("daintree-clearing"))).toBe(false);
  });

  it("matches a long host id by its hashed part, and no other host's", () => {
    // Each "-" escapes to five characters, so both parts are past 64 and hashed.
    const longId = `h${"-".repeat(30)}`;
    const otherLong = `g${"-".repeat(30)}`;
    for (const name of [
      browserOf(longId, "proj-1"),
      devPreviewOf(longId, "proj-1"),
      retiredPortalOf(longId),
    ]) {
      expect(isHostPartitionDirName(name, longId)).toBe(true);
      expect(isHostPartitionDirName(name, otherLong)).toBe(false);
    }
  });

  it("clears a symlinked partition only through its live session, never by its target", async () => {
    const target = fs.mkdtempSync(path.join(os.tmpdir(), "daintree-partition-target-"));
    seedFile(path.join(target, "Cookies"));
    fs.mkdirSync(partitionsRoot, { recursive: true });
    const link = partitionDir(browserOf("studio", "proj-1"));
    fs.symlinkSync(target, link);

    expect(await clearHostPartitions("studio")).toEqual({ cleared: 0, failed: 1 });
    expect(fs.existsSync(path.join(target, "Cookies"))).toBe(true);

    const live = { storagePath: link, clearData: vi.fn(() => Promise.resolve()) };
    trackSession(live as unknown as Electron.Session);
    expect(await clearHostPartitions("studio")).toEqual({ cleared: 1, failed: 0 });
    expect(live.clearData).toHaveBeenCalledTimes(1);
    fs.rmSync(target, { recursive: true, force: true });
  });

  it("has nothing to do when no partition was ever made", async () => {
    await expect(clearHostPartitions("studio")).resolves.toEqual({ cleared: 0, failed: 0 });
  });
});

describe("clearRetiredPortalPartitions", () => {
  const LONG_HOST = `h${"-".repeat(30)}`;

  function seedFullPartition(name: string): string {
    const dir = seedPartition(name);
    seedFile(path.join(dir, "Network", "Cookies"));
    return dir;
  }

  function expectUntouched(dir: string): void {
    expectPreserved(dir);
    expect(fs.existsSync(path.join(dir, "Network", "Cookies"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "Cache", "Cache_Data", "index"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "Code Cache", "js", "index"))).toBe(true);
  }

  function leftovers(): string[] {
    return fs.readdirSync(partitionsRoot).filter((name) => name.includes("daintree-clearing"));
  }

  it("names the host Portal sessions older builds wrote, escaped and hashed", () => {
    expect(retiredPortalOf("studio")).toBe("browser-remote__studio__-portal");
    expect(retiredPortalOf("Studio.Local")).toBe(
      "browser-remote___0053tudio_002e_004cocal__-portal"
    );
    expect(retiredPortalOf(LONG_HOST)).toBe("browser-remote__-1fbb310b7169e9__-portal");
  });

  it("names this machine's Portal session and every host's, in any host encoding", () => {
    for (const name of [
      "portal",
      "browser-remote__studio__-portal",
      "browser-remote___0053tudio_002e_004cocal__-portal",
      "browser-remote__-1fbb310b7169e9__-portal",
      "browser-remote__-0__-portal",
      "browser-remote__-1fffffffffffff__-portal",
      `browser-remote__${"a".repeat(64)}__-portal`,
      retiredPortalOf("studio"),
      retiredPortalOf("Studio.Local"),
      retiredPortalOf(LONG_HOST),
      `${retiredPortalOf("studio")}.daintree-clearing-0123456789ab`,
      `portal.daintree-clearing-0123456789ab.daintree-clearing-ba9876543210`,
    ]) {
      expect(isRetiredPortalPartitionDirName(name), name).toBe(true);
    }
  });

  it("names no other session, however close its name", () => {
    for (const name of [
      "daintree",
      "browser",
      "browser-default",
      "browser-portal",
      "browser-team-portal",
      dirName(buildBrowserPartition("-portal")),
      browserOf("studio", "-portal"),
      browserOf("studio", "proj-1"),
      browserOf(LONG_HOST, "proj-1"),
      devPreviewOf("studio", "proj-1"),
      dirName(buildDevPreviewPartition("portal", "main", "panel-1")),
      "browser-remote__studio__-portalfoo",
      "browser-remote__studio__-portal-2",
      "browser-remote__stu-dio__-portal",
      "browser-remote____-portal",
      "dev-preview-remote__studio__-portal",
      "portal-old",
      "portals",
      "sidecar",
      "portal.daintree-clearing-xyz",
      "portal.daintree-clearing-0123456789a",
      "portal.daintree-clearing-0123456789abc",
      `${browserOf("studio", "proj-1")}.daintree-clearing-0123456789ab`,
      // Spellings partitionPart never wrote: an escape past 64 characters, a
      // malformed escape, and hashes that aren't its canonical hex.
      `browser-remote__${"a".repeat(65)}__-portal`,
      "browser-remote___12__-portal",
      "browser-remote__-000000000000001__-portal",
      "browser-remote__-01__-portal",
      "browser-remote__-1fbb310b7169e9a__-portal",
    ]) {
      expect(isRetiredPortalPartitionDirName(name), name).toBe(false);
    }
  });

  it("wipes the Portal sessions whole and leaves every other partition as it was", async () => {
    const retired = ["portal", retiredPortalOf("studio"), retiredPortalOf(LONG_HOST)].map(
      seedFullPartition
    );
    const kept = [
      "daintree",
      "project-legacy",
      "browser",
      dirName(buildBrowserPartition("proj-1")),
      "browser-team-portal",
      browserOf("studio", "proj-1"),
      browserOf("studio", "-portal"),
      devPreviewOf("studio", "proj-1"),
      dirName(buildDevPreviewPartition("proj-1", "main", "panel-1")),
      "browser-remote__studio__-portalfoo",
      "plugin-foo",
    ].map(seedFullPartition);
    const renameSpy = vi.spyOn(fs, "renameSync");

    const result = await clearRetiredPortalPartitions();

    expect(result).toEqual({ cleared: retired.length, failed: 0 });
    for (const dir of retired) expect(fs.existsSync(dir)).toBe(false);
    for (const dir of kept) expectUntouched(dir);
    expect(renameSpy.mock.calls.map(([from]) => path.basename(String(from))).sort()).toEqual(
      retired.map((dir) => path.basename(dir)).sort()
    );
    expect(leftovers()).toEqual([]);
    expect(sessionMock.fromPartition).not.toHaveBeenCalled();
    expect(defaultSession.clearCache).not.toHaveBeenCalled();
  });

  it("finds nothing to do on the next launch", async () => {
    seedFullPartition("portal");
    const kept = seedFullPartition(browserOf("studio", "proj-1"));
    expect(await clearRetiredPortalPartitions()).toEqual({ cleared: 1, failed: 0 });
    const renameSpy = vi.spyOn(fs, "renameSync");
    const rmSpy = vi.spyOn(fs.promises, "rm");

    expect(await clearRetiredPortalPartitions()).toEqual({ cleared: 0, failed: 0 });
    expect(renameSpy).not.toHaveBeenCalled();
    expect(rmSpy).not.toHaveBeenCalled();
    expectUntouched(kept);
  });

  it("has nothing to do when no partition was ever made", async () => {
    await expect(clearRetiredPortalPartitions()).resolves.toEqual({ cleared: 0, failed: 0 });
  });

  it("reports a failed listing and leaves the rest of startup to carry on", async () => {
    fs.writeFileSync(partitionsRoot, "not a directory");

    await expect(clearRetiredPortalPartitions()).resolves.toEqual({ cleared: 0, failed: 1 });
  });

  it("leaves a Portal session it can't detach for the next launch, clearing the others", async () => {
    const stuck = seedFullPartition("portal");
    const other = seedFullPartition(retiredPortalOf("studio"));
    const realRename = fs.renameSync;
    const renameSpy = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (path.basename(String(from)) === "portal") {
        throw Object.assign(new Error("EBUSY: resource busy"), { code: "EBUSY" });
      }
      realRename(from, to);
    });

    expect(await clearRetiredPortalPartitions()).toEqual({ cleared: 1, failed: 1 });
    expectUntouched(stuck);
    expect(fs.existsSync(other)).toBe(false);

    renameSpy.mockRestore();
    expect(await clearRetiredPortalPartitions()).toEqual({ cleared: 1, failed: 0 });
    expect(fs.existsSync(stuck)).toBe(false);
  });

  it("finishes a detached Portal session it couldn't remove on the next launch", async () => {
    seedFullPartition("portal");
    vi.spyOn(fs.promises, "rm").mockRejectedValueOnce(
      Object.assign(new Error("EBUSY: resource busy"), { code: "EBUSY" })
    );

    expect(await clearRetiredPortalPartitions()).toEqual({ cleared: 0, failed: 1 });
    expect(leftovers()).toHaveLength(1);
    expect(leftovers()[0]).toMatch(/^portal\.daintree-clearing-[0-9a-f]{12}$/);
    const renameSpy = vi.spyOn(fs, "renameSync");

    expect(await clearRetiredPortalPartitions()).toEqual({ cleared: 1, failed: 0 });
    expect(fs.readdirSync(partitionsRoot)).toEqual([]);
    expect(renameSpy).not.toHaveBeenCalled();
  });

  it("removes a leftover in place, however many failed removals named it", async () => {
    const name = `portal${".daintree-clearing-0123456789ab".repeat(8)}`;
    seedFullPartition(name);
    const renameSpy = vi.spyOn(fs, "renameSync");

    expect(await clearRetiredPortalPartitions()).toEqual({ cleared: 1, failed: 0 });
    expect(renameSpy).not.toHaveBeenCalled();
    expect(fs.readdirSync(partitionsRoot)).toEqual([]);
  });

  it("removes what host removal detached from a Portal session, and nothing a host still uses", async () => {
    const detachedPortal = `${retiredPortalOf("studio")}.daintree-clearing-0123456789ab`;
    const detachedBrowser = `${browserOf("studio", "proj-1")}.daintree-clearing-0123456789ab`;
    seedFullPartition(detachedPortal);
    const browserLeftover = seedFullPartition(detachedBrowser);

    expect(await clearRetiredPortalPartitions()).toEqual({ cleared: 1, failed: 0 });
    expect(fs.readdirSync(partitionsRoot)).toEqual([detachedBrowser]);
    expectUntouched(browserLeftover);
  });

  it("never follows a symlinked Portal session to its target", async () => {
    const target = seedFullPartition("daintree");
    fs.symlinkSync(target, partitionDir("portal"), "dir");
    const renameSpy = vi.spyOn(fs, "renameSync");

    expect(await clearRetiredPortalPartitions()).toEqual({ cleared: 0, failed: 1 });
    expect(renameSpy).not.toHaveBeenCalled();
    expectUntouched(target);
  });

  it("clears an open Portal session through the Session API", async () => {
    const dir = seedFullPartition("portal");
    const live = { storagePath: dir, clearData: vi.fn(() => Promise.resolve()) };
    trackSession(live as unknown as Electron.Session);

    expect(await clearRetiredPortalPartitions()).toEqual({ cleared: 1, failed: 0 });
    // No options: every data type, the sign-in cookies included.
    expect(live.clearData).toHaveBeenCalledTimes(1);
    expect(live.clearData).toHaveBeenCalledWith();
    expect(fs.existsSync(dir)).toBe(true);
  });
});
