import { afterEach, describe, expect, it } from "vitest";
import { useGitHubFilterStore, resetGitHubFilterStore } from "../githubFilterStore";

describe("githubFilterStore", () => {
  afterEach(() => {
    resetGitHubFilterStore();
  });

  it("defaults both filters to open", () => {
    const state = useGitHubFilterStore.getState();
    expect(state.issueFilter).toBe("open");
    expect(state.prFilter).toBe("open");
  });

  it("setIssueFilter updates issueFilter without touching prFilter", () => {
    useGitHubFilterStore.getState().setIssueFilter("closed");
    const state = useGitHubFilterStore.getState();
    expect(state.issueFilter).toBe("closed");
    expect(state.prFilter).toBe("open");
  });

  it("setPrFilter updates prFilter without touching issueFilter", () => {
    useGitHubFilterStore.getState().setPrFilter("merged");
    const state = useGitHubFilterStore.getState();
    expect(state.prFilter).toBe("merged");
    expect(state.issueFilter).toBe("open");
  });

  it("resetGitHubFilterStore restores both filters to open", () => {
    useGitHubFilterStore.getState().setIssueFilter("closed");
    useGitHubFilterStore.getState().setPrFilter("merged");
    resetGitHubFilterStore();
    const state = useGitHubFilterStore.getState();
    expect(state.issueFilter).toBe("open");
    expect(state.prFilter).toBe("open");
  });

  it("issue and PR filters are fully independent", () => {
    useGitHubFilterStore.getState().setIssueFilter("all");
    useGitHubFilterStore.getState().setPrFilter("closed");
    const state = useGitHubFilterStore.getState();
    expect(state.issueFilter).toBe("all");
    expect(state.prFilter).toBe("closed");
  });
});
