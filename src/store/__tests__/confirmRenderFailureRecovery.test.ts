/**
 * The helpers a confirmation dialog's ErrorBoundary calls when the dialog
 * can't load or render (#17204). Each must answer the request the failed
 * render was showing, advance any queue behind it, and leave a request that
 * has since replaced it alone, so a late report never answers the wrong one.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  __resetMcpConfirmStoreForTesting,
  declineFailedMcpConfirmation,
  requestMcpConfirmation,
  useMcpConfirmStore,
} from "../mcpConfirmStore";
import {
  __resetPluginPromptStoreForTesting,
  dismissFailedUiPrompt,
  enqueueUiPrompt,
  usePluginPromptStore,
} from "../pluginPromptStore";
import {
  cancelLayoutApplyConfirmations,
  declineFailedLayoutApplyConfirmation,
  requestLayoutApplyConfirmation,
  useLayoutApplyConfirmStore,
} from "../layoutApplyConfirmStore";
import { declineFailedGitPushConfirmation, useGitPushConfirmStore } from "../gitPushConfirmStore";
import {
  declineFailedGitPullRebaseConfirmation,
  useGitPullRebaseConfirmStore,
} from "../gitPullRebaseConfirmStore";
import {
  declineFailedFileMutationConfirmation,
  useFileMutationConfirmStore,
} from "../fileMutationConfirmStore";
import {
  declineFailedGitWorktreeOperationConfirmation,
  useGitWorktreeOperationConfirmStore,
} from "../gitWorktreeOperationConfirmStore";
import { cancelFailedRecipeConflict, useRecipeConflictStore } from "../recipeConflictStore";
import { declineFailedPanelLimitConfirmation, usePanelLimitStore } from "../panelLimitStore";
import type { PluginUiPromptParams } from "@shared/types/pluginUiPrompt";

async function settled(promise: Promise<unknown>): Promise<boolean> {
  let done = false;
  void promise.then(() => {
    done = true;
  });
  await Promise.resolve();
  await Promise.resolve();
  return done;
}

function mcpRequest(requestId: string) {
  return requestMcpConfirmation({
    requestId,
    actionId: "worktree.delete",
    actionTitle: "Delete worktree",
    actionDescription: "Permanently delete a worktree.",
    argsSummary: "{}",
    danger: "confirm",
  });
}

describe("declineFailedMcpConfirmation", () => {
  afterEach(() => __resetMcpConfirmStoreForTesting());

  it("rejects the request in front and shows the next, leaving the next one pending", async () => {
    const failed = mcpRequest("a");
    const next = mcpRequest("b");

    declineFailedMcpConfirmation("a");

    expect(await failed).toEqual({ decision: "rejected" });
    expect(useMcpConfirmStore.getState().current?.requestId).toBe("b");
    expect(await settled(next)).toBe(false);
  });

  it("leaves the request in front alone when the failure names one that already went", async () => {
    const first = mcpRequest("a");
    const second = mcpRequest("b");
    useMcpConfirmStore.getState().resolveCurrent("approved");
    expect(await first).toEqual({ decision: "approved" });

    declineFailedMcpConfirmation("a");

    expect(useMcpConfirmStore.getState().current?.requestId).toBe("b");
    expect(await settled(second)).toBe(false);
  });

  it("closes a request that already expired without answering it a second time", async () => {
    const expiring = mcpRequest("a");
    useMcpConfirmStore.getState().markShown("a");
    useMcpConfirmStore.getState().expire("a");
    expect(await expiring).toEqual({ decision: "timeout" });
    expect(useMcpConfirmStore.getState().current?.expired).toBe(true);

    declineFailedMcpConfirmation("a");

    expect(useMcpConfirmStore.getState().current).toBeNull();
  });
});

describe("dismissFailedUiPrompt", () => {
  afterEach(() => __resetPluginPromptStoreForTesting());

  function prompt(promptId: string, pluginId: string, params: PluginUiPromptParams) {
    return enqueueUiPrompt({ promptId, pluginId, params });
  }

  it.each<[PluginUiPromptParams, unknown]>([
    [{ kind: "confirm", options: { title: "Ship it?" } }, false],
    [{ kind: "inputBox", options: {} }, undefined],
    [{ kind: "quickPick", items: [], options: {} }, undefined],
  ])("answers a %o prompt with its dismiss value and shows the next", async (params, dismissed) => {
    const failed = prompt("p1", "acme.one", params);
    const next = prompt("p2", "acme.two", { kind: "inputBox", options: {} });

    dismissFailedUiPrompt("p1");

    expect(await failed).toBe(dismissed);
    expect(usePluginPromptStore.getState().current?.promptId).toBe("p2");
    expect(await settled(next)).toBe(false);
  });

  it("does nothing for a prompt that is no longer in front, or for no prompt at all", async () => {
    const first = prompt("p1", "acme.one", { kind: "inputBox", options: {} });
    const second = prompt("p2", "acme.one", { kind: "inputBox", options: {} });
    usePluginPromptStore.getState().resolveCurrent("typed");
    expect(await first).toBe("typed");

    dismissFailedUiPrompt("p1");
    dismissFailedUiPrompt(null);

    expect(usePluginPromptStore.getState().current?.promptId).toBe("p2");
    expect(await settled(second)).toBe(false);
  });
});

describe("declineFailedLayoutApplyConfirmation", () => {
  afterEach(() => cancelLayoutApplyConfirmations());

  function layoutRequest(layoutId: string) {
    return requestLayoutApplyConfirmation({
      layoutId,
      layoutName: layoutId,
      pluginName: "Acme",
      previewLines: [],
    });
  }

  it("declines only the request in front and leaves the next one waiting", async () => {
    const failed = layoutRequest("one");
    const next = layoutRequest("two");
    const failedId = useLayoutApplyConfirmStore.getState().current!.requestId;

    declineFailedLayoutApplyConfirmation(failedId);

    expect(await failed).toBe(false);
    expect(useLayoutApplyConfirmStore.getState().current?.layoutId).toBe("two");
    expect(await settled(next)).toBe(false);

    declineFailedLayoutApplyConfirmation(failedId);
    expect(await settled(next)).toBe(false);
  });
});

/**
 * The single-slot stores: the request is identified by the `requestSeq` it
 * bumped, so a decline for an earlier request can't answer a newer one.
 */
