import { describe, expect, it } from "vitest";
import type { BranchInfo } from "@shared/types";
import type { PR } from "@shared/types/forge";
import {
  buildSourcePrOptions,
  findUnambiguousPrRemoteBranch,
  normalizeSourcePrState,
} from "../prWorktreeSource";

const branch = (name: string, remote?: string): BranchInfo => ({
  name,
  current: false,
  commit: "c0",
  remote,
});

describe("findUnambiguousPrRemoteBranch", () => {
  it("returns the one remote branch carrying the head, under any remote name", () => {
    const upstream = branch("upstream/fix", "upstream");
    expect(findUnambiguousPrRemoteBranch([branch("fix"), upstream], "fix")).toBe(upstream);
  });

  it("returns nothing when two remotes carry the same name", () => {
    expect(
      findUnambiguousPrRemoteBranch(
        [branch("origin/fix", "origin"), branch("upstream/fix", "upstream")],
        "fix"
      )
    ).toBeUndefined();
  });

  it("matches the whole `<remote>/<head>` name, never a suffix or a local branch", () => {
    expect(
      findUnambiguousPrRemoteBranch(
        [branch("origin/feature/fix", "origin"), branch("origin/fix-2", "origin"), branch("fix")],
        "fix"
      )
    ).toBeUndefined();
  });

  it("finds a head that itself contains slashes", () => {
    const nested = branch("origin/feature/fix", "origin");
    expect(findUnambiguousPrRemoteBranch([nested], "feature/fix")).toBe(nested);
  });
});

describe("normalizeSourcePrState", () => {
  it.each([
    ["open", "open"],
    ["merged", "merged"],
    ["closed", "closed"],
    ["declined", "closed"],
  ] as const)("maps %s to %s", (state, expected) => {
    expect(normalizeSourcePrState(state)).toBe(expected);
  });
});

describe("buildSourcePrOptions", () => {
  const pr = {
    number: 12,
    title: "Stop the leak",
    url: "https://github.com/acme/app/pull/12",
    state: "declined",
    body: "Resolves #4",
  } as Pick<PR, "number" | "title" | "url" | "state" | "body">;

  it("carries the PR identity, its normalized state, and the issue it closes", () => {
    expect(buildSourcePrOptions(pr)).toEqual({
      sourcePrNumber: 12,
      sourcePrTitle: "Stop the leak",
      sourcePrUrl: "https://github.com/acme/app/pull/12",
      sourcePrState: "closed",
      sourcePrLinkedIssueNumber: 4,
    });
  });

  it.each([
    ["open", "open"],
    ["merged", "merged"],
    ["closed", "closed"],
  ] as const)("reports a %s PR as %s", (state, expected) => {
    expect(buildSourcePrOptions({ ...pr, state }).sourcePrState).toBe(expected);
  });

  it("leaves the linked issue unset when the body closes none", () => {
    expect(buildSourcePrOptions({ ...pr, body: "Just a refactor" }).sourcePrLinkedIssueNumber).toBe(
      undefined
    );
  });
});
