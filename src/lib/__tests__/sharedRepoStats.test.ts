// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  publishSharedObservation,
  readRepoAlias,
  readSharedObservation,
  writeRepoAlias,
} from "../sharedRepoStats";

const REPO = "github.com/acme/widgets";

function observation(observedAt: number, issueCount = 3, hostId = "local") {
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

  it("keeps the newest observation and ignores older or equal ones", () => {
    publishSharedObservation("gh", "octo", REPO, observation(2_000, 5, "studio"));
    publishSharedObservation("gh", "octo", REPO, observation(1_000, 9));
    publishSharedObservation("gh", "octo", REPO, observation(2_000, 9));

    expect(readSharedObservation("gh", "octo", REPO)).toEqual(observation(2_000, 5, "studio"));

    publishSharedObservation("gh", "octo", REPO, observation(3_000, 0));
    expect(readSharedObservation("gh", "octo", REPO)).toEqual(observation(3_000, 0));
  });

  it("keeps observations apart by provider, account and repository", () => {
    publishSharedObservation("gh", "octo", REPO, observation(1_000));

    expect(readSharedObservation("gl", "octo", REPO)).toBeNull();
    expect(readSharedObservation("gh", "someone-else", REPO)).toBeNull();
    expect(readSharedObservation("gh", "octo", "github.com/acme/other")).toBeNull();
  });

  it("reads a malformed entry as absent", () => {
    publishSharedObservation("gh", "octo", REPO, observation(1_000));
    const key = Object.keys(window.localStorage).find((k) => k.includes("obs"))!;

    window.localStorage.setItem(key, "{not json");
    expect(readSharedObservation("gh", "octo", REPO)).toBeNull();

    window.localStorage.setItem(key, JSON.stringify({ ...observation(1_000), issueCount: -1 }));
    expect(readSharedObservation("gh", "octo", REPO)).toBeNull();
  });

  it("treats blocked storage as empty instead of throwing", () => {
    publishSharedObservation("gh", "octo", REPO, observation(1_000));
    // Spying on a Storage instance's methods just stores a key by that name, so
    // block the accessor itself, as a sandboxed or disabled store does.
    vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
      throw new Error("blocked");
    });

    expect(() => publishSharedObservation("gh", "octo", REPO, observation(1_000))).not.toThrow();
    expect(() => writeRepoAlias("studio", "/repo", { providerId: "gh", repoKey: REPO })).not.toThrow();
    expect(readSharedObservation("gh", "octo", REPO)).toBeNull();
    expect(readRepoAlias("studio", "/repo")).toBeNull();
  });

  it("maps a host's project path to its repository, per host", () => {
    writeRepoAlias("studio", "/home/me/widgets", { providerId: "gh", repoKey: REPO });

    expect(readRepoAlias("studio", "/home/me/widgets")).toEqual({ providerId: "gh", repoKey: REPO });
    expect(readRepoAlias("local", "/home/me/widgets")).toBeNull();

    writeRepoAlias("studio", "/home/me/widgets", { providerId: "gl", repoKey: "gitlab.com/a/b" });
    expect(readRepoAlias("studio", "/home/me/widgets")).toEqual({
      providerId: "gl",
      repoKey: "gitlab.com/a/b",
    });
  });
});
