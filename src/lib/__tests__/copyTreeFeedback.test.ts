import { afterEach, describe, expect, it, vi } from "vitest";

const notifyMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/notify", () => ({ notify: notifyMock }));

import {
  announceCopyTreeCopy,
  registerCopyTreeNoticePresenter,
  _resetCopyTreeNoticePresenterForTest,
} from "../copyTreeFeedback";

const NOTICE = { title: "Context copied", message: "Copied 3 files (4 KB) as XML to clipboard" };

afterEach(() => {
  _resetCopyTreeNoticePresenterForTest();
  notifyMock.mockClear();
});

describe("announceCopyTreeCopy", () => {
  it("hands the notice to the presenter and raises no toast when it presents", () => {
    const presenter = vi.fn().mockReturnValue(true);
    registerCopyTreeNoticePresenter(presenter);

    announceCopyTreeCopy(NOTICE, "worktree.copyTree");

    expect(presenter).toHaveBeenCalledWith(NOTICE);
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("falls back to a toast carrying the caller's rate-limit bucket when the presenter declines", () => {
    // A presenter declines when its anchor is hidden — the completion must
    // still land somewhere visible, in the shape the toast always had.
    registerCopyTreeNoticePresenter(() => false);

    announceCopyTreeCopy(NOTICE, "copyTree.generateAndCopyFile");

    expect(notifyMock).toHaveBeenCalledWith({
      type: "success",
      title: NOTICE.title,
      message: NOTICE.message,
      rateLimitKey: "copyTree.generateAndCopyFile",
      context: { eventKind: "agent" },
    });
  });

  it("falls back to a toast when no presenter is registered at all", () => {
    announceCopyTreeCopy(NOTICE, "worktree.copyTree");
    expect(notifyMock).toHaveBeenCalledTimes(1);
  });

  it("lets a newer presenter's cleanup leave the current one in place", () => {
    // StrictMode-shaped churn: A registers, is replaced by B, then A's
    // unregister runs late. B must survive it.
    const a = vi.fn().mockReturnValue(true);
    const b = vi.fn().mockReturnValue(true);
    const unregisterA = registerCopyTreeNoticePresenter(a);
    registerCopyTreeNoticePresenter(b);
    unregisterA();

    announceCopyTreeCopy(NOTICE, "worktree.copyTree");

    expect(b).toHaveBeenCalledTimes(1);
    expect(a).not.toHaveBeenCalled();
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("unregisters cleanly so a torn-down presenter is never called", () => {
    const presenter = vi.fn().mockReturnValue(true);
    const unregister = registerCopyTreeNoticePresenter(presenter);
    unregister();

    announceCopyTreeCopy(NOTICE, "worktree.copyTree");

    expect(presenter).not.toHaveBeenCalled();
    expect(notifyMock).toHaveBeenCalledTimes(1);
  });
});
