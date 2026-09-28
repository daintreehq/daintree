import { describe, it, expect } from "vitest";
import {
  normalizeGitRemoteUrl,
  normalizeGitRemoteUrls,
  repositoryNameFromRemote,
  sharedGitRemotes,
  stripGitRemoteCredentials,
} from "../gitRemoteUrl.js";

describe("normalizeGitRemoteUrl", () => {
  it.each([
    ["git@github.com:daintreehq/daintree.git", "github.com/daintreehq/daintree"],
    ["https://github.com/daintreehq/daintree", "github.com/daintreehq/daintree"],
    ["https://github.com/daintreehq/daintree.git/", "github.com/daintreehq/daintree"],
    ["ssh://git@github.com/daintreehq/daintree.git", "github.com/daintreehq/daintree"],
    ["ssh://git@github.com:22/daintreehq/daintree", "github.com/daintreehq/daintree"],
    ["ssh://git@ssh.github.com:443/daintreehq/daintree.git", "github.com/daintreehq/daintree"],
    ["https://user:token@github.com/daintreehq/daintree", "github.com/daintreehq/daintree"],
    ["git+ssh://git@github.com/daintreehq/daintree", "github.com/daintreehq/daintree"],
    ["https://www.github.com/daintreehq/daintree", "github.com/daintreehq/daintree"],
    ["  git@github.com:daintreehq/daintree.git  ", "github.com/daintreehq/daintree"],
  ])("reduces %s to %s", (input, expected) => {
    expect(normalizeGitRemoteUrl(input)).toBe(expected);
  });

  it("folds case on GitHub and GitLab only", () => {
    expect(normalizeGitRemoteUrl("git@GitHub.com:DaintreeHQ/Daintree.git")).toBe(
      "github.com/daintreehq/daintree"
    );
    expect(normalizeGitRemoteUrl("https://gitlab.com/Group/Sub/Repo")).toBe(
      "gitlab.com/group/sub/repo"
    );
    expect(normalizeGitRemoteUrl("https://git.example.com/Team/Repo.git")).toBe(
      "git.example.com/Team/Repo"
    );
  });

  it("keeps nested group paths", () => {
    expect(normalizeGitRemoteUrl("git@gitlab.com:group/subgroup/team/repo.git")).toBe(
      "gitlab.com/group/subgroup/team/repo"
    );
    expect(normalizeGitRemoteUrl("https://gitlab.com/group/subgroup/team/repo")).toBe(
      "gitlab.com/group/subgroup/team/repo"
    );
  });

  it("keeps non-default ports and drops default ones", () => {
    expect(normalizeGitRemoteUrl("ssh://git@git.example.com:2222/team/repo.git")).toBe(
      "git.example.com:2222/team/repo"
    );
    expect(normalizeGitRemoteUrl("https://git.example.com:8443/team/repo")).toBe(
      "git.example.com:8443/team/repo"
    );
    expect(normalizeGitRemoteUrl("https://git.example.com:443/team/repo")).toBe(
      "git.example.com/team/repo"
    );
    expect(normalizeGitRemoteUrl("git://git.example.com:9418/team/repo")).toBe(
      "git.example.com/team/repo"
    );
  });

  it("treats an SCP path with a leading slash like its relative spelling", () => {
    expect(normalizeGitRemoteUrl("git@git.example.com:/team/repo.git")).toBe(
      "git.example.com/team/repo"
    );
  });

  it.each([
    "",
    "/srv/git/repo.git",
    "./repo",
    "file:///srv/git/repo.git",
    "C:\\repos\\thing",
    "not a url",
    "https://github.com/",
  ])("returns null for %j", (input) => {
    expect(normalizeGitRemoteUrl(input)).toBeNull();
  });
});

describe("sharedGitRemotes", () => {
  it("matches SSH against HTTPS across every remote, not only origin", () => {
    const local = ["git@github.com:me/daintree.git", "https://github.com/daintreehq/daintree"];
    const host = ["git@github.com:daintreehq/daintree.git"];
    expect(sharedGitRemotes(local, host)).toEqual(["github.com/daintreehq/daintree"]);
  });

  it("finds nothing between different repositories", () => {
    expect(sharedGitRemotes(["git@github.com:a/b.git"], ["git@github.com:a/c.git"])).toEqual([]);
  });

  it("dedupes and skips unparseable entries", () => {
    expect([
      ...normalizeGitRemoteUrls(["git@github.com:a/b", "https://github.com/a/b.git", "/local"]),
    ]).toEqual(["github.com/a/b"]);
  });
});

describe("repositoryNameFromRemote", () => {
  it("keeps the repository's own case", () => {
    expect(repositoryNameFromRemote("git@github.com:Owner/MyRepo.git")).toBe("MyRepo");
    expect(repositoryNameFromRemote("https://gitlab.com/a/b/c/deep")).toBe("deep");
    expect(repositoryNameFromRemote("/local/path")).toBeNull();
  });
});

describe("stripGitRemoteCredentials", () => {
  it.each([
    [
      "https://greg:ghp_s3cret@github.com/daintreehq/daintree.git",
      "https://github.com/daintreehq/daintree.git",
    ],
    [
      "https://ghp_s3cret@github.com/daintreehq/daintree.git",
      "https://github.com/daintreehq/daintree.git",
    ],
    ["http://user:pw@git.example.com:8080/a/b.git", "http://git.example.com:8080/a/b.git"],
    ["ssh://git:pw@example.com/repo.git", "ssh://git@example.com/repo.git"],
    ["https://user:token@bad host/repo.git", "https://bad host/repo.git"],
  ])("strips the credentials from %s", (input, expected) => {
    expect(stripGitRemoteCredentials(input)).toBe(expected);
  });

  it.each([
    "git@github.com:daintreehq/daintree.git",
    "ssh://git@example.com:2222/repo.git",
    "https://github.com/daintreehq/daintree",
    "/srv/repo.git",
    "not a url @ all",
  ])("leaves %s as it is", (input) => {
    expect(stripGitRemoteCredentials(input)).toBe(input);
  });
});
