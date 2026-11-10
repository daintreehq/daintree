import { describe, it, expect } from "vitest";
import type { AppErrorCode, CachedViewReleaseBlock } from "../../types/appError.js";
import {
  getProjectHeldElsewhereMessage,
  getProjectHeldRecovery,
  getProjectOpenFailure,
  isPersistentHold,
  withRemoveFromRecent,
  PROJECT_OPEN_RECOVERY_LABELS,
  type ProjectOpenFailure,
} from "../projectOpenErrors.js";

const FOLDER = "/Volumes/Archive/repos/alpha";

/** Every code the table is expected to answer for. */
const CLASSIFIED_CODES: AppErrorCode[] = [
  "NOT_FOUND",
  "NOT_A_DIRECTORY",
  "INVALID_PATH",
  "PERMISSION",
  "DUBIOUS_OWNERSHIP",
  "GIT_NOT_INSTALLED",
  "PROJECT_OPEN_FAILED",
];

/**
 * The whole point of #11409: none of this copy may name an internal method, a
 * library, or a raw errno. Matched case-insensitively so a reworded message
 * can't sneak one back in under different capitalization.
 */
const FORBIDDEN = [
  "simple-git",
  "simplegit",
  "getRepositoryRoot",
  "GitConstructError",
  "baseDir",
  "AppError",
  "ENOENT",
  "ENOTDIR",
  "EACCES",
  "EPERM",
  "ESTALE",
  "ELOOP",
  "ENAMETOOLONG",
  "errno",
  "stat(",
];

function classified(code: AppErrorCode, directoryPath?: string): ProjectOpenFailure {
  const failure = getProjectOpenFailure(code, directoryPath);
  if (!failure) throw new Error(`expected ${code} to be classified`);
  return failure;
}

describe("getProjectOpenFailure", () => {
  it("classifies every folder-open failure code and nothing else", () => {
    for (const code of CLASSIFIED_CODES) {
      expect(getProjectOpenFailure(code, FOLDER)).not.toBeNull();
    }

    // NOT_A_GIT_REPO stays the guided git-init path and must never be rendered
    // as a dead-end error; unrelated codes fall through to the caller's own
    // generic handling.
    expect(getProjectOpenFailure("NOT_A_GIT_REPO", FOLDER)).toBeNull();
    expect(getProjectOpenFailure("INTERNAL", FOLDER)).toBeNull();
    // A project another window holds is about that window, never the folder (#16724).
    expect(getProjectOpenFailure("PROJECT_HELD_ELSEWHERE", FOLDER)).toBeNull();
    expect(getProjectOpenFailure("BINARY_FILE", FOLDER)).toBeNull();
  });

  it.each(CLASSIFIED_CODES)("leaks no internals for %s, with or without a path", (code) => {
    for (const text of [
      classified(code, FOLDER).message,
      classified(code, FOLDER).title,
      classified(code).message,
      classified(code).title,
    ]) {
      for (const banned of FORBIDDEN) {
        expect(text.toLowerCase()).not.toContain(banned.toLowerCase());
      }
    }
  });

  it("names the failing folder for every failure that is about the folder", () => {
    // GIT_NOT_INSTALLED is about the machine, not the path, so it is excluded
    // deliberately rather than by oversight.
    const folderSpecific = CLASSIFIED_CODES.filter((code) => code !== "GIT_NOT_INSTALLED");

    for (const code of folderSpecific) {
      expect(classified(code, FOLDER).message).toContain(FOLDER);
    }
  });

  it("still reads as a sentence when no path is available", () => {
    // The renderer often has no path: IPC sanitization scrubs absolute paths
    // out of error messages, so copy must not depend on interpolating one.
    for (const code of CLASSIFIED_CODES) {
      const { message } = classified(code);
      expect(message).not.toContain("undefined");
      expect(message).not.toMatch(/""/);
      expect(message.trim().length).toBeGreaterThan(0);
    }
  });

  it("gives every failure exactly one recovery action with a titled label", () => {
    for (const code of CLASSIFIED_CODES) {
      const label = PROJECT_OPEN_RECOVERY_LABELS[classified(code, FOLDER).recovery];
      expect(label).toBeTruthy();
      // Microcopy rule: buttons and titles take no trailing period.
      expect(label.endsWith(".")).toBe(false);
      expect(classified(code, FOLDER).title.endsWith(".")).toBe(false);
    }
  });

  it("marks a row removable only when the filesystem proved the path is dead", () => {
    const removable = CLASSIFIED_CODES.filter((code) => classified(code, FOLDER).removable);

    // A folder that is gone or is now a file is proven dead. A timeout, a
    // permission failure, or a malformed path proves only that we couldn't
    // read it — offering to delete the project row on that evidence would
    // destroy state over an unproven claim (#11258).
    expect(removable.sort()).toEqual(["NOT_A_DIRECTORY", "NOT_FOUND"]);
  });
});

describe("withRemoveFromRecent", () => {
  it("offers removal for a proven-dead path", () => {
    const upgraded = withRemoveFromRecent(classified("NOT_FOUND", FOLDER));

    expect(upgraded.recovery).toBe("remove-from-recent");
    expect(upgraded.message).toBe(classified("NOT_FOUND", FOLDER).message);
  });

  it("never offers removal for a path that is merely unreachable", () => {
    for (const code of CLASSIFIED_CODES) {
      const failure = classified(code, FOLDER);
      if (failure.removable) continue;

      expect(withRemoveFromRecent(failure)).toEqual(failure);
    }
  });

  it("leaves the original untouched", () => {
    const failure = classified("NOT_FOUND", FOLDER);
    withRemoveFromRecent(failure);

    expect(failure.recovery).toBe("choose-folder");
  });
});

describe("a project another window holds (#16724)", () => {
  const REASONS: CachedViewReleaseBlock[] = [
    "assistant",
    "unsaved-work",
    "mcp",
    "flush",
    "dictation",
    "unavailable",
  ];

  it.each(REASONS)("words the %s hold as the project being open elsewhere, never a folder", (reason) => {
    const message = getProjectHeldElsewhereMessage("Alpha", reason);
    expect(message).toContain('"Alpha" is open in another window');
    for (const folderWord of ["folder", "drive", "repository"]) {
      expect(message.toLowerCase()).not.toContain(folderWord);
    }
    // Only a hold that clears on its own is worth trying again for.
    expect(message.includes("Try again")).toBe(!isPersistentHold(reason));
  });

  it("offers that window for a lasting hold, a retry for a passing one", () => {
    for (const reason of REASONS) {
      expect(
        getProjectHeldRecovery({ code: "PROJECT_HELD_ELSEWHERE", reason, showable: true })
      ).toBe(isPersistentHold(reason) ? "show-in-other-window" : "retry");
    }
  });

  it("offers nothing for a lasting hold it can't show, and never a retry", () => {
    for (const reason of REASONS) {
      const recovery = getProjectHeldRecovery({
        code: "PROJECT_HELD_ELSEWHERE",
        reason,
        showable: false,
      });
      expect(recovery).toBe(isPersistentHold(reason) ? "none" : "retry");
    }
  });

  it("keeps the retry when nothing says the hold lasts", () => {
    expect(getProjectHeldRecovery(undefined)).toBe("retry");
  });
});
