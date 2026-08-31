import { describe, it, expect, beforeEach } from "vitest";
import { useGitWorktreeOperationConfirmStore } from "@/store/gitWorktreeOperationConfirmStore";

beforeEach(() => {
  useGitWorktreeOperationConfirmStore.setState({ pendingConfirm: null, requestSeq: 0 });
});

describe("gitWorktreeOperationConfirmStore", () => {
  it("holds the request until the dialog resolves it", async () => {
    const store = useGitWorktreeOperationConfirmStore.getState();
    const pending = store.requestConfirmation({
      kind: "rebase-onto-base",
      cwd: "/repo/wt",
      baseBranch: "develop",
    });

    expect(useGitWorktreeOperationConfirmStore.getState().pendingConfirm?.request).toEqual({
      kind: "rebase-onto-base",
      cwd: "/repo/wt",
      baseBranch: "develop",
    });

    useGitWorktreeOperationConfirmStore.getState().resolveConfirmation(true);
    await expect(pending).resolves.toEqual({ confirmed: true, pinned: null });
    expect(useGitWorktreeOperationConfirmStore.getState().pendingConfirm).toBeNull();
  });

  it("carries the operation for an abort request", async () => {
    const pending = useGitWorktreeOperationConfirmStore.getState().requestConfirmation({
      kind: "abort-operation",
      cwd: "/repo/wt",
      operation: "MERGING",
    });
    expect(useGitWorktreeOperationConfirmStore.getState().pendingConfirm?.request).toEqual({
      kind: "abort-operation",
      cwd: "/repo/wt",
      operation: "MERGING",
    });
    useGitWorktreeOperationConfirmStore.getState().resolveConfirmation(false);
    await expect(pending).resolves.toEqual({ confirmed: false, pinned: null });
  });

  it("cancels a superseded request rather than leaking its Promise", async () => {
    // The action `run()` is awaiting the first Promise. If a second request
    // simply overwrote it, that await would never settle and the first
    // operation would hang forever.
    const first = useGitWorktreeOperationConfirmStore.getState().requestConfirmation({
      kind: "rebase-onto-base",
      cwd: "/repo/one",
      baseBranch: "develop",
    });
    const second = useGitWorktreeOperationConfirmStore.getState().requestConfirmation({
      kind: "merge-base",
      cwd: "/repo/two",
      baseBranch: "main",
    });

    await expect(first).resolves.toEqual({ confirmed: false, pinned: null });
    expect(useGitWorktreeOperationConfirmStore.getState().pendingConfirm?.request).toMatchObject({
      cwd: "/repo/two",
    });

    useGitWorktreeOperationConfirmStore.getState().resolveConfirmation(true);
    await expect(second).resolves.toEqual({ confirmed: true, pinned: null });
  });

  it("bumps requestSeq on every request, including a back-to-back supersede", () => {
    // The ErrorBoundary reset key. `pendingConfirm` never returns to null
    // between superseding requests, so it cannot serve as the signal (#9918).
    const store = useGitWorktreeOperationConfirmStore.getState();
    void store.requestConfirmation({ kind: "rebase-onto-base", cwd: "/a", baseBranch: "develop" });
    void store.requestConfirmation({ kind: "rebase-onto-base", cwd: "/b", baseBranch: "develop" });
    expect(useGitWorktreeOperationConfirmStore.getState().requestSeq).toBe(2);
  });

  it("carries the previewed commits back to the caller", async () => {
    // The whole reason the result is not a bare boolean: the action hands these
    // to the write, which refuses if either has moved since.
    const pending = useGitWorktreeOperationConfirmStore.getState().requestConfirmation({
      kind: "rebase-onto-base",
      cwd: "/repo/wt",
      baseBranch: "develop",
    });
    useGitWorktreeOperationConfirmStore
      .getState()
      .resolveConfirmation(true, { headOid: "aaa", baseOid: "bbb" });
    await expect(pending).resolves.toEqual({
      confirmed: true,
      pinned: { headOid: "aaa", baseOid: "bbb" },
    });
  });

  it("drops any pins on a decline", async () => {
    // A declined confirm has nothing to pin, and carrying OIDs through it would
    // let a caller act on refs it was never given permission for.
    const pending = useGitWorktreeOperationConfirmStore.getState().requestConfirmation({
      kind: "merge-base",
      cwd: "/repo/wt",
      baseBranch: "develop",
    });
    useGitWorktreeOperationConfirmStore
      .getState()
      .resolveConfirmation(false, { headOid: "aaa", baseOid: "bbb" });
    await expect(pending).resolves.toEqual({ confirmed: false, pinned: null });
  });

  it("ignores a resolve with nothing pending", () => {
    useGitWorktreeOperationConfirmStore.getState().resolveConfirmation(true);
    expect(useGitWorktreeOperationConfirmStore.getState().pendingConfirm).toBeNull();
  });
});
