import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { GetProjectPulseOptions, PulseRangeDays } from "../../../shared/types/pulse.js";

const { existsSyncMock } = vi.hoisted(() => ({
  existsSyncMock: vi.fn(() => true),
}));
vi.mock("fs", () => ({
  existsSync: existsSyncMock,
}));

const PROBE_ARGV = ["rev-parse", "HEAD", "--abbrev-ref", "HEAD"];

interface Repo {
  sha: string | null;
  branch: string;
  // Replaces the probe's answer when set, to model a failed or garbled read.
  probe?: () => Promise<string>;
}

function isProbe(args: string[]): boolean {
  return args.length === PROBE_ARGV.length && args.every((a, i) => a === PROBE_ARGV[i]);
}

function isHeatmapLog(args: string[]): boolean {
  return args[0] === "log" && args.some((a) => a.startsWith("--since="));
}

const NO_COMMITS =
  "fatal: ambiguous argument 'HEAD': unknown revision or path not in the working tree.";

async function loadService(repo: Repo) {
  const raw = vi.fn(async (args: string[]): Promise<string> => {
    if (isProbe(args)) {
      if (repo.probe) return repo.probe();
      if (repo.sha === null) throw new Error(NO_COMMITS);
      return `${repo.sha}\n${repo.branch}\n`;
    }
    if (args[0] === "rev-parse" && args[1] === "--verify" && args[2] === "HEAD") {
      if (repo.sha === null) throw new Error(NO_COMMITS);
      return `${repo.sha}\n`;
    }
    if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return `${repo.branch}\n`;
    return "";
  });
  const createStrictExitGit = vi.fn(async () => ({ checkIsRepo: async () => true, raw }));
  vi.doMock("../../utils/hardenedGit.js", () => ({ createStrictExitGit }));
  const { ProjectPulseService } = await import("../ProjectPulseService.js");
  return { svc: new ProjectPulseService(), raw, createStrictExitGit };
}

function options(overrides: Partial<GetProjectPulseOptions> = {}): GetProjectPulseOptions {
  return {
    worktreePath: "/repo",
    worktreeId: "wt-1",
    mainBranch: "main",
    rangeDays: 60 as PulseRangeDays,
    includeDelta: false,
    includeRecentCommits: false,
    ...overrides,
  };
}

