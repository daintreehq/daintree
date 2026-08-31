import { afterEach, describe, expect, it } from "vitest";
import { useGitForcePushStore } from "../gitForcePushStore";

const CWD = "/repo/wt";
const BRANCH = "feature/x";
const SHA = "deadbeefcafe";

function reset() {
  useGitForcePushStore.setState({
    recovery: {},
    pendingConfirm: null,
    requestSeq: 0,
    generationSeq: 0,
  });
}

afterEach(() => {
  useGitForcePushStore.getState().resolveConfirmation(false);
  reset();
});

describe("gitForcePushStore recovery", () => {
  it("keeps the branch and lease exactly as the rejection reported them", () => {
    const store = useGitForcePushStore.getState();
    const record = store.recordRejection({ cwd: CWD, branchName: BRANCH, leaseSha: SHA });

    expect(record).not.toBeNull();
    expect(useGitForcePushStore.getState().getRecovery(CWD)).toEqual({
      cwd: CWD,
      branchName: BRANCH,
      leaseSha: SHA,
      generation: record!.generation,
    });
  });

  it.each([
    ["no branch", { cwd: CWD, leaseSha: SHA }],
    ["no lease", { cwd: CWD, branchName: BRANCH }],
    ["empty lease", { cwd: CWD, branchName: BRANCH, leaseSha: "" }],
    ["non-hex lease", { cwd: CWD, branchName: BRANCH, leaseSha: "not-a-sha" }],
    ["over-long lease", { cwd: CWD, branchName: BRANCH, leaseSha: "a".repeat(65) }],
  ])("records nothing when the rejection carried %s", (_label, input) => {
    // `handlePush` omits `leaseSha` when its revparse failed. A record built
    // from a missing or malformed value would surface a force-push row whose
    // only honest option is a lease-less force — #7822 says suppress the CTA
    // instead, and suppression starts here.
    expect(useGitForcePushStore.getState().recordRejection(input)).toBeNull();
    expect(useGitForcePushStore.getState().getRecovery(CWD)).toBeNull();
  });

  it("keeps one lease per worktree and never merges two rejections", () => {
    const store = useGitForcePushStore.getState();
    store.recordRejection({ cwd: CWD, branchName: BRANCH, leaseSha: SHA });
    const second = store.recordRejection({ cwd: CWD, branchName: "other", leaseSha: "abc123" });

    const held = useGitForcePushStore.getState().getRecovery(CWD);
    expect(held).toEqual(second);
    expect(held!.generation).toBeGreaterThan(1);
  });

  it("isolates worktrees from each other", () => {
    const store = useGitForcePushStore.getState();
    store.recordRejection({ cwd: CWD, branchName: BRANCH, leaseSha: SHA });
    store.recordRejection({ cwd: "/repo/other", branchName: "b", leaseSha: "abcd" });

    useGitForcePushStore.getState().clearRecovery(CWD);
    expect(useGitForcePushStore.getState().getRecovery(CWD)).toBeNull();
    expect(useGitForcePushStore.getState().getRecovery("/repo/other")).not.toBeNull();
  });

  it("refuses a conditional clear that names a superseded generation", () => {
    const store = useGitForcePushStore.getState();
    const first = store.recordRejection({ cwd: CWD, branchName: BRANCH, leaseSha: SHA })!;
    const second = useGitForcePushStore
      .getState()
      .recordRejection({ cwd: CWD, branchName: BRANCH, leaseSha: "abcdef" })!;

    // A force push that started against `first` finishing after a new push
    // captured `second` must not delete the newer lease on its way out.
    useGitForcePushStore.getState().clearRecovery(CWD, first.generation);
    expect(useGitForcePushStore.getState().getRecovery(CWD)).toEqual(second);

    useGitForcePushStore.getState().clearRecovery(CWD, second.generation);
    expect(useGitForcePushStore.getState().getRecovery(CWD)).toBeNull();
  });
});

describe("gitForcePushStore confirm gate", () => {
  it("resolves the pending request and clears it", async () => {
    const store = useGitForcePushStore.getState();
    const record = store.recordRejection({ cwd: CWD, branchName: BRANCH, leaseSha: SHA })!;

    const pending = store.requestConfirmation(record);
    expect(useGitForcePushStore.getState().pendingConfirm?.record).toEqual(record);

    useGitForcePushStore.getState().resolveConfirmation(true);
    expect(await pending).toBe(true);
    expect(useGitForcePushStore.getState().pendingConfirm).toBeNull();
  });

  it("declines the first request when a second supersedes it", async () => {
    const store = useGitForcePushStore.getState();
    const a = store.recordRejection({ cwd: CWD, branchName: BRANCH, leaseSha: SHA })!;
    const b = store.recordRejection({ cwd: "/repo/other", branchName: "b", leaseSha: "abcd" })!;

    const first = useGitForcePushStore.getState().requestConfirmation(a);
    const second = useGitForcePushStore.getState().requestConfirmation(b);

    // Same semantics as `gitPushConfirmStore`: a superseded confirm must settle
    // false rather than hang, or the action awaiting it never returns.
    expect(await first).toBe(false);
    useGitForcePushStore.getState().resolveConfirmation(true);
    expect(await second).toBe(true);
  });

  it("bumps requestSeq per request so a crashed dialog host can reset", () => {
    const store = useGitForcePushStore.getState();
    const record = store.recordRejection({ cwd: CWD, branchName: BRANCH, leaseSha: SHA })!;

    void useGitForcePushStore.getState().requestConfirmation(record);
    const first = useGitForcePushStore.getState().requestSeq;
    void useGitForcePushStore.getState().requestConfirmation(record);

    expect(useGitForcePushStore.getState().requestSeq).toBeGreaterThan(first);
  });
});
