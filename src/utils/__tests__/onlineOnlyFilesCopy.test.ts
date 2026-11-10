import { describe, expect, it } from "vitest";
import type { OnlineOnlyFilesSide, ProjectOnlineOnlyFiles } from "@shared/types/onlineOnlyFiles";
import type { CloudSyncService } from "@shared/utils/cloudSyncDetection";
import { getOnlineOnlyFilesCopy, getOnlineOnlyFilesInboxCopy } from "../onlineOnlyFilesCopy";

const side = (files: number, directories = 0, complete = true): OnlineOnlyFilesSide => ({
  files,
  directories,
  complete,
});

const snapshot = (
  git: OnlineOnlyFilesSide | null,
  workingTree: OnlineOnlyFilesSide | null,
  service: CloudSyncService = "Dropbox"
): ProjectOnlineOnlyFiles => ({ projectId: "p1", service, revision: 1, git, workingTree });

const describeOf = (...args: Parameters<typeof snapshot>) =>
  getOnlineOnlyFilesCopy(snapshot(...args))?.description;

describe("getOnlineOnlyFilesCopy", () => {
  it("reports both sides and that git status is waiting", () => {
    expect(describeOf(side(479), side(206))).toContain(
      "Dropbox hasn't downloaded 479 files in .git and 206 project files yet. Git status is waiting for them."
    );
  });

  it("reports .git alone", () => {
    expect(describeOf(side(3), side(0))).toContain(
      "Dropbox hasn't downloaded 3 files in .git yet. Git status is waiting for them."
    );
  });

  it("says it for a single outstanding entry", () => {
    expect(describeOf(side(1), side(0))).toContain(
      "Dropbox hasn't downloaded 1 file in .git yet. Git status is waiting for it."
    );
    expect(describeOf(side(0, 1), null)).toContain("Git status is waiting for it.");
    expect(describeOf(side(1), side(1))).toContain("Git status is waiting for them.");
  });

  it("never claims git status is waiting when only project files are outstanding", () => {
    const description = describeOf(side(0), side(206));
    expect(description).toContain("Dropbox hasn't downloaded 206 project files yet.");
    expect(description).not.toContain("Git status");
  });

  it("makes no claim about a side that hasn't answered", () => {
    expect(describeOf(null, side(206))).toContain("hasn't downloaded 206 project files yet.");
    expect(describeOf(side(9), null)).toContain("hasn't downloaded 9 files in .git yet.");
  });

  it("counts folders as folders, never as files", () => {
    expect(describeOf(side(0, 3), side(2, 1))).toContain(
      "3 folders in .git, and 2 project files and 1 project folder yet."
    );
    expect(describeOf(side(479, 3), side(0))).toContain("479 files and 3 folders in .git yet.");
  });

  it("says at least for a count the walk couldn't finish", () => {
    expect(describeOf(side(40, 0, false), side(6, 0, false))).toContain(
      "at least 40 files in .git and at least 6 project files yet."
    );
  });

  it("leaves out an incomplete zero rather than reading it as downloaded", () => {
    const description = describeOf(side(0, 0, false), side(6));
    expect(description).toContain("hasn't downloaded 6 project files yet.");
    expect(description).not.toContain(".git");
    expect(description).not.toContain("Git status");
  });

  it("says the project folder itself hasn't downloaded, without repeating it as a count", () => {
    const rootGit = { ...side(0, 0, false), rootOnlineOnly: true };
    const description = describeOf(rootGit, side(0, 1));
    expect(description).toContain(
      "Dropbox hasn't downloaded this project's folder yet. Git status is waiting for it."
    );
    expect(description).not.toContain("1 project folder");
  });

  it("groups digits in large counts", () => {
    expect(describeOf(side(12_345), side(0))).toContain(`${(12_345).toLocaleString()} files`);
  });

  it.each([
    [side(0), side(0)],
    [side(0, 0, false), side(0, 0, false)],
    [null, null],
    [side(0), null],
  ])("says nothing when nothing has been seen (%#)", (git, tree) => {
    expect(getOnlineOnlyFilesCopy(snapshot(git, tree))).toBeNull();
  });

  it.each<[CloudSyncService, string]>([
    ["Dropbox", "Make available offline"],
    ["iCloud Drive", "Download Now"],
    ["OneDrive", "Always Keep on This Device"],
    ["Google Drive", "Available offline"],
  ])("points %s at its own control", (service, control) => {
    expect(describeOf(side(1), side(0), service)).toContain(`choose "${control}".`);
    expect(getOnlineOnlyFilesInboxCopy(service).description).toContain(`choose "${control}".`);
  });

  it("names the host's Finder in a remote window", () => {
    const copy = getOnlineOnlyFilesCopy(snapshot(side(1), side(0)), true);
    expect(copy?.description).toContain("in Finder on the host");
    expect(getOnlineOnlyFilesInboxCopy("Dropbox", true).description).toContain(
      "in Finder on the host"
    );
  });

  it("never says what the provider is doing", () => {
    const text = [
      describeOf(side(479, 3, false), side(206, 2)),
      describeOf({ ...side(0, 0, false), rootOnlineOnly: true }, null),
      getOnlineOnlyFilesInboxCopy("Dropbox").description,
    ].join(" ");
    expect(text).not.toMatch(/\b(syncing|sync|paused|stuck|broken|running|failed)\b/i);
  });
});