function callsSince(raw: ReturnType<typeof vi.fn>, start: number): string[][] {
  return raw.mock.calls.slice(start).map(([args]) => args as string[]);
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("ProjectPulseService HEAD probe (#17804)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-15T12:00:00.000Z"));
    existsSyncMock.mockReturnValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
    vi.clearAllMocks();
    vi.doUnmock("../../utils/hardenedGit.js");
  });

  it("serves a warm hit with one git process reading HEAD and the branch together", async () => {
    const { svc, raw } = await loadService({ sha: "sha-aaa", branch: "main" });
    const first = await svc.getPulse(options());
    const start = raw.mock.calls.length;

    const second = await svc.getPulse(options());

    expect(second).toBe(first);
    expect(callsSince(raw, start)).toEqual([PROBE_ARGV]);
  });

  it("shares one probe among concurrent warm callers of one worktree", async () => {
    const repo: Repo = { sha: "sha-aaa", branch: "main" };
    const { svc, raw, createStrictExitGit } = await loadService(repo);
    const warm60 = await svc.getPulse(options());
    const warm120 = await svc.getPulse(options({ rangeDays: 120 }));
    const start = raw.mock.calls.length;
    const gitsBefore = createStrictExitGit.mock.calls.length;

    const gate = deferred<string>();
    repo.probe = () => gate.promise;
    const pending = [
      svc.getPulse(options()),
      svc.getPulse(options()),
      svc.getPulse(options({ rangeDays: 120 })),
    ];
    await vi.advanceTimersByTimeAsync(0);
    gate.resolve("sha-aaa\nmain\n");

    expect(await Promise.all(pending)).toEqual([warm60, warm60, warm120]);
    expect(callsSince(raw, start)).toEqual([PROBE_ARGV]);
    expect(createStrictExitGit.mock.calls.length - gitsBefore).toBe(1);
  });

  it.each([
    ["ID", { worktreeId: "wt-2" }],
    ["path", { worktreePath: "/repo-2" }],
    ["ID and path", { worktreeId: "wt-2", worktreePath: "/repo-2" }],
  ])("does not share a probe with a worktree of another %s", async (_name, other) => {
    const repo: Repo = { sha: "sha-aaa", branch: "main" };
    const { svc, raw } = await loadService(repo);
    await svc.getPulse(options());
    await svc.getPulse(options(other));
    const start = raw.mock.calls.length;

    const gate = deferred<string>();
    repo.probe = () => gate.promise;
    const pending = Promise.all([svc.getPulse(options()), svc.getPulse(options(other))]);
    await vi.advanceTimersByTimeAsync(0);
    gate.resolve("sha-aaa\nmain\n");
    await pending;

    expect(callsSince(raw, start)).toEqual([PROBE_ARGV, PROBE_ARGV]);
  });

  it("leaves another worktree's pending probe joinable across an invalidate", async () => {
    const repo: Repo = { sha: "sha-aaa", branch: "main" };
    const { svc, raw } = await loadService(repo);
    const other = { worktreeId: "wt-2", worktreePath: "/repo-2" };
    const warmOther = await svc.getPulse(options(other));
    const start = raw.mock.calls.length;

    const gate = deferred<string>();
    repo.probe = () => gate.promise;
    const first = svc.getPulse(options(other));
    await vi.advanceTimersByTimeAsync(0);
    svc.invalidate("wt-1");
    const second = svc.getPulse(options(other));
    await vi.advanceTimersByTimeAsync(0);
    gate.resolve("sha-aaa\nmain\n");

    expect(await Promise.all([first, second])).toEqual([warmOther, warmOther]);
    expect(callsSince(raw, start)).toEqual([PROBE_ARGV]);
  });

  it("starts a fresh probe after an invalidate, which the old probe settling leaves in place", async () => {
    const repo: Repo = { sha: "sha-aaa", branch: "main" };
    const { svc, raw } = await loadService(repo);
    const warm = await svc.getPulse(options());
    const probes = () => raw.mock.calls.filter(([args]) => isProbe(args as string[])).length;

    const oldProbe = deferred<string>();
    repo.probe = () => oldProbe.promise;
    const beforeInvalidate = svc.getPulse(options());
    await vi.advanceTimersByTimeAsync(0);

    svc.invalidate("wt-1");
    repo.sha = "sha-bbb";
    repo.probe = undefined;
    await svc.getPulse(options());

    // The old probe may have read the HEAD the invalidate was about, so this caller must not join it.
    const newProbe = deferred<string>();
    repo.probe = () => newProbe.promise;
    const probesBefore = probes();
    const afterInvalidate = svc.getPulse(options());
    await vi.advanceTimersByTimeAsync(0);
    expect(probes()).toBe(probesBefore + 1);

    // Its entry was invalidated mid-probe, so the old caller recomputes rather than serving it.
    oldProbe.resolve("sha-aaa\nmain\n");
    const recomputed = await beforeInvalidate;
    expect(recomputed).not.toBe(warm);

    // Settling the old probe must not evict the new one: a later caller still joins it.
    const joiner = svc.getPulse(options());
    await vi.advanceTimersByTimeAsync(0);
    expect(probes()).toBe(probesBefore + 1);

    newProbe.resolve("sha-bbb\nmain\n");
    expect(await joiner).toBe(recomputed);
    await afterInvalidate;
  });

  it("reads a CRLF answer like an LF one", async () => {
    const repo: Repo = { sha: "sha-aaa", branch: "main" };
    const { svc, raw } = await loadService(repo);
    const first = await svc.getPulse(options());
    const start = raw.mock.calls.length;

    repo.probe = () => Promise.resolve("sha-aaa\r\nmain\r\n");

    expect(await svc.getPulse(options())).toBe(first);
    expect(callsSince(raw, start)).toEqual([PROBE_ARGV]);
  });

  it("recomputes when the branch switched at the same SHA", async () => {
    const repo: Repo = { sha: "sha-aaa", branch: "main" };
    const { svc, raw } = await loadService(repo);
    const onMain = await svc.getPulse(options());
    expect(await svc.getPulse(options())).toBe(onMain);
    const start = raw.mock.calls.length;

    repo.branch = "feature";
    await svc.getPulse(options());

    expect(callsSince(raw, start).filter(isHeatmapLog)).toHaveLength(1);
  });

  it("tells a detached HEAD from the branch it was cached on", async () => {
    const repo: Repo = { sha: "sha-aaa", branch: "main" };
    const { svc, raw } = await loadService(repo);
    await svc.getPulse(options());

    repo.branch = "HEAD";
    let start = raw.mock.calls.length;
    await svc.getPulse(options());
    expect(callsSince(raw, start).filter(isHeatmapLog)).toHaveLength(1);

    // Still detached at the same SHA: the detached entry is a hit.
    start = raw.mock.calls.length;
    await svc.getPulse(options());
    expect(callsSince(raw, start)).toEqual([PROBE_ARGV]);
  });

  it("serves a cached unborn-branch pulse while the branch is still unborn", async () => {
    const { svc, raw } = await loadService({ sha: null, branch: "main" });
    const first = await svc.getPulse(options());
    const start = raw.mock.calls.length;

    const second = await svc.getPulse(options());

    expect(second).toBe(first);
    expect(callsSince(raw, start)).toEqual([PROBE_ARGV]);
  });

  it.each([
    ["a failed read", () => Promise.reject(new Error("fatal: some unexpected git failure"))],
    ["a SHA with no branch line", () => Promise.resolve("sha-aaa\n")],
    ["an empty answer", () => Promise.resolve("")],
    ["extra lines", () => Promise.resolve("sha-aaa\nmain\n--\n")],
  ])("recomputes when the probe returns %s", async (_name, probe) => {
    const repo: Repo = { sha: "sha-aaa", branch: "main" };
    const { svc, raw } = await loadService(repo);
    const first = await svc.getPulse(options());
    const start = raw.mock.calls.length;

    repo.probe = probe;
    const second = await svc.getPulse(options());

    expect(second).not.toBe(first);
    expect(callsSince(raw, start).filter(isHeatmapLog)).toHaveLength(1);
  });

  it("does not read a garbled answer as an unborn branch", async () => {
    const repo: Repo = { sha: null, branch: "main" };
    const { svc, raw } = await loadService(repo);
    const unborn = await svc.getPulse(options());
    const start = raw.mock.calls.length;

    repo.probe = () => Promise.resolve("sha-aaa\n");
    const next = await svc.getPulse(options());

    expect(next).not.toBe(unborn);
    expect(callsSince(raw, start)[0]).toEqual(PROBE_ARGV);
    expect(callsSince(raw, start).length).toBeGreaterThan(1);
  });

  it("recomputes, and surfaces the error, when the worktree is gone", async () => {
    const { svc, raw } = await loadService({ sha: null, branch: "main" });
    await svc.getPulse(options());
    const start = raw.mock.calls.length;

    existsSyncMock.mockReturnValue(false);

    await expect(svc.getPulse(options())).rejects.toThrow("Worktree path does not exist");
    expect(callsSince(raw, start)).toEqual([]);
  });
});
