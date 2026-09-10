import { describe, expect, it } from "vitest";
import {
  encodeProjectId,
  parseGitLabRemoteUrl,
  repoFullPath,
  repoWebUrl,
} from "../gitlabRemote.js";

describe("parseGitLabRemoteUrl", () => {
  it("parses HTTPS clone URLs", () => {
    expect(parseGitLabRemoteUrl("https://gitlab.com/group/project.git")).toEqual({
      host: "gitlab.com",
      owner: "group",
      repo: "project",
    });
  });

  it("parses HTTPS URLs without .git", () => {
    expect(parseGitLabRemoteUrl("https://gitlab.com/group/project")).toEqual({
      host: "gitlab.com",
      owner: "group",
      repo: "project",
    });
  });

  it("parses SCP-style SSH remotes", () => {
    expect(parseGitLabRemoteUrl("git@gitlab.com:group/project.git")).toEqual({
      host: "gitlab.com",
      owner: "group",
      repo: "project",
    });
  });

  it("parses ssh:// remotes with ports", () => {
    expect(parseGitLabRemoteUrl("ssh://git@gitlab.example.com:2222/group/project.git")).toEqual({
      host: "gitlab.example.com",
      owner: "group",
      repo: "project",
    });
  });

  it("preserves nested subgroups in owner", () => {
    expect(parseGitLabRemoteUrl("git@gitlab.com:group/subgroup/deeper/project.git")).toEqual({
      host: "gitlab.com",
      owner: "group/subgroup/deeper",
      repo: "project",
    });
  });

  it("parses self-hosted HTTPS remotes", () => {
    expect(parseGitLabRemoteUrl("https://code.internal.example/team/app.git")).toEqual({
      host: "code.internal.example",
      owner: "team",
      repo: "app",
    });
  });

  it("cuts pasted web URLs at the /-/ route separator", () => {
    expect(parseGitLabRemoteUrl("https://gitlab.com/group/project/-/merge_requests/42")).toEqual({
      host: "gitlab.com",
      owner: "group",
      repo: "project",
    });
  });

  it("lowercases the host but preserves path case", () => {
    expect(parseGitLabRemoteUrl("https://GitLab.Com/Group/Project.git")).toEqual({
      host: "gitlab.com",
      owner: "Group",
      repo: "Project",
    });
  });

  it("rejects single-segment paths", () => {
    expect(parseGitLabRemoteUrl("https://gitlab.com/group")).toBeNull();
  });

  it("rejects reserved leading segments", () => {
    expect(parseGitLabRemoteUrl("https://gitlab.com/api/v4/projects")).toBeNull();
    expect(parseGitLabRemoteUrl("https://gitlab.com/uploads/foo/bar")).toBeNull();
  });

  it("rejects empty and garbage input", () => {
    expect(parseGitLabRemoteUrl("")).toBeNull();
    expect(parseGitLabRemoteUrl("   ")).toBeNull();
    expect(parseGitLabRemoteUrl("not a url at all")).toBeNull();
  });
});

describe("project id helpers", () => {
  const repo = { host: "gitlab.com", owner: "group/subgroup", repo: "project" };

  it("builds the full namespace path", () => {
    expect(repoFullPath(repo)).toBe("group/subgroup/project");
  });

  it("URL-encodes every slash for REST :id routes", () => {
    expect(encodeProjectId(repo)).toBe("group%2Fsubgroup%2Fproject");
  });

  it("builds the web URL with slashes intact", () => {
    expect(repoWebUrl(repo)).toBe("https://gitlab.com/group/subgroup/project");
  });
});
