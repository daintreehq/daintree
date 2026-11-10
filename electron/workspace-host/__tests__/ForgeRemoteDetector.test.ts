import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import { resolve as pathResolve } from "path";
import {
  ForgeRemoteDetector,
  type ForgeRemoteDetectorHost,
  type ForgeRemoteMonitor,
} from "../ForgeRemoteDetector.js";

type Remote = { name: string; refs: { fetch: string; push: string } };
type ConfigStat = { ino: number; mtimeMs: number; ctimeMs: number; size: number };

const mocks = vi.hoisted(() => ({
  getRemotes: vi.fn<() => Promise<Remote[]>>(),
  createHardenedGit: vi.fn<(cwd: string) => Promise<unknown>>(),
  getGitCommonDir: vi.fn<(path: string) => Promise<string | null>>(),
  stat: vi.fn<(path: string) => Promise<ConfigStat>>(),
  existsSync: vi.fn<(path: string) => boolean>(),
}));

vi.mock("../../utils/hardenedGit.js", () => ({ createHardenedGit: mocks.createHardenedGit }));
vi.mock("../../utils/gitUtils.js", () => ({ getGitCommonDir: mocks.getGitCommonDir }));
vi.mock("fs/promises", () => ({ stat: mocks.stat }));
vi.mock("fs", () => ({ existsSync: mocks.existsSync }));

function remote(name: string, url: string): Remote {
  return { name, refs: { fetch: url, push: url } };
}

const ORIGIN = remote("origin", "https://github.com/acme/app.git");
const UPSTREAM = remote("upstream", "https://github.com/upstream/app.git");
const MIRROR = remote("mirror", "https://github.com/mirror/app.git");
const GITHUB = "daintree.github.github";
const DEBOUNCE_MS = 250;
// Apart from the project root, so a fingerprint taken from the wrong file reads
// as unreadable rather than as the real config.
const COMMON_DIR = "/common/.git";
const COMMON_CONFIG = pathResolve(COMMON_DIR, "config");

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

class FakeMonitor implements ForgeRemoteMonitor {
  isRunning = true;
  remoteFetchUrl: string | undefined = undefined;
  matchedForgeProviderId: string | null | undefined = undefined;
  urlWrites = 0;
  constructor(readonly id: string) {}
  setRemoteFetchUrl(url: string | undefined): void {
    this.urlWrites++;
    this.remoteFetchUrl = url;
  }
  setMatchedForgeProviderId(value: string | null): void {
    this.matchedForgeProviderId = value;
  }
}

