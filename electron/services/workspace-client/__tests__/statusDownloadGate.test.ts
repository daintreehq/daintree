import { homedir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StatusDownloadGate } from "../../../../shared/types/workspace-host.js";
import type {
  OnlineOnlyFilesSide,
  ProjectOnlineOnlyFiles,
} from "../../../../shared/types/onlineOnlyFiles.js";
import { gateGitStatusOnDownload } from "../statusDownloadGate.js";

vi.mock("../../ProjectOnlineOnlyService.js", () => ({
  getProjectOnlineOnlyService: vi.fn(),
}));

const cloudRoot = `${homedir()}/Library/CloudStorage/Dropbox/repo`;

function fakeService(initial: OnlineOnlyFilesSide | null = null) {
  const snapshot = (git: OnlineOnlyFilesSide | null): ProjectOnlineOnlyFiles => ({
    projectId: "p1",
    service: "Dropbox",
    revision: 1,
    git,
    workingTree: null,
  });
  let listener: ((files: ProjectOnlineOnlyFiles) => void) | undefined;
  const release = vi.fn();
  const observe = vi.fn((_project: unknown, heard: (files: ProjectOnlineOnlyFiles) => void) => {
    listener = heard;
    return { files: snapshot(initial), release };
  });
  return {
    observe,
    release,
    getService: () => ({ observe }) as never,
    push: (git: OnlineOnlyFilesSide | null) => listener?.(snapshot(git)),
  };
}

const side = (files: number, directories = 0, complete = true) => ({
  files,
  directories,
  complete,
});

describe("gateGitStatusOnDownload", () => {
  const realPlatform = process.platform;
  const setPlatform = (platform: string) =>
    Object.defineProperty(process, "platform", { value: platform, configurable: true });
  let applied: StatusDownloadGate[];
  const apply = (gate: StatusDownloadGate) => applied.push(gate);

  beforeEach(() => {
    vi.useFakeTimers();
    setPlatform("darwin");
    applied = [];
  });

  afterEach(() => {
    vi.useRealTimers();
    setPlatform(realPlatform);
  });

  it.each(["linux", "win32"])("does nothing on %s", (platform) => {
    setPlatform(platform);
    const service = fakeService();

    expect(gateGitStatusOnDownload(cloudRoot, "p1", apply, service.getService)).toBeNull();
    expect(applied).toEqual([]);
    expect(service.observe).not.toHaveBeenCalled();
  });

  it("does nothing for a project outside a cloud folder", () => {
    const service = fakeService();

    expect(
      gateGitStatusOnDownload(`${homedir()}/Projects/repo`, "p1", apply, service.getService)
    ).toBeNull();
    expect(applied).toEqual([]);
    expect(service.observe).not.toHaveBeenCalled();
  });

  it("observes the project under its own id, path and provider", () => {
    const service = fakeService();
    gateGitStatusOnDownload(cloudRoot, "p1", apply, service.getService);

    expect(service.observe.mock.calls[0]?.[0]).toEqual({
      id: "p1",
      path: cloudRoot,
      service: "Dropbox",
    });
  });

  it("stays pending until the first walk of .git answers", () => {
    const service = fakeService();
    gateGitStatusOnDownload(cloudRoot, "p1", apply, service.getService);
    expect(applied).toEqual(["pending"]);

    // Word from the working tree alone says nothing about .git.
    service.push(null);
    expect(applied).toEqual(["pending"]);
  });

  it("holds on online-only files or folders in .git, and opens at zero", () => {
    const service = fakeService();
    gateGitStatusOnDownload(cloudRoot, "p1", apply, service.getService);

    service.push(side(479));
    expect(applied.at(-1)).toBe("held");
    service.push(side(0, 2));
    expect(applied.at(-1)).toBe("held");
    service.push(side(0));
    expect(applied.at(-1)).toBe("open");
  });

  it("holds on a dataless project folder", () => {
    const service = fakeService();
    gateGitStatusOnDownload(cloudRoot, "p1", apply, service.getService);

    service.push({ ...side(0, 0, false), rootOnlineOnly: true });
    expect(applied.at(-1)).toBe("held");
  });

  it("opens on an incomplete zero, so a linked worktree's pointer isn't held forever", () => {
    const service = fakeService();
    gateGitStatusOnDownload(cloudRoot, "p1", apply, service.getService);

    service.push(side(0, 0, false));
    expect(applied.at(-1)).toBe("open");
  });

  it("takes a verdict the shared walk already has", () => {
    const service = fakeService(side(12));
    gateGitStatusOnDownload(cloudRoot, "p1", apply, service.getService);

    expect(applied).toEqual(["pending", "held"]);
  });

  it("gives up waiting for a first verdict, but still honours a late one", () => {
    const service = fakeService();
    gateGitStatusOnDownload(cloudRoot, "p1", apply, service.getService);

    vi.advanceTimersByTime(25_000);
    expect(applied).toEqual(["pending", "open"]);

    service.push(side(3));
    expect(applied.at(-1)).toBe("held");
  });

  it("doesn't reopen a held gate when the deadline passes", () => {
    const service = fakeService();
    gateGitStatusOnDownload(cloudRoot, "p1", apply, service.getService);

    service.push(side(3));
    vi.advanceTimersByTime(60_000);
    expect(applied).toEqual(["pending", "held"]);
  });

  it("stops observing and clears its deadline on release", () => {
    const service = fakeService();
    const stop = gateGitStatusOnDownload(cloudRoot, "p1", apply, service.getService);

    stop?.();
    vi.advanceTimersByTime(60_000);

    expect(service.release).toHaveBeenCalledTimes(1);
    expect(applied).toEqual(["pending"]);
  });
});
