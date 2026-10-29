import { beforeEach, describe, expect, it } from "vitest";
import { useReviewCommitDraftStore } from "../reviewCommitDraftStore";

const draftFor = (path: string) => useReviewCommitDraftStore.getState().draftsByWorktree[path];

beforeEach(() => {
  useReviewCommitDraftStore.setState({ draftsByWorktree: {} });
});

describe("reviewCommitDraftStore (#15007)", () => {
  it("keeps each worktree's draft apart, exactly as typed", () => {
    const { setDraft } = useReviewCommitDraftStore.getState();
    setDraft("/repo/a", "  feat: a\n\nbody  ");
    setDraft("/repo/b", "fix: b");

    expect(draftFor("/repo/a")).toBe("  feat: a\n\nbody  ");
    expect(draftFor("/repo/b")).toBe("fix: b");
  });

  it("forgets a draft cleared to empty, but keeps a whitespace-only one", () => {
    const { setDraft } = useReviewCommitDraftStore.getState();
    setDraft("/repo/a", "feat: a");
    setDraft("/repo/a", "");
    setDraft("/repo/b", " ");

    expect("/repo/a" in useReviewCommitDraftStore.getState().draftsByWorktree).toBe(false);
    expect(draftFor("/repo/b")).toBe(" ");
  });

  it("leaves the state untouched for a write that changes nothing", () => {
    const { setDraft, clearWorktree } = useReviewCommitDraftStore.getState();
    setDraft("/repo/a", "feat: a");
    const before = useReviewCommitDraftStore.getState().draftsByWorktree;

    setDraft("/repo/a", "feat: a");
    setDraft("/repo/b", "");
    clearWorktree("/repo/b");

    expect(useReviewCommitDraftStore.getState().draftsByWorktree).toBe(before);
  });

  it("clears a committed draft only while it is still the message committed", () => {
    const { setDraft, clearCommitted } = useReviewCommitDraftStore.getState();
    setDraft("/repo/a", "feat: committed");
    setDraft("/repo/b", "feat: first");
    setDraft("/repo/b", "feat: rewritten while the commit ran");

    clearCommitted("/repo/a", "feat: committed");
    clearCommitted("/repo/b", "feat: first");

    expect(draftFor("/repo/a")).toBeUndefined();
    expect(draftFor("/repo/b")).toBe("feat: rewritten while the commit ran");
  });

  it("drops one worktree's draft without touching the others", () => {
    const { setDraft, clearWorktree } = useReviewCommitDraftStore.getState();
    setDraft("/repo/a", "feat: a");
    setDraft("/repo/b", "fix: b");

    clearWorktree("/repo/a");

    expect(draftFor("/repo/a")).toBeUndefined();
    expect(draftFor("/repo/b")).toBe("fix: b");
  });
});
