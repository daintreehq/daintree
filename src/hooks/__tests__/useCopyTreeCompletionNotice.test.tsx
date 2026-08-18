// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type React from "react";

const notifyMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/notify", () => ({ notify: notifyMock }));

import {
  COPY_TREE_NOTICE_DURATION_MS,
  useCopyTreeCompletionNotice,
} from "../useCopyTreeCompletionNotice";
import { announceCopyTreeCopy, _resetCopyTreeNoticePresenterForTest } from "@/lib/copyTreeFeedback";

const NOTICE = { title: "Context copied", message: "Copied 3 files (4 KB) as XML to clipboard" };

/**
 * jsdom computes no layout, so `offsetParent` is null on every element — the
 * exact signal the presenter reads as "overflow-evicted". The visible-anchor
 * fixture stubs it the way a laid-out toolbar button would report.
 */
function makeAnchor({ visible = true }: { visible?: boolean } = {}): {
  ref: React.RefObject<HTMLElement | null>;
  el: HTMLElement;
} {
  const el = document.createElement("button");
  document.body.appendChild(el);
  if (visible) {
    Object.defineProperty(el, "offsetParent", { get: () => document.body });
  }
  return { ref: { current: el }, el };
}

/** Announce through the real seam so the register/decline contract is what's under test. */
function announce(): void {
  act(() => {
    announceCopyTreeCopy({ ...NOTICE }, "worktree.copyTree");
  });
}

// jsdom reports an unfocused document by default, which the presenter reads as
// "window blurred → decline". Present-path tests need a focused one; the
// blur-decline case re-spies to false on top of this.
beforeEach(() => {
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
});

afterEach(() => {
  _resetCopyTreeNoticePresenterForTest();
  notifyMock.mockClear();
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("useCopyTreeCompletionNotice", () => {
  it("presents a completion on a visible anchor instead of the toast", () => {
    const { ref } = makeAnchor();
    const { result } = renderHook(() => useCopyTreeCompletionNotice(ref));

    announce();

    expect(result.current.notice).toEqual(NOTICE);
    expect(result.current.announcement).toBe(`${NOTICE.title}. ${NOTICE.message}`);
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("hides the notice and clears the announcement after the display window", () => {
    vi.useFakeTimers();
    const { ref } = makeAnchor();
    const { result } = renderHook(() => useCopyTreeCompletionNotice(ref));

    announce();
    act(() => {
      vi.advanceTimersByTime(COPY_TREE_NOTICE_DURATION_MS);
    });

    expect(result.current.notice).toBeNull();
    expect(result.current.announcement).toBe("");
  });

  it("keeps the notice up past the point a glanceable-only window would have closed", () => {
    // The window has to outlast reading, not just noticing: two lines of copy
    // costs 3.5-4.5s to acquire and read, so a sub-second-scale window shows a
    // message nobody finishes. Pinned at 3s — comfortably past the 2s this
    // shipped with, and short of the configured window — so shrinking the
    // constant back toward a glance fails here instead of passing silently.
    vi.useFakeTimers();
    const { ref } = makeAnchor();
    const { result } = renderHook(() => useCopyTreeCompletionNotice(ref));

    announce();
    act(() => {
      vi.advanceTimersByTime(3000);
    });

    expect(result.current.notice).toEqual(NOTICE);
    expect(result.current.announcement).toBe(`${NOTICE.title}. ${NOTICE.message}`);
  });

  it("re-arms the display window when a second completion lands mid-notice", () => {
    vi.useFakeTimers();
    const { ref } = makeAnchor();
    const { result } = renderHook(() => useCopyTreeCompletionNotice(ref));

    announce();
    act(() => {
      vi.advanceTimersByTime(COPY_TREE_NOTICE_DURATION_MS - 500);
    });
    announce();
    act(() => {
      vi.advanceTimersByTime(COPY_TREE_NOTICE_DURATION_MS - 500);
    });

    // A stale first-notice timer would have hidden this 500ms after the first
    // announce, long before now.
    expect(result.current.notice).toEqual(NOTICE);

    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(result.current.notice).toBeNull();
  });

  it("re-announces an identical back-to-back completion by toggling a zero-width space", () => {
    // The live region only speaks when its text CHANGES, so a second copy with
    // the same summary would otherwise be silent for a screen-reader user.
    vi.useFakeTimers();
    const { ref } = makeAnchor();
    const { result } = renderHook(() => useCopyTreeCompletionNotice(ref));

    announce();
    const first = result.current.announcement;
    announce();

    expect(result.current.announcement).toBe(`${first}\u200b`);
  });

  it("clears the notice and announcement on demand", () => {
    const { ref } = makeAnchor();
    const { result } = renderHook(() => useCopyTreeCompletionNotice(ref));

    announce();
    act(() => {
      result.current.clearNotice();
    });

    expect(result.current.notice).toBeNull();
    expect(result.current.announcement).toBe("");
  });

  it.each([
    ["the anchor is gone", () => ({ ref: { current: null } })],
    ["the anchor is overflow-evicted (offsetParent null)", () => makeAnchor({ visible: false })],
    [
      "the anchor sits under an aria-hidden wrapper",
      () => {
        const anchor = makeAnchor();
        const wrapper = document.createElement("div");
        wrapper.setAttribute("aria-hidden", "true");
        document.body.appendChild(wrapper);
        wrapper.appendChild(anchor.el);
        return anchor;
      },
    ],
  ])("declines to the toast fallback when %s", (_label, setup) => {
    const { ref } = setup();
    const { result } = renderHook(() => useCopyTreeCompletionNotice(ref));

    announce();

    expect(result.current.notice).toBeNull();
    expect(notifyMock).toHaveBeenCalledTimes(1);
  });

  it("declines when the caller suppresses presentation (recents panel open)", () => {
    const { ref } = makeAnchor();
    const { result } = renderHook(() => useCopyTreeCompletionNotice(ref, { suppress: true }));

    announce();

    expect(result.current.notice).toBeNull();
    expect(notifyMock).toHaveBeenCalledTimes(1);
  });

  it("declines when the view is background-hidden", () => {
    // MCP dispatches run in their project's renderer even when another project
    // is on screen; a tooltip there evaporates unseen while the toast fallback
    // at least leaves an inbox row.
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    const { ref } = makeAnchor();
    const { result } = renderHook(() => useCopyTreeCompletionNotice(ref));

    announce();

    expect(result.current.notice).toBeNull();
    expect(notifyMock).toHaveBeenCalledTimes(1);
  });

  it("declines when the window is blurred", () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    const { ref } = makeAnchor();
    const { result } = renderHook(() => useCopyTreeCompletionNotice(ref));

    announce();

    expect(result.current.notice).toBeNull();
    expect(notifyMock).toHaveBeenCalledTimes(1);
  });

  it("unregisters its presenter on unmount", () => {
    const { ref } = makeAnchor();
    const { unmount } = renderHook(() => useCopyTreeCompletionNotice(ref));

    unmount();
    announce();

    expect(notifyMock).toHaveBeenCalledTimes(1);
  });
});
