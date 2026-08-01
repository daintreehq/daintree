import { describe, expect, it } from "vitest";
import type { GitStatus } from "@shared/types/git";
import { GIT_STATUS_PRESENTATION, getGitStatusPresentation } from "../gitStatusPresentation";

const ALL_STATUSES = Object.keys(GIT_STATUS_PRESENTATION).filter(
  (key): key is GitStatus => key in GIT_STATUS_PRESENTATION
);

describe("getGitStatusPresentation", () => {
  it("resolves every status the type admits", () => {
    for (const status of ALL_STATUSES) {
      const presentation = getGitStatusPresentation(status);
      expect(presentation.marker).not.toBe("");
      expect(presentation.name).not.toBe("");
      expect(presentation.colorClass).not.toBe("");
    }
  });

  it("keeps every marker to a single character so a dense row can hold it", () => {
    for (const status of ALL_STATUSES) {
      expect(getGitStatusPresentation(status).marker).toHaveLength(1);
    }
  });

  it("never spends the accent on status, which is inherently multi-element", () => {
    for (const status of ALL_STATUSES) {
      expect(getGitStatusPresentation(status).colorClass).not.toMatch(/accent/);
    }
  });

  it("distinguishes the statuses a reader has to tell apart at a glance", () => {
    const distinguishable: GitStatus[] = ["modified", "added", "deleted", "conflicted"];
    const markers = distinguishable.map((status) => getGitStatusPresentation(status).marker);

    expect(new Set(markers).size).toBe(distinguishable.length);
  });

  it("falls back rather than leaving a changed row unmarked", () => {
    // The assertion is deliberately unsafe: a value the union forbids but IPC
    // can still deliver is the entire scenario under test.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- exercising an out-of-union runtime value
    const rogue = getGitStatusPresentation("something-new" as GitStatus);

    expect(rogue).toBe(getGitStatusPresentation("untracked"));
  });
});
