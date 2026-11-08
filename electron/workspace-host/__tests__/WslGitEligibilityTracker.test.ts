import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { Worktree } from "../../../shared/types/worktree.js";
import {
  WslGitEligibilityTracker,
  type WslGitEligibilityHost,
  type WslTrackedMonitor,
} from "../WslGitEligibilityTracker.js";

const { detectWslPathMock, getDefaultWslDistroMock } = vi.hoisted(() => ({
  detectWslPathMock: vi.fn(),
  getDefaultWslDistroMock: vi.fn(),
}));
vi.mock("../../utils/wsl.js", () => ({
  detectWslPath: detectWslPathMock,
  getDefaultWslDistro: getDefaultWslDistroMock,
}));

const POLL_MS = 60_000;

interface StubMonitor extends WslTrackedMonitor {
  setWslEligible: Mock<WslTrackedMonitor["setWslEligible"]>;
  setWslOptIn: Mock<WslTrackedMonitor["setWslOptIn"]>;
}

function stubMonitor(isWslPath: boolean, wslDistro: string | undefined): StubMonitor {
  return {
    isWslPath,
    wslDistro,
    setWslEligible: vi.fn<WslTrackedMonitor["setWslEligible"]>(),
    setWslOptIn: vi.fn<WslTrackedMonitor["setWslOptIn"]>(),
  };
}