describe("ForgeRemoteDetector", () => {
  let monitors: Map<string, FakeMonitor>;
  let host: {
    projectRootPath: string | null;
    gitBacked: boolean | null;
    backgrounded: boolean;
    shutDown: boolean;
  };
  let onRemotesChanged: Mock<() => void>;
  let detector: ForgeRemoteDetector;
  let configStat: ConfigStat;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    configStat = { ino: 1, mtimeMs: 1000, ctimeMs: 1000, size: 200 };
    mocks.getRemotes.mockResolvedValue([]);
    mocks.createHardenedGit.mockImplementation(async () => ({ getRemotes: mocks.getRemotes }));
    mocks.getGitCommonDir.mockImplementation(async (path) =>
      path === "/repo" ? COMMON_DIR : null
    );
    mocks.stat.mockImplementation(async (path) => {
      if (path === COMMON_CONFIG) return { ...configStat };
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
    mocks.existsSync.mockReturnValue(true);

    monitors = new Map();
    host = { projectRootPath: "/repo", gitBacked: true, backgrounded: false, shutDown: false };
    onRemotesChanged = vi.fn<() => void>();
    const detectorHost: ForgeRemoteDetectorHost = {
      getProjectRootPath: () => host.projectRootPath,
      getMonitor: (id) => monitors.get(id),
      getMonitors: () => monitors.values(),
      getGitBacked: () => host.gitBacked,
      isBackgrounded: () => host.backgrounded,
      isShutDown: () => host.shutDown,
      onRemotesChanged,
    };
    detector = new ForgeRemoteDetector(detectorHost);
    detector["providerMatchers"] = [{ providerId: GITHUB, hostnames: ["github.com"] }];
  });

  afterEach(() => {
    detector.stop();
    vi.useRealTimers();
  });

  function addMonitor(id: string): FakeMonitor {
    const monitor = new FakeMonitor(id);
    monitors.set(id, monitor);
    return monitor;
  }

  /** A real `git remote` mutation: git writes config lock-then-rename. */
  function touchConfig(): void {
    configStat = {
      ino: configStat.ino + 1,
      mtimeMs: configStat.mtimeMs + 1,
      ctimeMs: configStat.ctimeMs + 1,
      size: configStat.size + 1,
    };
  }

  function holdNextRead(): Deferred<Remote[]> {
    const read = deferred<Remote[]>();
    mocks.getRemotes.mockReturnValueOnce(read.promise);
    return read;
  }

  async function flush(): Promise<void> {
    await vi.advanceTimersByTimeAsync(0);
  }

  async function seed(remotes: Remote[]): Promise<void> {
    mocks.getRemotes.mockResolvedValue(remotes);
    detector.start();
    await flush();
    mocks.getRemotes.mockClear();
    mocks.createHardenedGit.mockClear();
  }

  async function configWritten(): Promise<void> {
    detector.scheduleReprobe({ observedConfigWrite: true });
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    await flush();
  }

  describe("baseline", () => {
    it("signals only when the remote table actually changed", async () => {
      const main = addMonitor("main");
      await seed([ORIGIN]);

      touchConfig();
      await configWritten();
      expect(mocks.getRemotes).toHaveBeenCalledTimes(1);
      expect(onRemotesChanged).not.toHaveBeenCalled();

      mocks.getRemotes.mockResolvedValue([ORIGIN, UPSTREAM]);
      touchConfig();
      await configWritten();
      expect(onRemotesChanged).toHaveBeenCalledTimes(1);
      // The URLs and the signature never cross to the host.
      expect(onRemotesChanged).toHaveBeenCalledWith();
      expect(main.remoteFetchUrl).toBe(ORIGIN.refs.fetch);
    });

    it("signals a renamed or repointed remote, but not a reordered table", async () => {
      await seed([ORIGIN, UPSTREAM]);
      mocks.getRemotes.mockResolvedValue([UPSTREAM, ORIGIN]);
      touchConfig();
      await configWritten();
      expect(onRemotesChanged).not.toHaveBeenCalled();

      mocks.getRemotes.mockResolvedValue([remote("fork", ORIGIN.refs.fetch), UPSTREAM]);
      touchConfig();
      await configWritten();
      expect(onRemotesChanged).toHaveBeenCalledTimes(1);

      mocks.getRemotes.mockResolvedValue([remote("fork", MIRROR.refs.fetch), UPSTREAM]);
      touchConfig();
      await configWritten();
      expect(onRemotesChanged).toHaveBeenCalledTimes(2);
    });

    it("discards a seed that spans an observed config write", async () => {
      const main = addMonitor("main");
      const seedRead = holdNextRead();
      detector.start();
      await flush();

      // The user's `git remote add` lands while the seed is still in git.
      detector.scheduleReprobe({ observedConfigWrite: true });
      seedRead.resolve([ORIGIN]);
      await flush();
      expect(detector["signature"]).toBeNull();

      mocks.getRemotes.mockResolvedValue([ORIGIN]);
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
      await flush();
      expect(onRemotesChanged).toHaveBeenCalledTimes(1);
      expect(main.remoteFetchUrl).toBe(ORIGIN.refs.fetch);
    });

    it("discards a seed whose config moved between its two stats", async () => {
      const seedRead = holdNextRead();
      detector.start();
      await flush();

      touchConfig();
      seedRead.resolve([ORIGIN]);
      await flush();

      expect(detector["signature"]).toBeNull();
      expect(detector["configFingerprint"]).toBeNull();
      // Not held as the table either: the next consumer reads afresh.
      expect(detector["remoteRead"]).toBeNull();
    });

    it("never lets a monitor's start read seed the baseline", async () => {
      const main = addMonitor("main");
      mocks.getRemotes.mockResolvedValue([ORIGIN]);
      await detector.probeMonitor(main);
      expect(main.remoteFetchUrl).toBe(ORIGIN.refs.fetch);
      expect(detector["signature"]).toBeNull();

      // The table it read may already contain the change; the reprobe must
      // still report it.
      detector.scheduleReprobe({ observedConfigWrite: false });
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
      await flush();
      expect(onRemotesChanged).toHaveBeenCalledTimes(1);
    });
  });

  describe("config fingerprint gate", () => {
    it("skips git while the config file is unchanged", async () => {
      await seed([]);
      await configWritten();
      await configWritten();
      expect(mocks.getRemotes).not.toHaveBeenCalled();
    });

    it("reads git when only the inode moved", async () => {
      await seed([]);
      configStat = { ...configStat, ino: configStat.ino + 1 };
      await configWritten();
      expect(mocks.getRemotes).toHaveBeenCalledTimes(1);
    });

    it("fails open when the config can't be stat'd", async () => {
      await seed([]);
      mocks.stat.mockRejectedValue(new Error("EACCES"));
      await configWritten();
      await configWritten();
      expect(mocks.getRemotes).toHaveBeenCalledTimes(2);
    });

    it("leaves the fingerprint unconsumed when the git read fails", async () => {
      const main = addMonitor("main");
      await seed([]);
      touchConfig();
      mocks.getRemotes.mockRejectedValueOnce(new Error("git spawn failed"));
      await configWritten();
      expect(onRemotesChanged).not.toHaveBeenCalled();

      // Same config, so only an unconsumed fingerprint lets this tick read.
      mocks.getRemotes.mockResolvedValue([ORIGIN]);
      detector.scheduleReprobe({ observedConfigWrite: false });
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
      await flush();
      expect(onRemotesChanged).toHaveBeenCalledTimes(1);
      expect(main.remoteFetchUrl).toBe(ORIGIN.refs.fetch);
    });
  });

  describe("shared remote table", () => {
    it("serves every monitor of a load, and a later one, from the seed's read", async () => {
      const seedRead = holdNextRead();
      detector.start();
      const probes = ["main", "feature-1", "feature-2"].map((id) =>
        detector.probeMonitor(addMonitor(id))
      );
      seedRead.resolve([ORIGIN]);
      await Promise.all(probes);
      const late = addMonitor("late");
      await detector.probeMonitor(late);

      expect(mocks.getRemotes).toHaveBeenCalledTimes(1);
      for (const monitor of monitors.values()) {
        expect(monitor.remoteFetchUrl).toBe(ORIGIN.refs.fetch);
        expect(monitor.matchedForgeProviderId).toBe(GITHUB);
      }
    });

    it("a start read displaced by a reprobe cannot overwrite the reprobe's fan-out", async () => {
      const main = addMonitor("main");
      const startRead = holdNextRead();
      const probe = detector.probeMonitor(main);

      mocks.getRemotes.mockResolvedValue([ORIGIN]);
      touchConfig();
      await configWritten();
      expect(main.remoteFetchUrl).toBe(ORIGIN.refs.fetch);

      startRead.resolve([]);
      await probe;
      expect(main.remoteFetchUrl).toBe(ORIGIN.refs.fetch);
    });

    it("a failed older read cannot clear the table a newer reprobe holds", async () => {
      const main = addMonitor("main");
      const startRead = holdNextRead();
      const probe = detector.probeMonitor(main);

      mocks.getRemotes.mockResolvedValue([ORIGIN]);
      touchConfig();
      await configWritten();
      const held = detector["remoteRead"];
      const reads = mocks.getRemotes.mock.calls.length;
      startRead.reject(new Error("git spawn failed"));
      await probe;
      expect(detector["remoteRead"]).toBe(held);
      expect(mocks.getRemotes).toHaveBeenCalledTimes(reads);
      mocks.getRemotes.mockClear();

      const late = addMonitor("late");
      await detector.probeMonitor(late);
      expect(mocks.getRemotes).not.toHaveBeenCalled();
      expect(late.remoteFetchUrl).toBe(ORIGIN.refs.fetch);
    });

    it("does not apply a read to a monitor that was replaced while it waited", async () => {
      const stale = addMonitor("main");
      const startRead = holdNextRead();
      const probe = detector.probeMonitor(stale);

      addMonitor("main");
      startRead.resolve([ORIGIN]);
      await probe;

      expect(stale.urlWrites).toBe(0);
    });

    it("reads at the project root, then the listed main worktree once the root is gone", async () => {
      detector.setMainWorktreePath("/main");
      await detector.probeMonitor(addMonitor("a"));
      expect(mocks.createHardenedGit).toHaveBeenLastCalledWith("/repo");

      detector["remoteRead"] = null;
      mocks.existsSync.mockReturnValue(false);
      await detector.probeMonitor(addMonitor("b"));
      expect(mocks.createHardenedGit).toHaveBeenLastCalledWith("/main");
    });
  });

  describe("reselect", () => {
    it("re-selects from the held table without re-reading git or signalling", async () => {
      const main = addMonitor("main");
      await seed([ORIGIN, MIRROR]);
      await detector.probeMonitor(main);
      expect(main.remoteFetchUrl).toBe(ORIGIN.refs.fetch);

      detector.updateRemoteName("mirror");
      await flush();

      expect(main.remoteFetchUrl).toBe(MIRROR.refs.fetch);
      expect(mocks.getRemotes).not.toHaveBeenCalled();
      expect(onRemotesChanged).not.toHaveBeenCalled();
    });

    it("re-matches remembered URLs at once and re-selects once per matcher burst", async () => {
      const main = addMonitor("main");
      main.remoteFetchUrl = ORIGIN.refs.fetch;
      mocks.getRemotes.mockResolvedValue([ORIGIN]);
      for (let i = 0; i < 4; i++) {
        detector.setProviderMatchers([{ providerId: "other", hostnames: ["github.com"] }]);
      }
      expect(main.matchedForgeProviderId).toBe("other");
      expect(vi.getTimerCount()).toBe(1);

      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
      await flush();
      expect(mocks.getRemotes).toHaveBeenCalledTimes(1);
      expect(main.urlWrites).toBe(1);
    });

    it("never bumps the config probe sequence, so an in-flight reprobe still lands", async () => {
      const main = addMonitor("main");
      await seed([]);
      touchConfig();
      const reprobeRead = holdNextRead();
      detector.scheduleReprobe({ observedConfigWrite: true });
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
      await flush();

      const probeSeq = detector["probeSeq"];
      detector.updateRemoteName("upstream");
      expect(detector["probeSeq"]).toBe(probeSeq);

      reprobeRead.resolve([ORIGIN, UPSTREAM]);
      await flush();
      expect(onRemotesChanged).toHaveBeenCalledTimes(1);
      expect(main.remoteFetchUrl).toBe(UPSTREAM.refs.fetch);
      expect(mocks.getRemotes).toHaveBeenCalledTimes(1);
    });

    it("drops an older reselect when a newer one lands", async () => {
      const main = addMonitor("main");
      const read = holdNextRead();
      detector.updateRemoteName("upstream");
      detector.updateRemoteName("mirror");
      read.resolve([ORIGIN, UPSTREAM, MIRROR]);
      await flush();

      expect(main.remoteFetchUrl).toBe(MIRROR.refs.fetch);
      expect(main.urlWrites).toBe(1);
    });

    it("re-arms a failed reselect at most three times", async () => {
      addMonitor("main");
      mocks.getRemotes.mockRejectedValue(new Error("not a git repository"));
      detector.updateRemoteName("upstream");
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 10);
      await flush();

      expect(mocks.getRemotes).toHaveBeenCalledTimes(4);
    });

    it("spawns no git for a folder without a repository", async () => {
      host.gitBacked = false;
      addMonitor("main");
      detector.setProviderMatchers([{ providerId: GITHUB, hostnames: ["github.com"] }]);
      detector.updateRemoteName("upstream");
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 10);
      await flush();

      expect(mocks.createHardenedGit).not.toHaveBeenCalled();
    });
  });

  describe("stop", () => {
    it("drops a seed that lands after it", async () => {
      const seedRead = holdNextRead();
      detector.start();
      await flush();
      detector.stop();
      seedRead.resolve([ORIGIN]);
      await flush();

      expect(detector["signature"]).toBeNull();
      expect(detector["configFingerprint"]).toBeNull();
      expect(detector["remoteRead"]).toBeNull();
    });

    it("drops a reprobe that lands after it", async () => {
      const main = addMonitor("main");
      await seed([]);
      touchConfig();
      const reprobeRead = holdNextRead();
      await configWritten();

      detector.stop();
      reprobeRead.resolve([ORIGIN]);
      await flush();

      expect(onRemotesChanged).not.toHaveBeenCalled();
      expect(main.urlWrites).toBe(0);
    });

    it("ends an in-flight reselect without a retry against the next project", async () => {
      addMonitor("main");
      const read = holdNextRead();
      detector.updateRemoteName("upstream");
      detector.stop();
      read.reject(new Error("git spawn failed"));
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 10);
      await flush();

      expect(mocks.getRemotes).toHaveBeenCalledTimes(1);
    });

    it("cancels pending reprobe and reselect timers", async () => {
      await seed([]);
      touchConfig();
      detector.scheduleReprobe({ observedConfigWrite: true });
      detector.setProviderMatchers([]);
      detector.stop();
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 4);

      expect(mocks.createHardenedGit).not.toHaveBeenCalled();
    });
  });

  describe("backstop and resume", () => {
    const POLL_MS = 5 * 60 * 1000;

    function configStats(): number {
      return mocks.stat.mock.calls.filter(([p]) => p === COMMON_CONFIG).length;
    }

    it("is not armed by a start while backgrounded, nor kept through a pause", async () => {
      host.backgrounded = true;
      await seed([]);
      mocks.stat.mockClear();
      await vi.advanceTimersByTimeAsync(POLL_MS * 3);
      expect(configStats()).toBe(0);

      host.backgrounded = false;
      detector.stop();
      await seed([]);
      detector.pause();
      mocks.stat.mockClear();
      await vi.advanceTimersByTimeAsync(POLL_MS * 3);
      expect(configStats()).toBe(0);
    });

    it("re-arms exactly one backstop on resume", async () => {
      await seed([]);
      detector.pause();
      await detector.resume();
      await detector.resume();
      expect(vi.getTimerCount()).toBe(1);
      mocks.stat.mockClear();

      await vi.advanceTimersByTimeAsync(POLL_MS + DEBOUNCE_MS);
      await flush();
      expect(configStats()).toBe(1);

      detector.pause();
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(POLL_MS * 2);
      expect(configStats()).toBe(1);
    });

    it("has nothing to settle when detection isn't running", async () => {
      expect(detector.resume()).toBeNull();
      await seed([]);
      expect(detector.resume()).not.toBeNull();
      detector.stop();
      expect(detector.resume()).toBeNull();
    });

    it("waits for a watcher reprobe that supersedes the resume probe", async () => {
      await seed([]);
      detector.pause();
      const releases: Array<() => void> = [];
      mocks.stat.mockImplementation(
        (p) =>
          new Promise<ConfigStat>((resolve) => {
            if (p === COMMON_CONFIG) releases.push(() => resolve({ ...configStat }));
          })
      );

      let settled = false;
      void detector.resume()!.then(() => {
        settled = true;
      });
      await flush();
      await configWritten();
      expect(releases).toHaveLength(2);

      releases[0]();
      await flush();
      expect(settled).toBe(false);

      releases[1]();
      await flush();
      expect(settled).toBe(true);
    });

    it("gives up after the deadline when the config stat hangs", async () => {
      await seed([]);
      detector.pause();
      mocks.stat.mockImplementation(() => new Promise<ConfigStat>(() => {}));

      let settled = false;
      void detector.resume()!.then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(4_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBe(true);
    });
  });
});