describe.each([
  {
    name: "git push",
    request: () => useGitPushConfirmStore.getState().requestConfirmation("/repo"),
    seq: () => useGitPushConfirmStore.getState().requestSeq,
    decline: declineFailedGitPushConfirmation,
    declined: { confirmed: false, review: null },
  },
  {
    name: "git pull rebase",
    request: () => useGitPullRebaseConfirmStore.getState().requestConfirmation("/repo"),
    seq: () => useGitPullRebaseConfirmStore.getState().requestSeq,
    decline: declineFailedGitPullRebaseConfirmation,
    declined: { confirmed: false, review: null },
  },
  {
    name: "file mutation",
    request: () =>
      useFileMutationConfirmStore.getState().requestConfirmation({
        kind: "discard",
        relativePath: "a.ts",
        worktreePath: "/repo",
      }),
    seq: () => useFileMutationConfirmStore.getState().requestSeq,
    decline: declineFailedFileMutationConfirmation,
    declined: null,
  },
  {
    name: "worktree operation",
    request: () =>
      useGitWorktreeOperationConfirmStore
        .getState()
        .requestConfirmation({ kind: "merge-base", cwd: "/repo", baseBranch: "main" }),
    seq: () => useGitWorktreeOperationConfirmStore.getState().requestSeq,
    decline: declineFailedGitWorktreeOperationConfirmation,
    declined: { confirmed: false, pinned: null, operation: null },
  },
  {
    name: "recipe conflict",
    request: () =>
      useRecipeConflictStore.getState().requestConflict({
        recipeId: "r1",
        recipeName: "Build",
        updates: {},
        reason: "stale",
      }),
    seq: () => useRecipeConflictStore.getState().requestSeq,
    decline: cancelFailedRecipeConflict,
    declined: "cancel",
  },
  {
    name: "panel limit",
    request: () =>
      usePanelLimitStore.getState().requestConfirmation({
        currentCount: 20,
        requestedCount: 2,
        allowedCount: 2,
        confirmationLimit: 20,
        hardLimit: 32,
      }),
    seq: () => usePanelLimitStore.getState().requestSeq,
    decline: declineFailedPanelLimitConfirmation,
    declined: false,
  },
])("$name decline on a failed render", ({ request, seq, decline, declined }) => {
  afterEach(() => decline(seq()));

  it("answers the pending request with the decline", async () => {
    const pending = request();
    decline(seq());
    expect(await pending).toEqual(declined);
  });

  it("leaves a newer request alone when the failure names an earlier one", async () => {
    const earlier = request();
    const failedSeq = seq();
    decline(failedSeq);
    await earlier;

    const newer = request();
    decline(failedSeq);
    expect(await settled(newer)).toBe(false);

    decline(seq());
    expect(await newer).toEqual(declined);
  });
});
