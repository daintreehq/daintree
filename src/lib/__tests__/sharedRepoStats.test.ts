// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearRepoAlias,
  publishSharedObservation,
  readNewestSharedObservation,
  readRepoAlias,
  writeRepoAlias,
} from "../sharedRepoStats";

const REPO = "github.com/acme/widgets";

function observation(observedAt: number, hostId: string, issueCount = 3) {
  return { issueCount, prCount: 1, observedAt, hostId };
}

describe("sharedRepoStats", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  it("reads the newest observation from any other host", () => {
    publishSharedObservation("gh", "octo", REPO, observation(2_000, "studio", 5));
    publishSharedObservation("gh", "octo", REPO, observation(3_000, "build-box", 8));
    publishSharedObservation("gh", "octo", REPO, observation(9_000, "local", 1));

    expect(readNewestSharedObservation("gh", "octo", REPO, "local")).toEqual(
      observation(3_000, "build-box", 8)
    );
    expect(readNewestSharedObservation("gh", "octo", REPO, "build-box")).toEqual(
      observation(9_000, "local", 1)
    );
  });

  it("never lets a host overwrite its own entry with an older observation", () => {
    publishSharedObservation("gh", "octo", REPO, observation(2_000, "studio", 5));
    publishSharedObservation("gh", "octo", REPO, observation(1_000, "studio", 9));
    publishSharedObservation("gh", "octo", REPO, observation(2_000, "studio", 9));
    expect(readNewestSharedObservation("gh", "octo", REPO, "local")?.issueCount).toBe(5);

    publishSharedObservation("gh", "octo", REPO, observation(3_000, "studio", 0));
    expect(readNewestSharedObservation("gh", "octo", REPO, "local")?.issueCount).toBe(0);
  });

  it("keeps observations apart by provider, account and repository", () => {
    publishSharedObservation("gh", "octo", REPO, observation(1_000, "studio"));

    expect(readNewestSharedObservation("gl", "octo", REPO, "local")).toBeNull();
    expect(readNewestSharedObservation("gh", "someone-else", REPO, "local")).toBeNull();
    expect(readNewestSharedObservation("gh", "octo", `${REPO}-2`, "local")).toBeNull();
    expect(readNewestSharedObservation("gh", "octo", "github.com/acme", "local")).toBeNull();
  });

  it.each([
    ["unparseable JSON", "{not json"],
    ["a negative count", { ...observation(1_000, "studio"), issueCount: -1 }],
    ["a fractional count", { ...observation(1_000, "studio"), prCount: 1.5 }],
    ["a far-future time", observation(Date.now() + 10 * 24 * 60 * 60 * 1000, "studio")],
    ["a missing host", { issueCount: 1, prCount: 1, observedAt: 1_000 }],
  ])("reads an entry with %s as absent", (_label, stored) => {
    publishSharedObservation("gh", "octo", REPO, observation(1_000, "studio"));
    const key = Object.keys(window.localStorage).find((k) => k.includes("obs"))!;
    window.localStorage.setItem(key, typeof stored === "string" ? stored : JSON.stringify(stored));

    expect(readNewestSharedObservation("gh", "octo", REPO, "local")).toBeNull();
  });

  it("refuses to publish an invalid observation", () => {
    publishSharedObservation("gh", "octo", REPO, observation(1_000, "studio"));
    publishSharedObservation("gh", "octo", REPO, {
      ...observation(2_000, "studio"),
      issueCount: Number.NaN,
    });

    expect(readNewestSharedObservation("gh", "octo", REPO, "local")?.observedAt).toBe(1_000);
  });

  it("treats blocked storage as empty instead of throwing", () => {
    publishSharedObservation("gh", "octo", REPO, observation(1_000, "studio"));
    writeRepoAlias("studio", "/repo", { providerId: "gh", repoKey: REPO });
    // Spying on a Storage instance's methods just stores a key by that name, so
    // block the accessor itself, as a sandboxed or disabled store does.
    vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
      throw new Error("blocked");
    });

    expect(() =>
      publishSharedObservation("gh", "octo", REPO, observation(2_000, "x"))
    ).not.toThrow();
    expect(() => writeRepoAlias("x", "/repo", { providerId: "gh", repoKey: REPO })).not.toThrow();
    expect(() => clearRepoAlias("studio", "/repo")).not.toThrow();
    expect(readNewestSharedObservation("gh", "octo", REPO, "local")).toBeNull();
    expect(readRepoAlias("studio", "/repo")).toBeNull();
  });

  it("survives a full store", () => {
    const setItem = vi.fn(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    const full: Storage = {
      length: 0,
      key: () => null,
      getItem: () => null,
      setItem,
      removeItem: () => {},
      clear: () => {},
    };
    vi.spyOn(window, "localStorage", "get").mockReturnValue(full);

    expect(() =>
      publishSharedObservation("gh", "octo", REPO, observation(1_000, "x"))
    ).not.toThrow();
    expect(() => writeRepoAlias("x", "/repo", { providerId: "gh", repoKey: REPO })).not.toThrow();
    expect(setItem).toHaveBeenCalledTimes(2);
  });

  it("maps a host's project path to its repository, per host, until cleared", () => {
    writeRepoAlias("studio", "/home/me/widgets", { providerId: "gh", repoKey: REPO });

    expect(readRepoAlias("studio", "/home/me/widgets")).toEqual({
      providerId: "gh",
      repoKey: REPO,
    });
    expect(readRepoAlias("local", "/home/me/widgets")).toBeNull();

    writeRepoAlias("studio", "/home/me/widgets", { providerId: "gl", repoKey: "gitlab.com/a/b" });
    expect(readRepoAlias("studio", "/home/me/widgets")).toEqual({
      providerId: "gl",
      repoKey: "gitlab.com/a/b",
    });

    clearRepoAlias("studio", "/home/me/widgets");
    expect(readRepoAlias("studio", "/home/me/widgets")).toBeNull();
  });
});
