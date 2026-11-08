import { describe, expect, it } from "vitest";
import type { ProjectOnlineOnlyFiles } from "../../types/onlineOnlyFiles.js";
import { gitStatusWaitsForDownload, hasOnlineOnlyEntries } from "../onlineOnlyFiles.js";

const files = (git: ProjectOnlineOnlyFiles["git"]): ProjectOnlineOnlyFiles => ({
  projectId: "p1",
  service: "Dropbox",
  revision: 1,
  git,
  workingTree: { files: 900, directories: 0, complete: true },
});

describe("hasOnlineOnlyEntries", () => {
  it("is false for a side not yet seen", () => {
    expect(hasOnlineOnlyEntries(null)).toBe(false);
    expect(hasOnlineOnlyEntries(undefined)).toBe(false);
  });

  it("counts files, folders and a dataless root", () => {
    expect(hasOnlineOnlyEntries({ files: 1, directories: 0, complete: true })).toBe(true);
    expect(hasOnlineOnlyEntries({ files: 0, directories: 1, complete: true })).toBe(true);
    expect(
      hasOnlineOnlyEntries({ files: 0, directories: 0, complete: false, rootOnlineOnly: true })
    ).toBe(true);
  });

  it("is false for a zero, complete or not", () => {
    expect(hasOnlineOnlyEntries({ files: 0, directories: 0, complete: true })).toBe(false);
    expect(hasOnlineOnlyEntries({ files: 0, directories: 0, complete: false })).toBe(false);
  });
});

describe("gitStatusWaitsForDownload", () => {
  it("waits on .git alone, however much of the working tree is outstanding", () => {
    expect(gitStatusWaitsForDownload(files({ files: 3, directories: 0, complete: true }))).toBe(
      true
    );
    expect(gitStatusWaitsForDownload(files({ files: 0, directories: 0, complete: true }))).toBe(
      false
    );
  });

  it("doesn't wait until something has been seen", () => {
    expect(gitStatusWaitsForDownload(null)).toBe(false);
    expect(gitStatusWaitsForDownload(files(null))).toBe(false);
  });

  it("waits on a partial count but not on an incomplete zero", () => {
    expect(gitStatusWaitsForDownload(files({ files: 3, directories: 0, complete: false }))).toBe(
      true
    );
    expect(gitStatusWaitsForDownload(files({ files: 0, directories: 0, complete: false }))).toBe(
      false
    );
  });
});
