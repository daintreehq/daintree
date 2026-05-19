import { describe, it, expect, beforeEach } from "vitest";
import { useGitHubTokenHealthStore } from "@/store/githubTokenHealthStore";
import {
  useForgeProviderHealthStore,
  selectForgeProviderHealth,
} from "@/store/forgeProviderHealthStore";
import { BUILTIN_GITHUB_PROVIDER_ID } from "@shared/utils/forgeProviderIds";

const FAKE = "acme.gitlab.gitlab";

describe("githubTokenHealthStore (shim)", () => {
  beforeEach(() => {
    useForgeProviderHealthStore.setState({ providers: {} });
  });

  it("starts healthy", () => {
    expect(useGitHubTokenHealthStore.getState().isUnhealthy).toBe(false);
  });

  it("setUnhealthy(true) writes through to GitHub's provider slice", () => {
    useGitHubTokenHealthStore.getState().setUnhealthy(true);

    expect(useGitHubTokenHealthStore.getState().isUnhealthy).toBe(true);
    expect(
      selectForgeProviderHealth(BUILTIN_GITHUB_PROVIDER_ID)(useForgeProviderHealthStore.getState())
        .tokenUnhealthy
    ).toBe(true);
  });

  it("does not report GitHub unhealthy when a different provider is unhealthy", () => {
    useForgeProviderHealthStore.getState().setTokenUnhealthy(FAKE, true);
    expect(useGitHubTokenHealthStore.getState().isUnhealthy).toBe(false);
  });

  it("clears back to healthy", () => {
    useGitHubTokenHealthStore.getState().setUnhealthy(true);
    useGitHubTokenHealthStore.getState().setUnhealthy(false);
    expect(useGitHubTokenHealthStore.getState().isUnhealthy).toBe(false);
  });
});