function worktree(id: string): Worktree {
  return { id, path: id, name: id, isCurrent: false };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("WslGitEligibilityTracker", () => {
  const originalPlatform = process.platform;
  let monitors: Map<string, StubMonitor>;
  let events: Array<{ type: "clear-wsl-git-opt-in"; worktreeId: string }>;
  let host: WslGitEligibilityHost & { backgrounded: boolean };
  let tracker: WslGitEligibilityTracker;

  function setPlatform(platform: NodeJS.Platform): void {
    Object.defineProperty(process, "platform", { value: platform, configurable: true });
  }

  function clearedIds(): string[] {
    return events.map((e) => e.worktreeId);
  }

  function seedMonitors(): { ubuntu: StubMonitor; debian: StubMonitor; nonWsl: StubMonitor } {
    const ubuntu = stubMonitor(true, "Ubuntu");
    const debian = stubMonitor(true, "Debian");
    const nonWsl = stubMonitor(false, undefined);
    monitors.set("ubuntu-wt", ubuntu);
    monitors.set("debian-wt", debian);
    monitors.set("local-wt", nonWsl);
    return { ubuntu, debian, nonWsl };
  }

  /** The opt-in a later enrichment of `id` would carry, read without changing it. */
  async function storedOptIn(id: string): Promise<{ enabled: boolean; dismissed: boolean }> {
    detectWslPathMock.mockReturnValue({ distro: "Ubuntu", posixPath: "/" });
    getDefaultWslDistroMock.mockResolvedValue("Ubuntu");
    const enriched = await tracker.enrichWorktree(worktree(id));
    return { enabled: Boolean(enriched.wslGitOptIn), dismissed: Boolean(enriched.wslGitDismissed) };
  }

  /** Paths under `\\wsl$\<distro>\` read as WSL mounts; anything else does not. */
  function detectFromUncPath(): void {
    detectWslPathMock.mockImplementation((p: string) => {
      const match = /^\\\\wsl\$\\([^\\]+)(\\.*)?$/.exec(p);
      if (!match) return null;
      return { distro: match[1], posixPath: (match[2] ?? "/").replace(/\\/g, "/") };
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    detectWslPathMock.mockReset().mockReturnValue(null);
    getDefaultWslDistroMock.mockReset();
    setPlatform("win32");
    monitors = new Map();
    events = [];
    host = {
      backgrounded: false,
      monitors,
      sendEvent: (event) => events.push(event),
    };
    tracker = new WslGitEligibilityTracker(host);
  });

  afterEach(() => {
    tracker.stop();
    setPlatform(originalPlatform);
    vi.useRealTimers();
  });

  describe("enrichWorktree", () => {
    it("leaves worktrees untouched off Windows without probing", async () => {
      setPlatform("linux");
      detectFromUncPath();
      const wt = worktree("\\\\wsl$\\Ubuntu\\home\\me\\repo");

      expect(await tracker.enrichWorktree(wt)).toBe(wt);
      expect(detectWslPathMock).not.toHaveBeenCalled();
      expect(getDefaultWslDistroMock).not.toHaveBeenCalled();
    });

    it("leaves a non-WSL Windows path untouched without probing", async () => {
      detectFromUncPath();
      const wt = worktree("C:\\repo");

      expect(await tracker.enrichWorktree(wt)).toBe(wt);
      expect(getDefaultWslDistroMock).not.toHaveBeenCalled();
    });

    it("attaches detection, eligibility and the persisted opt-in for a WSL path", async () => {
      detectFromUncPath();
      getDefaultWslDistroMock.mockResolvedValue("ubuntu");
      const id = "\\\\wsl$\\Ubuntu\\home\\me\\repo";
      tracker.mergePersistedOptIns({ [id]: { enabled: true, dismissed: true } });

      const enriched = await tracker.enrichWorktree(worktree(id));

      expect(enriched).toMatchObject({
        id,
        isWslPath: true,
        wslDistro: "Ubuntu",
        wslPosixPath: "/home/me/repo",
        // The probe returns a different case; UNC distro names compare case-insensitively.
        wslGitEligible: "eligible",
        wslGitOptIn: true,
        wslGitDismissed: true,
      });
    });

    it("marks a worktree on a non-default distro ineligible with no opt-in", async () => {
      detectFromUncPath();
      getDefaultWslDistroMock.mockResolvedValue("Debian");

      const enriched = await tracker.enrichWorktree(worktree("\\\\wsl$\\Ubuntu\\repo"));

      expect(enriched.wslGitEligible).toBe("ineligible");
      expect(enriched.wslGitOptIn).toBe(false);
      expect(enriched.wslGitDismissed).toBe(false);
    });

    it("maps a failed probe to 'unprobed', not 'ineligible'", async () => {
      detectFromUncPath();
      getDefaultWslDistroMock.mockRejectedValue(new Error("wsl.exe missing"));

      const enriched = await tracker.enrichWorktree(worktree("\\\\wsl$\\Ubuntu\\repo"));

      expect(enriched.wslGitEligible).toBe("unprobed");
    });

    it("probes the default distro once and shares it across worktrees", async () => {
      detectFromUncPath();
      getDefaultWslDistroMock.mockResolvedValue("Ubuntu");

      const [a, b] = await Promise.all([
        tracker.enrichWorktree(worktree("\\\\wsl$\\Ubuntu\\a")),
        tracker.enrichWorktree(worktree("\\\\wsl$\\Debian\\b")),
      ]);

      expect(getDefaultWslDistroMock).toHaveBeenCalledTimes(1);
      expect(a.wslGitEligible).toBe("eligible");
      expect(b.wslGitEligible).toBe("ineligible");
    });

    it("probes afresh after a project switch", async () => {
      detectFromUncPath();
      getDefaultWslDistroMock.mockResolvedValueOnce("Ubuntu").mockResolvedValueOnce("Debian");

      await tracker.enrichWorktree(worktree("\\\\wsl$\\Ubuntu\\a"));
      tracker.resetForProjectSwitch();
      const next = await tracker.enrichWorktree(worktree("\\\\wsl$\\Ubuntu\\a"));

      expect(getDefaultWslDistroMock).toHaveBeenCalledTimes(2);
      expect(next.wslGitEligible).toBe("ineligible");
    });
  });

  describe("default-distro poll", () => {
    it("never arms for a host that has seen no WSL worktree", async () => {
      vi.useFakeTimers();
      detectFromUncPath();
      await tracker.enrichWorktree(worktree("C:\\repo"));

      await vi.advanceTimersByTimeAsync(10 * POLL_MS);

      expect(getDefaultWslDistroMock).not.toHaveBeenCalled();
    });

    it("arms after the first WSL worktree and refreshes monitors only on a change", async () => {
      vi.useFakeTimers();
      detectFromUncPath();
      const { ubuntu, debian, nonWsl } = seedMonitors();
      getDefaultWslDistroMock.mockResolvedValue("Ubuntu");
      await tracker.enrichWorktree(worktree("\\\\wsl$\\Ubuntu\\a"));
      expect(getDefaultWslDistroMock).toHaveBeenCalledTimes(1);

      // Same distro: the seeded baseline suppresses a refresh.
      await vi.advanceTimersByTimeAsync(POLL_MS);
      expect(getDefaultWslDistroMock).toHaveBeenCalledTimes(2);
      expect(ubuntu.setWslEligible).not.toHaveBeenCalled();
      expect(debian.setWslEligible).not.toHaveBeenCalled();

      getDefaultWslDistroMock.mockResolvedValue("Debian");
      await vi.advanceTimersByTimeAsync(POLL_MS);
      expect(ubuntu.setWslEligible).toHaveBeenLastCalledWith("ineligible");
      expect(debian.setWslEligible).toHaveBeenLastCalledWith("eligible");
      expect(nonWsl.setWslEligible).not.toHaveBeenCalled();

      // The change became the new baseline: the same answer again refreshes nothing.
      ubuntu.setWslEligible.mockClear();
      debian.setWslEligible.mockClear();
      await vi.advanceTimersByTimeAsync(POLL_MS);
      expect(ubuntu.setWslEligible).not.toHaveBeenCalled();
      expect(debian.setWslEligible).not.toHaveBeenCalled();
    });

    it("updates the cached distro a later enrichment reads after a poll change", async () => {
      vi.useFakeTimers();
      detectFromUncPath();
      getDefaultWslDistroMock.mockResolvedValue("Ubuntu");
      await tracker.enrichWorktree(worktree("\\\\wsl$\\Ubuntu\\a"));

      getDefaultWslDistroMock.mockResolvedValue("Debian");
      await vi.advanceTimersByTimeAsync(POLL_MS);
      getDefaultWslDistroMock.mockClear();
      const later = await tracker.enrichWorktree(worktree("\\\\wsl$\\Debian\\b"));

      expect(getDefaultWslDistroMock).not.toHaveBeenCalled();
      expect(later.wslGitEligible).toBe("eligible");
    });

    it("stops while paused and restarts on resume", async () => {
      vi.useFakeTimers();
      detectFromUncPath();
      getDefaultWslDistroMock.mockResolvedValue("Ubuntu");
      await tracker.enrichWorktree(worktree("\\\\wsl$\\Ubuntu\\a"));

      tracker.pause();
      getDefaultWslDistroMock.mockClear();
      await vi.advanceTimersByTimeAsync(10 * POLL_MS);
      expect(getDefaultWslDistroMock).not.toHaveBeenCalled();

      tracker.resume();
      await vi.advanceTimersByTimeAsync(POLL_MS);
      expect(getDefaultWslDistroMock).toHaveBeenCalledTimes(1);
    });

    it("a repeated pause keeps the poll suspended for resume", async () => {
      vi.useFakeTimers();
      detectFromUncPath();
      getDefaultWslDistroMock.mockResolvedValue("Ubuntu");
      await tracker.enrichWorktree(worktree("\\\\wsl$\\Ubuntu\\a"));

      tracker.pause();
      tracker.pause();
      getDefaultWslDistroMock.mockClear();
      await vi.advanceTimersByTimeAsync(10 * POLL_MS);
      expect(getDefaultWslDistroMock).not.toHaveBeenCalled();

      tracker.resume();
      await vi.advanceTimersByTimeAsync(POLL_MS);
      expect(getDefaultWslDistroMock).toHaveBeenCalledTimes(1);
    });

    it("a project switch stops the poll", async () => {
      vi.useFakeTimers();
      detectFromUncPath();
      getDefaultWslDistroMock.mockResolvedValue("Ubuntu");
      await tracker.enrichWorktree(worktree("\\\\wsl$\\Ubuntu\\a"));

      tracker.resetForProjectSwitch();
      getDefaultWslDistroMock.mockClear();
      await vi.advanceTimersByTimeAsync(10 * POLL_MS);

      expect(getDefaultWslDistroMock).not.toHaveBeenCalled();
    });

    it("a pause with no running poll leaves resume with nothing to arm", async () => {
      vi.useFakeTimers();
      tracker.pause();
      tracker.resume();

      await vi.advanceTimersByTimeAsync(10 * POLL_MS);

      expect(getDefaultWslDistroMock).not.toHaveBeenCalled();
    });

    it("a first WSL enrichment landing while backgrounded arms the poll on resume", async () => {
      vi.useFakeTimers();
      detectFromUncPath();
      getDefaultWslDistroMock.mockResolvedValue("Ubuntu");
      host.backgrounded = true;
      tracker.pause();

      await tracker.enrichWorktree(worktree("\\\\wsl$\\Ubuntu\\a"));
      getDefaultWslDistroMock.mockClear();
      await vi.advanceTimersByTimeAsync(10 * POLL_MS);
      expect(getDefaultWslDistroMock).not.toHaveBeenCalled();

      host.backgrounded = false;
      tracker.resume();
      await vi.advanceTimersByTimeAsync(POLL_MS);
      expect(getDefaultWslDistroMock).toHaveBeenCalledTimes(1);
    });

    it("an unload while backgrounded does not revive the poll on resume", async () => {
      vi.useFakeTimers();
      detectFromUncPath();
      getDefaultWslDistroMock.mockResolvedValue("Ubuntu");
      await tracker.enrichWorktree(worktree("\\\\wsl$\\Ubuntu\\a"));
      tracker.pause();
      tracker.stop();

      tracker.resume();
      getDefaultWslDistroMock.mockClear();
      await vi.advanceTimersByTimeAsync(10 * POLL_MS);
      expect(getDefaultWslDistroMock).not.toHaveBeenCalled();
    });

    it("never arms off Windows", async () => {
      vi.useFakeTimers();
      detectFromUncPath();
      getDefaultWslDistroMock.mockResolvedValue("Ubuntu");
      // Enrich on win32 so the cache exists, then flip the platform: resume
      // must not arm a Windows-only poll.
      host.backgrounded = true;
      await tracker.enrichWorktree(worktree("\\\\wsl$\\Ubuntu\\a"));
      setPlatform("darwin");
      host.backgrounded = false;
      tracker.resume();
      getDefaultWslDistroMock.mockClear();

      await vi.advanceTimersByTimeAsync(10 * POLL_MS);

      expect(getDefaultWslDistroMock).not.toHaveBeenCalled();
    });
  });

  describe("reprobe", () => {
    it("refreshes every WSL monitor against the fresh default distro", async () => {
      const { ubuntu, debian, nonWsl } = seedMonitors();
      getDefaultWslDistroMock.mockResolvedValue("Debian");

      await tracker.reprobe("ubuntu-wt");

      // Target monitor first shows the pending state, then its final verdict.
      expect(ubuntu.setWslEligible).toHaveBeenCalledWith("unprobed");
      expect(ubuntu.setWslEligible).toHaveBeenLastCalledWith("ineligible");
      expect(debian.setWslEligible).toHaveBeenLastCalledWith("eligible");
      expect(nonWsl.setWslEligible).not.toHaveBeenCalled();
    });

    it("maps a failed probe (null default) to 'unprobed', not 'ineligible'", async () => {
      const { ubuntu, debian } = seedMonitors();
      getDefaultWslDistroMock.mockResolvedValue(null);

      await tracker.reprobe("ubuntu-wt");

      expect(ubuntu.setWslEligible).toHaveBeenLastCalledWith("unprobed");
      expect(debian.setWslEligible).toHaveBeenLastCalledWith("unprobed");
    });

    it("is a no-op for an unknown or non-WSL worktree", async () => {
      const { nonWsl } = seedMonitors();
      getDefaultWslDistroMock.mockResolvedValue("Ubuntu");

      await tracker.reprobe("local-wt");
      await tracker.reprobe("does-not-exist");

      expect(nonWsl.setWslEligible).not.toHaveBeenCalled();
      expect(getDefaultWslDistroMock).not.toHaveBeenCalled();
    });

    it("is a no-op off Windows", async () => {
      const { ubuntu } = seedMonitors();
      setPlatform("linux");

      await tracker.reprobe("ubuntu-wt");

      expect(ubuntu.setWslEligible).not.toHaveBeenCalled();
      expect(getDefaultWslDistroMock).not.toHaveBeenCalled();
    });

    it("discards an in-flight reprobe when the tracker is stopped (project switch)", async () => {
      const { ubuntu, debian } = seedMonitors();
      const probe = deferred<string | null>();
      getDefaultWslDistroMock.mockReturnValue(probe.promise);

      const pending = tracker.reprobe("ubuntu-wt");
      // Target shows the pending state synchronously, before the probe resolves.
      expect(ubuntu.setWslEligible).toHaveBeenCalledWith("unprobed");
      ubuntu.setWslEligible.mockClear();

      tracker.stop();
      probe.resolve("Debian");
      await pending;

      expect(ubuntu.setWslEligible).not.toHaveBeenCalled();
      expect(debian.setWslEligible).not.toHaveBeenCalled();
    });

    it("an older reprobe resolving last is discarded in favour of the newer one", async () => {
      const { ubuntu, debian } = seedMonitors();
      const older = deferred<string | null>();
      const newer = deferred<string | null>();
      getDefaultWslDistroMock.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);

      const first = tracker.reprobe("ubuntu-wt");
      const second = tracker.reprobe("debian-wt");
      newer.resolve("Debian");
      await second;
      ubuntu.setWslEligible.mockClear();
      debian.setWslEligible.mockClear();

      older.resolve("Ubuntu");
      await first;

      expect(ubuntu.setWslEligible).not.toHaveBeenCalled();
      expect(debian.setWslEligible).not.toHaveBeenCalled();
    });

    it("a superseded poll never overwrites a newer reprobe's result", async () => {
      vi.useFakeTimers();
      detectFromUncPath();
      const { ubuntu } = seedMonitors();
      getDefaultWslDistroMock.mockResolvedValueOnce("Debian");
      await tracker.enrichWorktree(worktree("\\\\wsl$\\Ubuntu\\a"));

      // A slow poll tick is held open and will return a stale value.
      const slowPoll = deferred<string | null>();
      getDefaultWslDistroMock.mockReturnValueOnce(slowPoll.promise);
      await vi.advanceTimersByTimeAsync(POLL_MS);

      // A reprobe started afterwards resolves first with the fresh value.
      getDefaultWslDistroMock.mockResolvedValueOnce("Debian");
      await tracker.reprobe("ubuntu-wt");
      expect(ubuntu.setWslEligible).toHaveBeenLastCalledWith("ineligible");

      ubuntu.setWslEligible.mockClear();
      slowPoll.resolve("Ubuntu");
      await vi.advanceTimersByTimeAsync(0);
      expect(ubuntu.setWslEligible).not.toHaveBeenCalled();

      // The baseline is still the reprobe's: the next tick seeing Debian is no change.
      getDefaultWslDistroMock.mockResolvedValueOnce("Debian");
      await vi.advanceTimersByTimeAsync(POLL_MS);
      expect(ubuntu.setWslEligible).not.toHaveBeenCalled();

      // The cache still holds the reprobe's answer, not the stale poll's.
      const later = await tracker.enrichWorktree(worktree("\\\\wsl$\\Debian\\b"));
      expect(later.wslGitEligible).toBe("eligible");
    });
  });

  describe("opt-in state", () => {
    it("setOptIn forwards to the monitor and is read by a later enrichment", async () => {
      detectFromUncPath();
      getDefaultWslDistroMock.mockResolvedValue("Ubuntu");
      const id = "\\\\wsl$\\Ubuntu\\repo";
      const monitor = stubMonitor(true, "Ubuntu");
      monitors.set(id, monitor);

      tracker.setOptIn(id, true, false);
      expect(monitor.setWslOptIn).toHaveBeenLastCalledWith(true, false);
      tracker.setOptIn(id, false, true);
      expect(monitor.setWslOptIn).toHaveBeenLastCalledWith(false, true);
      tracker.setOptIn("no-monitor-yet", true, true);

      expect(await storedOptIn(id)).toEqual({ enabled: false, dismissed: true });
      expect(await storedOptIn("no-monitor-yet")).toEqual({ enabled: true, dismissed: true });
    });

    it("lets an in-memory toggle win over the persisted map merged later", async () => {
      detectFromUncPath();
      getDefaultWslDistroMock.mockResolvedValue("Ubuntu");
      const id = "\\\\wsl$\\Ubuntu\\repo";

      tracker.setOptIn(id, false, true);
      tracker.mergePersistedOptIns({ [id]: { enabled: true, dismissed: false } });

      const enriched = await tracker.enrichWorktree(worktree(id));
      expect(enriched.wslGitOptIn).toBe(false);
      expect(enriched.wslGitDismissed).toBe(true);
    });

    it("a worktree recreated at a forgotten path starts without the old opt-in", async () => {
      detectFromUncPath();
      getDefaultWslDistroMock.mockResolvedValue("Ubuntu");
      const id = "\\\\wsl$\\Ubuntu\\repo";
      tracker.setOptIn(id, true, true);

      tracker.forgetWorktree(id);
      const recreated = await tracker.enrichWorktree(worktree(id));

      expect(recreated.wslGitOptIn).toBe(false);
      expect(recreated.wslGitDismissed).toBe(false);
    });

    it("forgetWorktree clears a known entry once and ignores unknown ids", () => {
      tracker.setOptIn("wt", true, false);

      tracker.forgetWorktree("wt");
      tracker.forgetWorktree("wt");
      tracker.forgetWorktree("never-seen");

      expect(clearedIds()).toEqual(["wt"]);
    });
  });

  describe("pruneStale", () => {
    // The persisted map is one global electron-store record, so a prune scoped
    // only by the live set would erase other projects' valid opt-ins on every
    // load, prewarm or host restart.
    const liveKey = "/test/root/.worktrees/live";

    it("keeps live keys and keys belonging to other projects", async () => {
      tracker.mergePersistedOptIns({
        [liveKey]: { enabled: true, dismissed: false },
        "/other-projects/repo/wt": { enabled: false, dismissed: true },
      });

      tracker.pruneStale([worktree(liveKey)], "/test/root");

      expect(clearedIds()).toEqual([]);
      expect(await storedOptIn(liveKey)).toEqual({ enabled: true, dismissed: false });
      expect(await storedOptIn("/other-projects/repo/wt")).toEqual({
        enabled: false,
        dismissed: true,
      });
    });

    it("clears stale keys at or under the project's parent directory", async () => {
      tracker.mergePersistedOptIns({
        [liveKey]: { enabled: true, dismissed: false },
        "/test/root/.worktrees/old-feature": { enabled: true, dismissed: false },
        "/test/sibling-worktree": { enabled: true, dismissed: false },
        "/test/root": { enabled: true, dismissed: false },
      });

      tracker.pruneStale([worktree(liveKey)], "/test/root");

      expect(await storedOptIn(liveKey)).toEqual({ enabled: true, dismissed: false });
      expect(clearedIds().sort()).toEqual(
        ["/test/root", "/test/root/.worktrees/old-feature", "/test/sibling-worktree"].sort()
      );
      // Pruned entries are gone from the mirror: a second prune sends nothing.
      events = [];
      tracker.pruneStale([worktree(liveKey)], "/test/root");
      expect(clearedIds()).toEqual([]);
    });

    it("does not treat a name-prefix sibling of the parent as inside it", () => {
      tracker.mergePersistedOptIns({
        "/testing/wt": { enabled: true, dismissed: false },
        "/test/": { enabled: true, dismissed: false },
      });

      tracker.pruneStale([], "/test/root");

      // "/testing" only shares a string prefix with "/test"; "/test/" is the parent itself.
      expect(clearedIds()).toEqual(["/test/"]);
    });

    it("handles Windows-style keys without relying on the host OS separator", async () => {
      const winLive = "C:\\test\\root";
      const winStale = "C:\\test\\root\\.worktrees\\old-feature";
      const winForeign = "D:\\other-projects\\repo\\wt";
      tracker.mergePersistedOptIns({
        [winLive]: { enabled: true, dismissed: false },
        [winStale]: { enabled: true, dismissed: false },
        [winForeign]: { enabled: false, dismissed: true },
      });

      tracker.pruneStale([worktree(winLive)], winLive);

      expect(clearedIds()).toEqual([winStale]);
      expect(await storedOptIn(winLive)).toEqual({ enabled: true, dismissed: false });
      expect(await storedOptIn(winForeign)).toEqual({ enabled: false, dismissed: true });
    });

    it("matches Windows keys case-insensitively on win32", () => {
      tracker.mergePersistedOptIns({
        "c:\\TEST\\root\\.worktrees\\old": { enabled: true, dismissed: false },
      });

      tracker.pruneStale([], "C:\\test\\root");

      expect(clearedIds()).toEqual(["c:\\TEST\\root\\.worktrees\\old"]);
    });

    it("clears every non-live key when no project root is known", () => {
      tracker.mergePersistedOptIns({
        [liveKey]: { enabled: true, dismissed: false },
        "/anywhere/else": { enabled: true, dismissed: false },
      });

      tracker.pruneStale([worktree(liveKey)], null);

      expect(clearedIds()).toEqual(["/anywhere/else"]);
    });
  });
});
