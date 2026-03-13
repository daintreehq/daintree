import { afterEach, describe, expect, it } from "vitest";
import { useGitHubFilterStore, resetGitHubFilterStore } from "../githubFilterStore";

describe("githubFilterStore", () => {
  afterEach(() => {
    resetGitHubFilterStore();
  });

  it("defaults both filters to open and search queries to empty", () => {
    const state = useGitHubFilterStore.getState();
    expect(state.issueFilter).toBe("open");
    expect(state.prFilter).toBe("open");
    expect(state.issueSearchQuery).toBe("");
    expect(state.prSearchQuery).toBe("");
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

  it("setIssueSearchQuery updates only issueSearchQuery", () => {
    useGitHubFilterStore.getState().setIssueSearchQuery("bug fix");
    const state = useGitHubFilterStore.getState();
    expect(state.issueSearchQuery).toBe("bug fix");
    expect(state.prSearchQuery).toBe("");
  });

  it("setPrSearchQuery updates only prSearchQuery", () => {
    useGitHubFilterStore.getState().setPrSearchQuery("refactor");
    const state = useGitHubFilterStore.getState();
    expect(state.prSearchQuery).toBe("refactor");
    expect(state.issueSearchQuery).toBe("");
  });

  it("issue and PR search queries are fully independent", () => {
    useGitHubFilterStore.getState().setIssueSearchQuery("issue query");
    useGitHubFilterStore.getState().setPrSearchQuery("pr query");
    const state = useGitHubFilterStore.getState();
    expect(state.issueSearchQuery).toBe("issue query");
    expect(state.prSearchQuery).toBe("pr query");
  });

  it("resetGitHubFilterStore resets filters and search queries", () => {
    useGitHubFilterStore.getState().setIssueFilter("closed");
    useGitHubFilterStore.getState().setPrFilter("merged");
    useGitHubFilterStore.getState().setIssueSearchQuery("search1");
    useGitHubFilterStore.getState().setPrSearchQuery("search2");
    resetGitHubFilterStore();
    const state = useGitHubFilterStore.getState();
    expect(state.issueFilter).toBe("open");
    expect(state.prFilter).toBe("open");
    expect(state.issueSearchQuery).toBe("");
    expect(state.prSearchQuery).toBe("");
  });
});
