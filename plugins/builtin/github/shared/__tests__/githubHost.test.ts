import { describe, expect, it } from "vitest";
import { GITHUB_REQUIRED_SCOPES } from "../credentialScopes.js";
import { newFineGrainedTokenUrl, newClassicTokenUrl } from "../githubHost.js";

describe("newClassicTokenUrl", () => {
  it("pre-fills the classic scopes for the host", () => {
    expect(newClassicTokenUrl("github.com", GITHUB_REQUIRED_SCOPES)).toBe(
      "https://github.com/settings/tokens/new?scopes=repo,read:org&description=Daintree"
    );
    expect(newClassicTokenUrl("github.example.com", ["repo"])).toBe(
      "https://github.example.com/settings/tokens/new?scopes=repo&description=Daintree"
    );
  });
});

describe("newFineGrainedTokenUrl", () => {
  it("pins the pre-filled fine-grained token page", () => {
    expect(newFineGrainedTokenUrl()).toBe(
      "https://github.com/settings/personal-access-tokens/new" +
        "?name=Daintree" +
        "&description=Pull+requests%2C+issues+and+CI+for+Daintree" +
        "&contents=write" +
        "&pull_requests=write" +
        "&issues=write" +
        "&statuses=read" +
        "&actions=read" +
        "&deployments=read" +
        "&vulnerability_alerts=read"
    );
  });

  it("stays inside GitHub's field limits and leaves the owner to the person", () => {
    const params = new URL(newFineGrainedTokenUrl()).searchParams;
    expect(params.get("name")!.length).toBeLessThanOrEqual(40);
    expect(params.get("description")!.length).toBeLessThanOrEqual(1024);
    expect(params.has("target_name")).toBe(false);
    for (const [key, value] of params) {
      if (key === "name" || key === "description") continue;
      expect(["read", "write"]).toContain(value);
    }
  });
});
